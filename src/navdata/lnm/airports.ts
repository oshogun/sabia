// ── Little Navmap converter: airports, runways, frequencies ──────────────────
//
// Fills nav_airport, nav_runway and nav_airport_frequency from the atools
// airport, runway / runway_end and com tables. Only the owner row of each
// airport ident is imported (SourceIndex.airportOwnerId), and everything that
// hangs off a losing duplicate or off no airport at all is dropped and counted.
// Closed airports and add-on airports are imported like any other.
//
// The procedure counters on nav_airport are written as 0; the pipeline
// finalises them once the procedures exist. n_runways and detail_runways are
// written here, from the runways actually kept.

import type Database from 'better-sqlite3';
import { parseRunway } from '../keys';
import type { ConverterStats, LnmContext, LnmConverter, SourceIndex } from './types';
import { comFrequencyHz, ftToM, magvarToReplica, stripTrueSuffix } from './units';

/** Rows per transaction. */
const CHUNK_ROWS = 50_000;

// ── Enumerations ─────────────────────────────────────────────────────────────

/**
 * atools runway.surface to the simulator's RUNWAY SURFACE value. A code not
 * listed (UNKNOWN, NULL, anything new) has no value: a NULL surface reads as
 * "not known" where a wrong number would read as soft.
 */
const SURFACE_CODE: ReadonlyMap<string, number> = new Map([
  ['CE', 0], ['G', 1], ['W', 2], ['A', 4], ['SN', 8], ['I', 9], ['D', 12], ['CR', 13], ['GR', 14], ['OT', 15],
  ['SM', 16], ['B', 17], ['BR', 18], ['M', 19], ['PL', 20], ['S', 21], ['SH', 22], ['T', 23],
]);

export function surfaceCodeOf(surface: string | null | undefined): number | null {
  return (surface == null ? undefined : SURFACE_CODE.get(surface)) ?? null;
}

/**
 * atools com.type to the simulator's FREQUENCY TYPE value. Both vocabularies
 * are folded into one table; the Navigraph-only codes go to the type they mean.
 */
const FREQUENCY_TYPE: ReadonlyMap<string, number> = new Map([
  ['ATIS', 1], ['MC', 2], ['UC', 3], ['CTAF', 4], ['G', 5], ['T', 6], ['C', 7],
  ['A', 8], ['ARR', 8], ['DIR', 8], ['TCA', 8], ['TMA', 8], ['TML', 8], ['RDR', 8],
  ['D', 9], ['CTR', 10], ['CTL', 10], ['CTA', 10], ['FSS', 11], ['RDO', 11],
  ['AWOS', 12], ['AWI', 12], ['AWS', 12], ['ASOS', 13], ['CPT', 14], ['GCO', 15],
]);

/** The FREQUENCY TYPE value, or undefined when the replica has no value for the atools type. */
export function frequencyTypeOf(type: string | null | undefined): number | undefined {
  return type == null ? undefined : FREQUENCY_TYPE.get(type);
}

// ── Chunked writing ──────────────────────────────────────────────────────────

/** Buffers rows and writes them in transactions of at most CHUNK_ROWS rows. */
class ChunkWriter<T> {
  private pending: T[] = [];
  private readonly write: (rows: T[]) => void;

  constructor(out: Database.Database, insert: (row: T) => void, private readonly onFlush: () => void) {
    this.write = out.transaction((rows: T[]) => {
      for (const row of rows) insert(row);
    });
  }

  add(row: T): void {
    this.pending.push(row);
    if (this.pending.length >= CHUNK_ROWS) this.flush();
  }

  flush(): void {
    if (this.pending.length === 0) return;
    this.write(this.pending);
    this.pending = [];
    this.onFlush();
  }
}

// ── Rows ─────────────────────────────────────────────────────────────────────

interface AirportSource {
  airport_id: number; ident: string; region: string; lat: number; lon: number; altitude: number;
  mag_var: number; name: string | null; is_closed: number;
}
interface AirportRow {
  ident: string; region: string; lat: number; lon: number; alt_m: number; magvar: number; name: string | null;
  runways: number;
}

interface RunwaySource {
  runwayId: number; airportId: number;
  surface: string | null; length: number; width: number; heading: number; patternFt: number | null;
  altFt: number; lat: number; lon: number;
  pId: number | null; pName: string | null; pOffsetFt: number | null; pIls: string | null;
  sId: number | null; sName: string | null; sOffsetFt: number | null; sIls: string | null;
}
interface RunwayRow {
  rwy_key: string; airport_ident: string; lat: number; lon: number; alt_m: number; heading_deg: number;
  length_m: number; width_m: number | null; primary_threshold_m: number | null; secondary_threshold_m: number | null;
  pattern_altitude_m: number | null; surface: number | null;
  primary_number: number; primary_designator: number; secondary_number: number; secondary_designator: number;
  primary_ils_ident: string | null; primary_ils_region: string | null;
  secondary_ils_ident: string | null; secondary_ils_region: string | null;
}

