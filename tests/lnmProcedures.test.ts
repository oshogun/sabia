// The Little Navmap procedures converter: SIDs, STARs, approaches, their
// transitions and legs. Everything runs on the invented atools rows of the
// fixture builder (plus rows each test adds); no real navigation database is
// opened.

import fs from 'fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { dest } from '../src/navdata/geometry';
import { applyNavdataSchema } from '../src/navdata/schema';
import { detectFlavour } from '../src/navdata/lnm/flavour';
import { createProceduresConverter, legSignature, proceduresConverter } from '../src/navdata/lnm/procedures';
import { buildSourceIndex } from '../src/navdata/lnm/sourceIndex';
import type { ConverterStats } from '../src/navdata/lnm/types';
import { ftToM, nmToM } from '../src/navdata/lnm/units';
import {
  buildLnmFixture, makeLnmFixtureDir, msfs, navigraph, type AtoolsRow, type LnmFixtureOverrides, type LnmFixtureSpec,
} from './helpers/lnmFixture';

// ── Scaffolding ──────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 9, 1, 12);

let dir: string;
let fixtures = 0;
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

type Row = Record<string, any>;
const q = (db: Database.Database, sql: string, ...params: unknown[]): Row[] => db.prepare(sql).all(...params) as Row[];
const one = (db: Database.Database, sql: string, ...params: unknown[]): any => db.prepare(sql).pluck().get(...params);

interface Run {
  out: Database.Database;
  stats: ConverterStats;
  warnings: string[];
  progress: [number, number][];
}

interface RunOptions {
  batchApproaches?: number;
  chunkRows?: number;
  /** Called with the replica before the converter runs. */
  prepare?: (out: Database.Database) => void;
  /** Idents left out of nav_airport, as if the airport converter had not written them. */
  withoutAirports?: string[];
}

/** Converts a fixture into a fresh replica that already holds the owner airports. */
function convert(spec: LnmFixtureSpec, options: RunOptions = {}): Run {
  const src = new Database(buildLnmFixture(dir, { ...spec, fileName: `procedures-${fixtures++}.sqlite` }), {
    readonly: true, fileMustExist: true,
  });
  const { flavour, provider } = detectFlavour(src);
  const index = buildSourceIndex(src, flavour);
  const out = new Database(':memory:');
  out.pragma('foreign_keys = ON');
  applyNavdataSchema(out);
  open.push(src, out);

  const addAirport = out.prepare('INSERT INTO nav_airport (ident, region, rev) VALUES (?, ?, 1)');
  for (const r of q(src, 'SELECT airport_id, ident FROM airport ORDER BY airport_id')) {
    if (index.airportById(r.airport_id)?.isOwner && !options.withoutAirports?.includes(r.ident)) addAirport.run(r.ident, '');
  }

  options.prepare?.(out);
  const warnings: string[] = [];
  const progress: [number, number][] = [];
  const stats = createProceduresConverter({ batchApproaches: options.batchApproaches, chunkRows: options.chunkRows }).run({
    src, out, flavour, provider, index, now: NOW,
    progress: (done, total) => progress.push([done, total]),
    warn: message => warnings.push(message),
  });
  return { out, stats, warnings, progress };
}

const procKeysOf = (out: Database.Database, airport: string): string[] =>
  q(out, 'SELECT proc_key FROM nav_procedure WHERE airport_ident = ? ORDER BY proc_key', airport).map(r => r.proc_key);

const transitionsOf = (out: Database.Database, key: string): Row[] =>
  q(out, `SELECT role, name, runway_number, runway_designator, trans_type, n_legs FROM nav_procedure_transition
           WHERE proc_key = ? ORDER BY role, name`, key);

/** The legs of one transition, in order. */
const legsOf = (out: Database.Database, key: string, role: string, name = ''): Row[] =>
  q(out, `SELECT l.* FROM nav_procedure_leg l JOIN nav_procedure_transition t ON t.trans_key = l.trans_key
           WHERE t.proc_key = ? AND t.role = ? AND t.name = ? ORDER BY l.seq`, key, role, name);

/** The legs of the transition with exactly this key, in order. */
const legsOfKey = (out: Database.Database, transKey: string): Row[] =>
  q(out, 'SELECT * FROM nav_procedure_leg WHERE trans_key = ? ORDER BY seq', transKey);

const idents = (legs: Row[]): (string | null)[] => legs.map(l => l.fix_ident);

/** Every row the converter wrote, for comparing two runs. */
const dump = (out: Database.Database): string =>
  JSON.stringify([
    q(out, 'SELECT * FROM nav_procedure ORDER BY proc_key'),
    q(out, 'SELECT * FROM nav_procedure_transition ORDER BY trans_key'),
    q(out, 'SELECT * FROM nav_procedure_leg ORDER BY trans_key, seq'),
  ]);

type Flavour = 'navigraph' | 'msfs';
const preset = (flavour: Flavour, over: LnmFixtureOverrides = {}): LnmFixtureSpec =>
  (flavour === 'navigraph' ? navigraph : msfs)(over);

// ── Invented rows the tests add ──────────────────────────────────────────────

/** An airport of its own in an empty stretch of the Pacific; its magnetic variation is 10 degrees east. */
const PA: AtoolsRow = {
  airport_id: 1000, ident: 'ZZPA', name: 'Zed Papa', region: 'ZZ', mag_var: 10, altitude: 100,
  lonx: -150, laty: 10, num_runways: 1, num_approach: 20,
};

const wpt = (id: number, ident: string, lon: number, lat: number, extra: AtoolsRow = {}): AtoolsRow =>
  ({ waypoint_id: id, ident, type: 'WN', region: 'ZZ', mag_var: 0, lonx: lon, laty: lat, ...extra });

const approachRow = (id: number, extra: AtoolsRow = {}): AtoolsRow => ({
  approach_id: id, airport_id: 1000, airport_ident: 'ZZPA', type: 'ILS', has_gps_overlay: 0, runway_name: '27',
  arinc_name: 'I27', fix_ident: 'ZZF01', fix_region: 'ZZ', ...extra,
});

/** A SID (suffix D) or STAR (suffix A) row; a null runway is the ALL row. */
const procedureRow = (id: number, name: string, suffix: 'D' | 'A', runway: string | null, extra: AtoolsRow = {}): AtoolsRow =>
  approachRow(id, {
    type: 'GPS', has_gps_overlay: 1, suffix, fix_ident: name, runway_name: runway,
    arinc_name: runway === null ? 'ALL' : `RW${runway}`, ...extra,
  });

const leg = (approachId: number, type: string, extra: AtoolsRow = {}): AtoolsRow => ({ approach_id: approachId, type, ...extra });
const tleg = (transitionId: number, type: string, extra: AtoolsRow = {}): AtoolsRow => ({ transition_id: transitionId, type, ...extra });
const fix = (type: string, ident: string, region: string | null = 'ZZ', extra: AtoolsRow = {}): AtoolsRow =>
  ({ fix_type: type, fix_ident: ident, fix_region: region, ...extra });
const transitionRow = (id: number, approachId: number, type: string, ident: string, extra: AtoolsRow = {}): AtoolsRow =>
  ({ transition_id: id, approach_id: approachId, type, fix_type: 'W', fix_ident: ident, fix_region: 'ZZ', ...extra });

/** The fixes around ZZPA that legs point at. */
const FIXES: AtoolsRow[] = [
  wpt(3001, 'ZZQ01', -149.9, 10.1, { airport_id: 1000 }),
  wpt(3002, 'ZZQ02', -149.8, 10.2),
  wpt(3003, 'ZZQ03', -149.7, 10.3),
  wpt(3004, 'ZZQ04', -149.6, 10.4),
];

// ── Kinds, names and keys ────────────────────────────────────────────────────

