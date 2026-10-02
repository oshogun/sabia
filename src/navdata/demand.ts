// ── What the sidecar should fetch next ────────────────────────────────────────
//
// There is no queue table in the replica: the demand response is the current
// need, recomputed on every poll. A facility is wanted when a planned leg the
// server would draw refers to it, the replica holds no usable row for it, and
// nothing has recorded it as missing from the simulator.
//
// "A planned leg the server would draw" is not "a leg not yet flown": every
// planned leg on this machine is already flown, and a not-yet-flown rule would
// make demand permanently empty. It is, in order, the manual requests, then
// every leg of the active trip whatever its status, then the legs still marked
// planned.

import type Database from 'better-sqlite3';
import { getDb } from '../db/connection';
import {
  deleteNavdataRequestById,
  listNavdataRequests,
  pruneExpiredNavdataRequests,
  type NavdataRequestRow,
} from '../db/navdataRequests';
import { performance } from 'perf_hooks';
import { haversineNm } from '../geo';
import type { PlannedWaypoint } from '../types';
import { getNavDb } from './connection';
import { navdataWriteGeneration } from './store';
import {
  airwayAttempted,
  resolvePlannedKey,
  validCoordinate,
  walkAirway,
  type AirwayReachNode,
  type AirwayWalk,
} from './routeGeometry';
import type { DemandResponse, DemandWaypoint } from './wire';

/** Planned legs looked at per poll, so the scan cost cannot grow without bound. */
export const NAVDATA_DEMAND_LEG_SCAN = 200;
/** Facilities returned per poll. Echoed in the response so the sidecar need not hardcode it. */
export const NAVDATA_DEMAND_CAP = 50;

/** Planned-waypoint types that name a simulator facility. USER never does. */
const WAYPOINT_TYPES_KIND: Readonly<Record<string, WaypointKind>> = { WAYPOINT: 'W', VOR: 'V', NDB: 'N' };
const WAYPOINT_TYPES: ReadonlySet<string> = new Set(Object.keys(WAYPOINT_TYPES_KIND));

interface DemandLeg {
  id: number;
  departure_ident: string;
  departure_is_airport: number;
  destination_ident: string;
  destination_is_airport: number;
  departure_lat: number;
  departure_lon: number;
  sid_name: string | null;
  sid_transition: string | null;
  star_name: string | null;
  star_transition: string | null;
}

interface PlannedWaypointRow {
  ident: string;
  region: string | null;
  type: string;
}

type WaypointKind = NonNullable<DemandWaypoint['kind']>;
type Want = { kind: 'A'; ident: string; region: null } | { kind: WaypointKind; ident: string; region: string | null };

const LEG_COLUMNS =
  'pl.id, pl.departure_ident, pl.departure_is_airport, pl.destination_ident, pl.destination_is_airport, ' +
  'pl.departure_lat, pl.departure_lon, pl.sid_name, pl.sid_transition, pl.star_name, pl.star_transition';

const ACTIVE_TRIP_LEGS = `
  SELECT ${LEG_COLUMNS}
  FROM planned_legs pl
  JOIN trips t ON t.id = pl.trip_id AND t.is_active = 1
  ORDER BY pl.seq ASC, pl.id ASC
  LIMIT ?`;

const PLANNED_LEGS = `
  SELECT ${LEG_COLUMNS}
  FROM planned_legs pl
  LEFT JOIN trips t ON t.id = pl.trip_id
  WHERE pl.status = 'planned' AND COALESCE(t.is_active, 0) = 0
  ORDER BY pl.imported_at DESC, pl.id DESC
  LIMIT ?`;

/** Longest skip list accepted per kind, so one request cannot make the exclusion set unbounded. */
export const NAVDATA_DEMAND_SKIP_MAX = 200;

/** Idents the sidecar has parked; excluded from this poll's answer and nothing else. */
export interface DemandSkip {
  airports: ReadonlySet<string>;
  waypoints: ReadonlySet<string>;
}

export class DemandSkipError extends Error {}

const SKIP_IDENT = /^[A-Z0-9]{1,8}$/;

