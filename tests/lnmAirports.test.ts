// The Little Navmap airports converter: airports, runways and frequencies, from
// invented atools rows into a replica created by the real schema, with foreign
// keys on. Nothing here opens a real navigation database.

import fs from 'fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { LNM_DATASET_DDL } from '../src/navdata/dataset';
import { applyNavdataSchema } from '../src/navdata/schema';
import { airportsConverter, frequencyTypeOf, surfaceCodeOf } from '../src/navdata/lnm/airports';
import { detectFlavour } from '../src/navdata/lnm/flavour';
import { buildSourceIndex } from '../src/navdata/lnm/sourceIndex';
import type { ConverterStats } from '../src/navdata/lnm/types';
import {
  buildLnmFixture, makeLnmFixtureDir, msfs, navigraph, type AtoolsRow, type LnmFixtureSpec,
} from './helpers/lnmFixture';

// ── Shared scaffolding ───────────────────────────────────────────────────────

const NOW = 1_790_000_000_000;

type Preset = 'navigraph' | 'msfs';

interface Run {
  src: Database.Database;
  out: Database.Database;
  stats: ConverterStats;
  warnings: string[];
  progress: [number, number][];
  /** Row counts per transaction handed to the replica, in order. */
  chunks: number[];
}

let dir: string;
let fixtureSeq = 0;
const handles: Database.Database[] = [];
const cached = new Map<Preset, Run>();

