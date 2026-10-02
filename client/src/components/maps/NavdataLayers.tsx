import { Fragment, useMemo, type ReactNode } from 'react';
import { CircleMarker, Marker, Polyline, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { unwrapLonChain } from '../../utils/geo';
import type { AirportTier, FeatureAirport, FeaturesResponse } from '../../types';
import { navdataPalette as P } from './navdata/navdataPalette';
import { navaidFrequencyLabel, navaidGlyph, navaidRoseEligible } from './navdata/navaidGlyph';
import { NAVAID_ICON_PX, ROSE_LIMIT, navaidIconHtml } from './navdata/navaidIcon';

export const NAVDATA_PANE = 'navdata';
export const NAVDATA_MARKER_PANE = 'navdata-markers';

const AIRWAY_COLOR = P.airway;
const NAVAID_COLOR = P.navaid;
// Same magenta as an uncontrolled airport's symbol — both are the sectional-chart
// "magenta" convention (uncontrolled airfield / enroute waypoint), so the two
// features read as one coherent palette rather than two arbitrary purples.
const WAYPOINT_COLOR = P.waypoint;
const RUNWAY_COLOR = P.runway;
const LABEL_LIMIT = 150;

// A canvas-rendered Polyline ignores its `pane` option and draws into its
// renderer's pane, so with the maps' preferCanvas navdata paths would land in
// the same pane as the flown track and paint over it. Giving them a canvas
// renderer of their own, bound to the navdata pane, is what keeps them below.
// The renderer has to be a direct prop: react-leaflet only applies pathOptions
// through setStyle after the layer has already chosen its renderer.
const renderers = new WeakMap<L.Map, L.Canvas>();

function navdataRenderer(map: L.Map): L.Canvas {
  let r = renderers.get(map);
  if (!r) {
    r = L.canvas({ pane: NAVDATA_PANE });
    renderers.set(map, r);
  }
  return r;
}

/**
 * Creates the two navdata panes (below the overlay pane, so below flown tracks
 * and planned routes) before any child that draws into them mounts.
 */
export function NavdataPanes({ children }: { children?: ReactNode }) {
  const map = useMap();
  useMemo(() => {
    if (!map.getPane(NAVDATA_PANE)) map.createPane(NAVDATA_PANE).style.zIndex = '350';
    if (!map.getPane(NAVDATA_MARKER_PANE)) map.createPane(NAVDATA_MARKER_PANE).style.zIndex = '360';
  }, [map]);
  return <>{children}</>;
}

export interface NavdataVisibility {
  airports: boolean;
  navaids: boolean;
  waypoints: boolean;
  airways: boolean;
  runways: boolean;
}

/** One point placed in the frame of `anchor`, so it lands beside the view rather than a world-copy away. */
export function unwrapPoint(anchor: [number, number], lat: number, lon: number): [number, number] {
  return unwrapLonChain([anchor, [lat, lon]])[1];
}

/** A dateline-crossing leg comes back with its far end past ±180 instead of a straight line across the map. */
export function unwrapAirwayLeg(
  anchor: [number, number],
  from: [number, number],
  to: [number, number]
): [[number, number], [number, number]] {
  const chain = unwrapLonChain([anchor, from, to]);
  return [chain[1], chain[2]];
}

const M_PER_DEG_LAT = 111_320;

function runwayEnds(
  centre: [number, number],
  headingDeg: number,
  lengthM: number
): [[number, number], [number, number]] {
  const half = lengthM / 2;
  const h = (headingDeg * Math.PI) / 180;
  const dLat = (Math.cos(h) * half) / M_PER_DEG_LAT;
  const dLon = (Math.sin(h) * half) / (M_PER_DEG_LAT * Math.max(0.05, Math.cos((centre[0] * Math.PI) / 180)));
  return [
    [centre[0] - dLat, centre[1] - dLon],
    [centre[0] + dLat, centre[1] + dLon],
  ];
}

/**
 * An enroute waypoint: a small hollow (stroke-only) triangle, apex up, instead
 * of a filled dot — the sectional-chart symbol for a plain named fix,
 * distinct from the navaid symbols. The label text has a dark halo; on the
 * inverted (dark) tiles the light purple reads against it.
 */
function waypointIcon(text: string) {
  return L.divIcon({
    className: '',
    iconAnchor: [5, 4],
    html:
      `<div style="display:flex;align-items:center;gap:3px;white-space:nowrap;pointer-events:none">` +
      `<svg width="10" height="9" viewBox="0 0 10 9" style="flex-shrink:0">` +
      `<polygon points="5,0 10,9 0,9" fill="none" stroke="${WAYPOINT_COLOR}" stroke-width="1.2"/></svg>` +
      `<span style="font:600 10px system-ui;color:${WAYPOINT_COLOR};text-shadow:0 0 3px ${P.halo},0 0 3px ${P.halo}">${text}</span></div>`,
  });
}

const mod360 = (deg: number) => ((deg % 360) + 360) % 360;

/**
 * A runway-end number, drawn bold and upright to the pilot who'd be landing on
 * that end — rotated to the end's own approach heading, dark on the light runway strip so it
 * reads against the pavement rather than beside a dot marker like the other
 * navdata labels.
 *
 * The anchor is the icon's own (0,0), never a guessed pixel offset: a fixed
 * `iconAnchor` assumes a fixed rendered box size, but the label's box varies
 * with its text ("14" vs "32R") and CSS `rotate` alone pivots around the
 * box's own center — whichever of those two centers doesn't match the
 * anchor drags the label off the runway centerline once rotated, in a
 * direction that flips between the two ends (they rotate ~180° apart),
 * which is exactly the mirrored left/right drift this fixes. `translate(-50%,-50%)`
 * (evaluated, per CSS, against the label's own shrink-to-fit box before the
 * later `rotate` in the same list is applied) recenters the box on the
 * anchor first, so `rotate` then pivots around that same point regardless of
 * text length or angle.
 */
function runwayLabelIcon(text: string, rotateDeg: number) {
  return L.divIcon({
    className: '',
    iconSize: [0, 0],
    iconAnchor: [0, 0],
    html:
      `<div style="display:inline-block;transform:translate(-50%,-50%) rotate(${mod360(rotateDeg)}deg);` +
      `white-space:nowrap;pointer-events:none;font:700 13px system-ui;color:${P.runwayLabel};` +
      `text-shadow:0 0 3px ${P.runway},0 0 3px ${P.runway},0 0 2px ${P.runway},0 0 2px ${P.runway}">${text}</div>`,
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

/** What the airport symbol claims, one property per knowledge axis.
 *  Exported so a test can assert the claim without parsing inline CSS. */
export interface AirportGlyph {
  /** 'disc' = the longest-runway length is known and sized it.
   *  'diamond' = length unknown; the symbol makes no size claim. */
  shape: 'disc' | 'diamond';
  /** Outer box of the symbol in px. */
  sizePx: 8 | 9 | 13 | 18;
  /** Tower-status color (blue = towered, purple = untowered, gray = unknown).
   *  null only on the diamond, which makes no tower claim at all. */
  color: string | null;
  /** Surface claim, read as fill treatment: 'hollow' = paved (open circle),
   *  'filled' = soft or water, 'faded' = surface unknown but size known
   *  (reduced-opacity fill), 'none' = diamond, no surface claim. */
  fill: 'hollow' | 'filled' | 'faded' | 'none';
  /** Longest runway's heading, already folded mod 180 (a line has no
   *  direction). null = not known, or the diamond — no line is drawn. */
  headingDeg: number | null;
  /** Left offset of the ident label from the airport position, px. */
  labelLeftPx: 11 | 12 | 14 | 16;
}

const AIRPORT_TIER_LARGE_M = 2500;
const AIRPORT_TIER_MEDIUM_M = 1200;

const AIRPORT_COLOR_TOWERED = P.airportTowered;
const AIRPORT_COLOR_UNTOWERED = P.airportUntowered;
const AIRPORT_COLOR_TOWER_UNKNOWN = P.airportTowerUnknown; // detail known, no tower fact either way
const AIRPORT_HOLLOW_CENTRE = P.airportHollowCentre;       // centre of an open (paved) circle
const AIRPORT_UNKNOWN_STROKE = P.airportUnknownStroke;     // the diamond's outline
const AIRPORT_HALO = P.airportHalo;

const AIRPORT_TIER = {
  18: { label: 16 },
  13: { label: 14 },
  9: { label: 12 },
  8: { label: 11 },
} as const;

const mod180 = (deg: number) => ((deg % 180) + 180) % 180;

/** The whole decision, in one pure function. No other rule sets these. */
export function airportGlyph(a: FeatureAirport): AirportGlyph {
  const sizePx =
    a.longestRunwayM === null ? 8
      : a.longestRunwayM >= AIRPORT_TIER_LARGE_M ? 18
        : a.longestRunwayM >= AIRPORT_TIER_MEDIUM_M ? 13
          : 9;
  const shape = a.longestRunwayM === null ? 'diamond' : 'disc';
  const color: AirportGlyph['color'] =
    shape === 'diamond' ? null
      : a.towered === true ? AIRPORT_COLOR_TOWERED
        : a.towered === false ? AIRPORT_COLOR_UNTOWERED
          : AIRPORT_COLOR_TOWER_UNKNOWN;
  const fill: AirportGlyph['fill'] =
    shape === 'diamond' ? 'none'
      : a.surface === 'paved' ? 'hollow'
        : a.surface === 'soft' || a.surface === 'water' ? 'filled'
          : 'faded';
  const headingDeg = shape === 'diamond' || a.longestRunwayHeadingDeg === null
    ? null
    : mod180(a.longestRunwayHeadingDeg);
  return { shape, sizePx, color, fill, headingDeg, labelLeftPx: AIRPORT_TIER[sizePx].label };
}

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** The disc's own border+background, given its tower color and surface fill. */
function airportDiscStyle(color: string, fill: AirportGlyph['fill']): string {
  switch (fill) {
    case 'hollow': return `background:${AIRPORT_HOLLOW_CENTRE};border:2px solid ${color}`;
    case 'filled': return `background:${color};border:1px solid ${color}`;
    default: return `background:${withAlpha(color, 0.4)};border:1px solid ${color}`; // 'faded'
  }
}

/** The short runway-direction tick, through the icon's own (0,0). A line's
 *  width is fixed up front, so centering it on the anchor is just `left:
 *  -half; width: 2*half` — the span is already centered before `rotate`
 *  applies, unlike `runwayLabelIcon()`'s variable-width text, which needs a
 *  `translate(-50%,-50%)` because its box size isn't known until it renders.
 *
 *  The span itself is a horizontal bar at rest — its long axis lies along
 *  screen +x, bearing 090, not bearing 0. `runwayLabelIcon()`'s `rotate(headingDeg)`
 *  is correct as-is because text's "up" axis (not its long/reading axis)
 *  carries the bearing, and that axis already points at bearing 0 by
 *  default — a different piece of geometry from a bar's long axis, so it
 *  needs a different offset: `headingDeg - 90` turns the bar's own
 *  bearing-090 rest axis to point at `headingDeg`. */
function airportDirectionLineHtml(g: AirportGlyph): string {
  if (g.headingDeg === null || g.color === null) return '';
  const len = g.sizePx * 1.75; // 1.5-2x the disc's diameter
  const half = len / 2;
  const thickness = 2;
  return (
    `<span data-direction-line="" data-rotate-deg="${g.headingDeg}" style="position:absolute;` +
    `left:${-half}px;top:${-thickness / 2}px;width:${len}px;height:${thickness}px;` +
    `background:${g.color};transform:rotate(${g.headingDeg - 90}deg);pointer-events:none"></span>`
  );
}

/** Frozen markup for one airport glyph, `ident` already escaped by the caller.
 *  `showLabel` omits the ident `<span>` entirely rather than hiding it, so a
 *  dense view draws fewer DOM nodes, not just fewer visible ones. */
function airportIconHtml(g: AirportGlyph, ident: string, showLabel: boolean): string {
  const half = g.sizePx / 2;
  const body = g.shape === 'disc' && g.color !== null
    ? `border-radius:50%;${airportDiscStyle(g.color, g.fill)};box-shadow:0 0 0 1.5px ${AIRPORT_HALO}`
    : `transform:rotate(45deg);background:transparent;border:1.5px solid ${AIRPORT_UNKNOWN_STROKE};filter:drop-shadow(0 0 1.5px ${P.halo})`;
  const line = airportDirectionLineHtml(g);
  const label = showLabel
    ? `<span style="position:absolute;left:${g.labelLeftPx}px;top:-7px;line-height:14px;font:600 10px system-ui;` +
      `color:${P.label};text-shadow:0 0 3px ${P.halo},0 0 3px ${P.halo}">${ident}</span>`
    : '';
  return (
    `<div data-glyph="${g.shape}" data-size="${g.sizePx}" data-color="${g.color ?? 'none'}" data-fill="${g.fill}" ` +
    `style="position:relative;width:0;height:0;pointer-events:none">${line}` +
    `<span style="position:absolute;left:${-half}px;top:${-half}px;width:${g.sizePx}px;height:${g.sizePx}px;` +
    `box-sizing:border-box;${body}"></span>${label}</div>`
  );
}

/**
 * The airport marker icon: a size/shape claim (longestRunwayM), a color claim
 * (towered), a fill claim (surface) and a direction-line claim
 * (longestRunwayHeadingDeg), each with its own distinct "unknown" rendering
 * so a missing fact can never be read as a known one. Self-positioning like
 * runwayLabelIcon(): iconSize/iconAnchor both [0,0], every child placed from
 * the airport's own point, so no box-model change can drift it off the
 * airport.
 *
 * `showLabel` is required, not defaulted, so every call site states whether
 * this airport's ident should draw — density-based suppression above some
 * count is a caller decision, not something this glyph guesses on its own.
 */
export function airportIcon(a: FeatureAirport, showLabel: boolean): L.DivIcon {
  const g = airportGlyph(a);
  return L.divIcon({
    className: '',
    iconSize: [0, 0],
    iconAnchor: [0, 0],
    html: airportIconHtml(g, escapeHtml(a.ident), showLabel),
  });
}

/** A candidate airport ident placed on screen, ready for the collision pass.
 *  `priorityRank` is the caller's flattened ordering (tier, then longest
 *  runway, then ident — see `compareAirportLabelPriority`): lower decides,
 *  and draws, first. */
export interface LabelCandidate {
  key: string;
  x: number;
  y: number;
  priorityRank: number;
}

/** Roughly an icon plus a short 3-4 letter ident at this file's label font
 *  sizes/offsets — the screen distance inside which two airport labels are
 *  judged to overlap. */
export const AIRPORT_LABEL_COLLISION_PX = 42;

/**
 * Greedy priority-ordered label suppression: a candidate gets a label iff no
 * higher-priority (already-labelled) candidate sits within `collisionPx` of
 * it. Grid-bucketed (cell size = `collisionPx`) so only the ~9 neighbouring
 * cells are ever checked per candidate, keeping the pass near-linear instead
 * of the O(n^2) an all-pairs check would be at a full-viewport candidate
 * count.
 */
export function chooseLabelledCandidates(
  candidates: readonly LabelCandidate[],
  collisionPx: number
): Set<string> {
  const ordered = [...candidates].sort((a, b) => a.priorityRank - b.priorityRank);
  // Only labelled candidates occupy the grid: a suppressed one has no drawn
  // text to collide with, so it can never block a later candidate either.
  const grid = new Map<string, LabelCandidate[]>();
  const labelled = new Set<string>();
  const cellOf = (v: number) => Math.floor(v / collisionPx);
  const cellKey = (cx: number, cy: number) => `${cx}:${cy}`;

  for (const c of ordered) {
    const cx = cellOf(c.x);
    const cy = cellOf(c.y);
    let collides = false;
    for (let dx = -1; dx <= 1 && !collides; dx++) {
      for (let dy = -1; dy <= 1 && !collides; dy++) {
        const bucket = grid.get(cellKey(cx + dx, cy + dy));
        if (!bucket) continue;
        for (const other of bucket) {
          const ddx = c.x - other.x;
          const ddy = c.y - other.y;
          if (Math.sqrt(ddx * ddx + ddy * ddy) < collisionPx) {
            collides = true;
            break;
          }
        }
      }
    }
    if (!collides) {
      labelled.add(c.key);
      const key = cellKey(cx, cy);
      const bucket = grid.get(key);
      if (bucket) bucket.push(c);
      else grid.set(key, [c]);
    }
  }

  return labelled;
}

// Same order as the server's tier codes: a lower number is the more
// significant airport. An airport with no tier at all (neither the sim nor
// OurAirports could classify it) ranks below even 'other' — 'other' is still
// a positive classification, no tier is none.
const AIRPORT_LABEL_TIER_RANK: Record<AirportTier, number> = {
  large: 0, medium: 1, small: 2, unknown: 3, other: 4,
};
const AIRPORT_LABEL_TIER_RANK_NONE = 5;

/**
 * Label-priority order for one pair of airports: tier first, then longest
 * runway descending within a tier (a known length always beats an unknown
 * one — `null` never wins a tie against a real number), then ident ascending
 * so the same view chooses the same labels on every re-render. Negative
 * means `a` decides, and draws, before `b`.
 */
export function compareAirportLabelPriority(a: FeatureAirport, b: FeatureAirport): number {
  const tierRank = (t: AirportTier | null) => (t === null ? AIRPORT_LABEL_TIER_RANK_NONE : AIRPORT_LABEL_TIER_RANK[t]);
  const tierDiff = tierRank(a.tier) - tierRank(b.tier);
  if (tierDiff !== 0) return tierDiff;
  if (a.longestRunwayM !== b.longestRunwayM) {
    if (a.longestRunwayM === null) return 1;
    if (b.longestRunwayM === null) return -1;
    return b.longestRunwayM - a.longestRunwayM;
  }
  return a.ident < b.ident ? -1 : a.ident > b.ident ? 1 : 0;
}

interface LayersProps {
  data: FeaturesResponse;
  anchor: [number, number];
  visible: NavdataVisibility;
}

/** Draws one features response. Every position is unwrapped into the frame of `anchor` first. */
export function NavdataLayers({ data, anchor, visible }: LayersProps) {
  const map = useMap();
  const renderer = navdataRenderer(map);
  const labelled = data.waypoints.length + data.navaids.length <= LABEL_LIMIT;
  const roseAllowed = data.navaids.filter(navaidRoseEligible).length <= ROSE_LIMIT;

  const labelledAirportIdents = useMemo(() => {
    if (!visible.airports || data.airports.length === 0) return new Set<string>();
    const ordered = [...data.airports].sort(compareAirportLabelPriority);
    const candidates: LabelCandidate[] = ordered.map((a, priorityRank) => {
      const [lat, lon] = unwrapPoint(anchor, a.lat, a.lon);
      const { x, y } = map.latLngToContainerPoint([lat, lon]);
      return { key: a.ident, x, y, priorityRank };
    });
    return chooseLabelledCandidates(candidates, AIRPORT_LABEL_COLLISION_PX);
  }, [data, map, anchor, visible.airports]);

  return (
    <>
      {visible.airways &&
        data.airways.map((leg, i) => {
          const positions = unwrapAirwayLeg(anchor, leg.from, leg.to);
          return (
            <Polyline
              renderer={renderer}
              key={`${leg.airway}-${leg.fromIdent}-${leg.toIdent}-${i}`}
              positions={positions}
              pathOptions={{ color: AIRWAY_COLOR, weight: 1.2, opacity: 0.8}}
            >
              <Tooltip sticky>{`${leg.airway}: ${leg.fromIdent} → ${leg.toIdent}`}</Tooltip>
            </Polyline>
          );
        })}
      {visible.runways &&
        data.runways.map((r, i) => {
          if (r.headingDeg === null || r.lengthM === null) return null;
          const centre = unwrapPoint(anchor, r.lat, r.lon);
          const ends = runwayEnds(centre, r.headingDeg, r.lengthM);
          const key = `${r.airport}-${r.designation}-${i}`;
          return (
            <Fragment key={key}>
              <Polyline
                renderer={renderer}
                positions={ends}
                pathOptions={{ color: RUNWAY_COLOR, weight: 3, opacity: 0.9}}
              >
                <Tooltip sticky>{`${r.airport} ${r.designation}`}</Tooltip>
              </Polyline>
              {r.designation !== '' && (
                <Marker
                  position={ends[0]}
                  icon={runwayLabelIcon(escapeHtml(r.designation), r.headingDeg)}
                  pane={NAVDATA_MARKER_PANE}
                  interactive={false}
                />
              )}
              {r.secondaryDesignation !== '' && (
                <Marker
                  position={ends[1]}
                  icon={runwayLabelIcon(escapeHtml(r.secondaryDesignation), r.headingDeg + 180)}
                  pane={NAVDATA_MARKER_PANE}
                  interactive={false}
                />
              )}
            </Fragment>
          );
        })}
      {visible.waypoints &&
        data.waypoints.map(w => {
          const pos = unwrapPoint(anchor, w.lat, w.lon);
          return labelled ? (
            <Marker key={w.key} position={pos} icon={waypointIcon(escapeHtml(w.ident))} pane={NAVDATA_MARKER_PANE} interactive={false} />
          ) : (
            <CircleMarker
              renderer={renderer}
              key={w.key}
              center={pos}
              radius={2.5}
              pathOptions={{ color: WAYPOINT_COLOR, weight: 1, fillOpacity: 0.8}}
            />
          );
        })}
      {visible.navaids &&
        data.navaids.map(n => {
          const pos = unwrapPoint(anchor, n.lat, n.lon);
          const key = `${n.kind}-${n.ident}-${n.region}-${n.lat}-${n.lon}`;
          return labelled ? (
            <Marker
              key={key}
              position={pos}
              icon={L.divIcon({
                className: '',
                iconSize: [NAVAID_ICON_PX, NAVAID_ICON_PX],
                iconAnchor: [NAVAID_ICON_PX / 2, NAVAID_ICON_PX / 2],
                html: navaidIconHtml(navaidGlyph(n, roseAllowed), escapeHtml(n.ident), navaidFrequencyLabel(n)),
              })}
              pane={NAVDATA_MARKER_PANE}
              interactive={false}
            />
          ) : (
            <CircleMarker
              renderer={renderer}
              key={key}
              center={pos}
              radius={3.5}
              pathOptions={{ color: NAVAID_COLOR, weight: 1.5, fillOpacity: 0.7}}
            />
          );
        })}
      {visible.airports &&
        data.airports.map(a => (
          <Marker
            key={a.ident}
            position={unwrapPoint(anchor, a.lat, a.lon)}
            icon={airportIcon(a, labelledAirportIdents.has(a.ident))}
            pane={NAVDATA_MARKER_PANE}
            interactive={false}
          />
        ))}
    </>
  );
}