function parseSkipList(name: string, value: unknown): Set<string> {
  const out = new Set<string>();
  if (value === undefined) return out;
  if (typeof value !== 'string') throw new DemandSkipError(`${name} must be a single comma-separated list`);
  for (const part of value.split(',')) {
    const ident = part.trim().toUpperCase();
    if (ident === '') continue;
    if (!SKIP_IDENT.test(ident)) throw new DemandSkipError(`${name} holds an invalid ident (1-8 letters or digits each)`);
    out.add(ident);
    if (out.size > NAVDATA_DEMAND_SKIP_MAX) {
      throw new DemandSkipError(`${name} holds more than ${NAVDATA_DEMAND_SKIP_MAX} idents`);
    }
  }
  return out;
}

/** Reads `skipAirports` / `skipWaypoints` from a query object; throws DemandSkipError when malformed. */
export function parseDemandSkip(query: Record<string, unknown>): DemandSkip {
  return {
    airports: parseSkipList('skipAirports', query.skipAirports),
    waypoints: parseSkipList('skipWaypoints', query.skipWaypoints),
  };
}

const normIdent = (ident: string): string => ident.trim().toUpperCase();

function normRegion(region: string | null | undefined): string | null {
  const r = region == null ? '' : region.trim().toUpperCase();
  return r === '' ? null : r;
}

/**
 * Point lookups that decide whether a facility still needs fetching. Prepared
 * once per poll against one replica handle; the caller must not yield while
 * this object is alive, or a swap could pull the file out from under it.
 */
class Satisfaction {
  private readonly airportDetail;
  private readonly airportAbsent;
  private readonly waypointAny;
  private readonly waypointInRegion;
  private readonly navaidAny;
  private readonly navaidInRegion;
  private readonly absentAny;
  private readonly absentInRegion;
  private readonly absentWaypointInRegion;
  private readonly navaidKindsAt;

  constructor(nav: Database.Database) {
    this.airportDetail = nav.prepare(
      "SELECT 1 FROM nav_airport WHERE ident = ? AND detail_state IN ('detail', 'absent')",
    );
    this.airportAbsent = nav.prepare("SELECT 1 FROM nav_absent WHERE kind = 'A' AND ident = ?");
    // Only a row whose airways were fetched (or checked and found absent) answers a
    // waypoint want. A minimal candidate from an ambiguous ident carries a position
    // and nothing else, so it must not stop the demand for the fix's routes.
    this.waypointAny = nav.prepare(
      "SELECT 1 FROM nav_waypoint WHERE ident = ? AND routes_state IN ('fetched', 'absent')",
    );
    this.waypointInRegion = nav.prepare(
      "SELECT 1 FROM nav_waypoint WHERE ident = ? AND region = ? AND routes_state IN ('fetched', 'absent')",
    );
    // A navaid answers a VOR or NDB want only once its facility detail was read;
    // an index or position-only row does not.
    this.navaidAny = nav.prepare(
      "SELECT 1 FROM nav_navaid WHERE kind = ? AND ident = ? AND detail_state IN ('detail', 'absent')",
    );
    this.navaidInRegion = nav.prepare(
      "SELECT 1 FROM nav_navaid WHERE kind = ? AND ident = ? AND region = ? AND detail_state IN ('detail', 'absent')",
    );
    this.absentAny = nav.prepare('SELECT 1 FROM nav_absent WHERE kind = ? AND ident = ?');
    this.absentInRegion = nav.prepare('SELECT 1 FROM nav_absent WHERE kind = ? AND ident = ? AND region = ?');
    this.absentWaypointInRegion = nav.prepare("SELECT 1 FROM nav_absent WHERE kind = 'W' AND ident = ? AND region = ?");
    // The primary key leads with kind, so an ident and region lookup goes through the ident index.
    this.navaidKindsAt = nav.prepare('SELECT kind FROM nav_navaid WHERE ident = ? AND region = ? ORDER BY kind');
  }

  /** The navaid kinds the replica holds a row for under exactly this ident and region, in ascending kind order ('N' before 'V'). */
  navaidKinds(ident: string, region: string): ('V' | 'N')[] {
    return (this.navaidKindsAt.all(ident, region) as { kind: 'V' | 'N' }[]).map((r) => r.kind);
  }

  /** Whether the navaid of this kind at exactly this ident and region needs no further fetch. */
  navaidAnswered(kind: 'V' | 'N', ident: string, region: string): boolean {
    return Boolean(this.navaidInRegion.get(kind, ident, region) || this.absentInRegion.get(kind, ident, region));
  }

