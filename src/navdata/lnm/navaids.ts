// ── Little Navmap navaid converter ───────────────────────────────────────────
//
// Three atools tables feed nav_navaid: vor, ndb and ils. They share one primary
// key (kind, ident, region), so rows collide; the SourceIndex names the winner of
// every key once, and this converter writes the winner and nothing else, with
// ambiguous = 1 where more than one row wanted the key. The losers are not
// written anywhere, so a re-run over the same file yields the same replica.

import type Database from 'better-sqlite3';
import type { ConverterStats, LnmContext, LnmConverter, LnmFlavour, SrcIls } from './types';
import { ftToM, ilsFrequencyHz, magvarToReplica, ndbFrequencyHz, nmToM, vorFrequencyHz } from './units';

const CHUNK_ROWS = 50_000;
const PROGRESS_EVERY = 2_000;

/** The MSFS simulator reception range is 1.5 times the class range the replica stores. */
const MSFS_RANGE_FACTOR = 1.5;

/** Two positions closer than this, in degrees on both axes, are the same site. */
const SAME_SITE_DEG = 0.0005;

const COLUMNS = [
  'kind', 'ident', 'region', 'lat', 'lon', 'alt_m', 'position_source', 'position_fetched_at', 'frequency_hz',
  'nav_type', 'name', 'magvar', 'nav_range_m', 'is_nav', 'is_dme', 'is_tacan', 'has_glide_slope', 'has_back_course',
  'dme_at_nav', 'dme_at_glide_slope', 'localizer_deg', 'localizer_width_deg', 'gs_lat', 'gs_lon', 'gs_alt_m',
  'dme_lat', 'dme_lon', 'dme_alt_m', 'tacan_lat', 'tacan_lon', 'tacan_alt_m', 'airport_ident', 'detail_state',
  'detail_fetched_at', 'ambiguous', 'rev',
] as const;

type NavaidRow = Record<(typeof COLUMNS)[number], string | number | null>;

const INSERT_SQL = `INSERT INTO nav_navaid (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(c => `@${c}`).join(', ')})`;

/** nav_type of a VOR: 1 terminal, 2 low, 3 high. A TACAN-only station has no class. */
const VOR_NAV_TYPE: ReadonlyMap<string, number> = new Map([
  ['H', 3], ['VTH', 3], ['L', 2], ['VTL', 2], ['T', 1], ['VTT', 1],
]);

/** nav_type of an NDB: the simulator's NDB TYPE enumeration. */
const NDB_NAV_TYPE: ReadonlyMap<string, number> = new Map([['CP', 0], ['MH', 1], ['H', 2], ['HH', 3]]);

/** Types whose DME is the TACAN half of the station. */
const TACAN_TYPES: ReadonlySet<string> = new Set(['TC', 'VTH', 'VTL', 'VTT']);

/** nav_type of every ILS the importer keeps. */
const ILS_NAV_TYPE = 4;

interface VorSource {
  vor_id: number; ident: string; name: string | null; region: string; airport_id: number | null; type: string | null;
  frequency: number | null; range: number | null; mag_var: number; dme_only: number;
  dme_altitude: number | null; dme_lonx: number | null; dme_laty: number | null;
  altitude: number | null; lonx: number; laty: number;
}

interface NdbSource {
  ndb_id: number; ident: string; name: string | null; region: string; airport_id: number | null; type: string | null;
  frequency: number; range: number | null; mag_var: number; altitude: number | null; lonx: number; laty: number;
}

interface IlsSource {
  ils_id: number; ident: string; name: string | null; region: string | null; type: string | null;
  frequency: number | null; mag_var: number; has_backcourse: number;
  dme_altitude: number | null; dme_lonx: number | null; dme_laty: number | null;
  gs_altitude: number | null; gs_lonx: number | null; gs_laty: number | null;
  loc_airport_ident: string | null; loc_heading: number | null; loc_width: number | null;
  altitude: number | null; lonx: number; laty: number;
}

/** Whether two optional positions are the same site: both complete and within SAME_SITE_DEG on each axis. */
function sameSite(
  aLat: number | null, aLon: number | null, bLat: number | null, bLon: number | null,
): boolean {
  return aLat != null && aLon != null && bLat != null && bLon != null
    && Math.abs(aLat - bLat) <= SAME_SITE_DEG && Math.abs(aLon - bLon) <= SAME_SITE_DEG;
}

/** Metres from an atools range in nautical miles; MSFS ranges are reduced to the class range. */
function rangeM(range: number | null, flavour: LnmFlavour): number | null {
  const m = nmToM(range);
  return m !== null && flavour === 'MSFS' ? m / MSFS_RANGE_FACTOR : m;
}

/** A zero altitude on a station is the source's "unknown", not sea level. */
const altitudeM = (feet: number | null): number | null => (feet == null || feet === 0 ? null : ftToM(feet));

