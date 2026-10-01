// Route geometry for a planned leg, resolved against the navdata replica.
// A pure function over a planned leg and a database handle (or null), so it
// tests with a synthetic replica and no HTTP. Every chain empty is a legal,
// non-error answer: it is what an absent replica returns.

import type Database from 'better-sqlite3';
import { haversineNm } from '../geo';
import type { PlannedLegWithChildren, PlannedWaypoint } from '../types';
import { ARINC_LETTER_TYPE, PLAN_APPROACH_TYPE_NAME } from './approachTypes';
import { parseRunway, wptKey } from './keys';
import {
  customApproachOffsetDeg,
  customDepartureDatum,
  dest,
  RUNWAY_HEADING_REFERENCE,
  runwayThreshold,
  runwayTrueBearing,
  type HeadingReference,
} from './geometry';
import type {
  GeometryArc,
  GeometryChain,
  GeometryPoint,
  RouteGeometryEndpoint,
  RouteGeometryResponse,
  UnresolvedKind,
  UnresolvedReason,
} from './queryTypes';

export const PLANNED_POSITION_TOLERANCE_M = 1000;
export const AIRWAY_MAX_HOPS = 200;
export const AIRWAY_MAX_VISITED = 500;

const NM_M = 1852;
const FT_M = 0.3048;

/** Leg types drawn at their fix coordinate: AF CF DF HF IF PI RF TF. */
const DRAWABLE_LEG_TYPES = new Set([1, 4, 7, 13, 15, 16, 17, 18]);
/** Unknown is drawable only when its fix coordinate is valid. */
const UNKNOWN_LEG_TYPE = 0;
const ARC_LEG_TYPES = new Set([1, 17]);

type ChainName = 'sid' | 'enroute' | 'star' | 'approach';

export interface RouteGeometryOptions {
  headingReference?: HeadingReference;
}