  /**
   * Whether one specific fix, ident and region, needs no further fetch: its
   * routes were fetched or found absent, or it is recorded as missing under the
   * same region (the empty region matches only an empty region).
   */
  waypointAnswered(ident: string, region: string): boolean {
    return Boolean(this.waypointInRegion.get(ident, region) || this.absentWaypointInRegion.get(ident, region));
  }

  holds(want: Want): boolean {
    if (want.kind === 'A') {
      // An index-only row is not enough: the detail is the point, and it is
      // what makes a custom procedure drawable.
      return Boolean(this.airportDetail.get(want.ident) || this.airportAbsent.get(want.ident));
    }
    const { kind, ident, region } = want;
    if (kind === 'W') {
      return region === null
        ? Boolean(this.waypointAny.get(ident) || this.absentAny.get('W', ident))
        : Boolean(this.waypointInRegion.get(ident, region) || this.absentInRegion.get('W', ident, region));
    }
    return region === null
      ? Boolean(this.navaidAny.get(kind, ident) || this.absentAny.get(kind, ident))
      : Boolean(this.navaidInRegion.get(kind, ident, region) || this.absentInRegion.get(kind, ident, region));
  }
}

function legWants(db: Database.Database, leg: DemandLeg): Want[] {
  const wants: Want[] = [];
  if (leg.departure_is_airport) wants.push({ kind: 'A', ident: normIdent(leg.departure_ident), region: null });

  const waypoints = db
    .prepare('SELECT ident, region, type FROM planned_waypoints WHERE planned_leg_id = ? ORDER BY seq ASC')
    .all(leg.id) as PlannedWaypointRow[];
  for (const w of waypoints) {
    const type = (w.type ?? '').trim().toUpperCase();
    if (type === 'AIRPORT') {
      wants.push({ kind: 'A', ident: normIdent(w.ident), region: null });
    } else if (WAYPOINT_TYPES.has(type)) {
      wants.push({ kind: WAYPOINT_TYPES_KIND[type], ident: normIdent(w.ident), region: normRegion(w.region) });
    }
  }

  if (leg.destination_is_airport) wants.push({ kind: 'A', ident: normIdent(leg.destination_ident), region: null });

  const alternates = db
    .prepare('SELECT ident FROM planned_alternates WHERE planned_leg_id = ? ORDER BY seq ASC')
    .all(leg.id) as { ident: string }[];
  // Alternates are airports the aircraft might actually land at.
  for (const a of alternates) wants.push({ kind: 'A', ident: normIdent(a.ident), region: null });

  return wants;
}

/** Frontier nodes asked per side of an airway gap. */
const GAP_NODES_PER_SIDE = 2;

interface PlannedEnd { key: string; lat: number; lon: number }

/**
 * The fixes on `reach` the replica has no answer for, nearest first to the far
 * end of the gap. A leg row does not say what kind of facility an endpoint is,
 * so a node whose ident and region exactly match a navaid row is asked for as
 * that navaid (a waypoint request for a VOR ident answers with whichever
 * region's station the simulator picks) and is judged by the navaid rules. Any
 * other node is a waypoint, and is left out when the same ident and region is
 * already wanted as a navaid in this response.
 */
