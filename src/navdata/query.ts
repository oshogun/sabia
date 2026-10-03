// ── Navdata read side ─────────────────────────────────────────────────────────
//
// What the browser asks of the replica: features in a viewport, replica status,
// one airport's detail, and the manual "please fetch this" request. Every
// function takes the replica handle (or null when the file is absent) and never
// yields, so a swap cannot land between a handle being obtained and its last
// query.

import type Database from 'better-sqlite3';
import { upsertNavdataRequest } from '../db/navdataRequests';
import {
  AIRPORT_TIER_BY_CODE, AIRPORT_TIER_LAST_CODE, AIRPORT_TIER_ZOOM_MIN,
  airportTierFloor, airportTierMapSize, airportTierOf, chooseAirportTier, ensureAirportTierTable,
} from './airportTiers';
import { readNavdataDataset, type NavdataSource } from './dataset';
import { runwayDesignation } from './runwayDesignation';
import { navdataWriteGeneration } from './store';
import type {
  AirportDetailResponse, AirportProcedureSummary, AirportSurface, AirportThinning, AirportTier, FeatureAirport,
  FeatureAirwayLeg, FeatureCoverage, FeatureCoverageKind, FeatureNavaid, FeatureRunway, FeatureWaypoint,
  FeaturesResponse, NavdataStatusResponse,
} from './queryTypes';
import type { SidecarStateRecord } from './sidecarState';
import type { DetailState, NavdataRequestBody, NavdataRequestResponse } from './wire';

export const NAVDATA_ZOOM_MIN = {
  airports: 6, airways: 7, navaids: 8, waypoints: 9, runways: 12,
} as const;

export type FeatureKind = keyof typeof NAVDATA_ZOOM_MIN;
export const FEATURE_KINDS: readonly FeatureKind[] = ['airports', 'navaids', 'waypoints', 'airways', 'runways'];

export const FEATURES_DEFAULT_LIMIT = 2000;
export const FEATURES_MAX_LIMIT = 5000;
export const COVERAGE_MAX_CELLS = 259_200;

const CELL_COLS = 720;
const CELL_ROWS = 360;

// ── bbox ──────────────────────────────────────────────────────────────────────

export type Bbox = [number, number, number, number];
type LonRange = [number, number];

/** null when the string is not four finite numbers forming a legal box. */
export function parseBbox(raw: unknown): Bbox | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',');
  if (parts.length !== 4 || parts.some(p => p.trim() === '')) return null;
  const [w, s, e, n] = parts.map(Number);
  if (![w, s, e, n].every(Number.isFinite)) return null;
  if (s < -90 || n > 90 || s > n) return null;
  if (w < -180 || w > 180 || e < -180 || e > 180) return null;
  return [w, s, e, n];
}

/** w > e crosses the antimeridian; w === e is a zero-width box, not the world. */
export function lonRanges(w: number, e: number): LonRange[] {
  if (w === e) return [];
  return w > e ? [[w, 180], [-180, e]] : [[w, e]];
}

const cellRow = (lat: number): number => Math.min(CELL_ROWS - 1, Math.max(0, Math.floor((lat + 90) * 2)));
const cellCol = (lon: number): number => Math.min(CELL_COLS - 1, Math.max(0, Math.floor((lon + 180) * 2)));

export function totalCells(bbox: Bbox): number {
  const [w, s, e, n] = bbox;
  const latCells = cellRow(n) - cellRow(s) + 1;
  let lonCells = 0;
  for (const [lo, hi] of lonRanges(w, e)) lonCells += cellCol(hi) - cellCol(lo) + 1;
  return Math.min(COVERAGE_MAX_CELLS, latCells * lonCells);
}

// ── features ──────────────────────────────────────────────────────────────────

export interface FeaturesQuery {
  bbox: Bbox;
  zoom: number;
  kinds: readonly FeatureKind[];
  limit: number;
}

interface Extent { clause: string; params: number[] }

/** OR of BETWEEN tests over the longitude ranges, columns given by the caller. */
function lonClause(column: string, ranges: LonRange[]): Extent {
  if (ranges.length === 0) return { clause: '0', params: [] };
  return {
    clause: '(' + ranges.map(() => `${column} BETWEEN ? AND ?`).join(' OR ') + ')',
    params: ranges.flat(),
  };
}

const bool = (v: number | null): boolean | null => (v == null ? null : v === 1);

