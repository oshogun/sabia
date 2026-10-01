// ── Little Navmap waypoint converter ─────────────────────────────────────────
//
// nav_waypoint holds every fix of the atools waypoint table except LNM's own
// copies of VORs and NDBs (types V and N, which nav_navaid owns). That includes
// the VFR and RNAV points of the MSFS flavour: airways end on them, and plans
// name them.
//
// The key is position-qualified and rounded, so two source rows can share one:
// a fix stored once as an enroute point and once as a terminal copy, positions
// a hair apart. They merge into one row. An enroute row wins over a terminal
// one, otherwise the lowest waypoint_id; a merged row is terminal only when
// every member was.

import type Database from 'better-sqlite3';
import { wptKey } from '../keys';
import type { ConverterStats, LnmContext, LnmConverter } from './types';
import { magvarToReplica } from './units';

const CHUNK_ROWS = 50_000;
const PROGRESS_EVERY = 10_000;

/** wpt_type of the atools waypoint types; anything else is NULL. */
const WPT_TYPE: ReadonlyMap<string, number> = new Map([['WN', 1], ['WU', 2], ['RNAV', 8], ['VFR', 9]]);

interface WaypointSource {
  waypoint_id: number; ident: string; region: string; type: string | null; airport_id: number | null;
  mag_var: number; lonx: number; laty: number;
}

interface WaypointRow {
  wpt_key: string; ident: string; region: string; lat: number; lon: number; magvar: number;
  wpt_type: number | null; is_terminal: number; airport_ident: string | null;
}

// Rows arrive in ascending waypoint_id, so a later row beats the stored one only
// when the stored one is terminal and the later one is enroute; equal rank keeps
// the lowest id. The merged position is the winner's own, not the first one seen.
const UPSERT_SQL = `
INSERT INTO nav_waypoint (
  wpt_key, ident, region, lat, lon, alt_m, magvar, wpt_type, is_terminal, airport_ident, n_routes,
  routes_state, routes_fetched_at, position_source, rev
) VALUES (
  @wpt_key, @ident, @region, @lat, @lon, NULL, @magvar, @wpt_type, @is_terminal, @airport_ident, 0,
  'fetched', @now, 'facility', 1
)
ON CONFLICT (wpt_key) DO UPDATE SET
  ident = excluded.ident, region = excluded.region, lat = excluded.lat, lon = excluded.lon,
  magvar = excluded.magvar, wpt_type = excluded.wpt_type, is_terminal = excluded.is_terminal,
  airport_ident = excluded.airport_ident
WHERE nav_waypoint.is_terminal = 1 AND excluded.is_terminal = 0`;

function run(ctx: LnmContext): ConverterStats {
  const { src, out, index, now } = ctx;
  const upsert = out.prepare(UPSERT_SQL);
  const writeChunk = out.transaction((rows: WaypointRow[]) => {
    for (const row of rows) upsert.run({ ...row, now });
  });
  const countRows = (db: Database.Database): number =>
    db.prepare('SELECT COUNT(*) FROM nav_waypoint').pluck().get() as number;

  const before = countRows(out);
  const total = src.prepare(
    `SELECT COUNT(*) FROM waypoint WHERE ident <> '' AND (type IS NULL OR type NOT IN ('V', 'N'))`,
  ).pluck().get() as number;

  const rows = src.prepare(
    `SELECT waypoint_id, ident, COALESCE(region, '') AS region, type, airport_id, mag_var, lonx, laty
       FROM waypoint
      WHERE ident <> '' AND (type IS NULL OR type NOT IN ('V', 'N'))
      ORDER BY waypoint_id`,
  );

  let pending: WaypointRow[] = [];
  let done = 0;
  for (const r of rows.iterate() as IterableIterator<WaypointSource>) {
    pending.push({
      wpt_key: wptKey(r.ident, r.region, r.laty, r.lonx),
      ident: r.ident,
      region: r.region,
      lat: r.laty,
      lon: r.lonx,
      magvar: magvarToReplica(r.mag_var),
      wpt_type: r.type == null ? null : WPT_TYPE.get(r.type) ?? null,
      is_terminal: r.airport_id == null ? 0 : 1,
      airport_ident: r.airport_id == null ? null : index.airportById(r.airport_id)?.ident ?? null,
    });
    done++;
    if (pending.length >= CHUNK_ROWS) {
      writeChunk(pending);
      pending = [];
    }
    if (done % PROGRESS_EVERY === 0) ctx.progress(done, total);
  }
  if (pending.length > 0) writeChunk(pending);
  ctx.progress(total, total);

  const written = countRows(out) - before;
  const merged = done - written;
  const skipped: Record<string, number> = {};
  if (merged > 0) {
    skipped['waypoint rows merged into another with the same key'] = merged;
    ctx.warn(`waypoints: merged ${merged} rows into another waypoint with the same key`);
  }
  return { written: { nav_waypoint: written }, skipped };
}

export const waypointsConverter: LnmConverter = { stage: 'waypoints', run };