function frontier(
  reach: readonly AirwayReachNode[],
  farEnd: PlannedEnd,
  satisfaction: Satisfaction,
  navaidWanted: (ident: string, region: string) => boolean,
): Want[] {
  const seen = new Set<string>();
  const open: { node: AirwayReachNode; kind: WaypointKind; dist: number }[] = [];
  for (const node of reach) {
    const region = normRegion(node.region) ?? '';
    const id = `${node.ident}|${region}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const navaids = satisfaction.navaidKinds(node.ident, region);
    let kind: WaypointKind;
    if (navaids.length > 0) {
      const unanswered = navaids.find((k) => !satisfaction.navaidAnswered(k, node.ident, region));
      if (unanswered === undefined) continue;
      kind = unanswered;
    } else {
      if (satisfaction.waypointAnswered(node.ident, region) || navaidWanted(node.ident, region)) continue;
      kind = 'W';
    }
    open.push({ node, kind, dist: haversineNm(farEnd.lat, farEnd.lon, node.lat, node.lon) });
  }
  open.sort((a, b) => a.dist - b.dist || (a.node.key < b.node.key ? -1 : a.node.key > b.node.key ? 1 : 0));
  return open.slice(0, GAP_NODES_PER_SIDE).map(({ node, kind }) => ({
    kind,
    ident: node.ident,
    region: normRegion(node.region),
  }));
}

/** Wall-clock allowance for the whole gap pass of one poll, in milliseconds. */
export const GAP_PASS_BUDGET_MS = 100;

/**
 * What the gap pass remembers between polls, all in memory: where the next
 * poll's pass starts in the scanned legs (so legs behind an expensive one are not
 * starved, and kept across replica changes), and the airway walks and
 * planned-waypoint key lookups already done, dropped whenever the replica changes.
 * Those are pure functions of the replica's rows, so while it is unchanged a
 * plan the airways already connect costs a map lookup per pair.
 */
interface GapState {
  handle: Database.Database | null;
  generation: number;
  updatedAt: number;
  snapshotId: string;
  rev: number;
  /** Survives replica changes; the memo maps do not. */
  offset: number;
  resolved: Map<string, ReturnType<typeof resolvePlannedKey>>;
  walks: Map<string, AirwayWalk>;
}

const freshGapState = (offset = 0): GapState => ({
  handle: null, generation: -1, updatedAt: -1, snapshotId: '', rev: -1, offset, resolved: new Map(), walks: new Map(),
});

let gapState = freshGapState();

/** Entries kept per map, so a long-lived process cannot grow them without bound. */
const GAP_MEMO_MAX = 5000;

/** Forgets everything the gap pass remembers; for tests, which share one module. */
export function resetGapCursor(): void {
  gapState = freshGapState();
}

/**
 * The memo is valid only for the exact replica it was built from: the same
 * open handle (a swapped-in file is a new one), the same header (snapshot,
 * revision, timestamp) and the same count of header writes to that handle,
 * since a batch or a same-epoch snapshot can change rows under an unchanged
 * snapshot id and revision.
 */
function currentGapState(nav: Database.Database): GapState {
  const meta = nav.prepare('SELECT snapshot_id, rev, updated_at FROM nav_meta WHERE id = 1').get() as
    | { snapshot_id: string; rev: number; updated_at: number }
    | undefined;
  const snapshotId = meta?.snapshot_id ?? '';
  const rev = meta?.rev ?? -1;
  const updatedAt = meta?.updated_at ?? -1;
  const generation = navdataWriteGeneration(nav);
  const s = gapState;
  if (s.handle !== nav || s.generation !== generation || s.updatedAt !== updatedAt || s.snapshotId !== snapshotId || s.rev !== rev) {
    gapState = { ...freshGapState(s.offset), handle: nav, generation, updatedAt, snapshotId, rev };
  }
  if (gapState.resolved.size > GAP_MEMO_MAX) gapState.resolved.clear();
  if (gapState.walks.size > GAP_MEMO_MAX) gapState.walks.clear();
  return gapState;
}

/** Everything one poll's gap pass looks up more than once. */
interface GapContext {
  nav: Database.Database;
  satisfaction: Satisfaction;
  waypoints: Database.Statement;
  /** Whether a VOR or NDB with this ident and region (or no region) is already wanted in this response. */
  navaidWanted: (ident: string, region: string) => boolean;
  state: GapState;
  pairs: number;
}

function walkOnce(ctx: GapContext, airway: string, from: string, target?: string): AirwayWalk {
  const id = `${airway}\u0000${from}\u0000${target ?? ''}`;
  let walk = ctx.state.walks.get(id);
  if (!walk) ctx.state.walks.set(id, (walk = walkAirway(ctx.nav, airway, from, target)));
  return walk;
}

function resolveOnce(ctx: GapContext, wp: PlannedWaypoint, near: { lat: number; lon: number }) {
  // The anchor only matters when the plan gave no usable position of its own.
  if (!validCoordinate(wp.lat, wp.lon)) return resolvePlannedKey(ctx.nav, wp, near);
  const id = `${wp.type}\u0000${wp.ident}\u0000${wp.region ?? ''}\u0000${wp.lat}\u0000${wp.lon}`;
  if (!ctx.state.resolved.has(id)) ctx.state.resolved.set(id, resolvePlannedKey(ctx.nav, wp, near));
  return ctx.state.resolved.get(id) ?? null;
}

type GapOutcome = 'done' | 'capped' | 'budget';

/**
 * Fixes whose fetch would close a hole in an airway between two consecutive
 * planned waypoints. The sidecar fetches the fixes a plan names and one hop of
 * their neighbours, so the fixes in the middle of an airway segment are never
 * fetched and route geometry finds no path between the ends. Each poll walks
 * the replica's legs for that airway from one end, stopping the moment the other
 * end is reached; only when it is not reached is the far side walked too, and
 * the fixes at the edge of what is known, nearest the other end, are wanted.
 * `outOfTime` is asked before each pair, `emit` returns false once nothing more
 * can be accepted.
 */
function gapWants(
  ctx: GapContext,
  leg: DemandLeg,
  emit: (want: Want) => boolean,
  outOfTime: () => boolean,
): GapOutcome {
  const waypoints = ctx.waypoints.all(leg.id) as PlannedWaypoint[];
  let near = { lat: leg.departure_lat, lon: leg.departure_lon };
  let prev: PlannedEnd | null = null;
  let prevIsAirport = false;
  let hasPrevious = false;

  for (const wp of waypoints) {
    const found = resolveOnce(ctx, wp, near);
    if (prev && found && prev.key !== found.key && airwayAttempted(leg, wp, prevIsAirport, hasPrevious)) {
      if (outOfTime()) return 'budget';
      ctx.pairs++;
      const airway = wp.airway as string;
      const fromA = walkOnce(ctx, airway, prev.key, found.key);
      if (!fromA.reached) {
        for (const want of frontier(fromA.nodes, found, ctx.satisfaction, ctx.navaidWanted)) if (!emit(want)) return 'capped';
        const fromB = walkOnce(ctx, airway, found.key);
        for (const want of frontier(fromB.nodes, prev, ctx.satisfaction, ctx.navaidWanted)) if (!emit(want)) return 'capped';
      }
    }
    if (validCoordinate(wp.lat, wp.lon)) {
      hasPrevious = true;
      near = { lat: wp.lat, lon: wp.lon };
    }
    prev = found ? { key: found.key, lat: found.lat, lon: found.lon } : null;
    prevIsAirport = wp.type === 'AIRPORT';
  }
  return 'done';
}

function scanLegs(db: Database.Database): DemandLeg[] {
  const active = db.prepare(ACTIVE_TRIP_LEGS).all(NAVDATA_DEMAND_LEG_SCAN) as DemandLeg[];
  const remaining = NAVDATA_DEMAND_LEG_SCAN - active.length;
  if (remaining <= 0) return active;
  const planned = db.prepare(PLANNED_LEGS).all(remaining) as DemandLeg[];
  return active.concat(planned);
}

function wantOfRequest(row: NavdataRequestRow): Want {
  return row.kind === 'A'
    ? { kind: 'A', ident: normIdent(row.ident), region: null }
    : { kind: 'W', ident: normIdent(row.ident), region: normRegion(row.region) };
}

/**
 * The current need. Manual requests come first and are deleted as soon as the
 * replica can answer them — the replica is the only record of what is held, so
 * the request row is an intent and nothing more. Idents in `skip` are left out
 * of the answer without being recorded anywhere.
 */
export function buildDemand(
  now: Date = new Date(),
  skip?: DemandSkip,
  clock: () => number = () => performance.now(),
): DemandResponse {
  pruneExpiredNavdataRequests(now);
  const db = getDb();
  const nav = getNavDb();
  const satisfaction = nav ? new Satisfaction(nav) : null;
  // With no replica everything is wanted, which is what bootstraps the first harvest.
  const holds = (want: Want): boolean => (satisfaction ? satisfaction.holds(want) : false);

  // A skipped ident is dropped before the cap is applied, so the tail of the
  // wanted list is reached and `more` reflects only what can still be asked for.
  const skipped = (want: Want): boolean =>
    skip !== undefined && (want.kind === 'A' ? skip.airports : skip.waypoints).has(want.ident);

  // Wants are collected first and capped after: fixes and airports keep their
  // encounter order and always come ahead of VOR and NDB wants, so a long run of
  // navaids can never push a fix out from under the cap.
  const primary: Want[] = [];
  const navaids: Want[] = [];
  const gaps: Want[] = [];
  const seen = new Set<string>();
  // Regions ('' for none) each collected navaid ident is wanted under.
  const navaidRegions = new Map<string, Set<string>>();

  const collect = (want: Want, into?: Want[]): void => {
    const key = `${want.kind}|${want.ident}|${want.region ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (want.kind === 'V' || want.kind === 'N') {
      const regions = navaidRegions.get(want.ident) ?? new Set<string>();
      regions.add(want.region ?? '');
      navaidRegions.set(want.ident, regions);
    }
    (into ?? (want.kind === 'V' || want.kind === 'N' ? navaids : primary)).push(want);
  };
  // Once the primary group alone overflows the cap nothing further can be emitted.
  const full = (): boolean => primary.length > NAVDATA_DEMAND_CAP;

  for (const request of listNavdataRequests(now)) {
    const want = wantOfRequest(request);
    // The sidecar owns the retry decision, so a parked request is left in place.
    if (skipped(want)) continue;
    if (holds(want)) {
      deleteNavdataRequestById(request.id);
      continue;
    }
    collect(want);
  }

  const legs = scanLegs(db);
  for (const leg of legs) {
    if (full()) break;
    for (const want of legWants(db, leg)) {
      if (skipped(want) || holds(want)) continue;
      collect(want);
      if (full()) break;
    }
  }

  // Airway gap fixes come after every fix the plans name themselves and before
  // the navaids (a gap fix that is a navaid joins them); they are only worth computing while the cap has room for them.
  if (nav && satisfaction && !full()) {
    const room = (): boolean => primary.length + gaps.length <= NAVDATA_DEMAND_CAP;
    const ctx: GapContext = {
      nav,
      satisfaction,
      waypoints: db.prepare(
        'SELECT id, seq, ident, region, type, airway, lat, lon FROM planned_waypoints WHERE planned_leg_id = ? ORDER BY seq ASC',
      ),
      navaidWanted: (ident, region) => {
        const regions = navaidRegions.get(ident);
        return regions !== undefined && (regions.has('') || regions.has(region));
      },
      state: currentGapState(nav),
      pairs: 0,
    };
    const startedAt = clock();
    let pairsDone = false;
    // The first pair of a pass is always looked at, so a slow pair cannot stop the pass from moving on.
    const outOfTime = (): boolean => {
      if (!pairsDone) {
        pairsDone = true;
        return false;
      }
      return clock() - startedAt > GAP_PASS_BUDGET_MS;
    };
    const first = legs.length === 0 ? 0 : ctx.state.offset % legs.length;
    let nextOffset = 0;
    for (let n = 0; n < legs.length; n++) {
      if (!room()) { nextOffset = ctx.state.offset; break; }
      const index = (first + n) % legs.length;
      const pairsBefore = ctx.pairs;
      const outcome = gapWants(ctx, legs[index], (want) => {
        if (!skipped(want) && !holds(want)) collect(want, want.kind === 'W' ? gaps : undefined);
        return room();
      }, outOfTime);
      if (outcome === 'capped') { nextOffset = ctx.state.offset; break; }
      // A leg that got no time at all is the first to run next poll; one cut short is not retried until the rotation wraps.
      if (outcome === 'budget') { nextOffset = ctx.pairs > pairsBefore ? index + 1 : index; break; }
    }
    ctx.state.offset = nextOffset;
  }

  const ordered = primary.concat(gaps, navaids);
  const airports: string[] = [];
  const waypoints: DemandWaypoint[] = [];
  for (const want of ordered.slice(0, NAVDATA_DEMAND_CAP)) {
    if (want.kind === 'A') airports.push(want.ident);
    else if (want.region === null) waypoints.push({ ident: want.ident, kind: want.kind });
    else waypoints.push({ ident: want.ident, region: want.region, kind: want.kind });
  }
  const more = ordered.length > NAVDATA_DEMAND_CAP;

  return {
    v: 1,
    airports,
    waypoints,
    cap: NAVDATA_DEMAND_CAP,
    more,
    generatedAt: now.getTime(),
  };
}