function emptyCoverageKind(): FeatureCoverageKind {
  return { harvestedCells: 0, fraction: 0, oldestHarvestAt: null, newestHarvestAt: null };
}

type CoverageKindCode = 'V' | 'N' | 'W';

// What a complete replica (a Little Navmap import) looks like in
// nav_coverage_cell: every cell of every kind, all harvested at one instant.
// The probe is one pass over the table per handle and write generation of
// that handle (writes to another handle do not count); an import is never
// written to after its swap, so it runs once there. A replica that is not
// uniformly full (the sparse simulator replica) is remembered as null and
// always takes the bbox query.
const uniformCoverage = new WeakMap<
  Database.Database,
  { generation: number; harvestedAt: Record<CoverageKindCode, number> | null }
>();

function uniformFullCoverage(nav: Database.Database): Record<CoverageKindCode, number> | null {
  const generation = navdataWriteGeneration(nav);
  const hit = uniformCoverage.get(nav);
  if (hit && hit.generation === generation) return hit.harvestedAt;
  const rows = nav.prepare(
    'SELECT kind, COUNT(*) AS cells, MIN(harvested_at) AS oldest, MAX(harvested_at) AS newest FROM nav_coverage_cell GROUP BY kind',
  ).all() as { kind: string; cells: number; oldest: number; newest: number }[];
  const found: Partial<Record<CoverageKindCode, number>> = {};
  for (const r of rows) {
    if ((r.kind === 'V' || r.kind === 'N' || r.kind === 'W') && r.cells === COVERAGE_MAX_CELLS && r.oldest === r.newest) {
      found[r.kind] = r.oldest;
    }
  }
  const harvestedAt = found.V !== undefined && found.N !== undefined && found.W !== undefined
    ? { V: found.V, N: found.N, W: found.W }
    : null;
  uniformCoverage.set(nav, { generation, harvestedAt });
  return harvestedAt;
}

/** Whether no two of the longitude column ranges share a column (they can when a box crosses the antimeridian within one cell). */
function columnsDisjoint(cols: LonRange[]): boolean {
  const sorted = [...cols].sort((a, b) => a[0] - b[0]);
  return sorted.every((c, i) => i === 0 || c[0] > sorted[i - 1][1]);
}

/**
 * Harvest coverage inside a bbox. `fastPath: false` forces the bbox query, which
 * is what the shortcut must agree with.
 */
export function coverageFor(nav: Database.Database | null, bbox: Bbox, fastPath = true): FeatureCoverage {
  const total = totalCells(bbox);
  const byKind: FeatureCoverage['byKind'] = { V: emptyCoverageKind(), N: emptyCoverageKind(), W: emptyCoverageKind() };
  let airportsComplete = false;
  if (nav) {
    const [w, s, e, n] = bbox;
    const cols = lonRanges(w, e).map(([lo, hi]): LonRange => [cellCol(lo), cellCol(hi)]);
    const full = fastPath && cols.length > 0 && columnsDisjoint(cols) ? uniformFullCoverage(nav) : null;
    if (full) {
      // Every cell exists and shares one harvest time, so the bbox query would
      // count exactly the cells of the box and report that time as both ends.
      for (const kind of ['V', 'N', 'W'] as const) {
        byKind[kind] = {
          harvestedCells: total,
          fraction: total === 0 ? 0 : 1,
          oldestHarvestAt: full[kind],
          newestHarvestAt: full[kind],
        };
      }
    } else if (cols.length > 0) {
      const minCell = cellRow(s) * CELL_COLS + Math.min(...cols.map(c => c[0]));
      const maxCell = cellRow(n) * CELL_COLS + Math.max(...cols.map(c => c[1]));
      const colClause = cols.map(() => '(cell_id % 720) BETWEEN ? AND ?').join(' OR ');
      const rows = nav.prepare(
        `SELECT kind, COUNT(*) AS cells, MIN(harvested_at) AS oldest, MAX(harvested_at) AS newest
           FROM nav_coverage_cell
          WHERE cell_id BETWEEN ? AND ? AND (${colClause})
          GROUP BY kind`,
      ).all(minCell, maxCell, ...cols.flat()) as { kind: 'V' | 'N' | 'W'; cells: number; oldest: number; newest: number }[];
      for (const r of rows) {
        if (!byKind[r.kind]) continue;
        byKind[r.kind] = {
          harvestedCells: r.cells,
          fraction: total === 0 ? 0 : r.cells / total,
          oldestHarvestAt: r.oldest,
          newestHarvestAt: r.newest,
        };
      }
    }
    const meta = nav.prepare('SELECT bulk_completed_at FROM nav_meta WHERE id = 1').get() as
      | { bulk_completed_at: number | null }
      | undefined;
    airportsComplete = Boolean(meta && meta.bulk_completed_at != null);
  }
  return { totalCells: total, byKind, airportsComplete };
}