describe('which rows are SIDs, STARs and approaches', () => {
  it('goes by type, overlay flag and suffix together', () => {
    const { out, stats } = convert(msfs({ extra: {
      airport: [PA],
      approach: [
        procedureRow(1001, 'ZZS1', 'D', '27'),
        procedureRow(1002, 'ZZR1', 'A', '27'),
        // an overlay GPS approach with another suffix, a GPS approach with no overlay, and a plain approach that carries suffix A
        approachRow(1003, { type: 'GPS', has_gps_overlay: 1, suffix: 'C', arinc_name: 'G27' }),
        approachRow(1004, { type: 'GPS', has_gps_overlay: 0, suffix: 'D', arinc_name: 'P27' }),
        approachRow(1005, { type: 'RNAV', has_gps_overlay: 0, suffix: 'A', arinc_name: 'R27' }),
      ],
    } }));
    expect(procKeysOf(out, 'ZZPA')).toEqual([
      'ZZPA|APPROACH|1-27|27|0|C',
      'ZZPA|APPROACH|1-27|27|0|D',
      'ZZPA|APPROACH|10-27|27|0|A',
      'ZZPA|SID|ZZS1|||',
      'ZZPA|STAR|ZZR1|||',
    ]);
    // the preset adds one SID and one STAR of its own
    expect(stats.written).toMatchObject({ 'procedures.sid': 2, 'procedures.star': 2, 'procedures.approach': 5 });
  });

  it('skips the rows of a duplicated airport ident that lost, and their legs', () => {
    const { out, stats } = convert(navigraph({ extra: {
      // airport 3 is the lighter of the two ZZAC rows
      approach: [approachRow(1300, { airport_id: 3, airport_ident: 'ZZAC' }), approachRow(1301, { airport_id: 4, airport_ident: 'ZZAC' })],
      approach_leg: [leg(1300, 'TF', { ...fix('W', 'ZZNONE'), fix_region: 'ZZ' })],
    } }));
    expect(stats.skipped['approaches.duplicateAirport']).toBe(1);
    expect(stats.skipped).not.toHaveProperty('unresolved.approach.W');
    expect(procKeysOf(out, 'ZZAC')).toHaveLength(1);
  });

  it('skips the rows of an airport that is not in the replica', () => {
    const { out, stats, warnings } = convert(
      msfs({ extra: { airport: [PA], approach: [approachRow(1001)] } }), { withoutAirports: ['ZZPA'] },
    );
    expect(procKeysOf(out, 'ZZPA')).toEqual([]);
    expect(stats.skipped['approaches.airportNotInReplica']).toBe(1);
    expect(warnings).toContain('procedures: skipped 1 approach rows of an airport that was not imported');
  });
});

describe('approach names and keys', () => {
  it('names an approach by type and runway, with circling, compass and true-bearing runways', () => {
    const { out, stats } = convert(msfs({ extra: {
      airport: [PA],
      approach: [
        approachRow(1010, { runway_name: null, arinc_name: 'VDMA', type: 'VORDME', suffix: null }),
        approachRow(1011, { runway_name: 'NE', arinc_name: 'R-NE', type: 'RNAV', suffix: null }),
        approachRow(1012, { runway_name: '09T', arinc_name: 'I09', suffix: 'Z' }),
        approachRow(1013, { runway_name: '12C', arinc_name: 'N12C', type: 'NDB', suffix: '' }),
        approachRow(1014, { runway_name: '99X' }),
      ],
    } }));
    expect(procKeysOf(out, 'ZZPA')).toEqual([
      'ZZPA|APPROACH|10-NE|38|0|0',
      'ZZPA|APPROACH|2-00|0|0|0',
      'ZZPA|APPROACH|3-12C|12|3|0',
      'ZZPA|APPROACH|4-09|9|0|Z',
    ]);
    expect(q(out, `SELECT name, runway_number, runway_designator, approach_type, suffix, n_runway_transitions
                     FROM nav_procedure WHERE airport_ident = 'ZZPA' ORDER BY name`)).toEqual([
      { name: '10-NE', runway_number: 38, runway_designator: 0, approach_type: 10, suffix: '0', n_runway_transitions: null },
      { name: '2-00', runway_number: 0, runway_designator: 0, approach_type: 2, suffix: '0', n_runway_transitions: null },
      { name: '3-12C', runway_number: 12, runway_designator: 3, approach_type: 3, suffix: '0', n_runway_transitions: null },
      { name: '4-09', runway_number: 9, runway_designator: 0, approach_type: 4, suffix: 'Z', n_runway_transitions: null },
    ]);
    expect(stats.skipped['approaches.unparseableRunway']).toBe(1);
  });

  describe.each<Flavour>(['navigraph', 'msfs'])('two approaches on one key (%s)', flavour => {
    it('keeps the plain key on the first in final-fix order and gives the other a #2 key', () => {
      const { out, stats } = convert(preset(flavour));
      expect(procKeysOf(out, 'ZZAA').filter(k => k.includes('APPROACH'))).toEqual([
        'ZZAA|APPROACH|4-27R|27|2|0', 'ZZAA|APPROACH|4-27R|27|2|0#2',
      ]);
      expect(q(out, `SELECT proc_key, faf_ident, n_transitions FROM nav_procedure WHERE kind = 'APPROACH' ORDER BY proc_key`)).toEqual([
        { proc_key: 'ZZAA|APPROACH|4-27R|27|2|0', faf_ident: 'ZZW02', n_transitions: 3 },
        { proc_key: 'ZZAA|APPROACH|4-27R|27|2|0#2', faf_ident: 'ZZW03', n_transitions: 0 },
      ]);
      expect(stats.written['approaches.keySuffixed']).toBe(1);
    });
  });

  it('breaks a tie on every compared field by approach id: base, #2, #3', () => {
    const { out } = convert(msfs({ extra: {
      airport: [PA],
      approach: [approachRow(1022), approachRow(1020), approachRow(1021)],
    } }));
    expect(q(out, `SELECT proc_key FROM nav_procedure WHERE airport_ident = 'ZZPA' ORDER BY proc_key`).map(r => r.proc_key)).toEqual([
      'ZZPA|APPROACH|4-27|27|0|0', 'ZZPA|APPROACH|4-27|27|0|0#2', 'ZZPA|APPROACH|4-27|27|0|0#3',
    ]);
  });
});

// ── SID and STAR ─────────────────────────────────────────────────────────────

describe.each<Flavour>(['navigraph', 'msfs'])('SIDs and STARs of the preset (%s)', flavour => {
  it('splits a SID into the legs its runways share and each runway own legs', () => {
    const { out } = convert(preset(flavour));
    const key = 'ZZAA|SID|ZZ1D|||';
    expect(q(out, 'SELECT * FROM nav_procedure WHERE proc_key = ?', key)).toEqual([{
      proc_key: key, airport_ident: 'ZZAA', kind: 'SID', name: 'ZZ1D', runway_number: null, runway_designator: null,
      approach_type: null, suffix: null, faf_ident: null, faf_region: null, faf_alt_m: null, faf_heading_deg: null,
      missed_alt_m: null, has_lnav: null, has_lnavvnav: null, has_lp: null, has_lpv: null, n_transitions: null,
      n_runway_transitions: 2, n_enroute_transitions: 1, rev: 1,
    }]);
    expect(transitionsOf(out, key)).toEqual([
      { role: 'common', name: '', runway_number: null, runway_designator: null, trans_type: null, n_legs: 2 },
      { role: 'enroute', name: 'ZZW04', runway_number: null, runway_designator: null, trans_type: null, n_legs: 1 },
      { role: 'runway', name: '09L', runway_number: 9, runway_designator: 1, trans_type: null, n_legs: 2 },
      { role: 'runway', name: '27R', runway_number: 27, runway_designator: 2, trans_type: null, n_legs: 1 },
    ]);
    expect(idents(legsOf(out, key, 'common'))).toEqual(['ZZW02', 'ZZW03']);
    expect(idents(legsOf(out, key, 'runway', '09L'))).toEqual([null, 'ZZW01']);
    expect(idents(legsOf(out, key, 'runway', '27R'))).toEqual([null]);
    expect(legsOf(out, key, 'runway', '27R')[0]).toMatchObject({
      seq: 0, leg_type: 2, course_deg: 270, alt_desc: 2, altitude1_m: ftToM(500), true_degree: 0, rev: 1,
    });
  });

  it('puts the legs two rows share at the start of a STAR in common, and a runway-less row writes no runway transition', () => {
    const { out } = convert(preset(flavour));
    const key = 'ZZAA|STAR|ZZ2A|||';
    expect(transitionsOf(out, key).map(t => [t.role, t.name, t.n_legs])).toEqual([
      ['common', '', 3], ['enroute', 'ZZW06', 2], ['runway', '27R', 1],
    ]);
    expect(idents(legsOf(out, key, 'common'))).toEqual(['ZZW03', 'ZZW02', 'ZZW01']);
    expect(legsOf(out, key, 'common').map(l => l.is_if)).toEqual([1, 0, 0]);
    expect(legsOf(out, key, 'runway', '27R')[0]).toMatchObject({
      fix_ident: 'ZZT01', fix_type: 'W', fix_region: 'ZZ', fix_lat: 12.2, fix_lon: -165.2, leg_type: 4, course_deg: 270,
      distance_minute: 0, route_distance_m: nmToM(4),
    });
  });

  it('keeps every flag off every SID and STAR leg', () => {
    const { out } = convert(preset(flavour));
    expect(one(out, `SELECT SUM(l.is_faf) + SUM(l.is_map) + SUM(l.is_iaf) FROM nav_procedure_leg l
                       JOIN nav_procedure_transition t ON t.trans_key = l.trans_key
                       JOIN nav_procedure p ON p.proc_key = t.proc_key WHERE p.kind IN ('SID', 'STAR')`)).toBe(0);
    expect(one(out, `SELECT COUNT(*) FROM nav_procedure_leg l JOIN nav_procedure_transition t ON t.trans_key = l.trans_key
                       JOIN nav_procedure p ON p.proc_key = t.proc_key WHERE p.kind IN ('SID', 'STAR')`)).toBeGreaterThan(8);
  });
});