interface FrequencySource { com_id: number; airport_id: number; type: string | null; frequency: number; name: string | null }
interface FrequencyRow { freq_key: string; airport_ident: string; freq_type: number; frequency_hz: number; name: string | null }

/**
 * The region of the ILS a runway end names: the one on that very end, else one
 * of the same airport; nothing when the ident belongs to no ILS (a VOR, say).
 */
function ilsRegionOf(index: SourceIndex, ident: string | null, endId: number, airportIdent: string): string | null {
  if (!ident) return null;
  const candidates = index.ilsByIdent(ident);
  const ils = candidates.find(i => i.locRunwayEndId === endId) ?? candidates.find(i => i.airportIdent === airportIdent);
  return ils ? index.ilsRegion(ils) : null;
}

// ── The converter ────────────────────────────────────────────────────────────

export const airportsConverter: LnmConverter = {
  stage: 'airports',

  run(ctx: LnmContext): ConverterStats {
    const { src, out, index, now } = ctx;
    const skipped = {
      'airports.duplicateIdent': 0,
      'runways.orphan': 0,
      'runways.ofDuplicateAirport': 0,
      'runways.danglingEnd': 0,
      'runways.unparseableEnd': 0,
      'runways.duplicateKey': 0,
      'frequencies.orphan': 0,
      'frequencies.ofDuplicateAirport': 0,
      'frequencies.duplicateKey': 0,
      'frequencies.unmappedType': 0,
    };
    const written = { airports: 0, runways: 0, frequencies: 0, 'airports.closed': 0 };

    const count = (table: string): number => src.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
    const total = count('airport') + count('runway') + count('com');
    let examined = 0;
    const report = (): void => ctx.progress(examined, total);

    // Airports: the owner row of each ident. The map answers, for the runway and
    // frequency passes, which airport_ids are kept and under which ident.
    const kept = new Map<number, AirportRow>();
    const airportSql = src.prepare(
      `SELECT airport_id, ident, COALESCE(region, '') AS region, laty AS lat, lonx AS lon, altitude, mag_var, name, is_closed
         FROM airport ORDER BY airport_id`,
    );
    for (const r of airportSql.iterate() as IterableIterator<AirportSource>) {
      examined++;
      if (index.airportOwnerId(r.ident) !== r.airport_id) {
        skipped['airports.duplicateIdent']++;
        continue;
      }
      kept.set(r.airport_id, {
        ident: r.ident, region: r.region, lat: r.lat, lon: r.lon, alt_m: ftToM(r.altitude),
        magvar: magvarToReplica(r.mag_var), name: r.name, runways: 0,
      });
      if (r.is_closed === 1) written['airports.closed']++;
    }
    report();

    // Runways: read in descending runway_id order, so the first row of a key is
    // the later scenery layer, the one the simulator shows. Primary is always the
    // primary end, whatever its number.
    const runways = new Map<string, RunwayRow>();
    const runwaySql = src.prepare(
      `SELECT r.runway_id AS runwayId, r.airport_id AS airportId, r.surface, r.length, r.width, r.heading,
              r.pattern_altitude AS patternFt, r.altitude AS altFt, r.laty AS lat, r.lonx AS lon,
              p.runway_end_id AS pId, p.name AS pName, p.offset_threshold AS pOffsetFt, p.ils_ident AS pIls,
              s.runway_end_id AS sId, s.name AS sName, s.offset_threshold AS sOffsetFt, s.ils_ident AS sIls
         FROM runway r
         LEFT JOIN runway_end p ON p.runway_end_id = r.primary_end_id
         LEFT JOIN runway_end s ON s.runway_end_id = r.secondary_end_id
        ORDER BY r.runway_id DESC`,
    );
    for (const r of runwaySql.iterate() as IterableIterator<RunwaySource>) {
      examined++;
      const airport = kept.get(r.airportId);
      if (!airport) {
        skipped[index.airportById(r.airportId) ? 'runways.ofDuplicateAirport' : 'runways.orphan']++;
        continue;
      }
      if (r.pId === null || r.sId === null || r.pName === null || r.sName === null) {
        skipped['runways.danglingEnd']++;
        continue;
      }
      const primary = parseRunway(stripTrueSuffix(r.pName));
      const secondary = parseRunway(stripTrueSuffix(r.sName));
      if (!primary || !secondary) {
        skipped['runways.unparseableEnd']++;
        continue;
      }
      const rwyKey = `${airport.ident}|${primary.number}|${primary.designator}`;
      if (runways.has(rwyKey)) {
        skipped['runways.duplicateKey']++;
        continue;
      }
      runways.set(rwyKey, {
        rwy_key: rwyKey, airport_ident: airport.ident, lat: r.lat, lon: r.lon, alt_m: ftToM(r.altFt),
        heading_deg: r.heading, length_m: ftToM(r.length),
        width_m: r.width === 0 ? null : ftToM(r.width),
        primary_threshold_m: ftToM(r.pOffsetFt), secondary_threshold_m: ftToM(r.sOffsetFt),
        pattern_altitude_m: r.patternFt ? ftToM(r.patternFt) : null,
        surface: surfaceCodeOf(r.surface),
        primary_number: primary.number, primary_designator: primary.designator,
        secondary_number: secondary.number, secondary_designator: secondary.designator,
        primary_ils_ident: r.pIls, primary_ils_region: ilsRegionOf(index, r.pIls, r.pId, airport.ident),
        secondary_ils_ident: r.sIls, secondary_ils_region: ilsRegionOf(index, r.sIls, r.sId, airport.ident),
      });
      airport.runways++;
    }
    report();

    // Writing, airports first: a runway or frequency row points at its airport.
    const insertAirport = out.prepare(
      `INSERT INTO nav_airport (ident, region, lat, lon, alt_m, magvar, name, n_runways, n_approaches, n_departures,
                                n_arrivals, detail_state, detail_fetched_at, detail_runways, detail_procedures,
                                position_source, rev)
       VALUES (@ident, @region, @lat, @lon, @alt_m, @magvar, @name, @runways, 0, 0, 0, 'detail', @now, @runways, 0,
               'facility', 1)`,
    );
    const airportWriter = new ChunkWriter<AirportRow>(out, row => insertAirport.run({ ...row, now }), report);
    for (const airport of kept.values()) airportWriter.add(airport);
    airportWriter.flush();
    written.airports = kept.size;

    const insertRunway = out.prepare(
      `INSERT INTO nav_runway (rwy_key, airport_ident, lat, lon, alt_m, heading_deg, length_m, width_m,
                               primary_threshold_m, secondary_threshold_m, pattern_altitude_m, surface,
                               primary_number, primary_designator, secondary_number, secondary_designator,
                               primary_ils_ident, primary_ils_region, secondary_ils_ident, secondary_ils_region, rev)
       VALUES (@rwy_key, @airport_ident, @lat, @lon, @alt_m, @heading_deg, @length_m, @width_m,
               @primary_threshold_m, @secondary_threshold_m, @pattern_altitude_m, @surface,
               @primary_number, @primary_designator, @secondary_number, @secondary_designator,
               @primary_ils_ident, @primary_ils_region, @secondary_ils_ident, @secondary_ils_region, 1)`,
    );
    const runwayWriter = new ChunkWriter<RunwayRow>(out, row => insertRunway.run(row), report);
    for (const runway of runways.values()) runwayWriter.add(runway);
    runwayWriter.flush();
    written.runways = runways.size;

    // Frequencies, descending com_id: the first row of a freq_key keeps its name.
    const insertFrequency = out.prepare(
      `INSERT INTO nav_airport_frequency (freq_key, airport_ident, freq_type, frequency_hz, name, rev)
       VALUES (@freq_key, @airport_ident, @freq_type, @frequency_hz, @name, 1)`,
    );
    const frequencyWriter = new ChunkWriter<FrequencyRow>(out, row => insertFrequency.run(row), report);
    const seen = new Set<string>();
    const frequencySql = src.prepare('SELECT com_id, airport_id, type, frequency, name FROM com ORDER BY com_id DESC');
    for (const r of frequencySql.iterate() as IterableIterator<FrequencySource>) {
      examined++;
      const airport = kept.get(r.airport_id);
      if (!airport) {
        skipped[index.airportById(r.airport_id) ? 'frequencies.ofDuplicateAirport' : 'frequencies.orphan']++;
        continue;
      }
      const mapped = frequencyTypeOf(r.type);
      const type = mapped ?? 0;
      const hz = Math.round(comFrequencyHz(r.frequency, ctx.flavour));
      const freqKey = `${airport.ident}|${type}|${hz}`;
      if (seen.has(freqKey)) {
        skipped['frequencies.duplicateKey']++;
        continue;
      }
      seen.add(freqKey);
      if (mapped === undefined) skipped['frequencies.unmappedType']++;
      frequencyWriter.add({ freq_key: freqKey, airport_ident: airport.ident, freq_type: type, frequency_hz: hz, name: r.name });
    }
    frequencyWriter.flush();
    written.frequencies = seen.size;
    report();

    const note = (n: number, text: string): void => {
      if (n > 0) ctx.warn(`airports: ${text.replace('%n', String(n))}`);
    };
    note(skipped['airports.duplicateIdent'], 'skipped %n airport rows that repeat an ident already imported');
    note(skipped['runways.orphan'] + skipped['runways.ofDuplicateAirport'], 'skipped %n runways of no airport or of a duplicate airport row');
    note(skipped['runways.danglingEnd'], 'skipped %n runways with a missing runway end');
    note(skipped['runways.unparseableEnd'], 'skipped %n runways with unparseable end names');
    note(skipped['runways.duplicateKey'], 'skipped %n runways that repeat a runway already imported');
    note(skipped['frequencies.orphan'] + skipped['frequencies.ofDuplicateAirport'], 'skipped %n frequencies of no airport or of a duplicate airport row');
    note(skipped['frequencies.duplicateKey'], 'skipped %n frequencies that repeat one already imported');
    note(skipped['frequencies.unmappedType'], 'wrote %n frequencies with an unmapped type as type 0');

    return { written, skipped };
  },
};