// Four correlated scalar subqueries appended to an airport row aliased `a`.
// The three runway subqueries share the same WHERE/ORDER BY/LIMIT so they
// pick the same row — the surface and heading have to come from the runway
// that supplied the max length, not from independent MAX(surface)/heading
// aggregates. The `rwy_key` tiebreak makes that row a function of the data
// when two runways tie on length.
// MAX(freq_type = 6) answers "towered" in one probe: 1 = a tower frequency
// exists, 0 = frequencies exist but none is a tower, NULL = no frequency rows
// at all (an aggregate over the empty set). The CASE gate skips all four
// probes for an airport whose detail was never fetched.
const AIRPORT_SYMBOL_COLUMNS = `
       CASE WHEN a.detail_state = 'detail' THEN (
         SELECT r.length_m FROM nav_runway r
          WHERE r.airport_ident = a.ident AND r.length_m IS NOT NULL
          ORDER BY r.length_m DESC, r.rwy_key ASC LIMIT 1) END AS longest_length_m,
       CASE WHEN a.detail_state = 'detail' THEN (
         SELECT r.surface FROM nav_runway r
          WHERE r.airport_ident = a.ident AND r.length_m IS NOT NULL
          ORDER BY r.length_m DESC, r.rwy_key ASC LIMIT 1) END AS longest_surface,
       CASE WHEN a.detail_state = 'detail' THEN (
         SELECT r.heading_deg FROM nav_runway r
          WHERE r.airport_ident = a.ident AND r.length_m IS NOT NULL
          ORDER BY r.length_m DESC, r.rwy_key ASC LIMIT 1) END AS longest_heading_deg,
       CASE WHEN a.detail_state = 'detail' THEN (
         SELECT MAX(f.freq_type = 6) FROM nav_airport_frequency f
          WHERE f.airport_ident = a.ident) END AS tower_flag`;

/**
 * The tier of one nav_airport row, as one expression: the sim's own longest
 * runway where the detail was fetched, then the OurAirports class, then 4 for
 * an ident nothing classifies. `alias` is the table reference of the
 * nav_airport row — `nav_airport` inside the features query's unaliased inner
 * select, `a` in the histogram — so the filter and the histogram can never
 * disagree.
 *
 * Three choices here are deliberate; do not simplify them away:
 *  - the outer CASE gates the runway probe on detail_state, so it fires for
 *    the handful of detail-fetched airports instead of every candidate row;
 *  - MAX(length_m) is deliberate where the symbol columns use ORDER BY ...
 *    LIMIT 1 — those need one specific row's surface and heading, this needs
 *    only the maximum, and MAX avoids a sort;
 *  - MAX() over no rows is NULL, so a detail-fetched airport with no usable
 *    runway falls through to the OurAirports class exactly as an unfetched
 *    one would.
 */
export const AIRPORT_TIER_EXPR = (alias: string): string => `COALESCE(
         CASE WHEN ${alias}.detail_state = 'detail' THEN (
           SELECT CASE WHEN MAX(r.length_m) >= 2500 THEN 1
                       WHEN MAX(r.length_m) >= 1200 THEN 2
                       WHEN MAX(r.length_m) IS NOT NULL THEN 3 END
             FROM nav_runway r WHERE r.airport_ident = ${alias}.ident) END,
         (SELECT ti.tier FROM temp.nav_airport_tier ti WHERE ti.ident = ${alias}.ident),
         4)`;

/** The one line added to the features query's inner WHERE when a tier filter
 *  applies. Omitted entirely when the chosen tier is the last one, which
 *  leaves today's statement character for character. Bound parameter: the
 *  chosen tier code. */
const AIRPORT_TIER_FILTER = `AND ${AIRPORT_TIER_EXPR('nav_airport')} <= ?`;

/** Unfiltered per-tier counts for a bbox. No LIMIT on purpose: this is what
 *  makes `hidden` exact and what the tier choice is made from. `lonClauseSql`
 *  is the caller's existing longitude fragment, built for the `a.lon`
 *  column. Parameters: s, n, ...lonClause('a.lon', ranges).params. */