describe('the common and runway split', () => {
  const wps = [
    wpt(3101, 'ZZX01', -149.9, 10.1), wpt(3102, 'ZZX02', -149.8, 10.2), wpt(3103, 'ZZX03', -149.7, 10.3),
    wpt(3104, 'ZZX04', -149.6, 10.4), wpt(3105, 'ZZX05', -149.5, 10.5),
  ];
  const tf = (id: number, ident: string): AtoolsRow => leg(id, 'TF', fix('W', ident));

  it('puts the whole shorter member of a STAR in common when it is a strict prefix of another', () => {
    const { out } = convert(msfs({ extra: {
      airport: [PA], waypoint: wps,
      approach: [procedureRow(1030, 'ZZR2', 'A', '27'), procedureRow(1031, 'ZZR2', 'A', '09')],
      approach_leg: [
        leg(1030, 'IF', fix('W', 'ZZX01')), tf(1030, 'ZZX02'),
        leg(1031, 'IF', fix('W', 'ZZX01')), tf(1031, 'ZZX02'), tf(1031, 'ZZX03'), tf(1031, 'ZZX04'),
      ],
    } }));
    const key = 'ZZPA|STAR|ZZR2|||';
    expect(transitionsOf(out, key).map(t => [t.role, t.name, t.n_legs])).toEqual([
      ['common', '', 2], ['runway', '09', 2], ['runway', '27', 0],
    ]);
    expect(idents(legsOf(out, key, 'common'))).toEqual(['ZZX01', 'ZZX02']);
    expect(idents(legsOf(out, key, 'runway', '09'))).toEqual(['ZZX03', 'ZZX04']);
  });

  it('shares the end of a SID, and writes no common transition when no leg is shared', () => {
    const { out } = convert(msfs({ extra: {
      airport: [PA], waypoint: wps,
      approach: [
        procedureRow(1040, 'ZZS2', 'D', '27'), procedureRow(1041, 'ZZS2', 'D', '09'),
        procedureRow(1042, 'ZZS3', 'D', '27'), procedureRow(1043, 'ZZS3', 'D', '09'),
      ],
      approach_leg: [
        tf(1040, 'ZZX01'), tf(1040, 'ZZX02'), tf(1040, 'ZZX03'), tf(1041, 'ZZX02'), tf(1041, 'ZZX03'),
        tf(1042, 'ZZX01'), tf(1042, 'ZZX02'), tf(1043, 'ZZX03'), tf(1043, 'ZZX04'),
      ],
    } }));
    const shared = 'ZZPA|SID|ZZS2|||';
    expect(transitionsOf(out, shared).map(t => [t.role, t.name, t.n_legs])).toEqual([
      ['common', '', 2], ['runway', '09', 0], ['runway', '27', 1],
    ]);
    expect(idents(legsOf(out, shared, 'common'))).toEqual(['ZZX02', 'ZZX03']);
    expect(idents(legsOf(out, shared, 'runway', '27'))).toEqual(['ZZX01']);

    const distinct = 'ZZPA|SID|ZZS3|||';
    expect(transitionsOf(out, distinct).map(t => [t.role, t.name, t.n_legs])).toEqual([['runway', '09', 2], ['runway', '27', 2]]);
  });

  it('keeps a single ALL row whole in common, and a single runway row whole with an empty runway transition', () => {
    const { out } = convert(msfs({ extra: {
      airport: [PA], waypoint: wps,
      approach: [procedureRow(1070, 'ZZR3', 'A', null), procedureRow(1071, 'ZZR4', 'A', '18')],
      approach_leg: [tf(1070, 'ZZX01'), tf(1070, 'ZZX02'), tf(1071, 'ZZX03')],
    } }));
    expect(transitionsOf(out, 'ZZPA|STAR|ZZR3|||').map(t => [t.role, t.name, t.n_legs])).toEqual([['common', '', 2]]);
    expect(q(out, `SELECT n_runway_transitions FROM nav_procedure WHERE proc_key = 'ZZPA|STAR|ZZR3|||'`)).toEqual([{ n_runway_transitions: 0 }]);
    expect(transitionsOf(out, 'ZZPA|STAR|ZZR4|||').map(t => [t.role, t.name, t.n_legs])).toEqual([['common', '', 1], ['runway', '18', 0]]);
  });

  it('expands a both-ends runway to the runways of that number at the airport, or to the bare number', () => {
    const { out, stats } = convert(msfs({ extra: {
      airport: [PA], waypoint: wps,
      runway_end: [
        { runway_end_id: 3100, name: '09L', lonx: -150.01, laty: 10 }, { runway_end_id: 3101, name: '27R', lonx: -149.99, laty: 10 },
        { runway_end_id: 3102, name: '09R', lonx: -150.01, laty: 10.01 }, { runway_end_id: 3103, name: '27L', lonx: -149.99, laty: 10.01 },
      ],
      runway: [
        { runway_id: 3200, airport_id: 1000, primary_end_id: 3100, secondary_end_id: 3101, lonx: -150, laty: 10 },
        { runway_id: 3201, airport_id: 1000, primary_end_id: 3102, secondary_end_id: 3103, lonx: -150, laty: 10.01 },
      ],
      approach: [
        procedureRow(1050, 'ZZS4', 'D', null, { arinc_name: 'RW09B' }),
        procedureRow(1051, 'ZZS4', 'D', null, { arinc_name: 'RW05B' }),
      ],
      approach_leg: [tf(1050, 'ZZX01'), tf(1050, 'ZZX02'), tf(1051, 'ZZX03'), tf(1051, 'ZZX02')],
    } }));
    const key = 'ZZPA|SID|ZZS4|||';
    expect(transitionsOf(out, key).map(t => [t.role, t.name, t.runway_number, t.runway_designator, t.n_legs])).toEqual([
      ['common', '', null, null, 1], ['runway', '05', 5, 0, 1], ['runway', '09L', 9, 1, 1], ['runway', '09R', 9, 2, 1],
    ]);
    expect(idents(legsOf(out, key, 'common'))).toEqual(['ZZX02']);
    expect(idents(legsOf(out, key, 'runway', '09R'))).toEqual(['ZZX01']);
    expect(stats.skipped).not.toHaveProperty('sidstar.legsWithoutRunway');
  });

  it('keeps the lower approach id when two rows name one runway, reads a true-bearing runway, and drops an unreadable one', () => {
    const { out, stats } = convert(msfs({ extra: {
      airport: [PA], waypoint: wps,
      approach: [
        procedureRow(1060, 'ZZS5', 'D', '27'), procedureRow(1061, 'ZZS5', 'D', '27T'), procedureRow(1062, 'ZZS5', 'D', '99X'),
        procedureRow(1063, 'ZZS6', 'D', '99X'),
      ],
      approach_leg: [tf(1060, 'ZZX01'), tf(1061, 'ZZX02'), tf(1062, 'ZZX03'), tf(1063, 'ZZX04')],
      transition: [transitionRow(1160, 1060, 'F', 'ZZX05'), transitionRow(1161, 1061, 'F', 'ZZX05'), transitionRow(1162, 1061, 'F', 'ZZX04')],
      transition_leg: [tleg(1160, 'TF', fix('W', 'ZZX05')), tleg(1161, 'TF', fix('W', 'ZZX01')), tleg(1162, 'TF', fix('W', 'ZZX04'))],
    } }));
    const key = 'ZZPA|SID|ZZS5|||';
    expect(transitionsOf(out, key).map(t => [t.role, t.name, t.n_legs])).toEqual([
      ['common', '', 1], ['enroute', 'ZZX04', 1], ['enroute', 'ZZX05', 1], ['runway', '27', 0],
    ]);
    expect(idents(legsOf(out, key, 'common'))).toEqual(['ZZX01']);
    expect(idents(legsOf(out, key, 'enroute', 'ZZX05'))).toEqual(['ZZX05']);
    expect(procKeysOf(out, 'ZZPA')).not.toContain('ZZPA|SID|ZZS6|||');
    expect(stats.skipped['sidstar.duplicateRunway']).toBe(1);
    expect(stats.skipped['sidstar.unparseableRunway']).toBe(2);
  });

  it('counts the legs of a runway-less row that no runway row shares', () => {
    const { out, stats } = convert(msfs({ extra: {
      airport: [PA], waypoint: wps,
      approach: [procedureRow(1080, 'ZZR5', 'A', null), procedureRow(1081, 'ZZR5', 'A', '27')],
      approach_leg: [tf(1080, 'ZZX01'), tf(1080, 'ZZX05'), tf(1081, 'ZZX01'), tf(1081, 'ZZX02')],
    } }));
    expect(transitionsOf(out, 'ZZPA|STAR|ZZR5|||').map(t => [t.role, t.name, t.n_legs])).toEqual([['common', '', 1], ['runway', '27', 1]]);
    expect(stats.skipped['sidstar.legsWithoutRunway']).toBe(1);
  });

  it('compares legs on their source columns, not on a position or a flag', () => {
    const leg0 = {
      leg_type: 17, fix_ident: 'A', fix_region: 'ZZ', fix_type: 'W', fix_lat: 1, fix_lon: 2,
      origin_ident: null, origin_region: null, origin_type: null, origin_lat: null, origin_lon: null,
      arc_center_ident: 'C', arc_center_region: 'ZZ', arc_center_type: 'W', arc_center_lat: 5, arc_center_lon: 6,
      fly_over: 0, turn_direction: 1, course_deg: null, true_degree: 0, theta_deg: 30, rho_m: 3704, distance_minute: null,
      route_distance_m: null, alt_desc: 0, altitude1_m: null, altitude2_m: null, speed_limit_kt: null,
      vertical_angle_deg: null, is_iaf: 0, is_if: 0, is_faf: 0, is_map: 0,
    };
    const same = legSignature({ ...leg0, fix_lat: 9, fix_lon: 9, arc_center_lat: 9, arc_center_lon: 9, is_iaf: 1, is_faf: 1, is_map: 1, is_if: 1 });
    expect(same).toBe(legSignature(leg0));
    expect(legSignature({ ...leg0, arc_center_ident: 'D' })).not.toBe(legSignature(leg0));
    expect(legSignature({ ...leg0, altitude1_m: 1 })).not.toBe(legSignature(leg0));
    expect(legSignature({ ...leg0, fix_type: 'N' })).not.toBe(legSignature(leg0));
    expect(JSON.parse(legSignature(leg0))).toHaveLength(22);
  });
});

