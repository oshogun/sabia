// The Little Navmap navaid and waypoint converters, run against invented atools
// databases and checked in a replica created by the real schema, so every
// constraint of the shipped DDL applies to what they write.

import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { LNM_DATASET_DDL } from '../src/navdata/dataset';
import { wptKey } from '../src/navdata/keys';
import { applyNavdataSchema } from '../src/navdata/schema';
import { verifyNavdataColumns } from '../src/navdata/store';
import { detectFlavour } from '../src/navdata/lnm/flavour';
import { navaidsConverter } from '../src/navdata/lnm/navaids';
import { buildSourceIndex } from '../src/navdata/lnm/sourceIndex';
import type { ConverterStats, LnmContext, LnmConverter } from '../src/navdata/lnm/types';
import { waypointsConverter } from '../src/navdata/lnm/waypoints';
import { buildLnmFixture, makeLnmFixtureDir, msfs, navigraph, type AtoolsRow, type LnmFixtureSpec } from './helpers/lnmFixture';

// ── Shared scaffolding ───────────────────────────────────────────────────────

const NOW = 1_790_000_000_000;
const FT = 0.3048;
const NM = 1852;

let dir: string;
let serial = 0;
const open: Database.Database[] = [];

beforeAll(() => {
  dir = makeLnmFixtureDir();
});
afterEach(() => {
  while (open.length) open.pop()!.close();
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Built {
  src: Database.Database;
  out: Database.Database;
  stats: ConverterStats[];
  warnings: string[];
}

/** An empty replica the way the pipeline makes it: the shipped DDL and the dataset table, foreign keys on. */
function newReplica(): Database.Database {
  const out = new Database(path.join(dir, `out-${++serial}.db`));
  open.push(out);
  out.pragma('foreign_keys = ON');
  applyNavdataSchema(out);
  out.exec(LNM_DATASET_DDL);
  return out;
}

function openSource(spec: LnmFixtureSpec): Database.Database {
  const src = new Database(buildLnmFixture(dir, { ...spec, fileName: `src-${++serial}.sqlite` }), {
    readonly: true, fileMustExist: true,
  });
  open.push(src);
  return src;
}

function contextFor(src: Database.Database, out: Database.Database, warnings: string[]): LnmContext {
  const { flavour } = detectFlavour(src);
  const index = buildSourceIndex(src, flavour);
  return {
    src, out, flavour, provider: index.provider, index, now: NOW, progress: () => undefined,
    warn: message => warnings.push(message),
  };
}

function convert(spec: LnmFixtureSpec, converters: LnmConverter[] = [navaidsConverter, waypointsConverter]): Built {
  const src = openSource(spec);
  const out = newReplica();
  const warnings: string[] = [];
  const ctx = contextFor(src, out, warnings);
  return { src, out, warnings, stats: converters.map(c => c.run(ctx)) };
}

const rows = (db: Database.Database, sql: string, ...args: unknown[]): Record<string, any>[] =>
  db.prepare(sql).all(...args) as Record<string, any>[];

function navaid(db: Database.Database, kind: 'V' | 'N', ident: string, region = 'ZZ'): Record<string, any> | undefined {
  return db.prepare('SELECT * FROM nav_navaid WHERE kind = ? AND ident = ? AND region = ?').get(kind, ident, region) as
    Record<string, any> | undefined;
}

const PRESETS: [string, typeof navigraph][] = [['navigraph', navigraph], ['msfs', msfs]];

// Invented stations in an empty stretch of ocean, away from the preset's own fixes.
const vor = (id: number, ident: string, over: AtoolsRow = {}): AtoolsRow => ({
  vor_id: id, ident, name: `Station ${ident}`, region: 'ZZ', type: 'H', frequency: 112_000, range: 100, mag_var: 12,
  altitude: 100, lonx: -150, laty: 5, ...over,
});
const ndb = (id: number, ident: string, over: AtoolsRow = {}): AtoolsRow => ({
  ndb_id: id, ident, name: `Beacon ${ident}`, region: 'ZZ', type: 'H', frequency: 30_000, range: 30, mag_var: 12,
  altitude: 10, lonx: -150, laty: 6, ...over,
});
const ils = (id: number, ident: string, over: AtoolsRow = {}): AtoolsRow => ({
  ils_id: id, ident, name: `Localizer ${ident}`, region: 'ZZ', type: 'I', frequency: 109_900, range: 20, mag_var: 12,
  has_backcourse: 0, altitude: 0, lonx: -150, laty: 7, loc_airport_ident: 'ZZAA', ...over,
});
const waypoint = (id: number, ident: string, over: AtoolsRow = {}): AtoolsRow => ({
  waypoint_id: id, ident, type: 'WN', region: 'ZZ', mag_var: 12, lonx: -149, laty: 8, ...over,
});

// ── nav_navaid ───────────────────────────────────────────────────────────────

describe.each(PRESETS)('navaids from the %s preset', (name, preset) => {
  const isMsfs = name === 'msfs';
  const navRange = (nm: number): number => nm * NM;

  it('writes a high VOR with its DME on the station', () => {
    const { out } = convert(preset());
    const v = navaid(out, 'V', 'ZZV')!;
    expect(v).toMatchObject({
      nav_type: 3, frequency_hz: 112_300_000, name: 'Zed Victor', lat: 12.5, lon: -166, position_source: 'facility',
      position_fetched_at: NOW, detail_state: 'detail', detail_fetched_at: NOW, rev: 1, is_nav: 1, is_dme: 1,
      is_tacan: 0, has_glide_slope: 0, has_back_course: 0, dme_at_nav: 1, dme_at_glide_slope: 0, airport_ident: null,
      localizer_deg: null, gs_lat: null, tacan_lat: null, dme_lat: 12.5, dme_lon: -166,
    });
    expect(v.alt_m).toBeCloseTo(50 * FT, 9);
    expect(v.dme_alt_m).toBeCloseTo(50 * FT, 9);
    expect(v.magvar).toBe(348);
    expect(v.nav_range_m).toBeCloseTo(navRange(130), 6);
  });

  it('writes the class range of a station, undoing the factor MSFS puts on it', () => {
    const { out, src } = convert(preset());
    const stored = src.prepare("SELECT range FROM vor WHERE ident = 'ZZV'").pluck().get() as number;
    expect(stored).toBe(isMsfs ? 195 : 130);
    expect(navaid(out, 'V', 'ZZV')!.nav_range_m).toBeCloseTo(130 * NM, 6);
    expect(navaid(out, 'N', 'ZZN')!.nav_range_m).toBeCloseTo(50 * NM, 6);
  });

  it('writes a TACAN as a station that is not a navigation aid, with its DME as the TACAN position', () => {
    const t = navaid(convert(preset()).out, 'V', 'ZZT')!;
    expect(t).toMatchObject({
      nav_type: null, is_nav: 0, is_dme: 1, is_tacan: 1, tacan_lat: 13, tacan_lon: -165.5, dme_at_nav: 1,
      frequency_hz: 108_600_000,
    });
    expect(t.tacan_alt_m).toBeCloseTo(30 * FT, 9);
  });

  it('writes a DME-only station as low-class and not a navigation aid', () => {
    expect(navaid(convert(preset()).out, 'V', 'ZZD')).toMatchObject({
      nav_type: 2, is_nav: 0, is_dme: 1, is_tacan: 0, tacan_lat: null, tacan_alt_m: null,
    });
  });

  it('lets a VOR keep its key against an ILS with the same ident and region, and marks it ambiguous', () => {
    const { out, stats } = convert(preset());
    const v = navaid(out, 'V', 'ZZV')!;
    expect(v.ambiguous).toBe(1);
    expect(v.nav_type).toBe(3);
    expect(rows(out, "SELECT 1 FROM nav_navaid WHERE kind = 'V' AND ident = 'ZZV'")).toHaveLength(1);
    expect(stats[0].skipped['ILS rows that lost their key to another station']).toBe(1);
  });

  it('writes an ILS at its localizer, keyed by the airport region when the file has none', () => {
    const { out } = convert(preset());
    const i = navaid(out, 'V', 'IZZA')!;
    expect(i).toMatchObject({
      nav_type: 4, nav_range_m: null, is_nav: 1, is_dme: 0, is_tacan: 0, has_glide_slope: 1, dme_at_nav: 0,
      dme_at_glide_slope: 0, localizer_deg: 270, localizer_width_deg: 4, gs_lat: 12, gs_lon: -164.99,
      airport_ident: 'ZZAA', lat: 12, lon: -165.03, frequency_hz: 110_500_000, ambiguous: 0, magvar: 348,
      dme_lat: null, tacan_lat: null,
      // MSFS sets the back-course flag on nearly every row, as the simulator does; Navigraph does not.
      has_back_course: isMsfs ? 1 : 0,
    });
    expect(i.gs_alt_m).toBeCloseTo(50 * FT, 9);
    // Navigraph's ILS altitude is 0 on every row: not an elevation.
    if (isMsfs) expect(i.alt_m).toBeCloseTo(50 * FT, 9);
    else expect(i.alt_m).toBeNull();
  });

  it('writes one NDB for two sharing an ident and region: the airway endpoint, ambiguous', () => {
    const { out, stats } = convert(preset());
    expect(rows(out, "SELECT * FROM nav_navaid WHERE kind = 'N'")).toHaveLength(1);
    const n = navaid(out, 'N', 'ZZN')!;
    // NDB 2 is the airport one, but it is the end of airway ZZ2; NDB 1 is free of any airport and is not.
    expect(n).toMatchObject({
      lat: 12.1, lon: -165.1, ambiguous: 1, airport_ident: 'ZZAA', nav_type: isMsfs ? 2 : 1, frequency_hz: 375_000,
      is_nav: null, is_dme: null, is_tacan: null, has_glide_slope: null, has_back_course: null, dme_at_nav: null,
      dme_at_glide_slope: null, localizer_deg: null, gs_lat: null, dme_lat: null, tacan_lat: null, magvar: 348,
    });
    expect(stats[0].skipped['NDB rows that lost their key to another station']).toBe(1);
  });

  it('gives the same rows on every run', () => {
    const first = convert(preset());
    const second = convert(preset());
    const dump = (db: Database.Database): unknown[] =>
      rows(db, 'SELECT * FROM nav_navaid ORDER BY kind, ident, region');
    expect(dump(first.out).length).toBeGreaterThan(0);
    expect(dump(second.out)).toEqual(dump(first.out));
  });

  it('writes one row per key: three VORs, the localizer IZZA and one NDB', () => {
    const { out, stats } = convert(preset());
    const byKind = rows(out, 'SELECT kind, COUNT(*) AS n FROM nav_navaid GROUP BY kind ORDER BY kind');
    expect(byKind).toEqual([{ kind: 'N', n: 1 }, { kind: 'V', n: 4 }]);
    expect(stats[0].written).toEqual({ nav_navaid: 5 });
  });

  it('inserts into the shipped DDL without a constraint or foreign-key failure', () => {
    const { out } = convert(preset());
    expect(rows(out, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(() => verifyNavdataColumns(out)).not.toThrow();
  });
});

describe('navaid key collisions beyond the preset', () => {
  // Airway endpoints are the artificial V/N waypoint rows; id 1000+ keeps clear of the preset.
  const endpoint = (id: number, ident: string, type: 'V' | 'N', navId: number): AtoolsRow =>
    waypoint(id, ident, { type, nav_id: navId, artificial: 1 });
  const airwayOn = (id: number, from: number, to: number): AtoolsRow => ({
    airway_id: id, airway_name: 'ZZ9', airway_type: 'V', from_waypoint_id: from, to_waypoint_id: to,
  });

  it('prefers an NDB with no airport over one at an airport when neither is an airway endpoint', () => {
    const { out } = convert(msfs({ extra: { ndb: [
      ndb(1000, 'ZZNA', { airport_id: 1, airport_ident: 'ZZAA', lonx: -150, laty: 6 }),
      ndb(1001, 'ZZNA', { lonx: -149, laty: 6 }),
    ] } }));
    const n = navaid(out, 'N', 'ZZNA')!;
    expect(n.lon).toBe(-149);
    expect(n.airport_ident).toBeNull();
    expect(n.ambiguous).toBe(1);
  });

  it('breaks a full tie by the lowest ndb_id', () => {
    const { out } = convert(msfs({ extra: { ndb: [
      ndb(1003, 'ZZNB', { lonx: -148, laty: 6 }),
      ndb(1002, 'ZZNB', { lonx: -147, laty: 6 }),
    ] } }));
    expect(navaid(out, 'N', 'ZZNB')).toMatchObject({ lon: -147, ambiguous: 1 });
  });

  it('chooses the same winner whatever order the rows come in', () => {
    const group = [
      ndb(1010, 'ZZNC', { lonx: -146, laty: 6 }),
      ndb(1011, 'ZZNC', { lonx: -145, laty: 6 }),
      ndb(1012, 'ZZNC', { airport_id: 1, airport_ident: 'ZZAA', lonx: -144, laty: 6 }),
    ];
    const forward = convert(msfs({ extra: { ndb: group } }));
    const backward = convert(msfs({ extra: { ndb: [...group].reverse() } }));
    expect(navaid(forward.out, 'N', 'ZZNC')!.lon).toBe(-146);
    expect(navaid(backward.out, 'N', 'ZZNC')!.lon).toBe(-146);
  });

  it('keeps one of two airway-endpoint NDBs, the lowest id, and drops the other without a row of its own', () => {
    const { out } = convert(msfs({ extra: {
      ndb: [ndb(1020, 'ZZND', { lonx: -143, laty: 6 }), ndb(1021, 'ZZND', { lonx: -142, laty: 6 })],
      waypoint: [endpoint(1020, 'ZZND', 'N', 1020), endpoint(1021, 'ZZND', 'N', 1021)],
      airway: [airwayOn(1020, 1020, 4), airwayOn(1021, 1021, 4)],
    } }));
    const winners = rows(out, "SELECT lon, ambiguous FROM nav_navaid WHERE kind = 'N' AND ident = 'ZZND'");
    expect(winners).toEqual([{ lon: -143, ambiguous: 1 }]);
  });

  it('keeps the VOR when an ILS with the same id, ident and region sits beside it', () => {
    // The tables number their rows separately; only the table and the id together name the winner.
    const { out } = convert(msfs({ extra: {
      vor: [vor(1000, 'ZZSAME', { lonx: -141, laty: 5 })],
      ils: [ils(1000, 'ZZSAME', { lonx: -141, laty: 7 })],
    } }));
    expect(rows(out, "SELECT lat, nav_type, ambiguous FROM nav_navaid WHERE ident = 'ZZSAME'")).toEqual([
      { lat: 5, nav_type: 3, ambiguous: 1 },
    ]);
  });

  it('keeps a VOR and an NDB that share an id, an ident and a region: they are different kinds', () => {
    const { out } = convert(msfs({ extra: {
      vor: [vor(1000, 'ZZKIND', { lonx: -141, laty: 5 })],
      ndb: [ndb(1000, 'ZZKIND', { lonx: -141, laty: 6 })],
    } }));
    expect(navaid(out, 'V', 'ZZKIND')).toMatchObject({ lat: 5, ambiguous: 0 });
    expect(navaid(out, 'N', 'ZZKIND')).toMatchObject({ lat: 6, ambiguous: 0 });
  });

  it('keeps the lowest of two ILS rows on one key, and the lowest of two VORs', () => {
    const { out } = convert(navigraph({ extra: {
      ils: [ils(1000, 'IZZB', { lonx: -140, laty: 7 }), ils(1001, 'IZZB', { lonx: -139, laty: 7 })],
      vor: [vor(1001, 'ZZVB', { lonx: -138, laty: 5 }), vor(1000, 'ZZVB', { lonx: -137, laty: 5 })],
    } }));
    expect(navaid(out, 'V', 'IZZB')).toMatchObject({ lon: -140, ambiguous: 1, nav_type: 4 });
    expect(navaid(out, 'V', 'ZZVB')).toMatchObject({ lon: -137, ambiguous: 1, nav_type: 3 });
  });

  it('keeps stations that share only an ident, in different regions', () => {
    const { out } = convert(msfs({ extra: { vor: [
      vor(1000, 'ZZVR', { region: 'ZZ', lonx: -136 }), vor(1001, 'ZZVR', { region: 'ZY', lonx: -135 }),
    ] } }));
    expect(navaid(out, 'V', 'ZZVR', 'ZZ')!.ambiguous).toBe(0);
    expect(navaid(out, 'V', 'ZZVR', 'ZY')!.ambiguous).toBe(0);
  });
});

describe('navaid columns beyond the preset', () => {
  it('maps every VOR type to its class and TACAN flag', () => {
    const types: [string, number | null, number, number][] = [
      // type, nav_type, is_nav, is_tacan
      ['H', 3, 1, 0], ['VTH', 3, 1, 1], ['L', 2, 1, 0], ['VTL', 2, 1, 1], ['T', 1, 1, 0], ['VTT', 1, 1, 1],
      ['TC', null, 0, 1], ['XX', null, 1, 0],
    ];
    const { out } = convert(msfs({ extra: { vor: types.map(([type], i) => vor(1000 + i, `ZZX${i}`, { type, lonx: -150 + i })) } }));
    types.forEach(([type, navType, isNav, isTacan], i) => {
      expect(navaid(out, 'V', `ZZX${i}`), type).toMatchObject({ nav_type: navType, is_nav: isNav, is_tacan: isTacan });
    });
  });

  it('maps NDB types, with an absent type left unclassed', () => {
    const types: [string | null, number | null][] = [['CP', 0], ['MH', 1], ['H', 2], ['HH', 3], [null, null], ['XX', null]];
    const { out } = convert(navigraph({ extra: { ndb: types.map(([type], i) => ndb(1000 + i, `ZZY${i}`, { type, lonx: -150 + i })) } }));
    types.forEach(([type, navType], i) => {
      expect(navaid(out, 'N', `ZZY${i}`), String(type)).toMatchObject({ nav_type: navType });
    });
  });

  it('flags a DME that is not at the station, and a VOR with no DME', () => {
    const { out } = convert(msfs({ extra: { vor: [
      vor(1000, 'ZZFAR', { dme_lonx: -150.001, dme_laty: 5, dme_altitude: 100 }),
      vor(1001, 'ZZNO', { dme_lonx: null, dme_laty: null, dme_altitude: null }),
      vor(1002, 'ZZNEAR', { dme_lonx: -150.0004, dme_laty: 5.0004, dme_altitude: 0 }),
    ] } }));
    expect(navaid(out, 'V', 'ZZFAR')).toMatchObject({ is_dme: 1, dme_at_nav: 0, dme_lon: -150.001 });
    expect(navaid(out, 'V', 'ZZNO')).toMatchObject({ is_dme: 0, dme_at_nav: 0, dme_lat: null, dme_alt_m: null });
    expect(navaid(out, 'V', 'ZZNEAR')).toMatchObject({ is_dme: 1, dme_at_nav: 1, dme_alt_m: 0 });
  });

  it('turns an NDB altitude of 0 into NULL and a VOR altitude of 0 into 0', () => {
    const { out } = convert(msfs({ extra: {
      ndb: [ndb(1000, 'ZZZ0', { altitude: 0 }), ndb(1001, 'ZZZ1', { altitude: null, lonx: -149 }),
        ndb(1002, 'ZZZ2', { altitude: 100, lonx: -148 })],
      vor: [vor(1000, 'ZZZV', { altitude: 0 }), vor(1001, 'ZZZW', { altitude: null, lonx: -149 })],
    } }));
    expect(navaid(out, 'N', 'ZZZ0')!.alt_m).toBeNull();
    expect(navaid(out, 'N', 'ZZZ1')!.alt_m).toBeNull();
    expect(navaid(out, 'N', 'ZZZ2')!.alt_m).toBeCloseTo(100 * FT, 9);
    expect(navaid(out, 'V', 'ZZZV')!.alt_m).toBe(0);
    expect(navaid(out, 'V', 'ZZZW')!.alt_m).toBeNull();
  });

  it('leaves a missing range NULL and reduces MSFS ranges by a third only for that flavour', () => {
    const extra = { vor: [vor(1000, 'ZZRNG', { range: 60 }), vor(1001, 'ZZRNN', { range: null, lonx: -149 })] };
    const m = convert(msfs({ extra })).out;
    const n = convert(navigraph({ extra })).out;
    expect(navaid(m, 'V', 'ZZRNG')!.nav_range_m).toBeCloseTo((60 * NM) / 1.5, 6);
    expect(navaid(n, 'V', 'ZZRNG')!.nav_range_m).toBeCloseTo(60 * NM, 6);
    expect(navaid(m, 'V', 'ZZRNN')!.nav_range_m).toBeNull();
    expect(navaid(n, 'V', 'ZZRNN')!.nav_range_m).toBeNull();
  });

  it('writes frequencies in hertz, rounded to whole numbers', () => {
    const { out } = convert(navigraph({ extra: {
      vor: [vor(1000, 'ZZF1', { frequency: 117_950 })], ndb: [ndb(1000, 'ZZF2', { frequency: 32_550 })],
      ils: [ils(1000, 'IZZF', { frequency: 111_750 })],
    } }));
    expect(navaid(out, 'V', 'ZZF1')!.frequency_hz).toBe(117_950_000);
    expect(navaid(out, 'N', 'ZZF2')!.frequency_hz).toBe(325_500);
    expect(navaid(out, 'V', 'IZZF')!.frequency_hz).toBe(111_750_000);
  });

  it('normalises a NULL region to the empty string and keeps it in the key', () => {
    const { out } = convert(msfs({ extra: {
      vor: [vor(1000, 'ZZNR', { region: null })], ndb: [ndb(1000, 'ZZNR', { region: null })],
    } }));
    expect(navaid(out, 'V', 'ZZNR', '')).toMatchObject({ region: '' });
    expect(navaid(out, 'N', 'ZZNR', '')).toMatchObject({ region: '' });
  });

  it('takes the owner airport ident of an airport_id, including a duplicated airport that lost its ident', () => {
    // Navigraph preset: ZZAC is airport 3 (loses) and 4 (owns); either id gives the one ident.
    const { out } = convert(navigraph({ extra: {
      vor: [vor(1000, 'ZZAV', { airport_id: 3 }), vor(1001, 'ZZAW', { airport_id: 4, lonx: -149 }),
        vor(1002, 'ZZAX', { airport_id: 9999, lonx: -148 }), vor(1003, 'ZZAY', { airport_id: null, lonx: -147 })],
    } }));
    expect(navaid(out, 'V', 'ZZAV')!.airport_ident).toBe('ZZAC');
    expect(navaid(out, 'V', 'ZZAW')!.airport_ident).toBe('ZZAC');
    expect(navaid(out, 'V', 'ZZAX')!.airport_ident).toBeNull();
    expect(navaid(out, 'V', 'ZZAY')!.airport_ident).toBeNull();
  });

  it('describes an ILS with a DME and a glide slope by their positions', () => {
    const { out } = convert(navigraph({ extra: { ils: [
      ils(1000, 'IZZD', { dme_lonx: -150, dme_laty: 7, dme_altitude: 20, gs_lonx: -150.0001, gs_laty: 7.0001, gs_altitude: 30,
        loc_width: 0, has_backcourse: 1 }),
      ils(1001, 'IZZE', { dme_lonx: -150, dme_laty: 7, gs_lonx: null, gs_laty: null, lonx: -149.99, loc_width: null,
        loc_heading: null }),
      ils(1002, 'IZZG', { dme_lonx: -150.2, dme_laty: 7, gs_lonx: -150, gs_laty: 7, altitude: 0, lonx: -148 }),
    ] } }));
    const d = navaid(out, 'V', 'IZZD')!;
    expect(d).toMatchObject({
      is_dme: 1, dme_at_nav: 1, dme_at_glide_slope: 1, has_glide_slope: 1, has_back_course: 1, localizer_width_deg: null,
    });
    expect(d.dme_alt_m).toBeCloseTo(20 * FT, 9);
    // No glide slope: the DME cannot be at it.
    expect(navaid(out, 'V', 'IZZE')).toMatchObject({
      has_glide_slope: 0, dme_at_glide_slope: 0, gs_lat: null, gs_alt_m: null, localizer_width_deg: null, localizer_deg: null,
    });
    // The DME is at neither the localizer nor the glide slope.
    expect(navaid(out, 'V', 'IZZG')).toMatchObject({ dme_at_nav: 0, dme_at_glide_slope: 0 });
  });

  it('takes the region of an ILS from its own column when it has one, and from the airport ident otherwise', () => {
    const { out } = convert(msfs({ extra: { ils: [
      ils(1000, 'IZZH', { region: 'ZY', loc_airport_ident: 'ZZAA' }),
      ils(1001, 'IZZI', { region: null, loc_airport_ident: 'ZYBB', lonx: -149 }),
      ils(1002, 'IZZJ', { region: '', loc_airport_ident: 'ZXCC', lonx: -148 }),
    ] } }));
    expect(navaid(out, 'V', 'IZZH', 'ZY')).toBeDefined();
    expect(navaid(out, 'V', 'IZZI', 'ZY')).toMatchObject({ airport_ident: 'ZYBB' });
    expect(navaid(out, 'V', 'IZZJ', 'ZX')).toBeDefined();
  });
});

describe('rows the navaid converter leaves out', () => {
  it('skips rows without an ident, GLS rows and ILS rows with no region to take, and says so once each', () => {
    const { out, stats, warnings } = convert(msfs({ extra: {
      vor: [vor(1000, null as unknown as string)],
      ndb: [ndb(1000, null as unknown as string), ndb(1001, '', { lonx: -149 })],
      ils: [
        ils(1000, 'IZZK', { type: 'G' }),
        ils(1001, null as unknown as string, { lonx: -149 }),
        ils(1002, 'IZZL', { region: null, loc_airport_ident: null, lonx: -148 }),
        ils(1003, 'IZZM', { region: null, loc_airport_ident: '', lonx: -147 }),
      ],
    } }));
    expect(stats[0].skipped).toMatchObject({
      'VOR rows without an ident': 1,
      'NDB rows without an ident': 2,
      'GLS rows, whose frequency column is a channel': 1,
      'ILS rows without an ident': 1,
      'ILS rows with no region and no airport to take one from': 2,
    });
    expect(rows(out, "SELECT 1 FROM nav_navaid WHERE ident IN ('IZZK', 'IZZL', 'IZZM')")).toEqual([]);
    expect(warnings).toContain('navaids: skipped 2 NDB rows without an ident');
    expect(warnings.every(w => w.startsWith('navaids: skipped '))).toBe(true);
  });

  it('writes nothing for a file with no stations', () => {
    const base = msfs();
    const { out, stats } = convert({ ...base, rows: { ...base.rows, vor: [], ndb: [], ils: [] } });
    expect(rows(out, 'SELECT * FROM nav_navaid')).toEqual([]);
    expect(stats[0]).toEqual({ written: { nav_navaid: 0 }, skipped: {} });
  });

  it('puts no row value in a warning', () => {
    const { warnings } = convert(msfs({ extra: { ndb: [ndb(1000, null as unknown as string)] } }));
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of warnings) expect(w).not.toMatch(/ZZ|IZZ|Zed|Station|Beacon/);
  });
});

// ── nav_waypoint ─────────────────────────────────────────────────────────────

describe.each(PRESETS)('waypoints from the %s preset', (name, preset) => {
  const isMsfs = name === 'msfs';

  it('writes every fix that is not LNM\'s copy of a VOR or NDB', () => {
    const { out, stats } = convert(preset());
    const idents = rows(out, 'SELECT ident FROM nav_waypoint ORDER BY ident, lon').map(r => r.ident);
    const expected = ['ZZT01', 'ZZW01', 'ZZW02', 'ZZW03', 'ZZW04', 'ZZW05', 'ZZW06', 'ZZW07'];
    if (isMsfs) expected.push('ZZR01', 'ZZV', 'ZZW10');
    expect(idents).toEqual(expected.sort());
    expect(stats[1].written).toEqual({ nav_waypoint: expected.length });
    expect(stats[1].skipped).toEqual({});
    // The artificial V and N rows: the VOR and the NDB are navaids, not waypoints.
    expect(rows(out, "SELECT 1 FROM nav_waypoint WHERE ident = 'ZZN'")).toEqual([]);
  });

  it('writes the fields of a row', () => {
    const { out } = convert(preset());
    const w = rows(out, "SELECT * FROM nav_waypoint WHERE ident = 'ZZW01'")[0];
    expect(w).toEqual({
      wpt_key: wptKey('ZZW01', 'ZZ', 12, -163), ident: 'ZZW01', region: 'ZZ', lat: 12, lon: -163, alt_m: null, magvar: 348,
      wpt_type: 1, is_terminal: 0, airport_ident: null, n_routes: 0, routes_state: 'fetched', routes_fetched_at: NOW,
      position_source: 'facility', rev: 1,
    });
    expect(rows(out, "SELECT wpt_type FROM nav_waypoint WHERE ident = 'ZZW03'")[0].wpt_type).toBe(2);
  });

  it('marks a fix owned by an airport terminal and names the airport', () => {
    const w = rows(convert(preset()).out, "SELECT is_terminal, airport_ident FROM nav_waypoint WHERE ident = 'ZZT01'")[0];
    expect(w).toEqual({ is_terminal: 1, airport_ident: 'ZZAA' });
  });

  it('keeps longitude 180 and latitude 90 exactly as stored', () => {
    const { out } = convert(preset());
    const east = rows(out, "SELECT wpt_key, lat, lon FROM nav_waypoint WHERE ident = 'ZZW04'")[0];
    expect(east).toEqual({ wpt_key: 'ZZW04|ZZ|1100000|18000000', lat: 11, lon: 180 });
    const pole = rows(out, "SELECT wpt_key, lat, lon FROM nav_waypoint WHERE ident = 'ZZW05'")[0];
    expect(pole).toEqual({ wpt_key: 'ZZW05|ZZ|9000000|0', lat: 90, lon: 0 });
  });

  it('inserts into the shipped DDL without a constraint or foreign-key failure', () => {
    const { out } = convert(preset());
    expect(rows(out, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(() => verifyNavdataColumns(out)).not.toThrow();
  });
});

describe('MSFS-only waypoints', () => {
  it('imports the RNAV and VFR points, a VFR fix beside a VOR of the same ident included', () => {
    const { out } = convert(msfs());
    expect(rows(out, "SELECT wpt_type, lat, lon FROM nav_waypoint WHERE ident = 'ZZR01'")).toEqual([
      { wpt_type: 8, lat: 11.5, lon: -160.5 },
    ]);
    expect(rows(out, "SELECT wpt_type, lat, lon, region FROM nav_waypoint WHERE ident = 'ZZV'")).toEqual([
      { wpt_type: 9, lat: 15, lon: -160, region: 'ZZ' },
    ]);
  });

  it('stores a NULL region as the empty string, in the key as well', () => {
    const w = rows(convert(msfs()).out, "SELECT wpt_key, region FROM nav_waypoint WHERE ident = 'ZZW10'")[0];
    expect(w).toEqual({ wpt_key: wptKey('ZZW10', '', 10, -159), region: '' });
  });
});

describe('waypoint columns beyond the preset', () => {
  it('leaves wpt_type NULL for a type that has no code', () => {
    const { out } = convert(navigraph({ extra: { waypoint: [
      waypoint(1000, 'ZZQ1', { type: 'XX' }), waypoint(1001, 'ZZQ2', { type: null, lonx: -148 }),
    ] } }));
    expect(rows(out, "SELECT ident, wpt_type FROM nav_waypoint WHERE ident LIKE 'ZZQ_' ORDER BY ident")).toEqual([
      { ident: 'ZZQ1', wpt_type: null }, { ident: 'ZZQ2', wpt_type: null },
    ]);
  });

  it('skips a waypoint with no ident', () => {
    const { out } = convert(navigraph({ extra: { waypoint: [waypoint(1000, '')] } }));
    expect(rows(out, "SELECT 1 FROM nav_waypoint WHERE ident = ''")).toEqual([]);
  });

  it('keys a position on a negative half-unit the way JavaScript rounds it, not SQLite', () => {
    // lat * 1e5 is exactly -1.5: Math.round gives -1, SQLite round() gives -2.
    const lat = -0.000015;
    const { out } = convert(navigraph({ extra: { waypoint: [waypoint(1000, 'ZZHLF', { laty: lat, lonx: -149 })] } }));
    const sqlite = out.prepare('SELECT CAST(round(? * 1e5) AS INTEGER)').pluck().get(lat);
    expect(sqlite).toBe(-2);
    const key = rows(out, "SELECT wpt_key FROM nav_waypoint WHERE ident = 'ZZHLF'")[0].wpt_key;
    expect(key).toBe(wptKey('ZZHLF', 'ZZ', lat, -149));
    expect(key).toBe('ZZHLF|ZZ|-1|-14900000');
  });
});

describe('waypoints sharing a key', () => {
  // Same ident and region, positions a hundredth of a key unit apart: one key, a different stored longitude each.
  const twinLon = (id: number): number => -149 + (id - 1000) * 1e-8;
  const twin = (id: number, over: AtoolsRow = {}): AtoolsRow =>
    waypoint(id, 'ZZMRG', { lonx: twinLon(id), laty: 8, ...over });

  it('lets an enroute row win over an earlier terminal one, with its own fields and a terminal flag of 0', () => {
    const { out, stats, warnings } = convert(msfs({ extra: { waypoint: [
      twin(1000, { airport_id: 1, type: 'WU', mag_var: 5 }),
      twin(1001, { type: 'WN', mag_var: 6 }),
    ] } }));
    const merged = rows(out, "SELECT * FROM nav_waypoint WHERE ident = 'ZZMRG'");
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      is_terminal: 0, airport_ident: null, wpt_type: 1, magvar: 354, lon: twinLon(1001),
    });
    expect(stats[1].skipped['waypoint rows merged into another with the same key']).toBe(1);
    expect(warnings).toContain('waypoints: merged 1 rows into another waypoint with the same key');
  });

  it('keeps the lowest id between two enroute rows, and between two terminal ones', () => {
    const { out } = convert(msfs({ extra: { waypoint: [
      twin(1003, { type: 'WU' }), twin(1002, { type: 'WN' }),
      twin(1005, { type: 'WU', ident: 'ZZMRT', airport_id: 1 }), twin(1004, { type: 'WN', ident: 'ZZMRT', airport_id: 2 }),
    ] } }));
    expect(rows(out, "SELECT wpt_type, is_terminal, airport_ident FROM nav_waypoint WHERE ident = 'ZZMRG'")).toEqual([
      { wpt_type: 1, is_terminal: 0, airport_ident: null },
    ]);
    expect(rows(out, "SELECT wpt_type, is_terminal, airport_ident FROM nav_waypoint WHERE ident = 'ZZMRT'")).toEqual([
      { wpt_type: 1, is_terminal: 1, airport_ident: 'ZZAB' },
    ]);
  });

  it('keeps an enroute row against a later terminal one, and against terminal rows on either side', () => {
    const { out } = convert(msfs({ extra: { waypoint: [
      twin(1010, { airport_id: 1, type: 'WU' }), twin(1011, { type: 'WN' }), twin(1012, { airport_id: 2, type: 'RNAV' }),
    ] } }));
    expect(rows(out, "SELECT wpt_type, is_terminal FROM nav_waypoint WHERE ident = 'ZZMRG'")).toEqual([
      { wpt_type: 1, is_terminal: 0 },
    ]);
  });

  it('does not merge fixes whose keys differ, nor the same ident in another region', () => {
    const { out } = convert(msfs({ extra: { waypoint: [
      twin(1020), twin(1021, { laty: 8.0001 }), twin(1022, { region: 'ZY' }),
    ] } }));
    expect(rows(out, "SELECT 1 FROM nav_waypoint WHERE ident = 'ZZMRG'")).toHaveLength(3);
  });
});