beforeAll(() => {
  dir = makeLnmFixtureDir();
});
afterEach(() => {
  while (handles.length) handles.pop()!.close();
});
afterAll(() => {
  for (const run of cached.values()) {
    run.src.close();
    run.out.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Builds the fixture (optionally edited with raw SQL before it is opened read-only), then runs the
 * converter into a fresh schema-created replica with foreign keys on.
 */
function convert(spec: LnmFixtureSpec, edit?: (db: Database.Database) => void): Run {
  const file = buildLnmFixture(dir, { ...spec, fileName: `airports-${fixtureSeq++}.sqlite` });
  if (edit) {
    const rw = new Database(file);
    edit(rw);
    rw.close();
  }
  const src = new Database(file, { readonly: true, fileMustExist: true });
  const out = new Database(':memory:');
  out.pragma('foreign_keys = ON');
  applyNavdataSchema(out);
  out.exec(LNM_DATASET_DDL);

  const chunks: number[] = [];
  const transaction = out.transaction.bind(out) as (fn: (rows: unknown[]) => void) => (rows: unknown[]) => void;
  (out as unknown as { transaction: typeof transaction }).transaction = fn => {
    const run = transaction(fn);
    return rows => {
      chunks.push(rows.length);
      run(rows);
    };
  };

  const { flavour, provider } = detectFlavour(src);
  const warnings: string[] = [];
  const progress: [number, number][] = [];
  const stats = airportsConverter.run({
    src, out, flavour, provider, index: buildSourceIndex(src, flavour), now: NOW,
    progress: (done, total) => progress.push([done, total]),
    warn: message => warnings.push(message),
  });
  return { src, out, stats, warnings, progress, chunks };
}

/** An ad-hoc run, closed after the test. */
function convertOnce(spec: LnmFixtureSpec, edit?: (db: Database.Database) => void): Run {
  const run = convert(spec, edit);
  handles.push(run.src, run.out);
  return run;
}

/** An unmodified preset: converted once, read by every test that only inspects it. */
function preset(name: Preset): Run {
  let run = cached.get(name);
  if (!run) {
    run = convert((name === 'navigraph' ? navigraph : msfs)());
    cached.set(name, run);
  }
  return run;
}

type Row = Record<string, string | number | null>;

function rows(out: Database.Database, sql: string, ...params: unknown[]): Row[] {
  return out.prepare(sql).all(...params) as Row[];
}
function one(out: Database.Database, sql: string, ...params: unknown[]): Row {
  const found = rows(out, sql, ...params);
  expect(found).toHaveLength(1);
  return found[0];
}
const airportRow = (out: Database.Database, ident: string): Row =>
  one(out, 'SELECT * FROM nav_airport WHERE ident = ?', ident);
const runwayRow = (out: Database.Database, key: string): Row =>
  one(out, 'SELECT * FROM nav_runway WHERE rwy_key = ?', key);
const frequencies = (out: Database.Database, ident: string): Row[] =>
  rows(out, 'SELECT * FROM nav_airport_frequency WHERE airport_ident = ? ORDER BY freq_key', ident);

// Atools rows for a spec's `extra`; every id is the caller's own, above the preset's.
const end = (id: number, name: string, extra: AtoolsRow = {}): AtoolsRow =>
  ({ runway_end_id: id, name, lonx: -150, laty: 10, ...extra });
const runway = (id: number, airportId: number, primary: number, secondary: number, extra: AtoolsRow = {}): AtoolsRow => ({
  runway_id: id, airport_id: airportId, primary_end_id: primary, secondary_end_id: secondary,
  length: 5000, width: 100, heading: 90, lonx: -150, laty: 10, ...extra,
});
const com = (id: number, airportId: number, type: string | null, frequency: number, name: string | null = null): AtoolsRow =>
  ({ com_id: id, airport_id: airportId, type, frequency, name });

const PRESETS: Preset[] = ['navigraph', 'msfs'];

// ── Airports ─────────────────────────────────────────────────────────────────

describe.each(PRESETS)('airports (%s preset)', name => {
  it('writes an owner row converted to metres and the replica magnetic variation', () => {
    const { out } = preset(name);
    const a = airportRow(out, 'ZZAA');
    expect(a.region).toBe(name === 'navigraph' ? 'ZZ' : '');
    expect(a.lat).toBe(12);
    expect(a.lon).toBe(-165);
    expect(a.alt_m).toBeCloseTo(50 * 0.3048, 9);
    expect(a.magvar).toBe(347.5);
    expect(a.name).toBe('Zed Alpha Intl');
  });

  it('marks every airport as detailed, written at import time, with the procedure counters at 0', () => {
    const { out } = preset(name);
    const a = airportRow(out, 'ZZAA');
    expect(a).toMatchObject({
      detail_state: 'detail', detail_fetched_at: NOW, position_source: 'facility', rev: 1,
      n_approaches: 0, n_departures: 0, n_arrivals: 0, detail_procedures: 0,
    });
    expect(rows(out, "SELECT ident FROM nav_airport WHERE detail_state <> 'detail' OR detail_fetched_at <> ?", NOW)).toEqual([]);
  });

  it('counts the runways actually written in n_runways and detail_runways', () => {
    const { out } = preset(name);
    expect(airportRow(out, 'ZZAA')).toMatchObject({ n_runways: 2, detail_runways: 2 });
    expect(airportRow(out, 'ZZAB')).toMatchObject({ n_runways: 1, detail_runways: 1 });
  });

  it('keeps a closed airport and says how many it kept', () => {
    const { out, stats } = preset(name);
    expect(airportRow(out, 'ZZAB')).toMatchObject({ name: 'Zed Bravo Closed', lat: 12.5, lon: -164.5 });
    expect(stats.written['airports.closed']).toBe(1);
  });

  it('passes the replica foreign-key check', () => {
    expect(preset(name).out.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('duplicate airport idents', () => {
  it('keeps the row with the most content and drops what hangs off the loser (Navigraph)', () => {
    const { out, stats } = preset('navigraph');
    // ZZAC appears twice: id 3 (no runway, one frequency) loses to id 4 (one runway, one frequency).
    const a = airportRow(out, 'ZZAC');
    expect(a).toMatchObject({ region: 'ZY', lat: 9, lon: -158.5, name: 'Zed Charlie South', n_runways: 1 });
    expect(rows(out, "SELECT 1 FROM nav_airport WHERE ident = 'ZZAC'")).toHaveLength(1);
    expect(runwayRow(out, 'ZZAC|10|0').airport_ident).toBe('ZZAC');
    // The loser's frequency (122.800) is gone and the winner's (122.900) stays.
    expect(frequencies(out, 'ZZAC').map(f => f.frequency_hz)).toEqual([122_900_000]);
    expect(stats.skipped['airports.duplicateIdent']).toBe(1);
  });

  it('drops runways and frequencies that hang off the losing row, counting them apart', () => {
    const { out, stats } = convertOnce(navigraph({
      extra: {
        runway_end: [end(1001, '04'), end(1002, '22')],
        runway: [runway(1001, 3, 1001, 1002)],
        com: [com(1001, 3, 'T', 118_300, 'ZZAC NORTH TOWER')],
      },
    }));
    expect(rows(out, "SELECT 1 FROM nav_runway WHERE rwy_key LIKE 'ZZAC|4|%'")).toEqual([]);
    expect(rows(out, "SELECT 1 FROM nav_airport_frequency WHERE name = 'ZZAC NORTH TOWER'")).toEqual([]);
    expect(stats.skipped['runways.ofDuplicateAirport']).toBe(1);
    expect(stats.skipped['frequencies.ofDuplicateAirport']).toBe(2);
  });

  it.each(PRESETS)('the lowest airport_id wins a tie in content (%s)', name => {
    const spec = (name === 'navigraph' ? navigraph : msfs)({
      extra: {
        airport: [
          { airport_id: 1001, ident: 'ZZAD', name: 'Zed Delta First', region: 'ZZ', lonx: -157, laty: 8 },
          { airport_id: 1002, ident: 'ZZAD', name: 'Zed Delta Second', region: 'ZY', lonx: -156, laty: 7 },
        ],
      },
    });
    const { out, stats } = convertOnce(spec);
    expect(airportRow(out, 'ZZAD')).toMatchObject({ name: 'Zed Delta First', region: 'ZZ', lat: 8, lon: -157 });
    expect(stats.skipped['airports.duplicateIdent']).toBe(name === 'navigraph' ? 2 : 1);
  });

  it('imports every airport once on MSFS, which has no duplicates', () => {
    const { out, stats } = preset('msfs');
    expect(rows(out, 'SELECT ident FROM nav_airport ORDER BY ident').map(r => r.ident)).toEqual(['ZZAA', 'ZZAB']);
    expect(stats.skipped['airports.duplicateIdent']).toBe(0);
  });
});

// ── Runways ──────────────────────────────────────────────────────────────────

describe.each(PRESETS)('runways (%s preset)', name => {
  it('keys a runway on its primary end and converts its geometry to metres', () => {
    const r = runwayRow(preset(name).out, 'ZZAA|9|1');
    expect(r).toMatchObject({
      airport_ident: 'ZZAA', heading_deg: 90, primary_number: 9, primary_designator: 1,
      secondary_number: 27, secondary_designator: 2, lat: 12, lon: -165, rev: 1, slope_deg: null, true_slope_deg: null,
    });
    expect(r.length_m).toBeCloseTo(9000 * 0.3048, 9);
    expect(r.width_m).toBeCloseTo(150 * 0.3048, 9);
    expect(r.alt_m).toBeCloseTo(50 * 0.3048, 9);
    expect(r.pattern_altitude_m).toBeCloseTo(1000 * 0.3048, 9);
  });

  it('converts a displaced threshold per end and leaves 0 as 0', () => {
    const r = runwayRow(preset(name).out, 'ZZAA|9|1');
    expect(r.primary_threshold_m).toBe(0);
    expect(r.secondary_threshold_m).toBeCloseTo(300 * 0.3048, 9);
  });

  it('strips the trailing T from a numbered end named by true bearing (18T is 18)', () => {
    const r = runwayRow(preset(name).out, 'ZZAA|18|0');
    expect(r).toMatchObject({ primary_number: 18, primary_designator: 0, secondary_number: 36, secondary_designator: 0 });
  });

  it('writes a width of 0 and a pattern altitude of 0 as NULL', () => {
    const r = runwayRow(preset(name).out, 'ZZAA|18|0');
    expect(r.width_m).toBeNull();
    expect(r.pattern_altitude_m).toBeNull();
  });

  it('maps the surface on MSFS and leaves it NULL on Navigraph, which carries none', () => {
    const { out } = preset(name);
    const surfaces = rows(out, 'SELECT rwy_key, surface FROM nav_runway ORDER BY rwy_key');
    if (name === 'navigraph') {
      expect(surfaces.every(r => r.surface === null)).toBe(true);
    } else {
      expect(Object.fromEntries(surfaces.map(r => [r.rwy_key, r.surface])))
        .toEqual({ 'ZZAA|9|1': 4, 'ZZAA|18|0': 1, 'ZZAB|5|0': 0 });
    }
  });

  it('writes every runway into a table of integers where the schema asks for them', () => {
    const { out } = preset(name);
    const bad = rows(out, `SELECT rwy_key FROM nav_runway WHERE typeof(primary_number) <> 'integer'
      OR typeof(primary_designator) <> 'integer' OR typeof(secondary_number) <> 'integer'
      OR typeof(secondary_designator) <> 'integer' OR typeof(rev) <> 'integer'`);
    expect(bad).toEqual([]);
  });

  it('links a runway end to the ILS it names, by region, and leaves the other end empty', () => {
    const r = runwayRow(preset(name).out, 'ZZAA|9|1');
    expect(r).toMatchObject({
      primary_ils_ident: null, primary_ils_region: null, secondary_ils_ident: 'IZZA', secondary_ils_region: 'ZZ',
    });
  });
});

describe('runway rules', () => {
  it('dedupes on rwy_key keeping the highest runway_id', () => {
    const { out, stats } = convertOnce(msfs({
      extra: {
        runway_end: [end(1001, '09L'), end(1002, '27R'), end(1003, '09L'), end(1004, '27R')],
        runway: [
          // Lower id than the later layer, higher than the preset's own runway 1.
          runway(500, 1, 1003, 1004, { length: 8000, heading: 91 }),
          runway(1001, 1, 1001, 1002, { length: 7000, heading: 92 }),
        ],
      },
    }));
    const r = runwayRow(out, 'ZZAA|9|1');
    expect(r.length_m).toBeCloseTo(7000 * 0.3048, 9);
    expect(r.heading_deg).toBe(92);
    expect(rows(out, "SELECT 1 FROM nav_runway WHERE airport_ident = 'ZZAA'")).toHaveLength(2);
    expect(airportRow(out, 'ZZAA')).toMatchObject({ n_runways: 2, detail_runways: 2 });
    expect(stats.skipped['runways.duplicateKey']).toBe(2);
    expect(stats.written.runways).toBe(3);
  });

  it('keeps the primary end as the source gives it, even when it has the higher number', () => {
    const { out } = convertOnce(msfs({
      extra: { runway_end: [end(1001, '30'), end(1002, '12')], runway: [runway(1001, 1, 1001, 1002)] },
    }));
    expect(runwayRow(out, 'ZZAA|30|0')).toMatchObject({ primary_number: 30, secondary_number: 12 });
    expect(rows(out, "SELECT 1 FROM nav_runway WHERE rwy_key = 'ZZAA|12|0'")).toEqual([]);
  });

  it('parses compass-named water runways and W / A designators', () => {
    const { out, stats } = convertOnce(msfs({
      extra: {
        runway_end: [end(1001, 'NE'), end(1002, 'SW'), end(1003, '09W'), end(1004, '27W'), end(1005, '03A'), end(1006, '21A')],
        runway: [runway(1001, 1, 1001, 1002), runway(1002, 1, 1003, 1004), runway(1003, 1, 1005, 1006)],
      },
    }));
    expect(runwayRow(out, 'ZZAA|38|0')).toMatchObject({ secondary_number: 42, secondary_designator: 0 });
    expect(runwayRow(out, 'ZZAA|9|4')).toMatchObject({ secondary_number: 27, secondary_designator: 4 });
    expect(runwayRow(out, 'ZZAA|3|5')).toMatchObject({ secondary_number: 21, secondary_designator: 5 });
    expect(stats.skipped['runways.unparseableEnd']).toBe(0);
  });

  it('strips the T only from a two-digit name (08T is 8, a stray name is skipped and counted)', () => {
    const { out, stats, warnings } = convertOnce(msfs({
      extra: {
        runway_end: [end(1001, '08T'), end(1002, '26'), end(1003, 'XX'), end(1004, '36')],
        runway: [runway(1001, 1, 1001, 1002), runway(1002, 1, 1003, 1004)],
      },
    }));
    expect(runwayRow(out, 'ZZAA|8|0')).toMatchObject({ secondary_number: 26 });
    expect(rows(out, "SELECT 1 FROM nav_runway WHERE airport_ident = 'ZZAA'")).toHaveLength(3);
    expect(stats.skipped['runways.unparseableEnd']).toBe(1);
    expect(warnings).toContain('airports: skipped 1 runways with unparseable end names');
  });

  it('skips and counts a runway with a missing end or with no airport', () => {
    const { out, stats } = convertOnce(msfs({
      extra: {
        runway_end: [end(1001, '04'), end(1002, '22')],
        runway: [runway(1001, 1, 1001, 9999), runway(1002, 888, 1001, 1002)],
      },
    }));
    expect(rows(out, "SELECT 1 FROM nav_runway WHERE airport_ident = 'ZZAA'")).toHaveLength(2);
    expect(stats.skipped['runways.danglingEnd']).toBe(1);
    expect(stats.skipped['runways.orphan']).toBe(1);
  });

  it('reads UNKNOWN and unlisted surfaces as NULL, never as a soft surface', () => {
    const { out } = convertOnce(msfs({
      extra: {
        runway_end: [end(1001, '04'), end(1002, '22'), end(1003, '06'), end(1004, '24')],
        runway: [runway(1001, 1, 1001, 1002, { surface: 'UNKNOWN' }), runway(1002, 1, 1003, 1004, { surface: 'W' })],
      },
    }));
    expect(runwayRow(out, 'ZZAA|4|0').surface).toBeNull();
    expect(runwayRow(out, 'ZZAA|6|0').surface).toBe(2);
  });

  it('keeps a width above 999 ft as it is', () => {
    const { out } = convertOnce(msfs({
      extra: { runway_end: [end(1001, '04'), end(1002, '22')], runway: [runway(1001, 1, 1001, 1002, { width: 1200 })] },
    }));
    expect(runwayRow(out, 'ZZAA|4|0').width_m).toBeCloseTo(1200 * 0.3048, 9);
  });
});

describe.each(PRESETS)('ILS region of a runway end (%s)', name => {
  const ils = (id: number, ident: string, extra: AtoolsRow): AtoolsRow =>
    ({ ils_id: id, ident, lonx: -150, laty: 10, type: 'I', ...extra });
  const ends = [
    end(1001, '04', { ils_ident: 'IZZB' }), end(1002, '22'),
    end(1003, '06', { ils_ident: 'IZZC' }), end(1004, '24'),
    end(1005, '07', { ils_ident: 'ZZD' }), end(1006, '25'),
    end(1007, '08', { ils_ident: 'IZZE' }), end(1008, '26'),
  ];
  const spec = (name === 'navigraph' ? navigraph : msfs)({
    extra: {
      runway_end: ends,
      runway: [
        runway(1001, 1, 1001, 1002), runway(1002, 1, 1003, 1004), runway(1003, 1, 1005, 1006), runway(1004, 1, 1007, 1008),
      ],
      ils: [
        // On the very end; its airport is not the runway's, so only the end can match, and the region is derived.
        ils(1001, 'IZZB', { region: null, loc_runway_end_id: 1001, loc_airport_ident: 'ZYAA' }),
        // No end link, but the same airport; the stored region is used.
        ils(1002, 'IZZC', { region: 'ZY', loc_runway_end_id: null, loc_airport_ident: 'ZZAA' }),
        // Same ident as the end names, but on another airport's runway end.
        ils(1003, 'IZZE', { region: 'ZY', loc_runway_end_id: 11, loc_airport_ident: 'ZZAB' }),
      ],
    },
  });

  it('matches by the runway end first, taking the derived region when the stored one is empty', () => {
    expect(runwayRow(convertOnce(spec).out, 'ZZAA|4|0')).toMatchObject({ primary_ils_ident: 'IZZB', primary_ils_region: 'ZY' });
  });

  it('falls back to the airport ident and the stored region', () => {
    expect(runwayRow(convertOnce(spec).out, 'ZZAA|6|0')).toMatchObject({ primary_ils_ident: 'IZZC', primary_ils_region: 'ZY' });
  });

  it('writes the ident with no region when it names no ILS (a VOR, say), or an ILS elsewhere', () => {
    const { out } = convertOnce(spec);
    expect(runwayRow(out, 'ZZAA|7|0')).toMatchObject({ primary_ils_ident: 'ZZD', primary_ils_region: null });
    expect(runwayRow(out, 'ZZAA|8|0')).toMatchObject({ primary_ils_ident: 'IZZE', primary_ils_region: null });
  });
});

// ── Frequencies ──────────────────────────────────────────────────────────────

describe('frequencies', () => {
  it('writes Navigraph kHz as hertz, restoring the 25 kHz channels the source truncated', () => {
    const { out } = preset('navigraph');
    expect(frequencies(out, 'ZZAA').map(f => [f.freq_key, f.freq_type, f.frequency_hz, f.name])).toEqual([
      ['ZZAA|1|133600000', 1, 133_600_000, 'ZZAA ATIS'],
      ['ZZAA|5|121700000', 5, 121_700_000, 'ZZAA GROUND'],
      ['ZZAA|6|118325000', 6, 118_325_000, 'ZZAA TOWER'],
      ['ZZAA|8|119375000', 8, 119_375_000, 'ZZAA APPROACH'],
      ['ZZAA|8|257825000', 8, 257_825_000, 'ZZAA APPROACH UHF'],
    ]);
  });

  it('writes HF and LF Navigraph values as plain kHz', () => {
    const { out } = preset('navigraph');
    expect(Object.fromEntries(frequencies(out, 'ZZAB').map(f => [f.freq_type, f.frequency_hz])))
      .toEqual({ 1: 395_000, 11: 5_655_000, 3: 122_800_000 });
  });

  it('writes MSFS hertz as they are', () => {
    const { out } = preset('msfs');
    expect(frequencies(out, 'ZZAA').map(f => [f.freq_key, f.frequency_hz])).toEqual([
      ['ZZAA|1|133600000', 133_600_000],
      ['ZZAA|5|121700000', 121_700_000],
      ['ZZAA|6|118325000', 118_325_000],
      ['ZZAA|8|119375000', 119_375_000],
      ['ZZAA|8|257825000', 257_825_000],
    ]);
    expect(frequencies(out, 'ZZAB').map(f => [f.freq_type, f.frequency_hz])).toEqual([[3, 122_800_000]]);
  });

  it.each(PRESETS)('drops a frequency that belongs to no airport and counts it (%s)', name => {
    const { out, stats, warnings } = preset(name);
    expect(rows(out, "SELECT 1 FROM nav_airport_frequency WHERE name = 'ZZ ORPHAN'")).toEqual([]);
    expect(stats.skipped['frequencies.orphan']).toBe(1);
    expect(warnings.some(m => /^airports: skipped \d+ frequencies of no airport or of a duplicate airport row$/.test(m))).toBe(true);
  });

  it.each(PRESETS)('writes integers (%s)', name => {
    const bad = rows(preset(name).out, `SELECT freq_key FROM nav_airport_frequency
      WHERE typeof(freq_type) <> 'integer' OR typeof(frequency_hz) <> 'integer' OR typeof(rev) <> 'integer'`);
    expect(bad).toEqual([]);
  });

  it.each(PRESETS)('on a repeated freq_key the highest com_id keeps its name (%s)', name => {
    const hz = (khz: number, mhz: number): number => (name === 'navigraph' ? khz : mhz);
    const { out, stats } = convertOnce((name === 'navigraph' ? navigraph : msfs)({
      extra: { com: [com(1001, 1, 'T', hz(118320, 118_325_000), 'ZZAA TOWER NEW')] },
    }));
    const tower = rows(out, "SELECT name FROM nav_airport_frequency WHERE freq_key = 'ZZAA|6|118325000'");
    expect(tower).toEqual([{ name: 'ZZAA TOWER NEW' }]);
    expect(stats.skipped['frequencies.duplicateKey']).toBe(1);
    expect(stats.written.frequencies).toBe(name === 'navigraph' ? 9 : 6);
  });

  it('collapses two atools types that map to one type on the same frequency', () => {
    const { out, stats } = convertOnce(msfs({
      extra: { com: [com(1001, 1, 'ARR', 119_375_000, 'ZZAA ARRIVAL')] },
    }));
    expect(rows(out, "SELECT name FROM nav_airport_frequency WHERE freq_key = 'ZZAA|8|119375000'"))
      .toEqual([{ name: 'ZZAA ARRIVAL' }]);
    expect(stats.skipped['frequencies.duplicateKey']).toBe(1);
  });

  it('writes an unmapped or missing type as 0 and counts it', () => {
    const { out, stats, warnings } = convertOnce(msfs({
      extra: { com: [com(1001, 1, 'INF', 126_500_000, 'ZZAA INFO'), com(1002, 1, null, 126_600_000)] },
    }));
    expect(rows(out, 'SELECT freq_key, freq_type, name FROM nav_airport_frequency WHERE freq_type = 0 ORDER BY freq_key'))
      .toEqual([
        { freq_key: 'ZZAA|0|126500000', freq_type: 0, name: 'ZZAA INFO' },
        { freq_key: 'ZZAA|0|126600000', freq_type: 0, name: null },
      ]);
    expect(stats.skipped['frequencies.unmappedType']).toBe(2);
    expect(warnings).toContain('airports: wrote 2 frequencies with an unmapped type as type 0');
  });

  it('maps the Navigraph-only codes to the type they mean', () => {
    const { out } = convertOnce(navigraph({
      extra: {
        com: [
          com(1001, 1, 'TMA', 120_100, 'A'), com(1002, 1, 'RDO', 5_000, 'B'), com(1003, 1, 'CTL', 125_100, 'C'),
          com(1004, 1, 'AWI', 128_100, 'D'), com(1005, 1, 'CPT', 127_100, 'E'), com(1006, 1, 'GCO', 126_100, 'F'),
        ],
      },
    }));
    const types = rows(out, "SELECT name, freq_type FROM nav_airport_frequency WHERE name IN ('A','B','C','D','E','F') ORDER BY name");
    expect(types.map(t => t.freq_type)).toEqual([8, 11, 10, 12, 14, 15]);
  });
});

describe('enumerations', () => {
  it.each([
    ['ATIS', 1], ['MC', 2], ['UC', 3], ['CTAF', 4], ['G', 5], ['T', 6], ['C', 7], ['A', 8], ['ARR', 8], ['DIR', 8],
    ['TCA', 8], ['TMA', 8], ['TML', 8], ['RDR', 8], ['D', 9], ['CTR', 10], ['CTL', 10], ['CTA', 10], ['FSS', 11],
    ['RDO', 11], ['AWOS', 12], ['AWI', 12], ['AWS', 12], ['ASOS', 13], ['CPT', 14], ['GCO', 15],
  ])('maps com type %s to %i', (type, expected) => {
    expect(frequencyTypeOf(type)).toBe(expected);
  });

  it.each(['INF', 'OPS', 'RMP', 'EMR', 'HEL', 'ACP', 'RSA', 'TRS', 'atis', '', null, undefined])(
    'has no frequency type for %s', type => {
      expect(frequencyTypeOf(type)).toBeUndefined();
    });

  it.each([
    ['CE', 0], ['G', 1], ['W', 2], ['A', 4], ['SN', 8], ['I', 9], ['D', 12], ['CR', 13], ['GR', 14], ['OT', 15],
    ['SM', 16], ['B', 17], ['BR', 18], ['M', 19], ['PL', 20], ['S', 21], ['SH', 22], ['T', 23],
  ])('maps surface %s to %i', (surface, expected) => {
    expect(surfaceCodeOf(surface)).toBe(expected);
  });

  it.each(['UNKNOWN', 'asphalt', '', null, undefined])('gives surface %s no value', surface => {
    expect(surfaceCodeOf(surface)).toBeNull();
  });
});

// ── Writing ──────────────────────────────────────────────────────────────────

describe('writing', () => {
  it('writes in transactions of at most 50,000 rows', () => {
    const { out, chunks, stats } = convertOnce(msfs(), db => {
      db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 50000)
               INSERT INTO com (com_id, airport_id, type, frequency, name)
               SELECT 1001 + i, 1, 'T', 300000000 + i * 5000, NULL FROM n`);
    });
    expect(Math.max(...chunks)).toBe(50_000);
    expect(chunks.filter(n => n > 50_000)).toEqual([]);
    expect(rows(out, 'SELECT COUNT(*) AS n FROM nav_airport_frequency')).toEqual([{ n: 50_007 }]);
    expect(stats.written.frequencies).toBe(50_007);
    expect(out.pragma('foreign_key_check')).toEqual([]);
    // Converts and writes 50,000+ rows; about 7 s when the machine is busy, so this test gets 30 s.
  }, 30_000);

  it.each(PRESETS)('reports progress up to the source rows read (%s)', name => {
    const { src, progress } = preset(name);
    const total = ['airport', 'runway', 'com']
      .map(table => (src.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number))
      .reduce((a, b) => a + b, 0);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every(([done, of]) => of === total && done <= total)).toBe(true);
    expect(progress.map(p => p[0])).toEqual([...progress.map(p => p[0])].sort((a, b) => a - b));
    expect(progress[progress.length - 1]).toEqual([total, total]);
  });

  it.each(PRESETS)('counts what it wrote (%s)', name => {
    const { out, stats } = preset(name);
    for (const [key, table] of [['airports', 'nav_airport'], ['runways', 'nav_runway'], ['frequencies', 'nav_airport_frequency']]) {
      expect(stats.written[key]).toBe(one(out, `SELECT COUNT(*) AS n FROM ${table}`).n);
    }
  });

  it.each(PRESETS)('warns with counts only, never an ident or a name (%s)', name => {
    const { warnings } = preset(name);
    expect(warnings.length).toBeGreaterThan(0);
    for (const message of warnings) {
      expect(message).toMatch(/^airports: (skipped|wrote) \d+ /);
      expect(message).not.toMatch(/ZZ/);
    }
  });

  it('leaves the other tables to the other converters', () => {
    const { out } = preset('msfs');
    for (const table of ['nav_navaid', 'nav_waypoint', 'nav_airway_leg', 'nav_procedure', 'nav_procedure_transition', 'nav_procedure_leg']) {
      expect(one(out, `SELECT COUNT(*) AS n FROM ${table}`).n).toBe(0);
    }
  });
});