export const AIRPORT_TIER_HISTOGRAM_SQL = (lonClauseSql: string): string =>
  `SELECT ${AIRPORT_TIER_EXPR('a')} AS tier, COUNT(*) AS n
     FROM nav_airport a
    WHERE a.lat BETWEEN ? AND ? AND ${lonClauseSql}
    GROUP BY 1`;

const SURFACE_PAVED = new Set([0, 4, 10, 15, 16, 17, 18, 19, 23, 32]);
const SURFACE_WATER = new Set([2, 26, 27, 28, 29, 30, 31]);

/** Bucket of a raw RUNWAY SURFACE code. null only for a NULL code: an
 *  unrecognised code is an unpaved surface we cannot name, not an unknown one. */
export function surfaceBucket(code: number | null): AirportSurface | null {
  if (code == null) return null;
  if (SURFACE_PAVED.has(code)) return 'paved';
  if (SURFACE_WATER.has(code)) return 'water';
  return 'soft';
}

/** The four symbol fields for one nav_airport row joined with the aggregates
 *  above. Every one of them is null unless the airport's detail has actually
 *  been fetched: an index row knows nothing about runways or frequencies, and
 *  reporting false/'soft'/0 there would claim a fact the replica does not
 *  hold. The SQL above already gates on detail_state; this gates again on
 *  purpose, so the rule holds even if a caller ever queries these columns
 *  through a different SELECT. longestRunwayHeadingDeg has a second, distinct
 *  reason to be null even when longestRunwayM is known: heading_deg is its
 *  own independently-nullable column on nav_runway, not just an "unknown
 *  detail" case. */
function airportSymbolFields(
  r: Record<string, any>, hasDetail: boolean,
): {
  longestRunwayM: number | null; surface: AirportSurface | null; towered: boolean | null;
  longestRunwayHeadingDeg: number | null;
} {
  const longestRunwayM = hasDetail ? r.longest_length_m ?? null : null;
  return {
    longestRunwayM,
    surface: longestRunwayM === null ? null : surfaceBucket(r.longest_surface ?? null),
    towered: hasDetail && r.tower_flag != null ? r.tower_flag === 1 : null,
    longestRunwayHeadingDeg: longestRunwayM === null ? null : (r.longest_heading_deg ?? null),
  };
}