export function validCoordinate(lat: number | null | undefined, lon: number | null | undefined): boolean {
  if (typeof lat !== 'number' || typeof lon !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  return !(lat === 0 && lon === 0);
}

const e5 = (v: number): number => Math.round(v * 1e5);
const norm = (s: string | null | undefined): string => (s ?? '').trim().toUpperCase();

// ── Row shapes (only the columns read here) ──────────────────────────────────

interface ProcRow { proc_key: string; runway_number: number | null; runway_designator: number | null; suffix: string | null; name: string; approach_type?: number | null; faf_ident?: string | null }
interface TransRow {
  trans_key: string; role: string; name: string;
  runway_number: number | null; runway_designator: number | null;
}
interface LegRow {
  leg_type: number; fix_ident: string | null; fix_lat: number | null; fix_lon: number | null;
  arc_center_lat: number | null; arc_center_lon: number | null; fly_over: number | null;
  turn_direction: number | null; altitude1_m: number | null; altitude2_m: number | null;
  speed_limit_kt: number | null;
}
interface RunwayRow {
  rwy_key: string; lat: number | null; lon: number | null; heading_deg: number | null; length_m: number | null;
  primary_number: number | null; primary_designator: number | null;
  secondary_number: number | null; secondary_designator: number | null;
  primary_threshold_m: number | null; secondary_threshold_m: number | null;
}

// ── Chain builder ────────────────────────────────────────────────────────────

class ChainBuilder {
  points: GeometryPoint[] = [];
  arcs: GeometryArc[] = [];
  constructor(readonly name: ChainName, private readonly acc: Accumulator) {}

  get last(): GeometryPoint | null {
    return this.points.length ? this.points[this.points.length - 1] : null;
  }

  /** Appends a point unless it repeats the previous one; true when appended. */
  push(p: GeometryPoint): boolean {
    const prev = this.last;
    if (prev && e5(prev.lat) === e5(p.lat) && e5(prev.lon) === e5(p.lon)) return false;
    this.points.push(p);
    return true;
  }

  addProcedureLeg(leg: LegRow): void {
    const bearing = DRAWABLE_LEG_TYPES.has(leg.leg_type) || leg.leg_type === UNKNOWN_LEG_TYPE;
    if (!bearing || !validCoordinate(leg.fix_lat, leg.fix_lon)) {
      this.acc.skippedLegs++;
      this.acc.skippedByChain[this.name]++;
      return;
    }
    const hadPrevious = this.points.length > 0;
    const appended = this.push({
      lat: leg.fix_lat as number,
      lon: leg.fix_lon as number,
      ident: leg.fix_ident,
      legType: leg.leg_type,
      flyOver: leg.fly_over == null ? null : leg.fly_over === 1,
      altitude1M: leg.altitude1_m,
      altitude2M: leg.altitude2_m,
      speedLimitKt: typeof leg.speed_limit_kt === 'number' && Number.isFinite(leg.speed_limit_kt) && leg.speed_limit_kt >= 0
        ? leg.speed_limit_kt
        : null,
    });
    if (
      appended && hadPrevious && ARC_LEG_TYPES.has(leg.leg_type) &&
      validCoordinate(leg.arc_center_lat, leg.arc_center_lon)
    ) {
      this.arcs.push({
        fromIndex: this.points.length - 2,
        toIndex: this.points.length - 1,
        centerLat: leg.arc_center_lat as number,
        centerLon: leg.arc_center_lon as number,
        turn: leg.turn_direction === 1 ? 'L' : leg.turn_direction === 2 ? 'R' : null,
      });
    }
  }

  finish(source: string | null, synthetic = false): GeometryChain {
    if (this.points.length === 0 && !synthetic) return emptyChain();
    return { source, synthetic, points: this.points, arcs: this.arcs };
  }
}

interface Accumulator {
  skippedLegs: number;
  skippedByChain: Record<ChainName, number>;
  unresolved: RouteGeometryResponse['unresolved'];
}

function emptyChain(): GeometryChain {
  return { source: null, synthetic: false, points: [], arcs: [] };
}

function addUnresolved(acc: Accumulator, kind: UnresolvedKind, name: string, reason: UnresolvedReason): void {
  if (acc.unresolved.some((u) => u.kind === kind && u.name === name && u.reason === reason)) return;
  acc.unresolved.push({ kind, name, reason });
}

// ── Planned waypoint resolution ──────────────────────────────────────────────

interface Resolved { key: string; lat: number; lon: number }

/** Candidate nearest `near`; an exact distance tie goes to the smaller key. */
function pickNearest<T extends Resolved>(cands: T[], near: { lat: number; lon: number }): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  for (const c of cands) {
    const d = haversineNm(near.lat, near.lon, c.lat, c.lon);
    if (d < bestD || (d === bestD && best !== null && c.key < best.key)) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

const preparedStatements = new WeakMap<Database.Database, Map<string, Database.Statement>>();

/** One prepared statement per handle and text, so a lookup made for every planned waypoint does not recompile. */
function prepared(db: Database.Database, sql: string): Database.Statement {
  let byText = preparedStatements.get(db);
  if (!byText) preparedStatements.set(db, (byText = new Map()));
  let stmt = byText.get(sql);
  if (!stmt) byText.set(sql, (stmt = db.prepare(sql)));
  return stmt;
}

/** A planned waypoint's possible replica rows; `navaid` marks a nav_navaid row, not a nav_waypoint one. */
interface Candidate extends Resolved { navaid: boolean }

const TOLERANCE_NM = PLANNED_POSITION_TOLERANCE_M / NM_M;

/**
 * Every fix and navaid the plan's ident can stand for. When the plan gives a
 * region, that region's rows of both tables are the candidates, so a VFR/RNAV
 * waypoint that shares an ident with an airway VOR or NDB cannot hide the
 * navaid; with no region, or no row in it, every row with the ident is.
 */
function lookupCandidates(db: Database.Database, wp: PlannedWaypoint): Candidate[] {
  const region = (wp.region ?? '').trim();
  type WRow = { wpt_key: string; lat: number; lon: number };
  type NRow = { ident: string; region: string; lat: number; lon: number };
  const waypoint = (r: WRow): Candidate => ({ key: r.wpt_key, lat: r.lat, lon: r.lon, navaid: false });
  const navaid = (r: NRow): Candidate => ({ key: wptKey(r.ident, r.region, r.lat, r.lon), lat: r.lat, lon: r.lon, navaid: true });
  if (region) {
    const wpts = prepared(db, 'SELECT wpt_key, lat, lon FROM nav_waypoint WHERE ident = ? AND region = ?')
      .all(wp.ident, region) as WRow[];
    const navaids = prepared(
      db,
      'SELECT ident, region, lat, lon FROM nav_navaid WHERE region = ? AND ident = ? AND lat IS NOT NULL AND lon IS NOT NULL',
    ).all(region, wp.ident) as NRow[];
    if (wpts.length + navaids.length > 0) return [...navaids.map(navaid), ...wpts.map(waypoint)];
  }
  const wpts = prepared(db, 'SELECT wpt_key, lat, lon FROM nav_waypoint WHERE ident = ?').all(wp.ident) as WRow[];
  const navaids = prepared(db, 'SELECT ident, region, lat, lon FROM nav_navaid WHERE ident = ? AND lat IS NOT NULL AND lon IS NOT NULL')
    .all(wp.ident) as NRow[];
  return [...wpts.map(waypoint), ...navaids.map(navaid)];
}

/** Whether an airway leg starts or ends at exactly this key. */
function isAirwayEndpointKey(db: Database.Database, key: string): boolean {
  return prepared(
    db,
    `SELECT 1 FROM nav_airway_leg WHERE from_key = @k
     UNION ALL
     SELECT 1 FROM nav_airway_leg WHERE to_key = @k
     LIMIT 1`,
  ).get({ k: key }) !== undefined;
}

/**
 * The candidate the plan most likely means. Candidates within the position
 * tolerance of the anchor are ranked: one that is an airway endpoint first, so
 * the airway through it expands; then a navaid over a fix, since a VFR/RNAV
 * point beside an airway VOR is not what the airway runs through; then the
 * nearest. With none inside the tolerance, the nearest overall.
 */
function pickPlanned(db: Database.Database, cands: Candidate[], anchor: { lat: number; lon: number }): Candidate | null {
  const within = cands.filter((c) => haversineNm(anchor.lat, anchor.lon, c.lat, c.lon) <= TOLERANCE_NM);
  if (within.length === 0) return pickNearest(cands, anchor);
  const endpoints = within.filter((c) => isAirwayEndpointKey(db, c.key));
  const pool = endpoints.length > 0
    ? endpoints
    : within.some((c) => c.navaid) ? within.filter((c) => c.navaid) : within;
  return pickNearest(pool, anchor);
}

/**
 * Endpoints whose key starts with `ident|`. The key begins with the ident, so a
 * range on the key ('|' + 1 is '}') is served by the from_key and to_key indexes
 * where a comparison on the ident column would scan the whole table.
 */
export const AIRWAY_ENDPOINT_SQL =
  `SELECT from_key AS k, from_region AS region, from_lat AS lat, from_lon AS lon
     FROM nav_airway_leg WHERE from_key >= @lo AND from_key < @hi
   UNION ALL
   SELECT to_key, to_region, to_lat, to_lon
     FROM nav_airway_leg WHERE to_key >= @lo AND to_key < @hi`;

/**
 * The key of an airway endpoint with this waypoint's ident (and region, when the
 * plan gives one), within the position tolerance of the planned point; the
 * nearest wins and a tie goes to the smaller key. Null when there is none.
 * Keys carry the ident as the simulator spells it, uppercase in practice, so the
 * ident is matched uppercased and, when the plan spelled it differently, as given.
 */
function airwayEndpointNear(db: Database.Database, wp: PlannedWaypoint): string | null {
  const region = (wp.region ?? '').trim().toUpperCase();
  const idents = [...new Set([wp.ident.toUpperCase(), wp.ident])];
  const stmt = prepared(db, AIRWAY_ENDPOINT_SQL);
  const rows = idents.flatMap((ident) => stmt.all({ lo: `${ident}|`, hi: `${ident}}` }) as
    { k: string; region: string; lat: number; lon: number }[]);
  const cands = rows
    .filter((r) => (region === '' || r.region.toUpperCase() === region) && validCoordinate(r.lat, r.lon))
    .filter((r) => haversineNm(wp.lat, wp.lon, r.lat, r.lon) <= PLANNED_POSITION_TOLERANCE_M / NM_M)
    .map((r) => ({ key: r.k, lat: r.lat, lon: r.lon }));
  return pickNearest(cands, { lat: wp.lat, lon: wp.lon })?.key ?? null;
}

// ── Airway expansion ─────────────────────────────────────────────────────────

/** Endpoint keys of one fix can differ by a unit or two in the last place when the sender rounded differently. */
const KEY_JOIN_UNITS = 10;

export interface ParsedKey { prefix: string; lat: number; lon: number }

/** Splits ident|region|lat|lon on the last two separators, so an odd ident cannot confuse it. */
export function parseKey(key: string): ParsedKey | null {
  const lonAt = key.lastIndexOf('|');
  const latAt = lonAt > 0 ? key.lastIndexOf('|', lonAt - 1) : -1;
  if (latAt <= 0) return null;
  const lat = Number(key.slice(latAt + 1, lonAt));
  const lon = Number(key.slice(lonAt + 1));
  if (key.slice(latAt + 1, lonAt) === '' || key.slice(lonAt + 1) === '' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { prefix: key.slice(0, latAt), lat, lon };
}

/** Whether two parsed keys are one fix: same ident and region, positions within the join tolerance. */
export function keysNear(a: ParsedKey, b: ParsedKey): boolean {
  return a.prefix === b.prefix && Math.abs(a.lat - b.lat) <= KEY_JOIN_UNITS && Math.abs(a.lon - b.lon) <= KEY_JOIN_UNITS;
}

interface AirwayNode { ident: string; lat: number; lon: number }

/**
 * Shortest path over one airway's legs from `fromKey` to `toKey`, neighbours
 * visited in ascending key order. Returns the nodes strictly between the two
 * endpoints, or null when there is no path within the hop and visit caps.
 */
function expandAirway(db: Database.Database, airway: string, fromKey: string, toKey: string): AirwayNode[] | null {
  const rows = db
    .prepare(
      `SELECT from_key, to_key, from_ident, from_lat, from_lon, to_ident, to_lat, to_lon
         FROM nav_airway_leg WHERE airway = ?`,
    )
    .all(airway) as {
      from_key: string; to_key: string; from_ident: string; from_lat: number; from_lon: number;
      to_ident: string; to_lat: number; to_lon: number;
    }[];
  const adj = new Map<string, Set<string>>();
  const info = new Map<string, AirwayNode>();
  const link = (a: string, b: string): void => {
    let s = adj.get(a);
    if (!s) adj.set(a, (s = new Set()));
    s.add(b);
  };
  for (const r of rows) {
    link(r.from_key, r.to_key);
    link(r.to_key, r.from_key);
    info.set(r.from_key, { ident: r.from_ident, lat: r.from_lat, lon: r.from_lon });
    info.set(r.to_key, { ident: r.to_ident, lat: r.to_lat, lon: r.to_lon });
  }

  // Keys of one ident and region whose positions are within the join tolerance are
  // one node; the smallest key stands for the cluster, so exact keys never merge.
  const parsed = [...adj.keys()].sort().map((k) => ({ k, p: parseKey(k) }));
  const reps: { k: string; p: ParsedKey }[] = [];
  const repOf = new Map<string, string>();
  const near = keysNear;
  for (const { k, p } of parsed) {
    const hit = p ? reps.find((r) => near(r.p, p)) : undefined;
    if (hit) repOf.set(k, hit.k);
    else {
      repOf.set(k, k);
      if (p) reps.push({ k, p });
    }
  }
  const canon = (k: string): string => {
    const known = repOf.get(k);
    if (known !== undefined) return known;
    const p = parseKey(k);
    const hit = p ? reps.find((r) => near(r.p, p)) : undefined;
    return hit ? hit.k : k;
  };
  if (repOf.size !== new Set(repOf.values()).size) {
    const merged = new Map<string, Set<string>>();
    const mergedInfo = new Map<string, AirwayNode>();
    for (const [k, set] of adj) {
      const rk = canon(k);
      let m = merged.get(rk);
      if (!m) merged.set(rk, (m = new Set()));
      for (const n of set) if (canon(n) !== rk) m.add(canon(n));
      if (!mergedInfo.has(rk) || k === rk) mergedInfo.set(rk, info.get(k) as AirwayNode);
    }
    adj.clear();
    for (const [k, v] of merged) adj.set(k, v);
    info.clear();
    for (const [k, v] of mergedInfo) info.set(k, v);
  }
  fromKey = canon(fromKey);
  toKey = canon(toKey);
  if (!adj.has(fromKey) || !adj.has(toKey)) return null;

  const parent = new Map<string, string | null>([[fromKey, null]]);
  const depth = new Map<string, number>([[fromKey, 0]]);
  const queue: string[] = [fromKey];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    if (cur === toKey) break;
    const d = depth.get(cur) as number;
    if (d >= AIRWAY_MAX_HOPS) continue;
    for (const next of [...(adj.get(cur) ?? [])].sort()) {
      if (parent.has(next)) continue;
      if (parent.size >= AIRWAY_MAX_VISITED) return null;
      parent.set(next, cur);
      depth.set(next, d + 1);
      queue.push(next);
    }
  }
  if (!parent.has(toKey)) return null;
  const path: string[] = [];
  for (let k = parent.get(toKey) ?? null; k !== null && k !== fromKey; k = parent.get(k) ?? null) path.push(k);
  path.reverse();
  return path.map((k) => info.get(k) as AirwayNode);
}

export interface AirwayReachNode { key: string; ident: string; region: string; lat: number; lon: number }

/**
 * The airway column is wrapped in `+` so the planner keeps to the key-range
 * indexes: a plain equality on it would pick the airway-name index and read
 * every leg of the airway for each step.
 */
export const AIRWAY_NEIGHBOURS_SQL =
  `SELECT from_key, to_key, from_ident, from_region, from_lat, from_lon, to_ident, to_region, to_lat, to_lon
     FROM nav_airway_leg WHERE +airway = @airway AND from_key >= @lo AND from_key < @hi
   UNION ALL
   SELECT from_key, to_key, from_ident, from_region, from_lat, from_lon, to_ident, to_region, to_lat, to_lon
     FROM nav_airway_leg WHERE +airway = @airway AND to_key >= @lo AND to_key < @hi`;

export interface AirwayWalk {
  /** Fixes visited, start first when any leg touches it. Only the part explored before a target was reached. */
  nodes: AirwayReachNode[];
  /** True when the walk stopped because it reached the target key. */
  reached: boolean;
}

/**
 * Fixes reachable from `startKey` over one airway's legs, breadth first with the
 * hop and visit caps of `expandAirway`, joining endpoint keys with the same
 * position tolerance. Each step is a range lookup on the from_key and to_key
 * indexes, so the cost follows the part of the component explored and never the
 * table. With a `targetKey` the walk returns the moment it is reached, so a pair
 * the airway already connects costs only the hops between them; without one, or
 * when the target is not in the component, the whole component (within the caps)
 * is returned.
 */
export function walkAirway(
  db: Database.Database,
  airway: string,
  startKey: string,
  targetKey?: string,
): AirwayWalk {
  const stmt = prepared(db, AIRWAY_NEIGHBOURS_SQL);
  type Row = {
    from_key: string; to_key: string; from_ident: string; from_region: string; from_lat: number; from_lon: number;
    to_ident: string; to_region: string; to_lat: number; to_lon: number;
  };
  const nodes: AirwayReachNode[] = [];
  const startParsed = parseKey(startKey);
  if (!startParsed) return { nodes, reached: false };
  const target = targetKey === undefined ? null : parseKey(targetKey);
  const isTarget = (p: ParsedKey): boolean => target !== null && keysNear(p, target);
  if (isTarget(startParsed)) return { nodes, reached: true };

  const visited = new Map<string, ParsedKey[]>();
  let visitedCount = 0;
  const seenKey = (p: ParsedKey): boolean => visited.get(p.prefix)?.some((q) => keysNear(q, p)) ?? false;
  const mark = (p: ParsedKey): void => {
    visitedCount++;
    const list = visited.get(p.prefix);
    if (list) list.push(p);
    else visited.set(p.prefix, [p]);
  };
  const infoAt = (r: Row, side: 'from' | 'to'): AirwayReachNode => side === 'from'
    ? { key: r.from_key, ident: r.from_ident, region: r.from_region, lat: r.from_lat, lon: r.from_lon }
    : { key: r.to_key, ident: r.to_ident, region: r.to_region, lat: r.to_lat, lon: r.to_lon };

  mark(startParsed);
  let level: { key: string; p: ParsedKey }[] = [{ key: startKey, p: startParsed }];
  let startAdded = false;
  for (let depth = 0; level.length && depth < AIRWAY_MAX_HOPS; depth++) {
    const nextLevel: { key: string; p: ParsedKey }[] = [];
    for (const { key: cur, p } of level.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
      const rows = stmt.all({ airway, lo: `${p.prefix}|`, hi: `${p.prefix}}` }) as Row[];
      for (const r of rows) {
        const fromP = parseKey(r.from_key);
        const toP = parseKey(r.to_key);
        const fromIsCur = fromP !== null && keysNear(fromP, p);
        const toIsCur = toP !== null && keysNear(toP, p);
        if (fromIsCur === toIsCur) continue;
        if (!startAdded && cur === startKey) {
          nodes.push(infoAt(r, fromIsCur ? 'from' : 'to'));
          startAdded = true;
        }
        const otherSide = fromIsCur ? 'to' : 'from';
        const otherP = otherSide === 'to' ? toP : fromP;
        if (!otherP || seenKey(otherP)) continue;
        if (visitedCount >= AIRWAY_MAX_VISITED) return { nodes, reached: false };
        const other = infoAt(r, otherSide);
        mark(otherP);
        nodes.push(other);
        if (isTarget(otherP)) return { nodes, reached: true };
        nextLevel.push({ key: other.key, p: otherP });
      }
    }
    level = nextLevel;
  }
  return { nodes, reached: false };
}

// ── Procedures ───────────────────────────────────────────────────────────────

function selectProcedure(
  db: Database.Database,
  airport: string,
  kind: 'SID' | 'STAR' | 'APPROACH',
  name: string,
  runway: { number: number; designator: number } | null,
  suffix: string | null,
): ProcRow | null {
  const rows = (
    db
      .prepare(
        `SELECT proc_key, name, runway_number, runway_designator, suffix
           FROM nav_procedure WHERE airport_ident = ? AND kind = ?`,
      )
      .all(airport, kind) as ProcRow[]
  ).filter((r) => norm(r.name) === norm(name) && norm(r.suffix) === norm(suffix));
  if (!rows.length) return null;
  const byKey = (a: ProcRow, b: ProcRow): number => (a.proc_key < b.proc_key ? -1 : a.proc_key > b.proc_key ? 1 : 0);
  if (runway) {
    const m = rows
      .filter((r) => r.runway_number === runway.number && r.runway_designator === runway.designator)
      .sort(byKey);
    if (m.length) return m[0];
  }
  const generic = rows.filter((r) => r.runway_number === null).sort(byKey);
  if (generic.length) return generic[0];
  return [...rows].sort(byKey)[0];
}

// The simulator writes approach_type as a small integer; ARINC_LETTER_TYPE and PLAN_APPROACH_TYPE_NAME
// map the plan's ARINC leading letter (or, when that is empty, its approach_type string) onto it.
// Unknown input means no preference.

function preferredApproachType(arinc: string | null | undefined, typeName: string | null | undefined): number | null {
  const letter = norm(arinc).charAt(0);
  if (letter) return ARINC_LETTER_TYPE[letter] ?? null;
  return PLAN_APPROACH_TYPE_NAME[norm(typeName)] ?? null;
}

// The simulator sends "0" for "no suffix"; any other value, digit or letter, is a real suffix.
const noSuffix = (s: string | null | undefined): boolean => norm(s) === '' || norm(s) === '0';

function selectApproach(
  db: Database.Database,
  airport: string,
  fixName: string,
  runway: { number: number; designator: number } | null,
  suffix: string | null,
  arinc: string | null,
  typeName: string | null,
): ProcRow | null {
  let rows = db
    .prepare(
      `SELECT proc_key, name, runway_number, runway_designator, suffix, approach_type, faf_ident
         FROM nav_procedure WHERE airport_ident = ? AND kind = 'APPROACH'`,
    )
    .all(airport) as ProcRow[];
  if (runway) {
    rows = rows.filter((r) => r.runway_number === runway.number && r.runway_designator === runway.designator);
  }
  rows = rows.filter((r) => (noSuffix(suffix) ? noSuffix(r.suffix) : norm(r.suffix) === norm(suffix)));
  if (!rows.length) return null;
  const preferred = preferredApproachType(arinc, typeName);
  if (preferred !== null) {
    const typed = rows.filter((r) => r.approach_type === preferred);
    if (typed.length) rows = typed;
  }
  const wanted = norm(fixName);
  const transNames = db.prepare('SELECT name FROM nav_procedure_transition WHERE proc_key = ?');
  const fixMatch = (r: ProcRow): boolean =>
    norm(r.faf_ident) === wanted ||
    (transNames.all(r.proc_key) as { name: string }[]).some((t) => norm(t.name) === wanted);
  const scored = rows.map((r) => ({ r, m: wanted !== '' && fixMatch(r) }));
  scored.sort((a, b) =>
    a.m !== b.m ? (a.m ? -1 : 1) : a.r.proc_key < b.r.proc_key ? -1 : a.r.proc_key > b.r.proc_key ? 1 : 0);
  return scored[0].r;
}

function transitionsOf(db: Database.Database, procKey: string): TransRow[] {
  return (
    db
      .prepare(
        `SELECT trans_key, role, name, runway_number, runway_designator
           FROM nav_procedure_transition WHERE proc_key = ?`,
      )
      .all(procKey) as TransRow[]
  ).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.trans_key < b.trans_key ? -1 : 1));
}