/** A row with every optional column absent; the three kinds fill in what they have. */
function blankRow(
  ctx: LnmContext, kind: 'V' | 'N', ident: string, region: string, lat: number, lon: number, ambiguous: boolean,
): NavaidRow {
  return {
    kind, ident, region, lat, lon, alt_m: null, position_source: 'facility', position_fetched_at: ctx.now,
    frequency_hz: null, nav_type: null, name: null, magvar: null, nav_range_m: null,
    is_nav: null, is_dme: null, is_tacan: null, has_glide_slope: null, has_back_course: null,
    dme_at_nav: null, dme_at_glide_slope: null, localizer_deg: null, localizer_width_deg: null,
    gs_lat: null, gs_lon: null, gs_alt_m: null, dme_lat: null, dme_lon: null, dme_alt_m: null,
    tacan_lat: null, tacan_lon: null, tacan_alt_m: null, airport_ident: null,
    detail_state: 'detail', detail_fetched_at: ctx.now, ambiguous: ambiguous ? 1 : 0, rev: 1,
  };
}

/** Ident of the airport row an airport_id points at, whether it owns the ident or lost it; null when unset or dangling. */
function airportIdentOf(ctx: LnmContext, airportId: number | null): string | null {
  return airportId == null ? null : ctx.index.airportById(airportId)?.ident ?? null;
}

function vorRow(ctx: LnmContext, r: VorSource, ambiguous: boolean): NavaidRow {
  const isDme = r.dme_lonx != null;
  const isTacan = r.type != null && TACAN_TYPES.has(r.type);
  const dmeAlt = ftToM(r.dme_altitude);
  return {
    ...blankRow(ctx, 'V', r.ident, r.region, r.laty, r.lonx, ambiguous),
    alt_m: ftToM(r.altitude),
    frequency_hz: vorFrequencyHz(r.frequency),
    nav_type: r.type == null ? null : VOR_NAV_TYPE.get(r.type) ?? null,
    name: r.name,
    magvar: magvarToReplica(r.mag_var),
    nav_range_m: rangeM(r.range, ctx.flavour),
    is_nav: !r.dme_only && r.type !== 'TC' ? 1 : 0,
    is_dme: isDme ? 1 : 0,
    is_tacan: isTacan ? 1 : 0,
    has_glide_slope: 0,
    has_back_course: 0,
    dme_at_nav: isDme && sameSite(r.dme_laty, r.dme_lonx, r.laty, r.lonx) ? 1 : 0,
    dme_at_glide_slope: 0,
    dme_lat: r.dme_laty, dme_lon: r.dme_lonx, dme_alt_m: dmeAlt,
    tacan_lat: isTacan ? r.dme_laty : null, tacan_lon: isTacan ? r.dme_lonx : null, tacan_alt_m: isTacan ? dmeAlt : null,
    airport_ident: airportIdentOf(ctx, r.airport_id),
  };
}

/** NDB rows leave every flag, DME and localizer column NULL, as the simulator replica does. */
function ndbRow(ctx: LnmContext, r: NdbSource, ambiguous: boolean): NavaidRow {
  return {
    ...blankRow(ctx, 'N', r.ident, r.region, r.laty, r.lonx, ambiguous),
    alt_m: altitudeM(r.altitude),
    frequency_hz: ndbFrequencyHz(r.frequency),
    nav_type: r.type == null ? null : NDB_NAV_TYPE.get(r.type) ?? null,
    name: r.name,
    magvar: magvarToReplica(r.mag_var),
    nav_range_m: rangeM(r.range, ctx.flavour),
    airport_ident: airportIdentOf(ctx, r.airport_id),
  };
}

function ilsRow(ctx: LnmContext, r: IlsSource, region: string, ambiguous: boolean): NavaidRow {
  const isDme = r.dme_lonx != null;
  return {
    ...blankRow(ctx, 'V', r.ident, region, r.laty, r.lonx, ambiguous),
    alt_m: altitudeM(r.altitude),
    frequency_hz: ilsFrequencyHz(r.frequency),
    nav_type: ILS_NAV_TYPE,
    name: r.name,
    magvar: magvarToReplica(r.mag_var),
    is_nav: 1,
    is_dme: isDme ? 1 : 0,
    is_tacan: 0,
    has_glide_slope: r.gs_lonx != null ? 1 : 0,
    has_back_course: r.has_backcourse ? 1 : 0,
    dme_at_nav: isDme && sameSite(r.dme_laty, r.dme_lonx, r.laty, r.lonx) ? 1 : 0,
    dme_at_glide_slope: sameSite(r.dme_laty, r.dme_lonx, r.gs_laty, r.gs_lonx) ? 1 : 0,
    localizer_deg: r.loc_heading,
    localizer_width_deg: r.loc_width == null || r.loc_width === 0 ? null : r.loc_width,
    gs_lat: r.gs_laty, gs_lon: r.gs_lonx, gs_alt_m: ftToM(r.gs_altitude),
    dme_lat: r.dme_laty, dme_lon: r.dme_lonx, dme_alt_m: ftToM(r.dme_altitude),
    airport_ident: r.loc_airport_ident || null,
  };
}