describe('arc centres', () => {
  // Two waypoints named ZZC01: one on the perpendicular bisector of the leg's start and end, one near the airport.
  const centres: AtoolsRow[] = [
    wpt(3201, 'ZZC01', -150, 11), wpt(3202, 'ZZC01', -149.6, 10.2),
    wpt(3203, 'ZZP01', -149.5, 10), wpt(3204, 'ZZP02', -150.5, 10), wpt(3205, 'ZZP03', -148.7, 10.4),
  ];
  const rf = (id: number, ident: string): AtoolsRow => leg(id, 'RF', {
    ...fix('TW', ident, 'ZZ', { fix_airport_ident: 'ZZPA' }), recommended_fix_type: 'TW', recommended_fix_ident: 'ZZC01',
    recommended_fix_region: 'ZZ', turn_direction: 'L', theta: 30, rho: 2,
  });
  const tf = (id: number, ident: string): AtoolsRow => leg(id, 'TF', fix('W', ident));

  it('picks the candidate equally far from the previous and the current fix', () => {
    const { out, stats } = convert(msfs({ extra: {
      airport: [PA], waypoint: centres,
      approach: [approachRow(1090, { runway_name: '27' })],
      approach_leg: [tf(1090, 'ZZP01'), rf(1090, 'ZZP02')],
    } }));
    const rfLeg = legsOf(out, 'ZZPA|APPROACH|4-27|27|0|0', 'final')[1];
    expect(rfLeg).toMatchObject({
      leg_type: 17, turn_direction: 1, theta_deg: 30, rho_m: nmToM(2), origin_ident: null, origin_type: null,
      arc_center_ident: 'ZZC01', arc_center_region: 'ZZ', arc_center_type: 'W', arc_center_lat: 11, arc_center_lon: -150,
    });
    expect(stats.skipped).not.toHaveProperty('unresolved.approach.TW');
  });

  it('falls back to the candidate nearest the airport when there is no previous leg', () => {
    const { out } = convert(msfs({ extra: {
      airport: [PA], waypoint: centres,
      approach: [approachRow(1090, { runway_name: '27' })],
      approach_leg: [rf(1090, 'ZZP02')],
    } }));
    expect(legsOf(out, 'ZZPA|APPROACH|4-27|27|0|0', 'final')[0]).toMatchObject({ arc_center_lat: 10.2, arc_center_lon: -149.6 });
  });

  it('shares a first RF leg whose centre ident has two candidates, whatever each row resolves it to', () => {
    // Row A reaches the arc from ZZP01, row B from ZZP03; the rule picks a different centre for each,
    // but the two rows still fly the same arc and so share it.
    const { out } = convert(msfs({ extra: {
      airport: [PA], waypoint: centres,
      approach: [
        procedureRow(1100, 'ZZS7', 'D', '27'), procedureRow(1101, 'ZZS7', 'D', '09'),
        procedureRow(1102, 'ZZS8', 'D', '27'),
      ],
      approach_leg: [
        tf(1100, 'ZZP01'), rf(1100, 'ZZP02'), tf(1100, 'ZZQ01'),
        tf(1101, 'ZZP03'), rf(1101, 'ZZP02'), tf(1101, 'ZZQ01'),
        tf(1102, 'ZZP03'), rf(1102, 'ZZP02'), tf(1102, 'ZZQ01'),
      ],
    }, }));
    const key = 'ZZPA|SID|ZZS7|||';
    expect(transitionsOf(out, key).map(t => [t.role, t.name, t.n_legs])).toEqual([
      ['common', '', 2], ['runway', '09', 1], ['runway', '27', 1],
    ]);
    // the shared legs are those of the lowest approach id, which reached the arc from ZZP01
    expect(legsOf(out, key, 'common')[0]).toMatchObject({ leg_type: 17, arc_center_lat: 11, arc_center_lon: -150 });
    // a row that reaches the arc from ZZP03 on its own gets the other centre
    expect(legsOf(out, 'ZZPA|SID|ZZS8|||', 'common')[1]).toMatchObject({ leg_type: 17, arc_center_lat: 10.2, arc_center_lon: -149.6 });
  });
});

// ── Approaches: flags and header columns ─────────────────────────────────────