function legsOf(db: Database.Database, transKey: string): LegRow[] {
  return db
    .prepare(
      `SELECT leg_type, fix_ident, fix_lat, fix_lon, arc_center_lat, arc_center_lon, fly_over,
              turn_direction, altitude1_m, altitude2_m, speed_limit_kt
         FROM nav_procedure_leg WHERE trans_key = ? ORDER BY seq`,
    )
    .all(transKey) as LegRow[];
}

function addTransition(db: Database.Database, b: ChainBuilder, t: TransRow | undefined): void {
  if (!t) return;
  for (const leg of legsOf(db, t.trans_key)) b.addProcedureLeg(leg);
}

/** Enroute transition named by the plan, else the one whose joining fix is `fixIdent`. */
function pickEnrouteTransition(
  db: Database.Database,
  trans: TransRow[],
  planName: string | null,
  fixIdent: string | null,
  end: 'first' | 'last',
): TransRow | undefined {
  const enroute = trans.filter((t) => t.role === 'enroute');
  if (planName && norm(planName)) {
    const named = enroute.find((t) => norm(t.name) === norm(planName));
    if (named) return named;
  }
  if (!fixIdent) return undefined;
  return enroute.find((t) => {
    const legs = legsOf(db, t.trans_key);
    const leg = end === 'first' ? legs[0] : legs[legs.length - 1];
    return !!leg && norm(leg.fix_ident) === norm(fixIdent);
  });
}