export function queryFeatures(nav: Database.Database | null, q: FeaturesQuery): FeaturesResponse {
  const { bbox, zoom, kinds, limit } = q;
  const [w, s, e, n] = bbox;
  const ranges = lonRanges(w, e);
  const want = new Set(kinds);
  const gated: string[] = [];
  let truncated = false;

  // A kind under its zoom gate is named in gated[] and answers []; a kind not
  // asked for is neither. Beyond that, one query per kind, one row past the
  // limit to detect truncation.
  const fetch = <T, R>(kind: FeatureKind, run: () => T[], map: (row: T) => R): R[] => {
    if (!want.has(kind)) return [];
    if (zoom < NAVDATA_ZOOM_MIN[kind]) {
      gated.push(kind);
      return [];
    }
    if (!nav || ranges.length === 0) return [];
    let rows = run();
    if (rows.length > limit) {
      truncated = true;
      rows = rows.slice(0, limit);
    }
    return rows.map(map);
  };

  const pointClause = lonClause('lon', ranges);

  // Overwritten only when the airports branch actually ran a tier decision;
  // every other outcome (kind not requested, zoom-gated, no replica, no
  // classification data loaded) leaves airportThinning at mode 'none', with no
  // tier decision reported.
  let airportThinning: AirportThinning = { mode: 'none', through: null, hidden: 0, byTier: null, nextZoom: null };

  const unfilteredAirportsSql = `
       SELECT a.*, ${AIRPORT_SYMBOL_COLUMNS}
         FROM (SELECT ident, lat, lon, name, detail_state, detail_runways, detail_procedures,
                      n_runways, n_approaches, n_departures, n_arrivals
                 FROM nav_airport
                WHERE lat BETWEEN ? AND ? AND ${pointClause.clause}
                ORDER BY ident ASC LIMIT ?) a`;

  const airports = fetch(
    'airports',
    () => {
      ensureAirportTierTable(nav!);

      // No classification data loaded. The query stays exactly what it is
      // today, and no tier is ever consulted — a caller that never touches
      // this feature sees no behaviour change at all.
      if (airportTierMapSize() === 0) {
        return nav!.prepare(unfilteredAirportsSql).all(s, n, ...pointClause.params, limit + 1) as Record<string, any>[];
      }

      const floor = airportTierFloor(zoom);
      if (floor === AIRPORT_TIER_LAST_CODE) {
        // The common zoomed-in case: every tier is already admitted by zoom
        // alone, so no histogram is worth running.
        return nav!.prepare(unfilteredAirportsSql).all(s, n, ...pointClause.params, limit + 1) as Record<string, any>[];
      }

      const histClause = lonClause('a.lon', ranges);
      const histRows = nav!.prepare(AIRPORT_TIER_HISTOGRAM_SQL(histClause.clause)).all(
        s, n, ...histClause.params,
      ) as { tier: number; n: number }[];
      const byCode: Record<number, number> = {};
      for (const row of histRows) byCode[row.tier] = row.n;
      const byTier: Record<AirportTier, number> = {
        large: byCode[1] ?? 0, medium: byCode[2] ?? 0, small: byCode[3] ?? 0,
        unknown: byCode[4] ?? 0, other: byCode[5] ?? 0,
      };

      const chosen = chooseAirportTier(byCode, zoom);
      if (chosen === AIRPORT_TIER_LAST_CODE) {
        // Not reached with the current constants: a floor of
        // AIRPORT_TIER_LAST_CODE returned above, and chooseAirportTier() never
        // lifts past AIRPORT_TIER_LAST_CLASSIFIED_CODE. Kept so that a future
        // change to those constants still runs the unfiltered query when every
        // tier is admitted, reporting the counts that were measured.
        airportThinning = { mode: 'none', through: null, hidden: 0, byTier, nextZoom: null };
        return nav!.prepare(unfilteredAirportsSql).all(s, n, ...pointClause.params, limit + 1) as Record<string, any>[];
      }

      let cumThrough = 0;
      for (let t = 1; t <= chosen; t++) cumThrough += byCode[t] ?? 0;
      const total = byTier.large + byTier.medium + byTier.small + byTier.unknown + byTier.other;
      airportThinning = {
        mode: 'tier',
        through: AIRPORT_TIER_BY_CODE[chosen] as AirportTier,
        hidden: total - cumThrough,
        byTier,
        nextZoom: AIRPORT_TIER_ZOOM_MIN[AIRPORT_TIER_BY_CODE[chosen + 1] as AirportTier],
      };
      return nav!.prepare(
        `SELECT a.*, ${AIRPORT_SYMBOL_COLUMNS}
           FROM (SELECT ident, lat, lon, name, detail_state, detail_runways, detail_procedures,
                        n_runways, n_approaches, n_departures, n_arrivals
                   FROM nav_airport
                  WHERE lat BETWEEN ? AND ? AND ${pointClause.clause}
                  ${AIRPORT_TIER_FILTER}
                  ORDER BY ident ASC LIMIT ?) a`,
      ).all(s, n, ...pointClause.params, chosen, limit + 1) as Record<string, any>[];
    },
    (r): FeatureAirport => {
      const hasDetail = r.detail_state === 'detail';
      const listed = [r.n_approaches, r.n_departures, r.n_arrivals];
      const symbolFields = airportSymbolFields(r, hasDetail);
      return {
        ident: r.ident, lat: r.lat, lon: r.lon, name: r.name, hasDetail,
        runways: hasDetail ? r.detail_runways : r.n_runways,
        procedures: hasDetail
          ? r.detail_procedures
          : listed.every(v => v == null) ? null : listed.reduce((a, v) => a + (v ?? 0), 0),
        ...symbolFields,
        tier: airportTierOf(r.ident, symbolFields.longestRunwayM),
      };
    },
  );

  const navaids = fetch(
    'navaids',
    () => nav!.prepare(
      `SELECT kind, ident, region, lat, lon, frequency_hz, name, nav_type, is_dme, is_nav, is_tacan, magvar
         FROM nav_navaid
        WHERE lat BETWEEN ? AND ? AND ${pointClause.clause}
        ORDER BY kind, ident, region ASC LIMIT ?`,
    ).all(s, n, ...pointClause.params, limit + 1) as Record<string, any>[],
    (r): FeatureNavaid => ({
      kind: r.kind, ident: r.ident, region: r.region, lat: r.lat, lon: r.lon,
      frequencyHz: r.frequency_hz, name: r.name, navType: r.nav_type, isDme: bool(r.is_dme),
      isNav: bool(r.is_nav), isTacan: bool(r.is_tacan), magvar: r.magvar ?? null,
    }),
  );

  const waypoints = fetch(
    'waypoints',
    () => nav!.prepare(
      `SELECT wpt_key, ident, region, lat, lon, is_terminal
         FROM nav_waypoint
        WHERE lat BETWEEN ? AND ? AND ${pointClause.clause}
        ORDER BY wpt_key ASC LIMIT ?`,
    ).all(s, n, ...pointClause.params, limit + 1) as Record<string, any>[],
    (r): FeatureWaypoint => ({
      key: r.wpt_key, ident: r.ident, region: r.region, lat: r.lat, lon: r.lon, terminal: bool(r.is_terminal),
    }),
  );

  // A dateline row's min_lon/max_lon mean nothing. Such a leg crosses the
  // antimeridian, so it covers [max(from,to), 180] and [-180, min(from,to)];
  // it matches a longitude range only when that range reaches either part.
  const airways = fetch(
    'airways',
    () => {
      const overlap = ranges.map(() => '(max_lon >= ? AND min_lon <= ?)').join(' OR ');
      const wrapped = ranges.map(() => '(? >= MAX(from_lon, to_lon) OR ? <= MIN(from_lon, to_lon))').join(' OR ');
      return nav!.prepare(
        `SELECT airway, from_lat, from_lon, to_lat, to_lon, from_ident, to_ident, dateline
           FROM nav_airway_leg
          WHERE max_lat >= ? AND min_lat <= ?
            AND ((dateline = 0 AND (${overlap})) OR (dateline = 1 AND (${wrapped})))
          ORDER BY leg_key ASC LIMIT ?`,
      ).all(s, n, ...ranges.flat(), ...ranges.map(([w, e]) => [e, w]).flat(), limit + 1) as Record<string, any>[];
    },
    (r): FeatureAirwayLeg => ({
      airway: r.airway, from: [r.from_lat, r.from_lon], to: [r.to_lat, r.to_lon],
      fromIdent: r.from_ident, toIdent: r.to_ident, dateline: r.dateline === 1,
    }),
  );

  const runways = fetch(
    'runways',
    () => nav!.prepare(
      `SELECT airport_ident, lat, lon, heading_deg, length_m, width_m,
              primary_number, primary_designator, secondary_number, secondary_designator
         FROM nav_runway
        WHERE lat IS NOT NULL AND lon IS NOT NULL AND lat BETWEEN ? AND ? AND ${pointClause.clause}
        ORDER BY rwy_key ASC LIMIT ?`,
    ).all(s, n, ...pointClause.params, limit + 1) as Record<string, any>[],
    runwayFeature,
  );

  return {
    bbox, zoom, gated, truncated, limit,
    airports, navaids, waypoints, airways, runways,
    coverage: coverageFor(nav, bbox),
    airportThinning,
  };
}