describe.each<Flavour>(['navigraph', 'msfs'])('an ILS approach of the preset (%s)', flavour => {
  const key = 'ZZAA|APPROACH|4-27R|27|2|0';

  it('writes final, missed and approach transitions, the FAF and MAP flags, and the IAF flag', () => {
    const { out } = convert(preset(flavour));
    expect(transitionsOf(out, key).map(t => [t.role, t.name, t.trans_type, t.n_legs])).toEqual([
      ['approach', 'ZZV', 2, 3], ['approach', 'ZZW03', 1, 2], ['approach', 'ZZW03', 1, 2],
      ['final', '', null, 3], ['missed', '', null, 3],
    ]);
    expect(legsOf(out, key, 'final').map(l => [l.fix_ident, l.is_if, l.is_faf, l.is_map, l.is_iaf])).toEqual([
      ['ZZW01', 1, 0, 0, 0], ['ZZW02', 0, 1, 0, 0], ['RW27R', 0, 0, 1, 0],
    ]);
    expect(legsOf(out, key, 'missed').map(l => [l.is_faf, l.is_map, l.is_iaf])).toEqual([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    expect(legsOfKey(out, `${key}|approach|ZZW03`).map(l => l.is_iaf)).toEqual([1, 0]);
    expect(legsOfKey(out, `${key}|approach|ZZW03#2`).map(l => l.is_iaf)).toEqual([1, 0]);
    expect(legsOfKey(out, `${key}|approach|ZZV`).map(l => l.is_iaf)).toEqual([1, 0, 0]);
  });

  it('keeps a repeated approach-transition name in the key only', () => {
    const { out } = convert(preset(flavour));
    expect(q(out, `SELECT trans_key, name FROM nav_procedure_transition WHERE proc_key = ? AND role = 'approach' ORDER BY trans_key`, key)).toEqual([
      { trans_key: `${key}|approach|ZZV`, name: 'ZZV' },
      { trans_key: `${key}|approach|ZZW03`, name: 'ZZW03' },
      { trans_key: `${key}|approach|ZZW03#2`, name: 'ZZW03' },
    ]);
  });

  it('fills the header columns from the header, or from the legs when the header has none', () => {
    const { out } = convert(preset(flavour));
    const [row] = q(out, 'SELECT * FROM nav_procedure WHERE proc_key = ?', key);
    expect(row).toMatchObject({
      faf_ident: 'ZZW02', faf_region: 'ZZ', faf_alt_m: ftToM(2500), missed_alt_m: ftToM(3000),
      has_lnav: null, has_lpv: null, n_transitions: 3, n_runway_transitions: null, n_enroute_transitions: null,
    });
    // MSFS gives the final course as a true heading, 270 less the 12.5 degrees east variation; Navigraph gives the leg's magnetic course.
    expect(row.faf_heading_deg).toBeCloseTo(flavour === 'msfs' ? 257.5 : 270, 10);
  });

  it('writes the vertical angle as 360 minus the path angle on both flavours', () => {
    const { out } = convert(preset(flavour));
    expect(legsOf(out, key, 'final').map(l => l.vertical_angle_deg)).toEqual([null, null, 357]);
  });

  it('records the DME arc of a transition from its first AF leg', () => {
    const { out } = convert(preset(flavour));
    const [row] = q(out, `SELECT * FROM nav_procedure_transition WHERE proc_key = ? AND role = 'approach' AND name = 'ZZV'`, key);
    expect(row).toMatchObject({ trans_type: 2, iaf_ident: 'ZZV', iaf_region: 'ZZ', dme_arc_ident: 'ZZV', dme_arc_radial_deg: 45, dme_arc_distance_m: nmToM(10) });
    const [plain] = q(out, `SELECT * FROM nav_procedure_transition WHERE proc_key = ? AND role = 'approach' AND name = 'ZZW03' ORDER BY trans_key`, key);
    expect(plain).toMatchObject({ trans_type: 1, dme_arc_ident: null, dme_arc_region: null, dme_arc_radial_deg: null, dme_arc_distance_m: null });
  });
});

describe('the flags of an approach', () => {
  const wps = [wpt(3301, 'ZZX01', -149.9, 10.1), wpt(3302, 'ZZX02', -149.8, 10.2), wpt(3303, 'ZZX03', -149.7, 10.3)];

  it('marks the first leg of each approach transition as an IAF where the source has no descriptor (MSFS), and the FAF as the first leg on the final fix', () => {
    const { out } = convert(msfs({ extra: {
      airport: [PA], waypoint: wps,
      approach: [approachRow(1400, { fix_ident: 'ZZX02' })],
      approach_leg: [
        leg(1400, 'IF', fix('W', 'ZZX01')), leg(1400, 'TF', fix('W', 'ZZX02')), leg(1400, 'TF', fix('W', 'ZZX02')), leg(1400, 'TF', fix('W', 'ZZX03')),
      ],
      transition: [transitionRow(1401, 1400, 'F', 'ZZX01')],
      transition_leg: [tleg(1401, 'IF', fix('W', 'ZZX01')), tleg(1401, 'TF', fix('W', 'ZZX02'))],
    } }));
    const key = 'ZZPA|APPROACH|4-27|27|0|0';
    expect(legsOf(out, key, 'final').map(l => [l.is_faf, l.is_map])).toEqual([[0, 0], [1, 0], [0, 0], [0, 1]]);
    expect(legsOf(out, key, 'approach', 'ZZX01').map(l => l.is_iaf)).toEqual([1, 0]);
  });

  it('puts FAF and MAP on one leg when the FAF is the last final leg', () => {
    const { out } = convert(msfs({ extra: {
      airport: [PA], waypoint: wps,
      approach: [approachRow(1410, { fix_ident: 'ZZX03' })],
      approach_leg: [leg(1410, 'IF', fix('W', 'ZZX01')), leg(1410, 'TF', fix('W', 'ZZX03'))],
    } }));
    expect(legsOf(out, 'ZZPA|APPROACH|4-27|27|0|0', 'final').map(l => [l.is_faf, l.is_map])).toEqual([[0, 0], [1, 1]]);
  });

  it('reads the IAF flag from the fourth character of the descriptor where the source has one (Navigraph)', () => {
    const coords = (lon: number, lat: number): AtoolsRow => ({ fix_lonx: lon, fix_laty: lat });
    const { out } = convert(navigraph({ extra: {
      airport: [PA], waypoint: wps,
      approach: [approachRow(1420, { fix_ident: 'ZZX03' })],
      approach_leg: [
        leg(1420, 'IF', { ...fix('W', 'ZZX01'), ...coords(-149.9, 10.1), arinc_descr_code: 'E  D' }),
        leg(1420, 'TF', { ...fix('W', 'ZZX02'), ...coords(-149.8, 10.2), arinc_descr_code: 'E  F' }),
      ],
      transition: [transitionRow(1421, 1420, 'F', 'ZZX01')],
      transition_leg: [
        tleg(1421, 'IF', { ...fix('W', 'ZZX01'), ...coords(-149.9, 10.1), arinc_descr_code: 'E  A' }),
        tleg(1421, 'TF', { ...fix('W', 'ZZX02'), ...coords(-149.8, 10.2), arinc_descr_code: 'E  C' }),
        tleg(1421, 'TF', { ...fix('W', 'ZZX03'), ...coords(-149.7, 10.3) }),
      ],
    } }));
    const key = 'ZZPA|APPROACH|4-27|27|0|0';
    expect(legsOf(out, key, 'final').map(l => l.is_iaf)).toEqual([1, 0]);
    expect(legsOf(out, key, 'approach', 'ZZX01').map(l => l.is_iaf)).toEqual([1, 1, 0]);
  });

  it('never flags a SID or STAR leg, whatever its descriptor says', () => {
    const coords = (lon: number, lat: number): AtoolsRow => ({ fix_lonx: lon, fix_laty: lat });
    const { out } = convert(navigraph({ extra: {
      airport: [PA], waypoint: wps,
      approach: [procedureRow(1430, 'ZZS9', 'D', '27')],
      approach_leg: [
        leg(1430, 'IF', { ...fix('W', 'ZZX01'), ...coords(-149.9, 10.1), arinc_descr_code: 'E  C' }),
        leg(1430, 'TF', { ...fix('W', 'ZZX03'), ...coords(-149.7, 10.3), arinc_descr_code: 'E  A' }),
      ],
      transition: [transitionRow(1431, 1430, 'F', 'ZZX01')],
      transition_leg: [tleg(1431, 'IF', { ...fix('W', 'ZZX01'), ...coords(-149.9, 10.1), arinc_descr_code: 'E  D' })],
    } }));
    const legs = q(out, `SELECT l.is_iaf, l.is_faf, l.is_map, l.is_if FROM nav_procedure_leg l WHERE l.trans_key LIKE 'ZZPA|SID|ZZS9%'`);
    expect(legs).toHaveLength(3);
    expect(legs.map(l => [l.is_iaf, l.is_faf, l.is_map])).toEqual([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    expect(legs.map(l => l.is_if).sort()).toEqual([0, 1, 1]);
  });

  it('falls back to the leg altitude, the leg course and the missed legs when the header has none', () => {
    const { out } = convert(msfs({ extra: {
      airport: [PA], waypoint: wps,
      approach: [approachRow(1440, { fix_ident: 'ZZX02', altitude: null, heading: null, missed_altitude: null }),
        approachRow(1441, { fix_ident: 'ZZX02', arinc_name: 'I27-Z', altitude: 0, heading: 0, missed_altitude: 0 })],
      approach_leg: [
        leg(1440, 'TF', { ...fix('W', 'ZZX02'), altitude1: 1800, course: 261 }),
        leg(1440, 'CA', { is_missed: 1, altitude1: 700 }), leg(1440, 'DF', { is_missed: 1, ...fix('W', 'ZZX03'), altitude1: 2400 }),
        leg(1441, 'TF', { ...fix('W', 'ZZX02'), altitude1: 1800, course: 261 }),
        leg(1441, 'CA', { is_missed: 1, altitude1: 700 }),
      ],
    } }));
    const rows = q(out, `SELECT proc_key, faf_alt_m, faf_heading_deg, missed_alt_m FROM nav_procedure WHERE airport_ident = 'ZZPA' ORDER BY proc_key`);
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.faf_alt_m === ftToM(1800))).toMatchObject({ faf_heading_deg: 261, missed_alt_m: ftToM(2400) });
    // a header of zero is a value, not an absence
    expect(rows.find(r => r.faf_alt_m === 0)).toMatchObject({ faf_heading_deg: 350, missed_alt_m: 0 });
  });
});

// ── Legs ─────────────────────────────────────────────────────────────────────

describe('leg encodings', () => {
  const key = 'ZZPA|APPROACH|4-27|27|0|0';
  const wps = [wpt(3401, 'ZZX01', -149.9, 10.1)];

  it('maps altitude descriptors and altitudes', () => {
    const { out, stats } = convert(msfs({ extra: {
      airport: [PA],
      approach: [approachRow(1500)],
      approach_leg: [
        leg(1500, 'CA'),
        leg(1500, 'CA', { alt_descriptor: 'A', altitude1: 0 }),
        leg(1500, 'CA', { alt_descriptor: 'A', altitude1: 3000 }),
        leg(1500, 'CA', { alt_descriptor: '+', altitude1: 2000 }),
        leg(1500, 'CA', { alt_descriptor: '-', altitude1: 1500 }),
        leg(1500, 'CA', { alt_descriptor: 'B', altitude1: 3000, altitude2: 2000 }),
        leg(1500, 'CA', { alt_descriptor: 'X', altitude1: 500 }),
        leg(1500, 'CA', { alt_descriptor: '+', altitude1: 0, altitude2: 800 }),
      ],
    } }));
    expect(legsOf(out, key, 'final').map(l => [l.alt_desc, l.altitude1_m, l.altitude2_m])).toEqual([
      [0, null, null], [0, null, null], [1, ftToM(3000), null], [2, ftToM(2000), null], [3, ftToM(1500), null],
      [4, ftToM(3000), ftToM(2000)], [0, ftToM(500), null], [2, null, ftToM(800)],
    ]);
    expect(stats.skipped['legs.unknownAltDescriptor']).toBe(1);
  });

  it('maps turns, courses, holds, distances, arcs, speeds and leg types', () => {
    const { out, stats } = convert(msfs({ extra: {
      airport: [PA],
      approach: [approachRow(1510)],
      approach_leg: [
        leg(1510, 'CA', { course: 90, is_true_course: 1, is_flyover: 1, turn_direction: 'L', distance: 0, time: 0 }),
        leg(1510, 'HM', { time: 1.5, turn_direction: 'R', speed_limit: 230 }),
        leg(1510, 'CF', { distance: 5, turn_direction: 'B', speed_limit: 0, theta: 0, rho: 0 }),
        leg(1510, 'AF', { theta: 45, rho: 10 }),
        leg(1510, 'TF', { theta: 0, rho: 3, turn_direction: 'X' }),
        leg(1510, 'ZZ'),
        leg(1510, 'IF'),
        leg(1510, 'VA', { distance: 2, time: 3 }),
      ],
    } }));
    const legs = legsOf(out, key, 'final');
    expect(legs.map(l => [l.leg_type, l.is_if, l.fly_over, l.turn_direction, l.course_deg, l.true_degree])).toEqual([
      [2, 0, 1, 1, 90, 1], [14, 0, 0, 2, null, 0], [4, 0, 0, 3, null, 0], [1, 0, 0, 0, null, 0],
      [18, 0, 0, 0, null, 0], [0, 0, 0, 0, null, 0], [15, 1, 0, 0, null, 0], [19, 0, 0, 0, null, 0],
    ]);
    expect(legs.map(l => [l.distance_minute, l.route_distance_m, l.speed_limit_kt, l.theta_deg, l.rho_m])).toEqual([
      [null, null, null, null, null], [1, 1.5, 230, null, null], [0, nmToM(5), null, null, null], [null, null, null, 45, nmToM(10)],
      [null, null, null, 0, nmToM(3)], [null, null, null, null, null], [null, null, null, null, null], [1, 3, null, null, null],
    ]);
    expect(stats.skipped['legs.unknownType']).toBe(1);
  });

  it('writes the plain fix letter, with the position of a fix resolved from the index', () => {
    const { out, stats } = convert(msfs({ extra: {
      airport: [PA], waypoint: wps,
      vor: [{ vor_id: 3410, ident: 'ZZV9', region: 'ZZ', type: 'H', frequency: 112000, lonx: -149.5, laty: 10.5 }],
      ndb: [
        { ndb_id: 3420, ident: 'ZZN9', region: 'ZZ', airport_id: 1000, frequency: 37500, lonx: -149.4, laty: 10.6 },
        { ndb_id: 3421, ident: 'ZZN9', region: 'ZZ', frequency: 37500, lonx: -140, laty: 15 },
        { ndb_id: 3422, ident: 'ZZN8', region: 'ZZ', frequency: 37500, lonx: -149.3, laty: 10.7 },
        { ndb_id: 3423, ident: 'ZZN8', region: 'ZZ', frequency: 37500, lonx: -139, laty: 14 },
      ],
      approach: [approachRow(1520)],
      approach_leg: [
        leg(1520, 'TF', fix('W', 'ZZX01')),
        leg(1520, 'TF', fix('TW', 'ZZX01', 'ZZ', { fix_airport_ident: 'ZZPA' })),
        leg(1520, 'TF', fix('V', 'ZZV9')),
        leg(1520, 'TF', fix('N', 'ZZN8')),
        leg(1520, 'TF', fix('TN', 'ZZN9', 'ZZ', { fix_airport_ident: 'ZZPA' })),
        leg(1520, 'TF', fix('A', 'ZZPA', null)),
        leg(1520, 'TF', fix('Q', 'ZZX01')),
      ],
    } }));
    expect(legsOf(out, key, 'final').map(l => [l.fix_type, l.fix_ident, l.fix_region, l.fix_lat, l.fix_lon])).toEqual([
      ['W', 'ZZX01', 'ZZ', 10.1, -149.9], ['W', 'ZZX01', 'ZZ', 10.1, -149.9], ['V', 'ZZV9', 'ZZ', 10.5, -149.5],
      // an NDB with no airport is preferred, a terminal NDB is the one at the airport
      ['N', 'ZZN8', 'ZZ', 10.7, -149.3], ['N', 'ZZN9', 'ZZ', 10.6, -149.4], ['A', 'ZZPA', null, 10, -150],
      [null, 'ZZX01', 'ZZ', null, null],
    ]);
    expect(stats.skipped['legs.unknownFixType']).toBe(1);
    expect(stats.skipped['unresolved.approach.other']).toBe(1);
  });
});

describe('the recommended navaid of a leg', () => {
  it('is the origin of a course leg and the centre of an AF arc, an ILS getting its derived region', () => {
    const { out } = convert(msfs({ extra: {
      airport: [PA],
      waypoint: [wpt(3501, 'ZZX01', -149.9, 10.1)],
      vor: [{ vor_id: 3510, ident: 'ZZV9', region: 'ZZ', type: 'H', frequency: 112000, lonx: -149.5, laty: 10.5 }],
      ils: [{ ils_id: 3520, ident: 'IZZP', region: null, type: 'I', frequency: 110500, lonx: -150.02, laty: 10, loc_airport_ident: 'ZZPA' }],
      approach: [approachRow(1600)],
      approach_leg: [
        leg(1600, 'AF', { ...fix('W', 'ZZX01'), recommended_fix_type: 'V', recommended_fix_ident: 'ZZV9', recommended_fix_region: 'ZZ', theta: 90, rho: 8, turn_direction: 'R' }),
        leg(1600, 'CF', { ...fix('W', 'ZZX01'), recommended_fix_type: 'L', recommended_fix_ident: 'IZZP', course: 270 }),
        leg(1600, 'CF', { ...fix('W', 'ZZX01'), recommended_fix_type: null, recommended_fix_ident: 'IZZP', course: 270 }),
        leg(1600, 'TF', { ...fix('W', 'ZZX01'), recommended_fix_type: 'TN', recommended_fix_ident: 'ZZNOPE', recommended_fix_region: 'ZZ' }),
      ],
    } }));
    const legs = legsOf(out, 'ZZPA|APPROACH|4-27|27|0|0', 'final');
    const origin = (l: Row): unknown[] => [l.origin_ident, l.origin_region, l.origin_type, l.origin_lat, l.origin_lon];
    const arc = (l: Row): unknown[] => [l.arc_center_ident, l.arc_center_region, l.arc_center_type, l.arc_center_lat, l.arc_center_lon];
    expect(origin(legs[0])).toEqual(['ZZV9', 'ZZ', 'V', 10.5, -149.5]);
    expect(arc(legs[0])).toEqual(origin(legs[0]));
    expect(origin(legs[1])).toEqual(['IZZP', 'ZZ', 'V', 10, -150.02]);
    expect(origin(legs[2])).toEqual(origin(legs[1]));
    expect(arc(legs[1])).toEqual([null, null, null, null, null]);
    expect(origin(legs[3])).toEqual(['ZZNOPE', 'ZZ', 'N', null, null]);
  });
});

// ── Fix resolution ───────────────────────────────────────────────────────────

describe('fix resolution', () => {
  const key = 'ZZPA|APPROACH|4-27|27|0|0';

  /** Waypoints around ZZPA (10 N, 150 W); one degree of latitude is 60 NM. */
  const waypoints: AtoolsRow[] = [
    wpt(3601, 'ZZQ01', -149.9, 10.1, { airport_id: 1000 }),
    wpt(3602, 'ZZQ01', -149, 11, { region: 'ZY' }),
    wpt(3603, 'ZZQ02', -150, 10.5),
    wpt(3604, 'ZZQ03', -149.5, 10, { region: 'ZY' }),
    wpt(3605, 'ZZQ03', -150.5, 10, { region: 'ZW' }),
    wpt(3606, 'ZZQ04', -147, 10),
    wpt(3607, 'ZZQ05', -149.8, 10.2),
    wpt(3608, 'ZZQ06', -149.9, 10.1, { region: 'ZY' }),
  ];

  it('resolves a terminal waypoint of another region to the one the procedure airport owns', () => {
    const { out, stats } = convert(msfs({ extra: {
      airport: [PA], waypoint: waypoints,
      approach: [approachRow(1700)],
      approach_leg: [leg(1700, 'TF', fix('TW', 'ZZQ01', 'ZX', { fix_airport_ident: 'ZZPA' }))],
      transition: [transitionRow(1701, 1700, 'F', 'ZZQ01')],
      transition_leg: [tleg(1701, 'TF', fix('TW', 'ZZQ01', 'ZY', { fix_airport_ident: 'ZZPA' }))],
    } }));
    expect(legsOf(out, key, 'final')[0]).toMatchObject({ fix_ident: 'ZZQ01', fix_region: 'ZX', fix_type: 'W', fix_lat: 10.1, fix_lon: -149.9 });
    // a waypoint of the leg's own region exists elsewhere, but the airport's own wins
    expect(legsOf(out, key, 'approach', 'ZZQ01')[0]).toMatchObject({ fix_lat: 10.1, fix_lon: -149.9 });
    expect(stats.skipped).toEqual({ 'airportOwned.approach': 1, 'airportOwned.transition': 1 });
  });

  it('accepts the only same-ident waypoint within 60 NM when the region is foreign, and counts it', () => {
    const { out, stats } = convert(msfs({ extra: {
      airport: [PA], waypoint: waypoints,
      approach: [approachRow(1710)],
      approach_leg: [leg(1710, 'TF', fix('W', 'ZZQ02', 'ZX'))],
    } }));
    expect(legsOf(out, key, 'final')[0]).toMatchObject({ fix_ident: 'ZZQ02', fix_region: 'ZX', fix_lat: 10.5, fix_lon: -150 });
    expect(stats.skipped).toEqual({ 'regionRelaxed.approach': 1 });
  });

  it('leaves the position empty when two candidates are within 60 NM, or the only one is farther', () => {
    const { out, stats, warnings } = convert(msfs({ extra: {
      airport: [PA], waypoint: waypoints,
      approach: [approachRow(1720)],
      approach_leg: [leg(1720, 'TF', fix('W', 'ZZQ03', 'ZX')), leg(1720, 'TF', fix('W', 'ZZQ04', 'ZX')), leg(1720, 'TF', fix('W', 'ZZNONE', 'ZZ'))],
    } }));
    expect(legsOf(out, key, 'final').map(l => [l.fix_ident, l.fix_type, l.fix_lat, l.fix_lon])).toEqual([
      ['ZZQ03', 'W', null, null], ['ZZQ04', 'W', null, null], ['ZZNONE', 'W', null, null],
    ]);
    expect(stats.skipped).toEqual({ 'unresolved.approach.W': 3 });
    expect(warnings).toEqual(['procedures: wrote 3 drawable legs without a fix position']);
  });

  it('retries a one-letter region on the regions starting with that letter, and prefers an unowned waypoint', () => {
    const { out, stats } = convert(msfs({ extra: {
      airport: [PA], waypoint: waypoints,
      approach: [approachRow(1730)],
      approach_leg: [
        leg(1730, 'TF', fix('W', 'ZZQ05', 'Z')),
        // both ZZQ01 rows are in a region: the exact one is the airport's, the other is unowned
        leg(1730, 'TF', fix('W', 'ZZQ01', 'ZZ')),
        leg(1730, 'TF', fix('W', 'ZZQ01', 'ZY')),
      ],
    } }));
    expect(legsOf(out, key, 'final').map(l => [l.fix_lat, l.fix_lon])).toEqual([[10.2, -149.8], [10.1, -149.9], [11, -149]]);
    expect(stats.skipped).toEqual({});
  });

  it('counts a leg once per source row and only when it is drawable, whatever becomes of its procedure', () => {
    const { stats } = convert(msfs({ extra: {
      airport: [PA], waypoint: waypoints,
      approach: [
        procedureRow(1740, 'ZZS1', 'D', '27'), procedureRow(1741, 'ZZS1', 'D', '27'), procedureRow(1742, 'ZZS1', 'D', '99X'),
      ],
      approach_leg: [
        leg(1740, 'TF', fix('W', 'ZZNONE')), leg(1741, 'TF', fix('W', 'ZZNONE')), leg(1742, 'TF', fix('W', 'ZZNONE')),
        leg(1740, 'FM', fix('W', 'ZZNONE2')), leg(1740, 'TF', fix('R', 'RW27', null, { fix_airport_ident: 'ZZPA' })),
        leg(1740, 'TF', fix('V', 'ZZNOV')), leg(1740, 'TF', fix('TN', 'ZZNON', 'ZZ')), leg(1740, 'DF', fix('N', 'ZZNON')),
      ],
      transition: [transitionRow(1743, 1740, 'F', 'ZZNONE')],
      transition_leg: [tleg(1743, 'TF', fix('W', 'ZZNONE')), tleg(1743, 'FD', fix('W', 'ZZNONE'))],
    } }));
    expect(stats.skipped).toMatchObject({
      'unresolved.approach.W': 3, 'unresolved.approach.R': 1, 'unresolved.approach.V': 1, 'unresolved.approach.TN': 1,
      'unresolved.approach.N': 1, 'unresolved.transition.W': 1, 'sidstar.duplicateRunway': 1, 'sidstar.unparseableRunway': 1,
    });
  });

  it('puts a runway fix at the landing threshold, a displaced one along the runway heading', () => {
    const { out } = convert(msfs());
    const key27r = 'ZZAA|APPROACH|4-27R|27|2|0';
    const [last] = legsOf(out, key27r, 'final').slice(-1);
    const expected = dest(12, -164.97, 270, ftToM(300));
    expect(last.fix_lat).toBeCloseTo(expected.lat, 9);
    expect(last.fix_lon).toBeCloseTo(expected.lon, 9);
  });

  it('keeps the coordinates a Navigraph leg carries, and finds the ones it leaves out', () => {
    const { out } = convert(navigraph());
    const key = 'ZZAA|APPROACH|4-27R|27|2|0';
    const final = legsOf(out, key, 'final');
    expect([final[2].fix_lat, final[2].fix_lon]).toEqual([12, -164.97]);
    expect([final[1].origin_ident, final[1].origin_region, final[1].origin_type, final[1].origin_lat, final[1].origin_lon]).toEqual(['IZZA', 'ZZ', 'V', 12, -165.03]);
    const rf = legsOf(out, 'ZZAA|APPROACH|4-27R|27|2|0#2', 'final')[1];
    expect([rf.leg_type, rf.arc_center_ident, rf.arc_center_type, rf.arc_center_lat, rf.arc_center_lon]).toEqual([17, 'ZZW01', 'W', 12, -163]);
  });
});

// ── Transitions ──────────────────────────────────────────────────────────────

describe('approach transitions', () => {
  const key = 'ZZPA|APPROACH|4-27|27|0|0';
  const wps = [wpt(3801, 'ZZX01', -149.9, 10.1), wpt(3802, 'ZZX02', -149.8, 10.2), wpt(3803, 'ZZX03', -149.7, 10.3)];
  const garbageDme: AtoolsRow = { dme_ident: 'ZZQ', dme_region: 'ZZ', dme_airport_ident: 'ZZPA', dme_radial: 0, dme_distance: 0 };
  const body = (id: number, third = 'ZZX02'): AtoolsRow[] => [tleg(id, 'IF', fix('W', 'ZZX01')), tleg(id, 'TF', fix('W', third))];

  it('drops an exact duplicate, tells the other variants apart in the key, and fills the IAF and arc columns', () => {
    const { out, stats } = convert(msfs({ extra: {
      airport: [PA], waypoint: wps,
      vor: [{ vor_id: 3810, ident: 'ZZV9', region: 'ZZ', type: 'H', frequency: 112000, lonx: -149.5, laty: 10.5 }],
      approach: [approachRow(1800)],
      transition: [
        transitionRow(1801, 1800, 'F', 'ZZX01', { altitude: 4000, ...garbageDme }),
        transitionRow(1802, 1800, 'D', 'ZZV9', { fix_type: 'V', ...garbageDme }),
        transitionRow(1803, 1800, 'F', 'ZZX01', garbageDme),
        transitionRow(1804, 1800, 'F', 'ZZX01', garbageDme),
        transitionRow(1805, 1800, 'D', 'ZZX01', garbageDme),
      ],
      transition_leg: [
        ...body(1801),
        tleg(1802, 'IF', { ...fix('V', 'ZZV9'), altitude1: 3000, alt_descriptor: 'A' }),
        tleg(1802, 'AF', { ...fix('W', 'ZZX01'), recommended_fix_type: 'V', recommended_fix_ident: 'ZZV9', recommended_fix_region: 'ZZ', theta: 120, rho: 12 }),
        ...body(1803),
        ...body(1804, 'ZZX03'),
        ...body(1805),
      ],
    } }));
    expect(q(out, `SELECT trans_key, name, trans_type, iaf_ident, iaf_region, iaf_alt_m, dme_arc_ident, dme_arc_region,
                          dme_arc_radial_deg, dme_arc_distance_m, n_legs
                     FROM nav_procedure_transition WHERE proc_key = ? AND role = 'approach' ORDER BY trans_key`, key)).toEqual([
      { trans_key: `${key}|approach|ZZV9`, name: 'ZZV9', trans_type: 2, iaf_ident: 'ZZV9', iaf_region: 'ZZ', iaf_alt_m: ftToM(3000),
        dme_arc_ident: 'ZZV9', dme_arc_region: 'ZZ', dme_arc_radial_deg: 120, dme_arc_distance_m: nmToM(12), n_legs: 2 },
      { trans_key: `${key}|approach|ZZX01`, name: 'ZZX01', trans_type: 1, iaf_ident: 'ZZX01', iaf_region: 'ZZ', iaf_alt_m: ftToM(4000),
        dme_arc_ident: null, dme_arc_region: null, dme_arc_radial_deg: null, dme_arc_distance_m: null, n_legs: 2 },
      { trans_key: `${key}|approach|ZZX01#2`, name: 'ZZX01', trans_type: 1, iaf_ident: 'ZZX01', iaf_region: 'ZZ', iaf_alt_m: null,
        dme_arc_ident: null, dme_arc_region: null, dme_arc_radial_deg: null, dme_arc_distance_m: null, n_legs: 2 },
      { trans_key: `${key}|approach|ZZX01#3`, name: 'ZZX01', trans_type: 2, iaf_ident: 'ZZX01', iaf_region: 'ZZ', iaf_alt_m: null,
        dme_arc_ident: null, dme_arc_region: null, dme_arc_radial_deg: null, dme_arc_distance_m: null, n_legs: 2 },
    ]);
    expect(one(out, 'SELECT n_transitions FROM nav_procedure WHERE proc_key = ?', key)).toBe(4);
    expect(stats.skipped['transitions.duplicate']).toBe(1);
  });
});

// ── The whole converter ──────────────────────────────────────────────────────

describe.each<Flavour>(['navigraph', 'msfs'])('the converter as a whole (%s)', flavour => {
  const crowded = (): LnmFixtureSpec => preset(flavour, { extra: {
    airport: [PA],
    waypoint: [wpt(3901, 'ZZX01', -149.9, 10.1), wpt(3902, 'ZZX02', -149.8, 10.2)],
    approach: [
      procedureRow(1900, 'ZZS1', 'D', '27'), procedureRow(1901, 'ZZS1', 'D', '09'), approachRow(1902), approachRow(1903, { arinc_name: 'I27-Z' }),
    ],
    approach_leg: [
      leg(1900, 'TF', fix('W', 'ZZX01')), leg(1901, 'TF', fix('W', 'ZZX02')), leg(1902, 'IF', fix('W', 'ZZX01')), leg(1903, 'IF', fix('W', 'ZZX02')),
    ],
  } });

  it('writes rows that pass every constraint of the replica schema, and no orphan', () => {
    const { out, stats } = convert(crowded());
    expect(out.pragma('foreign_key_check')).toEqual([]);
    expect(out.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(stats.written).toMatchObject({
      procedures: one(out, 'SELECT COUNT(*) FROM nav_procedure'),
      transitions: one(out, 'SELECT COUNT(*) FROM nav_procedure_transition'),
      legs: one(out, 'SELECT COUNT(*) FROM nav_procedure_leg'),
    });
    expect(one(out, 'SELECT COUNT(*) FROM nav_procedure_leg')).toBeGreaterThan(30);
    // an airport's procedures hang off an airport that exists
    expect(one(out, 'SELECT COUNT(*) FROM nav_procedure p LEFT JOIN nav_airport a ON a.ident = p.airport_ident WHERE a.ident IS NULL')).toBe(0);
    expect(one(out, 'SELECT COUNT(*) FROM nav_procedure WHERE rev <> 1')).toBe(0);
    expect(one(out, 'SELECT COUNT(*) FROM nav_procedure_leg WHERE rev <> 1')).toBe(0);
  });

  it('writes the same rows whatever the batch size', () => {
    const whole = convert(crowded());
    const split = convert(crowded(), { batchApproaches: 1 });
    expect(dump(split.out)).toBe(dump(whole.out));
    expect(split.stats).toEqual(whole.stats);
  });

  it('writes the same rows whatever the transaction size, and commits in several', () => {
    const whole = convert(crowded());
    const commits: string[] = [];
    const small = convert(crowded(), {
      chunkRows: 1,
      prepare: out => {
        const exec = out.exec.bind(out);
        out.exec = (sql: string) => {
          if (/^(BEGIN|COMMIT)$/.test(sql)) commits.push(sql);
          return exec(sql);
        };
      },
    });
    expect(dump(small.out)).toBe(dump(whole.out));
    // a transaction of one row holds one whole procedure, so there is one transaction per procedure
    const procedures = one(whole.out, 'SELECT COUNT(*) FROM nav_procedure');
    expect(commits.filter(c => c === 'COMMIT')).toHaveLength(procedures);
    expect(commits.filter(c => c === 'BEGIN')).toHaveLength(procedures);
    expect(small.out.inTransaction).toBe(false);
  });

  it('rolls back the open transaction and rethrows when a write fails', () => {
    let replica: Database.Database | undefined;
    expect(() => convert(crowded(), {
      prepare: out => {
        replica = out;
        out.exec(`CREATE TRIGGER refuse_legs BEFORE INSERT ON nav_procedure_leg BEGIN SELECT RAISE(ABORT, 'refused'); END`);
      },
    })).toThrow('refused');
    expect(replica!.inTransaction).toBe(false);
    expect(one(replica!, 'SELECT COUNT(*) FROM nav_procedure')).toBe(0);
  });

  it('writes the same rows on a second run', () => {
    expect(dump(convert(crowded()).out)).toBe(dump(convert(crowded()).out));
  });

  it('reports progress in approach rows up to the total', () => {
    const { progress, out } = convert(crowded());
    expect(progress.length).toBeGreaterThan(1);
    const total = progress[0][1];
    expect(progress[progress.length - 1]).toEqual([total, total]);
    expect(progress.map(p => p[0])).toEqual([...progress.map(p => p[0])].sort((a, b) => a - b));
    // every approach row of the source: the preset's six and the four the fixture adds
    expect(total).toBe(10);
    expect(one(out, 'SELECT COUNT(*) FROM nav_procedure')).toBeLessThan(total);
  });

  it('warns without naming a row', () => {
    const { warnings } = convert(crowded());
    for (const w of warnings) expect(w).not.toMatch(/ZZ[A-Z0-9]/);
  });
});

describe('the exported converter', () => {
  it('is the procedures stage', () => {
    expect(proceduresConverter.stage).toBe('procedures');
  });
});