function runwayTransitionFor(
  trans: TransRow[],
  runway: { number: number; designator: number } | null,
): TransRow | undefined {
  if (!runway) return undefined;
  return trans.find(
    (t) => t.role === 'runway' && t.runway_number === runway.number && t.runway_designator === runway.designator,
  );
}

// ── Synthetic (custom) procedures ────────────────────────────────────────────

function pickRunwayRow(
  db: Database.Database,
  airport: string,
  rwy: { number: number; designator: number },
): { row: RunwayRow; end: 'primary' | 'secondary'; magvar: number | null } | null {
  const rows = db
    .prepare(
      `SELECT rwy_key, lat, lon, heading_deg, length_m, primary_number, primary_designator,
              secondary_number, secondary_designator, primary_threshold_m, secondary_threshold_m
         FROM nav_runway WHERE airport_ident = ? ORDER BY rwy_key`,
    )
    .all(airport) as RunwayRow[];
  for (const row of rows) {
    if (
      !validCoordinate(row.lat, row.lon) ||
      typeof row.heading_deg !== 'number' || !Number.isFinite(row.heading_deg) ||
      typeof row.length_m !== 'number' || !Number.isFinite(row.length_m) || row.length_m <= 0
    ) continue;
    const end =
      row.primary_number === rwy.number && row.primary_designator === rwy.designator
        ? 'primary'
        : row.secondary_number === rwy.number && row.secondary_designator === rwy.designator
          ? 'secondary'
          : null;
    if (!end) continue;
    const ap = db.prepare('SELECT magvar FROM nav_airport WHERE ident = ?').get(airport) as
      | { magvar: number | null }
      | undefined;
    return { row, end, magvar: ap?.magvar ?? null };
  }
  return null;
}