/** Counts rows left out, keyed by a fixed phrase; the phrases double as the warning text. */
class Skips {
  readonly counts: Record<string, number> = {};

  add(reason: string): void {
    this.counts[reason] = (this.counts[reason] ?? 0) + 1;
  }
}

class NavaidWriter {
  private pending: NavaidRow[] = [];
  private insert: Database.Statement;
  private flushTx: (rows: NavaidRow[]) => void;
  written = 0;

  constructor(out: Database.Database) {
    this.insert = out.prepare(INSERT_SQL);
    this.flushTx = out.transaction((rows: NavaidRow[]) => {
      for (const row of rows) this.insert.run(row);
    });
  }

  add(row: NavaidRow): void {
    this.pending.push(row);
    if (this.pending.length >= CHUNK_ROWS) this.flush();
  }

  flush(): void {
    if (this.pending.length === 0) return;
    this.flushTx(this.pending);
    this.written += this.pending.length;
    this.pending = [];
  }
}

function count(src: Database.Database, table: 'vor' | 'ndb' | 'ils'): number {
  return src.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
}

function run(ctx: LnmContext): ConverterStats {
  const { src, index } = ctx;
  const skips = new Skips();
  const writer = new NavaidWriter(ctx.out);
  const total = count(src, 'vor') + count(src, 'ndb') + count(src, 'ils');
  let done = 0;
  const tick = (): void => {
    if (++done % PROGRESS_EVERY === 0) ctx.progress(done, total);
  };

  const vors = src.prepare(
    `SELECT vor_id, ident, name, COALESCE(region, '') AS region, airport_id, type, frequency, range, mag_var, dme_only,
            dme_altitude, dme_lonx, dme_laty, altitude, lonx, laty
       FROM vor ORDER BY vor_id`,
  );
  for (const r of vors.iterate() as IterableIterator<VorSource>) {
    tick();
    if (!r.ident) {
      skips.add('VOR rows without an ident');
      continue;
    }
    const winner = index.navaidWinner('V', r.ident, r.region);
    if (winner?.table !== 'vor' || winner.id !== r.vor_id) {
      skips.add('VOR rows that lost their key to another station');
      continue;
    }
    writer.add(vorRow(ctx, r, winner.ambiguous));
  }

  const ndbs = src.prepare(
    `SELECT ndb_id, ident, name, COALESCE(region, '') AS region, airport_id, type, frequency, range, mag_var,
            altitude, lonx, laty
       FROM ndb ORDER BY ndb_id`,
  );
  for (const r of ndbs.iterate() as IterableIterator<NdbSource>) {
    tick();
    if (!r.ident) {
      skips.add('NDB rows without an ident');
      continue;
    }
    const winner = index.navaidWinner('N', r.ident, r.region);
    if (winner?.table !== 'ndb' || winner.id !== r.ndb_id) {
      skips.add('NDB rows that lost their key to another station');
      continue;
    }
    writer.add(ndbRow(ctx, r, winner.ambiguous));
  }

  const localizers = src.prepare(
    `SELECT ils_id, ident, name, region, type, frequency, mag_var, has_backcourse, dme_altitude, dme_lonx, dme_laty,
            gs_altitude, gs_lonx, gs_laty, loc_airport_ident, loc_heading, loc_width, altitude, lonx, laty
       FROM ils ORDER BY ils_id`,
  );
  for (const r of localizers.iterate() as IterableIterator<IlsSource>) {
    tick();
    if (r.type === 'G') {
      skips.add('GLS rows, whose frequency column is a channel');
      continue;
    }
    if (!r.ident) {
      skips.add('ILS rows without an ident');
      continue;
    }
    const known: SrcIls | undefined = index.ilsByIdent(r.ident).find(i => i.id === r.ils_id);
    const region = known ? index.ilsRegion(known) : null;
    if (region === null) {
      skips.add('ILS rows with no region and no airport to take one from');
      continue;
    }
    const winner = index.navaidWinner('V', r.ident, region);
    if (winner?.table !== 'ils' || winner.id !== r.ils_id) {
      skips.add('ILS rows that lost their key to another station');
      continue;
    }
    writer.add(ilsRow(ctx, r, region, winner.ambiguous));
  }

  writer.flush();
  ctx.progress(total, total);
  for (const [reason, n] of Object.entries(skips.counts)) ctx.warn(`navaids: skipped ${n} ${reason}`);
  return { written: { nav_navaid: writer.written }, skipped: skips.counts };
}

export const navaidsConverter: LnmConverter = { stage: 'navaids', run };
