// ── Little Navmap airway converter ───────────────────────────────────────────
//
// One nav_airway_leg row per atools airway row. A leg's two ends are waypoint
// ids, and what a waypoint id stands for depends on its type: an artificial
// V waypoint is a VOR, an artificial N waypoint an NDB, anything else a fix of
// its own. vor_id and ndb_id are separate id spaces that overlap, so the type
// decides which table an id is looked up in; resolving without it puts a
// station on the wrong position.
//
// Positions come from the resolved row's own double-precision columns. The
// float32 from_*/to_* columns of the airway row would round to a different
// key for about one endpoint in five on a Navigraph file.

import { legKey, wptKey } from '../keys';
import type { ConverterStats, LnmContext, LnmConverter } from './types';

const CHUNK_ROWS = 50_000;
const PROGRESS_EVERY = 10_000;

/** airway_type of the atools letters: Victor, jet, both. Anything else is NULL. */
const AIRWAY_TYPE: ReadonlyMap<string, number> = new Map([['V', 1], ['J', 2], ['B', 3]]);

// Both endpoint lookups gate the navaid join on the waypoint's type, inside the
// ON clause, so a V waypoint can only ever meet a vor and an N waypoint an ndb.
// A position that comes back NULL means the waypoint or its navaid is missing.
const SOURCE_SQL = `
SELECT a.airway_id AS id, a.airway_name AS airway, a.airway_type AS type,
       fw.ident AS fromIdent, COALESCE(fw.region, '') AS fromRegion,
       CASE fw.type WHEN 'V' THEN fv.laty WHEN 'N' THEN fn.laty ELSE fw.laty END AS fromLat,
       CASE fw.type WHEN 'V' THEN fv.lonx WHEN 'N' THEN fn.lonx ELSE fw.lonx END AS fromLon,
       tw.ident AS toIdent, COALESCE(tw.region, '') AS toRegion,
       CASE tw.type WHEN 'V' THEN tv.laty WHEN 'N' THEN tn.laty ELSE tw.laty END AS toLat,
       CASE tw.type WHEN 'V' THEN tv.lonx WHEN 'N' THEN tn.lonx ELSE tw.lonx END AS toLon
  FROM airway a
  LEFT JOIN waypoint fw ON fw.waypoint_id = a.from_waypoint_id
  LEFT JOIN vor fv ON fw.type = 'V' AND fv.vor_id = fw.nav_id
  LEFT JOIN ndb fn ON fw.type = 'N' AND fn.ndb_id = fw.nav_id
  LEFT JOIN waypoint tw ON tw.waypoint_id = a.to_waypoint_id
  LEFT JOIN vor tv ON tw.type = 'V' AND tv.vor_id = tw.nav_id
  LEFT JOIN ndb tn ON tw.type = 'N' AND tn.ndb_id = tw.nav_id
 ORDER BY a.airway_id`;

interface LegSource {
  id: number; airway: string; type: string | null;
  fromIdent: string | null; fromRegion: string; fromLat: number | null; fromLon: number | null;
  toIdent: string | null; toRegion: string; toLat: number | null; toLon: number | null;
}

interface LegRow {
  leg_key: string; airway: string; airway_type: number | null;
  from_key: string; to_key: string;
  from_ident: string; from_region: string; from_lat: number; from_lon: number;
  to_ident: string; to_region: string; to_lat: number; to_lon: number;
  min_lat: number; max_lat: number; min_lon: number; max_lon: number; dateline: number;
}

// A leg met twice (the same airway and endpoints in either direction) keeps the
// first row; the second is dropped by the key and counted from the change count.
const INSERT_SQL = `
INSERT INTO nav_airway_leg (
  leg_key, airway, airway_type, from_key, to_key, from_ident, from_region, from_lat, from_lon,
  to_ident, to_region, to_lat, to_lon, min_lat, max_lat, min_lon, max_lon, dateline, rev
) VALUES (
  @leg_key, @airway, @airway_type, @from_key, @to_key, @from_ident, @from_region, @from_lat, @from_lon,
  @to_ident, @to_region, @to_lat, @to_lon, @min_lat, @max_lat, @min_lon, @max_lon, @dateline, 1
)
ON CONFLICT (leg_key) DO NOTHING`;

class Skips {
  readonly counts: Record<string, number> = {};

  add(reason: string): void {
    this.counts[reason] = (this.counts[reason] ?? 0) + 1;
  }
}

interface End { ident: string; region: string; lat: number; lon: number }

function legOf(airway: string, type: string | null, from: End, to: End): LegRow | null {
  const fromKey = wptKey(from.ident, from.region, from.lat, from.lon);
  const toKey = wptKey(to.ident, to.region, to.lat, to.lon);
  if (fromKey === toKey) return null;
  return {
    leg_key: legKey(airway, fromKey, toKey),
    airway,
    airway_type: type == null ? null : AIRWAY_TYPE.get(type) ?? null,
    from_key: fromKey, to_key: toKey,
    from_ident: from.ident, from_region: from.region, from_lat: from.lat, from_lon: from.lon,
    to_ident: to.ident, to_region: to.region, to_lat: to.lat, to_lon: to.lon,
    min_lat: Math.min(from.lat, to.lat), max_lat: Math.max(from.lat, to.lat),
    min_lon: Math.min(from.lon, to.lon), max_lon: Math.max(from.lon, to.lon),
    dateline: Math.abs(from.lon - to.lon) > 180 ? 1 : 0,
  };
}

function run(ctx: LnmContext): ConverterStats {
  const { src, out } = ctx;
  const skips = new Skips();
  const insert = out.prepare(INSERT_SQL);
  let written = 0;
  const writeChunk = out.transaction((rows: LegRow[]) => {
    for (const row of rows) {
      if (insert.run(row).changes === 0) skips.add('airway legs repeating another leg');
      else written++;
    }
  });

  const total = src.prepare('SELECT COUNT(*) FROM airway').pluck().get() as number;
  let pending: LegRow[] = [];
  let done = 0;
  for (const r of src.prepare(SOURCE_SQL).iterate() as IterableIterator<LegSource>) {
    done++;
    if (r.fromIdent === null || r.toIdent === null || r.fromLat === null || r.fromLon === null
      || r.toLat === null || r.toLon === null) {
      skips.add('airway legs with an endpoint that does not exist');
    } else {
      const leg = legOf(
        r.airway, r.type,
        { ident: r.fromIdent, region: r.fromRegion, lat: r.fromLat, lon: r.fromLon },
        { ident: r.toIdent, region: r.toRegion, lat: r.toLat, lon: r.toLon },
      );
      if (leg) pending.push(leg);
      else skips.add('airway legs that start and end on the same fix');
    }
    if (pending.length >= CHUNK_ROWS) {
      writeChunk(pending);
      pending = [];
    }
    if (done % PROGRESS_EVERY === 0) ctx.progress(done, total);
  }
  if (pending.length > 0) writeChunk(pending);
  ctx.progress(total, total);

  for (const [reason, n] of Object.entries(skips.counts)) ctx.warn(`airways: skipped ${n} ${reason}`);
  return { written: { nav_airway_leg: written }, skipped: skips.counts };
}

export const airwaysConverter: LnmConverter = { stage: 'airways', run };