function syntheticPoint(
  lat: number, lon: number, ident: string | null, altitude1M: number | null,
): GeometryPoint {
  return { lat, lon, ident, legType: null, flyOver: null, altitude1M, altitude2M: null, speedLimitKt: null };
}

/**
 * A custom SID or approach, computed from the runway; null when the runway
 * cannot be resolved (the reason is reported on `acc`). Never counted as
 * skipped legs.
 */
function buildSynthetic(
  db: Database.Database,
  acc: Accumulator,
  kind: 'sid' | 'approach',
  airport: string,
  label: string | null,
  runwayName: string | null,
  distanceNm: number | null,
  altitudeFt: number | null,
  offsetDeg: number | null,
  reference: HeadingReference,
): GeometryChain | null {
  const name = label ?? '';
  if (runwayName == null || runwayName.trim() === '') {
    addUnresolved(acc, kind, name, 'custom procedure, no runway');
    return null;
  }
  const rwy = parseRunway(runwayName);
  if (!rwy) {
    addUnresolved(acc, kind, name, 'unparseable runway');
    return null;
  }
  const found = pickRunwayRow(db, airport, rwy);
  if (!found) {
    addUnresolved(acc, kind, name, 'custom procedure, no runway');
    return null;
  }
  if (typeof distanceNm !== 'number' || !Number.isFinite(distanceNm) || distanceNm <= 0) {
    addUnresolved(acc, kind, name, 'custom procedure, invalid distance');
    return null;
  }
  const { row, end, magvar } = found;
  const primaryBearing = runwayTrueBearing(row.heading_deg as number, magvar, reference);
  const thr = runwayThreshold(row.lat as number, row.lon as number, primaryBearing, row.length_m as number, end,
    end === 'primary' ? row.primary_threshold_m : row.secondary_threshold_m,
  );
  const metres = distanceNm * NM_M;

  if (kind === 'approach') {
    const start = dest(thr.lat, thr.lon, thr.bearingEnd + 180 + customApproachOffsetDeg(offsetDeg), metres);
    const alt = typeof altitudeFt === 'number' && Number.isFinite(altitudeFt) ? altitudeFt * FT_M : null;
    return {
      source: label,
      synthetic: true,
      points: [
        syntheticPoint(start.lat, start.lon, label, alt),
        syntheticPoint(thr.lat, thr.lon, runwayName, null),
      ],
      arcs: [],
    };
  }
  const farEnd = dest(row.lat as number, row.lon as number, thr.bearingEnd, (row.length_m as number) / 2);
  const datum = customDepartureDatum(thr, farEnd);
  const away = dest(datum.lat, datum.lon, thr.bearingEnd, metres);
  return {
    source: label,
    synthetic: true,
    points: [
      syntheticPoint(thr.lat, thr.lon, runwayName, null),
      syntheticPoint(away.lat, away.lon, label, null),
    ],
    arcs: [],
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

function endpoint(
  ident: string, lat: number, lon: number, isAirport: number,
): RouteGeometryEndpoint | null {
  if (!validCoordinate(lat, lon)) return null;
  return { ident, lat, lon, isAirport: isAirport === 1 };
}

export function buildRouteGeometry(
  leg: PlannedLegWithChildren,
  db: Database.Database | null,
  options: RouteGeometryOptions = {},
): RouteGeometryResponse {
  const reference = options.headingReference ?? RUNWAY_HEADING_REFERENCE;
  const acc: Accumulator = {
    skippedLegs: 0,
    skippedByChain: { sid: 0, enroute: 0, star: 0, approach: 0 },
    unresolved: [],
  };
  const chains: Record<ChainName, GeometryChain> = {
    sid: emptyChain(), enroute: emptyChain(), star: emptyChain(), approach: emptyChain(),
  };

  if (db) {
    buildEnroute(db, leg, acc, chains);
    buildSid(db, leg, acc, chains, reference);
    buildStar(db, leg, acc, chains);
    buildApproach(db, leg, acc, chains, reference);
  }

  return {
    legId: leg.id,
    origin: endpoint(leg.departure_ident, leg.departure_lat, leg.departure_lon, leg.departure_is_airport),
    destination: endpoint(leg.destination_ident, leg.destination_lat, leg.destination_lon, leg.destination_is_airport),
    sid: chains.sid,
    enroute: chains.enroute,
    star: chains.star,
    approach: chains.approach,
    skippedLegs: acc.skippedLegs,
    skippedByChain: acc.skippedByChain,
    unresolved: acc.unresolved,
  };
}

/**
 * SimBrief writes the via-airway verbatim: 'DCT' for a direct segment, and the
 * SID or STAR name on the waypoints that belong to that procedure. Neither is
 * an airway to expand or to report; the procedure chains already draw their
 * points and a direct segment is just the line between the two. The match is
 * scoped to this plan's own procedure names, never a guess that a value looks
 * like a procedure.
 */
export function isNonAirway(leg: ProcedureNames, airway: string): boolean {
  const a = norm(airway);
  if (a === '' || a === 'DCT') return true;
  return [leg.sid_name, leg.sid_transition, leg.star_name, leg.star_transition]
    .some((name) => name != null && norm(name) !== '' && norm(name) === a);
}

/** The airway-naming fields of a planned leg, all `isNonAirway` reads. */
export type ProcedureNames = Pick<PlannedLegWithChildren, 'sid_name' | 'sid_transition' | 'star_name' | 'star_transition'>;

/**
 * Whether the enroute chain tries to expand the segment that ends at `wp`: it
 * names a real airway, neither end is an airport, a point was already drawn
 * (`hasPrevious`) and the planned position is usable.
 */
export function airwayAttempted(
  leg: ProcedureNames,
  wp: Pick<PlannedWaypoint, 'airway' | 'type' | 'lat' | 'lon'>,
  prevIsAirport: boolean,
  hasPrevious: boolean,
): boolean {
  // Airways neither start nor end at an airport, so a value there is noise.
  return Boolean(wp.airway) && wp.type !== 'AIRPORT' && !prevIsAirport && !isNonAirway(leg, wp.airway as string)
    && hasPrevious && validCoordinate(wp.lat, wp.lon);
}

/**
 * The airway key a planned waypoint stands for: the replica's own fix or navaid
 * when it holds one, else an airway endpoint with the same ident (and region)
 * near the planned position. `viaEndpoint` marks the second case. Null for
 * airports and user-defined points, which are not navdata, and when nothing matches.
 * A candidate beyond the position tolerance yields to an airway endpoint inside it.
 */
export function resolvePlannedKey(
  db: Database.Database,
  wp: PlannedWaypoint,
  near: { lat: number; lon: number },
): (Resolved & { viaEndpoint: boolean }) | null {
  if (wp.type === 'AIRPORT' || wp.type === 'USER') return null;
  // The planned position is the best anchor: an ident shared by many fixes must
  // resolve to the one the plan drew, not the one nearest the previous point.
  const valid = validCoordinate(wp.lat, wp.lon);
  const anchor = valid ? { lat: wp.lat, lon: wp.lon } : near;
  const chosen = pickPlanned(db, lookupCandidates(db, wp), anchor);
  if (chosen && (!valid || haversineNm(wp.lat, wp.lon, chosen.lat, chosen.lon) <= TOLERANCE_NM)) {
    return { key: chosen.key, lat: chosen.lat, lon: chosen.lon, viaEndpoint: false };
  }
  // A facility whose own rows were never fetched can still be an airway
  // endpoint; join by ident, region and proximity to the planned position.
  const endpoint = valid ? airwayEndpointNear(db, wp) : null;
  if (endpoint) {
    const p = parseKey(endpoint);
    return { key: endpoint, lat: p ? p.lat / 1e5 : wp.lat, lon: p ? p.lon / 1e5 : wp.lon, viaEndpoint: true };
  }
  return chosen ? { key: chosen.key, lat: chosen.lat, lon: chosen.lon, viaEndpoint: false } : null;
}

function buildEnroute(
  db: Database.Database,
  leg: PlannedLegWithChildren,
  acc: Accumulator,
  chains: Record<ChainName, GeometryChain>,
): void {
  const wps = [...leg.waypoints].sort((a, b) => a.seq - b.seq);
  const b = new ChainBuilder('enroute', acc);
  let near = { lat: leg.departure_lat, lon: leg.departure_lon };
  let prevKey: string | null = null;
  let prevIsAirport = false;
  let prevResolved = false;

  for (const wp of wps) {
    let key: string | null = null;
    let resolved = false;
    // Airports and user-defined points are not navdata: nothing to look up.
    const skipLookup = wp.type === 'AIRPORT' || wp.type === 'USER';
    if (!skipLookup) {
      const found = resolvePlannedKey(db, wp, near);
      if (found) {
        key = found.key;
        resolved = true;
        if (!found.viaEndpoint && haversineNm(wp.lat, wp.lon, found.lat, found.lon) > PLANNED_POSITION_TOLERANCE_M / NM_M) {
          addUnresolved(acc, 'waypoint', wp.ident, 'position disagrees with cache');
        }
      } else {
        addUnresolved(acc, 'waypoint', wp.ident, 'ident not in cache');
      }
    }

    if (airwayAttempted(leg, wp, prevIsAirport, b.last !== null)) {
      const airway = wp.airway as string;
      const via = prevResolved && resolved && prevKey && key && prevKey !== key
        ? expandAirway(db, airway, prevKey, key)
        : null;
      if (via) {
        for (const n of via) {
          b.push(syntheticPoint(n.lat, n.lon, n.ident, null));
        }
      } else if (!(prevKey && key && prevKey === key)) {
        addUnresolved(acc, 'airway', airway, 'no path found');
      }
    }

    if (validCoordinate(wp.lat, wp.lon)) {
      b.push(syntheticPoint(wp.lat, wp.lon, wp.ident, null));
    }
    if (validCoordinate(wp.lat, wp.lon)) near = { lat: wp.lat, lon: wp.lon };
    prevKey = key;
    prevResolved = resolved;
    prevIsAirport = wp.type === 'AIRPORT';
  }
  chains.enroute = b.finish('planned');
}

function firstLastEnrouteIdents(leg: PlannedLegWithChildren): { first: string | null; last: string | null } {
  const inner = [...leg.waypoints].sort((a, b) => a.seq - b.seq).filter((w) => w.type !== 'AIRPORT');
  return {
    first: inner.length ? inner[0].ident : null,
    last: inner.length ? inner[inner.length - 1].ident : null,
  };
}

function procedureChain(
  db: Database.Database,
  acc: Accumulator,
  chainName: 'sid' | 'star' | 'approach',
  airport: string,
  kind: 'SID' | 'STAR' | 'APPROACH',
  name: string,
  runwayName: string | null,
  suffix: string | null,
  assemble: (b: ChainBuilder, trans: TransRow[], rwy: { number: number; designator: number } | null, proc: ProcRow) => void,
  approachPlan?: { arinc: string | null; typeName: string | null },
): GeometryChain {
  let rwy: { number: number; designator: number } | null = null;
  if (runwayName != null && runwayName.trim() !== '') {
    rwy = parseRunway(runwayName);
    if (!rwy) {
      addUnresolved(acc, chainName, name, 'unparseable runway');
      return emptyChain();
    }
  } else if (approachPlan) {
    addUnresolved(acc, chainName, name, 'approach runway not specified');
    return emptyChain();
  }
  const proc = approachPlan
    ? selectApproach(db, airport, name, rwy, suffix, approachPlan.arinc, approachPlan.typeName)
    : selectProcedure(db, airport, kind, name, rwy, suffix);
  if (!proc) {
    const ap = db.prepare('SELECT detail_state FROM nav_airport WHERE ident = ?').get(airport) as
      | { detail_state: string }
      | undefined;
    addUnresolved(
      acc, chainName, name,
      ap?.detail_state === 'detail' ? 'procedure not in cache' : 'airport detail not fetched',
    );
    return emptyChain();
  }
  const b = new ChainBuilder(chainName, acc);
  assemble(b, transitionsOf(db, proc.proc_key), rwy ?? (proc.runway_number != null
    ? { number: proc.runway_number, designator: proc.runway_designator ?? 0 }
    : null), proc);
  return b.finish(proc.proc_key);
}

function buildSid(
  db: Database.Database, leg: PlannedLegWithChildren, acc: Accumulator,
  chains: Record<ChainName, GeometryChain>, reference: HeadingReference,
): void {
  const airport = norm(leg.departure_ident);
  if (leg.sid_type === 'CUSTOMDEPART') {
    const chain = buildSynthetic(
      db, acc, 'sid', airport, leg.sid_name, leg.sid_runway, leg.sid_custom_distance_nm, null, null, reference,
    );
    if (chain) chains.sid = chain;
    return;
  }
  if (!leg.sid_name || !norm(leg.sid_name) || leg.departure_is_airport !== 1) return;
  const { first } = firstLastEnrouteIdents(leg);
  chains.sid = procedureChain(db, acc, 'sid', airport, 'SID', leg.sid_name, leg.sid_runway, null, (b, trans, rwy) => {
    addTransition(db, b, runwayTransitionFor(trans, rwy));
    addTransition(db, b, trans.find((t) => t.role === 'common'));
    addTransition(db, b, pickEnrouteTransition(db, trans, leg.sid_transition, first, 'last'));
  });
}

function buildStar(
  db: Database.Database, leg: PlannedLegWithChildren, acc: Accumulator,
  chains: Record<ChainName, GeometryChain>,
): void {
  if (!leg.star_name || !norm(leg.star_name) || leg.destination_is_airport !== 1) return;
  const airport = norm(leg.destination_ident);
  const { last } = firstLastEnrouteIdents(leg);
  chains.star = procedureChain(db, acc, 'star', airport, 'STAR', leg.star_name, leg.star_runway, null, (b, trans, rwy) => {
    addTransition(db, b, pickEnrouteTransition(db, trans, leg.star_transition, last, 'first'));
    addTransition(db, b, trans.find((t) => t.role === 'common'));
    addTransition(db, b, runwayTransitionFor(trans, rwy));
  });
}

function buildApproach(
  db: Database.Database, leg: PlannedLegWithChildren, acc: Accumulator,
  chains: Record<ChainName, GeometryChain>, reference: HeadingReference,
): void {
  const airport = norm(leg.destination_ident);
  if (leg.approach_type === 'CUSTOM') {
    const chain = buildSynthetic(
      db, acc, 'approach', airport, leg.approach_name, leg.approach_runway,
      leg.approach_custom_distance_nm, leg.approach_custom_altitude_ft, leg.approach_custom_offset_deg, reference,
    );
    if (chain) chains.approach = chain;
    return;
  }
  if (!leg.approach_name || !norm(leg.approach_name) || leg.destination_is_airport !== 1) return;
  const anchor = chains.star.points.length
    ? chains.star.points[chains.star.points.length - 1]
    : chains.enroute.points.length
      ? chains.enroute.points[chains.enroute.points.length - 1]
      : null;
  chains.approach = procedureChain(
    db, acc, 'approach', airport, 'APPROACH', leg.approach_name, leg.approach_runway, leg.approach_suffix,
    (b, trans) => {
      const approaches = trans.filter((t) => t.role === 'approach');
      let chosen: TransRow | undefined;
      const wanted = norm(leg.approach_transition);
      if (wanted) chosen = approaches.find((t) => norm(t.name) === wanted);
      if (!chosen && anchor) {
        let bestD = Infinity;
        for (const t of approaches) {
          const first = legsOf(db, t.trans_key).find((l) => validCoordinate(l.fix_lat, l.fix_lon));
          if (!first) continue;
          const d = haversineNm(anchor.lat, anchor.lon, first.fix_lat as number, first.fix_lon as number);
          if (d < bestD) { bestD = d; chosen = t; }
        }
      }
      addTransition(db, b, chosen);
      addTransition(db, b, trans.find((t) => t.role === 'final'));
    },
    { arinc: leg.approach_arinc, typeName: leg.approach_type },
  );
}