function runwayFeature(r: Record<string, any>): FeatureRunway {
  return {
    airport: r.airport_ident, lat: r.lat, lon: r.lon,
    headingDeg: r.heading_deg, lengthM: r.length_m, widthM: r.width_m,
    designation: runwayDesignation(r.primary_number, r.primary_designator),
    secondaryDesignation: runwayDesignation(r.secondary_number, r.secondary_designator),
  };
}

// ── status ────────────────────────────────────────────────────────────────────

export interface StatusSource {
  /** The source that answered. */
  source: NavdataSource;
  /** The stored choice. */
  selectedSource: NavdataSource;
}

/**
 * `sidecar` and `lastRowsAt` always describe the simulator feed, which keeps
 * syncing while Little Navmap data is shown. `src` names the source behind
 * `nav`; `now` decides the dataset's expiry.
 */
export function readStatus(
  nav: Database.Database | null,
  sidecar: SidecarStateRecord | null,
  lastRowsAt: number | null,
  src: StatusSource = { source: 'mcdu', selectedSource: 'mcdu' },
  now: number = Date.now(),
): NavdataStatusResponse {
  const sidecarOut = sidecar ? { state: sidecar.state, reason: sidecar.reason } : null;
  const sourceFields = {
    source: src.source,
    selectedSource: src.selectedSource,
    sourceFallback: src.selectedSource === 'lnm' && src.source === 'mcdu' ? 'lnm-unavailable' as const : null,
  };
  const absent: NavdataStatusResponse = {
    present: false, schemaVersion: null, snapshotId: null, rev: null, simId: null,
    simAppName: null, simAppVersion: null, snapshotAppliedAt: null, lastRowsAt: null,
    counts: null, sidecar: sidecarOut, ...sourceFields, dataset: null,
  };
  if (!nav) return absent;
  const meta = nav.prepare(
    'SELECT schema_version, snapshot_id, rev, sim_id, sim_app_name, sim_app_version, created_at FROM nav_meta WHERE id = 1',
  ).get() as Record<string, any> | undefined;
  if (!meta) return absent;

  const count = (sql: string): number => (nav.prepare(sql).get() as { c: number }).c;
  return {
    present: true,
    schemaVersion: meta.schema_version,
    snapshotId: meta.snapshot_id,
    rev: meta.rev,
    simId: meta.sim_id,
    simAppName: meta.sim_app_name,
    simAppVersion: meta.sim_app_version,
    snapshotAppliedAt: meta.created_at,
    lastRowsAt,
    counts: {
      airports: count('SELECT COUNT(*) AS c FROM nav_airport'),
      airportsWithDetail: count("SELECT COUNT(*) AS c FROM nav_airport WHERE detail_state = 'detail'"),
      navaids: count('SELECT COUNT(*) AS c FROM nav_navaid'),
      waypoints: count('SELECT COUNT(*) AS c FROM nav_waypoint'),
      airwayLegs: count('SELECT COUNT(*) AS c FROM nav_airway_leg'),
      runways: count('SELECT COUNT(*) AS c FROM nav_runway'),
      procedures: count('SELECT COUNT(*) AS c FROM nav_procedure'),
      coverageCells: count('SELECT COUNT(*) AS c FROM nav_coverage_cell'),
      absent: count('SELECT COUNT(*) AS c FROM nav_absent'),
    },
    sidecar: sidecarOut,
    ...sourceFields,
    dataset: readNavdataDataset(nav, src.source, now),
  };
}

