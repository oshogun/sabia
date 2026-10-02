import { useEffect, useMemo, useRef, useState, Fragment } from 'react';
import { Marker, Polyline, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import { Button, InlineLoading, Layer, Tile } from '@carbon/react';
import { useNavdataStatus } from '../../hooks/useNavdataStatus';
import { fetchRouteGeometry, requestNavdata } from '../../utils/navdataApi';
import { navdataPalette as P } from './navdata/navdataPalette';
import { formatDistance } from '../../utils/format';
import { unwrapLonChains } from '../../utils/geo';
import './navdata/navdata.scss';
import type {
  GeometryChain,
  NavdataRequestResponse,
  PlannedLegWithChildren,
  RouteGeometryResponse,
} from '../../types';

// Same colour family as the planned route on FlightMap and TripMap, so an
// expanded route still reads as "planned" and never as a flown track.
const PLANNED_ROUTE_COLOR = P.planned;

const ARC_SEGMENTS = 24;
const AIRPORT_IDENT = /^[A-Z0-9]{1,8}$/;

type ChainName = 'sid' | 'enroute' | 'star' | 'approach';
const CHAIN_ORDER: ChainName[] = ['sid', 'enroute', 'star', 'approach'];
const CHAIN_LABEL: Record<ChainName, string> = { sid: 'SID', enroute: 'Route', star: 'STAR', approach: 'APP' };

/** The one place the client says that a synthetic chain is not a coded procedure. */
export const COMPUTED_GEOMETRY_NOTE = 'Computed from the runway, not a coded procedure.';

// Route geometry is fetched after the map first draws, so its polylines are
// added after the flown track and would paint over it in the shared canvas.
// The maps therefore send the flown track back to the front once geometry
// mounts (see FlightMap and TripMap). The layers deliberately stay in the
// default renderer: Leaflet hit-tests only the topmost canvas, so a canvas of
// their own beneath the overlay pane would never show its tooltips.

const mkWaypointIcon = () =>
  L.divIcon({
    className: '',
    iconAnchor: [4, 4],
    html: `<div style="width:8px;height:8px;border-radius:50%;background:${PLANNED_ROUTE_COLOR};border:1px solid ${P.ring};box-shadow:0 0 3px ${P.shadow};opacity:0.9"></div>`,
  });

const mkComputedIcon = () =>
  L.divIcon({
    className: '',
    iconAnchor: [5, 5],
    html: `<div style="width:10px;height:10px;transform:rotate(45deg);background:${PLANNED_ROUTE_COLOR};border:1px solid ${P.ring};box-shadow:0 0 3px ${P.shadow}"></div>`,
  });

function chainOf(g: RouteGeometryResponse, name: ChainName): GeometryChain {
  return g[name];
}

/** True when any chain has at least one point. */
export function geometryHasChains(g: RouteGeometryResponse | null | undefined): boolean {
  return !!g && CHAIN_ORDER.some(n => chainOf(g, n).points.length > 0);
}

function nmBetween(a: [number, number], b: [number, number]): number {
  const R = 3440.065;
  const toRad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRad;
  const dLon = (b[1] - a[1]) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const UNRESOLVED_TEXT: Record<string, string> = {
  'custom procedure, no runway': 'custom procedure, not a simulator procedure',
  'custom procedure, invalid distance': 'custom procedure, not a simulator procedure — its distance is missing',
  'unparseable runway': 'runway not recognised',
  'approach runway not specified': 'runway not specified, so not drawn',
  'airport detail not fetched': 'airport detail not fetched yet',
  'procedure not in cache': 'procedure not in the local navdata',
};

/**
 * The tooltip line naming the leg's SID/STAR/approach. With no route geometry
 * (or an empty answer) it is the plain line the map has always shown; with
 * geometry it says what was actually drawn, and why anything was not.
 */
export function procedureNote(leg: PlannedLegWithChildren, geometry?: RouteGeometryResponse | null): string | null {
  const parts: string[] = [];
  if (leg.sid_name) parts.push(`SID ${leg.sid_name}`);
  if (leg.star_name) parts.push(`STAR ${leg.star_name}`);
  if (leg.approach_name) parts.push(`APP ${leg.approach_name}`);
  const allParts = parts.slice();
  if (parts.length === 0) return null;

  if (!geometry || (!geometryHasChains(geometry) && geometry.unresolved.length === 0)) {
    // Makes the gap at the ends read as missing procedure data, not a drawing
    // bug — the planned route is expected to diverge from the flown track
    // here, and that divergence is never "fixed" by this component.
    return `${parts.join(' · ')} (planned route excludes SID/STAR/approach legs)`;
  }

  const clauses: string[] = [];
  const synthKinds: string[] = [];
  if (geometry.sid.synthetic && geometry.sid.points.length > 0) synthKinds.push('SID');
  if (geometry.approach.synthetic && geometry.approach.points.length > 0) synthKinds.push('APP');
  if (synthKinds.length > 0) {
    clauses.push(`custom ${synthKinds.join('/')}, not a simulator procedure — drawn from the runway`);
  }
  const kindLabel = { sid: 'SID', star: 'STAR', approach: 'APP' } as const;
  for (const u of geometry.unresolved) {
    if (u.kind !== 'sid' && u.kind !== 'star' && u.kind !== 'approach') continue;
    const label = `${kindLabel[u.kind]} ${u.name}`;
    const end = u.kind === 'sid' ? geometry.origin : geometry.destination;
    let text = UNRESOLVED_TEXT[u.reason] ?? u.reason;
    if (u.reason === 'custom procedure, no runway') {
      text += end?.isAirport === true ? ' — runway detail not fetched yet' : ' — could not be drawn';
    }
    // The label already heads this clause, so the plain header drops it.
    const at = parts.indexOf(label);
    if (at >= 0) parts.splice(at, 1);
    clauses.push(`${label} — ${text}`);
  }
  if (geometry.skippedLegs > 0) clauses.push(`${geometry.skippedLegs} procedure legs not drawable`);
  if (clauses.length === 0) return allParts.join(' · ');
  return `${parts.length > 0 ? `${parts.join(' · ')} — ` : ''}${clauses.join('; ')}`;
}

interface DrawnChain {
  name: ChainName;
  chain: GeometryChain;
  /** One position per chain point, unwrapped. Markers sit on these. */
  points: [number, number][];
  /** `points` with every arc expanded into a polyline approximation. */
  path: [number, number][];
}

export interface GeometryPaths {
  chains: DrawnChain[];
  /** Dashed joins between neighbouring chain ends; what lies between is not known. */
  connectors: [number, number][][];
  /** The plan's own waypoints were expanded, so the planned polyline is replaced. */
  replacesPlanned: boolean;
}

function arcPositions(
  from: [number, number],
  to: [number, number],
  centre: [number, number],
  turn: 'L' | 'R' | null
): [number, number][] {
  let clon = centre[1];
  while (clon - from[1] > 180) clon -= 360;
  while (clon - from[1] < -180) clon += 360;
  const cosLat = Math.max(0.05, Math.cos((centre[0] * Math.PI) / 180));
  const toXY = (p: [number, number]): [number, number] => {
    let lon = p[1];
    while (lon - clon > 180) lon -= 360;
    while (lon - clon < -180) lon += 360;
    return [(lon - clon) * cosLat, p[0] - centre[0]];
  };
  const [x0, y0] = toXY(from);
  const [x1, y1] = toXY(to);
  const a0 = Math.atan2(y0, x0);
  const a1 = Math.atan2(y1, x1);
  const r0 = Math.hypot(x0, y0);
  const r1 = Math.hypot(x1, y1);
  let delta = a1 - a0;
  const TAU = Math.PI * 2;
  if (turn === 'L') {
    while (delta <= 0) delta += TAU;
    while (delta > TAU) delta -= TAU;
  } else if (turn === 'R') {
    while (delta >= 0) delta -= TAU;
    while (delta < -TAU) delta += TAU;
  } else {
    while (delta > Math.PI) delta -= TAU;
    while (delta <= -Math.PI) delta += TAU;
  }
  const out: [number, number][] = [];
  for (let i = 1; i < ARC_SEGMENTS; i++) {
    const t = i / ARC_SEGMENTS;
    const a = a0 + delta * t;
    const r = r0 + (r1 - r0) * t;
    out.push([centre[0] + r * Math.sin(a), clon + (r * Math.cos(a)) / cosLat]);
  }
  return out;
}

/**
 * Lays a route-geometry answer out as polylines. Every longitude goes through
 * one unwrapLonChains call, in flight order, so a route crossing the
 * antimeridian stays in one continuous frame; `anchor` lets a caller thread
 * the frame it already uses for the flown track and the planned route.
 */
export function buildGeometryPaths(g: RouteGeometryResponse, anchor?: [number, number] | null): GeometryPaths {
  const present = CHAIN_ORDER.filter(n => chainOf(g, n).points.length > 0);
  const slots: [number, number][][] = [];
  if (g.origin) slots.push([[g.origin.lat, g.origin.lon]]);
  for (const n of present) slots.push(chainOf(g, n).points.map(p => [p.lat, p.lon] as [number, number]));
  if (g.destination) slots.push([[g.destination.lat, g.destination.lon]]);

  const withAnchor = anchor ? [[anchor], ...slots] : slots;
  const unwrapped = unwrapLonChains(withAnchor);
  const laid = anchor ? unwrapped.slice(1) : unwrapped;

  let i = 0;
  const originPos = g.origin ? laid[i++] : null;
  const chains: DrawnChain[] = present.map(name => {
    const chain = chainOf(g, name);
    const points = laid[i++];
    const path: [number, number][] = [];
    points.forEach((p, idx) => {
      if (idx > 0) {
        for (const arc of chain.arcs) {
          if (arc.toIndex === idx && arc.fromIndex === idx - 1) {
            path.push(...arcPositions(points[idx - 1], p, [arc.centerLat, arc.centerLon], arc.turn));
          }
        }
      }
      path.push(p);
    });
    return { name, chain, points, path };
  });
  const destPos = g.destination ? laid[i++] : null;

  // Neighbours in flight order, skipping an empty procedure chain but never an
  // empty enroute chain: without the expanded route there is nothing sound to
  // join across.
  const enrouteDrawn = present.includes('enroute');
  const ends: { name: string; first: [number, number]; last: [number, number] }[] = [];
  if (originPos) ends.push({ name: 'origin', first: originPos[0], last: originPos[0] });
  for (const c of chains) ends.push({ name: c.name, first: c.points[0], last: c.points[c.points.length - 1] });
  if (destPos) ends.push({ name: 'destination', first: destPos[0], last: destPos[0] });

  const connectors: [number, number][][] = [];
  for (let k = 0; k + 1 < ends.length; k++) {
    const a = ends[k];
    const b = ends[k + 1];
    if (!enrouteDrawn && isBeforeEnroute(a.name) !== isBeforeEnroute(b.name)) continue;
    if (Math.abs(a.last[0] - b.first[0]) < 1e-7 && Math.abs(a.last[1] - b.first[1]) < 1e-7) continue;
    connectors.push([a.last, b.first]);
  }
  return { chains, connectors, replacesPlanned: enrouteDrawn };
}

function isBeforeEnroute(name: string): boolean {
  return name === 'origin' || name === 'sid';
}

function syntheticLabel(name: ChainName, chain: GeometryChain): string {
  const pts = chain.points;
  const nm =
    pts.length >= 2 ? formatDistance(nmBetween([pts[0].lat, pts[0].lon], [pts[pts.length - 1].lat, pts[pts.length - 1].lon])) : '—';
  return name === 'approach'
    ? `Computed straight-in — ${chain.source ?? ''} · ${nm} nm final`
    : `Computed departure — ${chain.source ?? ''} · ${nm} nm`;
}

interface LayerProps {
  legId: number;
  legSeq: number;
  geometry: RouteGeometryResponse;
  /** The planned route's own label, shown on the route and its joins. */
  label: string;
  note: string | null;
  anchor?: [number, number] | null;
}

/**
 * Draws the expanded planned route for one leg. Mounted only for a
 * non-empty answer; while `replacesPlanned` the caller leaves the plain
 * planned polyline out.
 */
export function RouteGeometryLayer({ legId, legSeq, geometry, label, note, anchor }: LayerProps) {
  const anchorLat = anchor?.[0];
  const anchorLon = anchor?.[1];
  const paths = useMemo(
    () => buildGeometryPaths(geometry, anchorLat === undefined || anchorLon === undefined ? null : [anchorLat, anchorLon]),
    [geometry, anchorLat, anchorLon]
  );

  return (
    <Fragment>
      {/* Joins first: where a join retraces a chain, the chain's own tooltip must win the hover. */}
      {paths.connectors.map((positions, idx) => (
        <Polyline
          key={`${legId}-join-${idx}`}
          positions={positions}
          pathOptions={{ color: PLANNED_ROUTE_COLOR, weight: 2, opacity: 0.6, dashArray: '6 6' }}
        >
          <Tooltip sticky>
            {label}
            {note && <><br />{note}</>}
          </Tooltip>
        </Polyline>
      ))}
      {paths.chains.map(c => {
        const synthetic = c.chain.synthetic;
        const dash = synthetic ? '4 6' : c.name === 'enroute' ? '6 6' : undefined;
        const title = synthetic ? syntheticLabel(c.name, c.chain) : c.name === 'enroute' ? label : `${CHAIN_LABEL[c.name]} ${c.chain.source ?? ''}`.trim();
        return (
          <Fragment key={`${legId}-${c.name}`}>
            <Polyline
              positions={c.path}
              pathOptions={{ color: PLANNED_ROUTE_COLOR, weight: 2, opacity: 0.9, dashArray: dash }}
            >
              <Tooltip sticky>
                {title}
                {synthetic && <><br />{COMPUTED_GEOMETRY_NOTE}</>}
                {c.name === 'enroute' && note && <><br />{note}</>}
              </Tooltip>
            </Polyline>
            {synthetic ? (
              <Marker key={`${legId}-${c.name}-label`} position={c.points[0]} icon={mkComputedIcon()}>
                <Tooltip direction="top" offset={[0, -6]}>
                  {c.name === 'approach' ? 'computed straight-in' : 'computed departure'}
                </Tooltip>
              </Marker>
            ) : (
              c.chain.points.map((p, idx) =>
                p.ident ? (
                  <Marker key={`${legId}-${c.name}-${idx}`} position={c.points[idx]} icon={mkWaypointIcon()}>
                    <Tooltip>{`Leg ${legSeq} · ${p.ident}`}</Tooltip>
                  </Marker>
                ) : null
              )
            )}
          </Fragment>
        );
      })}
    </Fragment>
  );
}

const NEEDS_AIRPORT_DETAIL = new Set(['custom procedure, no runway', 'airport detail not fetched']);

export interface DetailTarget {
  ident: string;
  why: string;
}

/**
 * Airports whose detail would let an unresolved procedure be drawn. An
 * endpoint that is not an airport (a plan-snippet waypoint) is never offered:
 * there is nothing to fetch.
 */
export function detailTargets(g: RouteGeometryResponse | null | undefined): DetailTarget[] {
  if (!g) return [];
  const out = new Map<string, DetailTarget>();
  for (const u of g.unresolved) {
    if (!NEEDS_AIRPORT_DETAIL.has(u.reason)) continue;
    const end = u.kind === 'sid' ? g.origin : u.kind === 'star' || u.kind === 'approach' ? g.destination : null;
    if (!end || end.isAirport !== true || !AIRPORT_IDENT.test(end.ident)) continue;
    if (!out.has(end.ident)) out.set(end.ident, { ident: end.ident, why: 'runway and procedure detail not fetched' });
  }
  return [...out.values()];
}

type RequestState =
  | { phase: 'pending' }
  | { phase: 'done'; state: NavdataRequestResponse['state'] }
  | { phase: 'error'; message: string };

function requestLabel(s: RequestState): string {
  if (s.phase === 'pending') return 'Requesting…';
  if (s.phase === 'error') return `Request failed: ${s.message}`;
  if (s.state === 'queued') return 'Queued';
  if (s.state === 'already-present') return 'Already fetched';
  return 'Not available';
}

/**
 * Mounts inside a MapContainer. Renders nothing when there is no airport to
 * fetch, and nothing while the imported Little Navmap database is the source:
 * it already carries every airport's detail. The status is only polled while
 * there is something to offer.
 */
export function FetchDetailPrompt({ targets }: { targets: DetailTarget[] }) {
  const status = useNavdataStatus(targets.length > 0);
  const ref = useRef<HTMLDivElement>(null);
  const [requests, setRequests] = useState<Record<string, RequestState>>({});

  useEffect(() => {
    if (ref.current) {
      L.DomEvent.disableClickPropagation(ref.current);
      L.DomEvent.disableScrollPropagation(ref.current);
    }
  });

  if (targets.length === 0 || status?.source === 'lnm') return null;

  async function fetchDetail(ident: string) {
    setRequests(r => ({ ...r, [ident]: { phase: 'pending' } }));
    try {
      const res = await requestNavdata({ kind: 'A', ident });
      setRequests(r => ({ ...r, [ident]: { phase: 'done', state: res.state } }));
    } catch (err) {
      setRequests(r => ({ ...r, [ident]: { phase: 'error', message: err instanceof Error ? err.message : 'failed' } }));
    }
  }

  return (
    <div ref={ref} className="navdata-panel navdata-route-detail">
      <Layer>
        <Tile className="navdata-panel__tile">
          {targets.map(t => {
            const req = requests[t.ident];
            return (
              <div key={t.ident} className="navdata-panel__row navdata-panel__row--wrap">
                <span className="navdata-panel__ident" id={`navdata-route-${t.ident}`}>{t.ident}</span>
                <span className="navdata-panel__muted">{t.why}</span>
                {req && (req.phase === 'pending' ? (
                  <InlineLoading description={requestLabel(req)} />
                ) : (
                  <span className={req.phase === 'error' ? 'navdata-panel__error' : 'navdata-panel__muted'}>{requestLabel(req)}</span>
                ))}
                {(!req || req.phase === 'error') && (
                  <Button
                    kind="ghost"
                    size="sm"
                    aria-describedby={`navdata-route-${t.ident}`}
                    onClick={() => fetchDetail(t.ident)}
                  >
                    Fetch detail
                  </Button>
                )}
              </div>
            );
          })}
        </Tile>
      </Layer>
    </div>
  );
}

export interface RouteGeometryState {
  geometries: Record<number, RouteGeometryResponse>;
  loading: boolean;
}

const NO_GEOMETRIES: Record<number, RouteGeometryResponse> = {};

/**
 * Route geometry for each planned leg, once the server reports a navdata
 * replica. A failed fetch leaves that leg without geometry — the map then
 * draws exactly what it drew before this existed — and never surfaces an error.
 */
export function useRouteGeometry(legIds: number[]): RouteGeometryState {
  const status = useNavdataStatus();
  const present = status?.present === true;
  // Differs between the two replicas and changes with every new simulator
  // snapshot, so a switch of source made elsewhere redraws the geometry.
  const snapshotId = status?.snapshotId ?? null;
  const key = legIds.join(',');
  const [state, setState] = useState<RouteGeometryState>({ geometries: NO_GEOMETRIES, loading: false });

  useEffect(() => {
    if (!present || key === '') {
      setState(s => (s.loading || s.geometries !== NO_GEOMETRIES ? { geometries: NO_GEOMETRIES, loading: false } : s));
      return;
    }
    const ids = key.split(',').map(Number);
    const controller = new AbortController();
    let cancelled = false;
    setState(s => ({ ...s, loading: true }));
    Promise.all(
      ids.map(id =>
        fetchRouteGeometry(id, controller.signal).then(
          g => [id, g] as const,
          () => null
        )
      )
    ).then(results => {
      if (cancelled) return;
      const geometries: Record<number, RouteGeometryResponse> = {};
      for (const r of results) if (r) geometries[r[0]] = r[1];
      setState({ geometries, loading: false });
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [present, key, snapshotId]);

  return state;
}