// ── airport detail ────────────────────────────────────────────────────────────

/** null when the replica is absent or the ident is not in the index. */
export function readAirportDetail(nav: Database.Database | null, rawIdent: string): AirportDetailResponse | null {
  if (!nav) return null;
  const ident = rawIdent.trim().toUpperCase();
  const a = nav.prepare(
    `SELECT a.ident, a.lat, a.lon, a.alt_m, a.name, a.magvar, a.detail_state, a.detail_fetched_at,
            ${AIRPORT_SYMBOL_COLUMNS}
       FROM nav_airport a WHERE a.ident = ?`,
  ).get(ident) as Record<string, any> | undefined;
  if (!a) return null;

  const runways = (nav.prepare(
    `SELECT airport_ident, lat, lon, heading_deg, length_m, width_m,
            primary_number, primary_designator, secondary_number, secondary_designator
       FROM nav_runway WHERE airport_ident = ? AND lat IS NOT NULL AND lon IS NOT NULL
      ORDER BY primary_number, primary_designator`,
  ).all(ident) as Record<string, any>[]).map(runwayFeature);

  const frequencies = (nav.prepare(
    'SELECT freq_type, frequency_hz, name FROM nav_airport_frequency WHERE airport_ident = ? ORDER BY freq_type, frequency_hz',
  ).all(ident) as Record<string, any>[]).map(f => ({
    type: f.freq_type as number | null, frequencyHz: f.frequency_hz as number | null, name: f.name as string | null,
  }));

  const transitionStmt = nav.prepare(
    `SELECT t.trans_key, t.role, t.name,
            COALESCE(t.n_legs, (SELECT COUNT(*) FROM nav_procedure_leg l WHERE l.trans_key = t.trans_key)) AS legs
       FROM nav_procedure_transition t WHERE t.proc_key = ? ORDER BY t.trans_key`,
  );
  const procedures = (nav.prepare(
    `SELECT proc_key, kind, name, runway_number, runway_designator
       FROM nav_procedure WHERE airport_ident = ? ORDER BY kind, name, proc_key`,
  ).all(ident) as Record<string, any>[]).map((p): AirportProcedureSummary => ({
    key: p.proc_key, kind: p.kind, name: p.name,
    runway: p.runway_number == null ? null : runwayDesignation(p.runway_number, p.runway_designator) || null,
    transitions: (transitionStmt.all(p.proc_key) as Record<string, any>[]).map(t => ({
      key: t.trans_key, role: t.role, name: t.name, legs: t.legs,
    })),
  }));

  return {
    ident: a.ident, detailState: a.detail_state as DetailState, detailFetchedAt: a.detail_fetched_at,
    lat: a.lat, lon: a.lon, altM: a.alt_m, name: a.name, magvar: a.magvar,
    runways, frequencies, procedures,
    ...airportSymbolFields(a, a.detail_state === 'detail'),
  };
}

// ── manual requests ───────────────────────────────────────────────────────────

const REQUEST_IDENT = /^[A-Z0-9]{1,8}$/;
const REQUEST_REGION = /^[A-Z0-9]{1,4}$/;

export interface ParsedRequest { kind: 'A' | 'W'; ident: string; region: string | null; force: boolean }

/** A parsed request, or the one-line reason it was refused. */
export function parseRequestBody(body: unknown): ParsedRequest | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Request body must be an object' };
  const b = body as Partial<NavdataRequestBody>;
  if (b.kind !== 'A' && b.kind !== 'W') return { error: "kind must be 'A' or 'W'" };
  const ident = typeof b.ident === 'string' ? b.ident.trim().toUpperCase() : '';
  if (!REQUEST_IDENT.test(ident)) return { error: 'ident must be 1-8 letters or digits' };
  let region: string | null = null;
  if (b.region != null && b.region !== '') {
    region = typeof b.region === 'string' ? b.region.trim().toUpperCase() : '';
    if (!REQUEST_REGION.test(region)) return { error: 'region must be 1-4 letters or digits' };
  }
  return { kind: b.kind, ident, region, force: b.force === true };
}

function isAbsent(nav: Database.Database, req: ParsedRequest): boolean {
  if (req.kind === 'A') {
    return Boolean(
      nav.prepare("SELECT 1 FROM nav_absent WHERE kind = 'A' AND ident = ?").get(req.ident) ||
        nav.prepare("SELECT 1 FROM nav_airport WHERE ident = ? AND detail_state = 'absent'").get(req.ident),
    );
  }
  return Boolean(
    req.region === null
      ? nav.prepare("SELECT 1 FROM nav_absent WHERE kind = 'W' AND ident = ?").get(req.ident)
      : nav.prepare("SELECT 1 FROM nav_absent WHERE kind = 'W' AND ident = ? AND region = ?").get(req.ident, req.region),
  );
}

function isHeld(nav: Database.Database, req: ParsedRequest): boolean {
  if (req.kind === 'A') {
    return Boolean(
      nav.prepare("SELECT 1 FROM nav_airport WHERE ident = ? AND detail_state IN ('detail', 'absent')").get(req.ident),
    );
  }
  const r = req.region;
  return Boolean(
    r === null
      ? nav.prepare('SELECT 1 FROM nav_waypoint WHERE ident = ?').get(req.ident) ||
          nav.prepare('SELECT 1 FROM nav_navaid WHERE ident = ?').get(req.ident)
      : nav.prepare('SELECT 1 FROM nav_waypoint WHERE ident = ? AND region = ?').get(req.ident, r) ||
          nav.prepare('SELECT 1 FROM nav_navaid WHERE ident = ? AND region = ?').get(req.ident, r),
  );
}

export interface SubmitRequestOptions {
  /** The replica is a complete dataset (a Little Navmap import): there is nothing
   *  the sidecar could fetch, so the answer comes from the replica alone and
   *  nothing is queued. */
  completeDataset?: boolean;
}

/**
 * Answers a manual request: a recorded absence wins over a held row (it is the
 * more specific fact), and either short-circuits unless force is set. Only
 * "queued" writes anything, and it writes flights.db, never the replica. On a
 * complete dataset nothing is ever queued and force is ignored: a held row is
 * "already-present", anything else is "known-absent".
 */
export function submitRequest(
  nav: Database.Database | null,
  req: ParsedRequest,
  options: SubmitRequestOptions = {},
): NavdataRequestResponse {
  if (options.completeDataset) {
    return { ok: true, state: nav && isHeld(nav, req) ? 'already-present' : 'known-absent', ident: req.ident };
  }
  if (nav && !req.force) {
    if (isAbsent(nav, req)) return { ok: true, state: 'known-absent', ident: req.ident };
    if (isHeld(nav, req)) return { ok: true, state: 'already-present', ident: req.ident };
  }
  upsertNavdataRequest(req.kind, req.ident, req.region);
  return { ok: true, state: 'queued', ident: req.ident };
}
