// The Little Navmap airway converter, run against invented atools databases and
// checked in a replica created by the real schema. The navaid and waypoint
// converters run first, as in the pipeline, so the legs can be compared with
// the rows they have to join to.

import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { LNM_DATASET_DDL } from '../src/navdata/dataset';
import { legKey, wptKey } from '../src/navdata/keys';
import { applyNavdataSchema } from '../src/navdata/schema';
import { verifyNavdataColumns } from '../src/navdata/store';
import { airwaysConverter } from '../src/navdata/lnm/airways';
import { detectFlavour } from '../src/navdata/lnm/flavour';
import { navaidsConverter } from '../src/navdata/lnm/navaids';
import { buildSourceIndex } from '../src/navdata/lnm/sourceIndex';
import type { ConverterStats, LnmContext, LnmConverter } from '../src/navdata/lnm/types';
import { waypointsConverter } from '../src/navdata/lnm/waypoints';
import { buildLnmFixture, makeLnmFixtureDir, msfs, navigraph, type AtoolsRow, type LnmFixtureSpec } from './helpers/lnmFixture';

// ── Shared scaffolding ───────────────────────────────────────────────────────

const NOW = 1_790_000_000_000;

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
  out: Database.Database;
  stats: ConverterStats[];
  warnings: string[];
}

function newReplica(): Database.Database {
  const out = new Database(path.join(dir, `out-${++serial}.db`));
  open.push(out);
  out.pragma('foreign_keys = ON');
  applyNavdataSchema(out);
  out.exec(LNM_DATASET_DDL);
  return out;
}

/** Runs the converters over a fresh fixture; stats come back in the same order. */
function convert(
  spec: LnmFixtureSpec, converters: LnmConverter[] = [navaidsConverter, waypointsConverter, airwaysConverter],
): Built {
  const src = new Database(buildLnmFixture(dir, { ...spec, fileName: `src-${++serial}.sqlite` }), {
    readonly: true, fileMustExist: true,
  });
  open.push(src);
  const out = newReplica();
  const warnings: string[] = [];
  const { flavour } = detectFlavour(src);
  const index = buildSourceIndex(src, flavour);
  const ctx: LnmContext = {
    src, out, flavour, provider: index.provider, index, now: NOW, progress: () => undefined,
    warn: message => warnings.push(message),
  };
  return { out, warnings, stats: converters.map(c => c.run(ctx)) };
}

const rows = (db: Database.Database, sql: string, ...args: unknown[]): Record<string, any>[] =>
  db.prepare(sql).all(...args) as Record<string, any>[];

const leg = (db: Database.Database, airway: string): Record<string, any>[] =>
  rows(db, 'SELECT * FROM nav_airway_leg WHERE airway = ? ORDER BY from_key', airway);

const PRESETS: [string, typeof navigraph][] = [['navigraph', navigraph], ['msfs', msfs]];

const waypoint = (id: number, ident: string, over: AtoolsRow = {}): AtoolsRow => ({
  waypoint_id: id, ident, type: 'WN', region: 'ZZ', mag_var: 12, lonx: -149, laty: 8, ...over,
});
/** An artificial copy of a VOR or NDB, with a position of its own that the converter must not use. */
const artificial = (id: number, ident: string, type: 'V' | 'N', navId: number, over: AtoolsRow = {}): AtoolsRow =>
  waypoint(id, ident, { type, nav_id: navId, artificial: 1, lonx: -100, laty: 50, ...over });
const airway = (id: number, name: string, from: number, to: number, over: AtoolsRow = {}): AtoolsRow => ({
  airway_id: id, airway_name: name, airway_type: 'V', from_waypoint_id: from, to_waypoint_id: to, ...over,
});

// Preset waypoints used below: 4 ZZW01 (-163, 12), 5 ZZW02 (-162, 12), 6 ZZW03 (-161, 12).
const W01 = { ident: 'ZZW01', region: 'ZZ', lat: 12, lon: -163 };
const W02 = { ident: 'ZZW02', region: 'ZZ', lat: 12, lon: -162 };
const keyOf = (p: { ident: string; region: string; lat: number; lon: number }): string => wptKey(p.ident, p.region, p.lat, p.lon);

// ── From the presets ─────────────────────────────────────────────────────────

describe.each(PRESETS)('airways from the %s preset', (name, preset) => {
  const isMsfs = name === 'msfs';

  it('writes one leg for each atools airway row, with the fields of the shipped table', () => {
    const { out, stats, warnings } = convert(preset());
    expect(rows(out, 'SELECT COUNT(*) AS n FROM nav_airway_leg')[0].n).toBe(5);
    expect(stats[2]).toEqual({ written: { nav_airway_leg: 5 }, skipped: {} });
    expect(warnings.filter(w => w.startsWith('airways:'))).toEqual([]);

    const l = leg(out, 'ZZ1').find(r => r.from_ident === 'ZZW01')!;
    expect(l).toEqual({
      leg_key: legKey('ZZ1', keyOf(W01), keyOf(W02)), airway: 'ZZ1', airway_type: 1,
      from_key: keyOf(W01), to_key: keyOf(W02),
      from_ident: 'ZZW01', from_region: 'ZZ', from_lat: 12, from_lon: -163,
      to_ident: 'ZZW02', to_region: 'ZZ', to_lat: 12, to_lon: -162,
      min_lat: 12, max_lat: 12, min_lon: -163, max_lon: -162, dateline: 0, rev: 1,
    });
  });

  it('maps Victor, jet and both airway letters', () => {
    const { out } = convert(preset());
    expect(rows(out, 'SELECT airway, airway_type FROM nav_airway_leg GROUP BY airway ORDER BY airway')).toEqual([
      { airway: 'ZZ1', airway_type: 1 }, { airway: 'ZZ2', airway_type: 2 }, { airway: 'ZZ3', airway_type: 3 },
      { airway: 'ZZ4', airway_type: 1 },
    ]);
  });

  it('puts an NDB end on the NDB, not on the VOR that shares its id', () => {
    // Waypoint 2 is type N with nav_id 2; vor_id 2 is the TACAN ZZT, 100 km away.
    const [l] = leg(convert(preset()).out, 'ZZ2');
    expect(l).toMatchObject({ from_ident: 'ZZN', from_lat: 12.1, from_lon: -165.1, to_ident: 'ZZW01' });
    expect(l.from_key).toBe(wptKey('ZZN', 'ZZ', 12.1, -165.1));
    expect(l.from_key).not.toBe(wptKey('ZZT', 'ZZ', 13, -165.5));
  });

  it('puts a VOR end on the VOR, not on a same-ident VFR fix', () => {
    // Waypoint 1 is the artificial copy of VOR ZZV (12.5, -166); MSFS also has a VFR point ZZV at (15, -160).
    const { out } = convert(preset());
    const [l] = leg(out, 'ZZ3');
    expect(l).toMatchObject({ from_ident: 'ZZV', from_region: 'ZZ', from_lat: 12.5, from_lon: -166 });
    expect(l.from_key).toBe(wptKey('ZZV', 'ZZ', 12.5, -166));
    expect(rows(out, "SELECT 1 FROM nav_airway_leg WHERE from_key = ? OR to_key = ?", wptKey('ZZV', 'ZZ', 15, -160), wptKey('ZZV', 'ZZ', 15, -160)))
      .toEqual([]);
    // The VFR point is still a waypoint, and the VOR still a navaid.
    expect(rows(out, "SELECT 1 FROM nav_waypoint WHERE ident = 'ZZV'")).toHaveLength(isMsfs ? 1 : 0);
    expect(rows(out, "SELECT lat, lon FROM nav_navaid WHERE kind = 'V' AND ident = 'ZZV'")).toEqual([{ lat: 12.5, lon: -166 }]);
  });

  it('flags the leg across the antimeridian as dateline and keeps its true bounding box', () => {
    const [l] = leg(convert(preset()).out, 'ZZ4');
    expect(l).toMatchObject({
      from_lon: 179.5, to_lon: -179.5, dateline: 1, min_lat: 12, max_lat: 12.5, min_lon: -179.5, max_lon: 179.5,
    });
    expect(leg(convert(preset()).out, 'ZZ1').map(r => r.dateline)).toEqual([0, 0]);
  });

  it('leaves n_routes at 0 for the pipeline to finalise', () => {
    const { out } = convert(preset());
    expect(rows(out, 'SELECT DISTINCT n_routes FROM nav_waypoint')).toEqual([{ n_routes: 0 }]);
  });

  it('writes legs whose ends all join a waypoint row or a navaid row by key', () => {
    const { out } = convert(preset());
    const known = new Set<string>([
      ...rows(out, 'SELECT wpt_key FROM nav_waypoint').map(r => r.wpt_key as string),
      ...rows(out, 'SELECT ident, region, lat, lon FROM nav_navaid').map(r => wptKey(r.ident, r.region, r.lat, r.lon)),
    ]);
    const ends = rows(out, 'SELECT from_key, to_key FROM nav_airway_leg').flatMap(r => [r.from_key, r.to_key] as string[]);
    expect(ends.length).toBe(10);
    expect(ends.filter(k => !known.has(k))).toEqual([]);
  });

  it('inserts into the shipped DDL without a constraint or foreign-key failure', () => {
    const { out } = convert(preset());
    expect(rows(out, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(() => verifyNavdataColumns(out)).not.toThrow();
  });
});

// ── Endpoint resolution beyond the presets ───────────────────────────────────

describe('endpoint resolution', () => {
  it('uses the navaid row\'s position, not the artificial waypoint\'s own', () => {
    const { out } = convert(navigraph({ extra: {
      waypoint: [artificial(1000, 'ZZV', 'V', 1), artificial(1001, 'ZZN', 'N', 1)],
      airway: [airway(1000, 'ZZ5', 1000, 4), airway(1001, 'ZZ6', 1001, 4)],
    } }));
    expect(leg(out, 'ZZ5')[0]).toMatchObject({ from_ident: 'ZZV', from_lat: 12.5, from_lon: -166 });
    expect(leg(out, 'ZZ6')[0]).toMatchObject({ from_ident: 'ZZN', from_lat: 13, from_lon: -167 });
  });

  it('looks a V waypoint up among VORs and an N waypoint among NDBs, whatever the other table holds', () => {
    const { out, stats } = convert(navigraph({ extra: {
      // vor_id 3 is the DME-only ZZD and there is no ndb 3; ndb 2000 exists with no vor 2000.
      ndb: [{ ndb_id: 2000, ident: 'ZZNQ', region: 'ZZ', type: 'H', frequency: 30_000, lonx: -150, laty: 6 }],
      waypoint: [artificial(1000, 'ZZN', 'N', 3), artificial(1001, 'ZZNQ', 'V', 2000), artificial(1002, 'ZZNQ', 'N', 2000)],
      airway: [airway(1000, 'ZZ5', 1000, 4), airway(1001, 'ZZ6', 1001, 4), airway(1002, 'ZZ7', 1002, 4)],
    } }));
    expect(leg(out, 'ZZ5')).toEqual([]);
    expect(leg(out, 'ZZ6')).toEqual([]);
    expect(leg(out, 'ZZ7')).toHaveLength(1);
    expect(leg(out, 'ZZ7')[0]).toMatchObject({ from_ident: 'ZZNQ', from_lat: 6, from_lon: -150 });
    expect(stats[2].skipped).toEqual({ 'airway legs with an endpoint that does not exist': 2 });
  });

  it('takes the position of a plain fix from the waypoint row, never from the airway row\'s own columns', () => {
    const { out } = convert(navigraph({ extra: { airway: [
      airway(1000, 'ZZ5', 4, 5, { from_lonx: -163.0004, from_laty: 12.0004, to_lonx: -161.9996, to_laty: 11.9996 }),
    ] } }));
    expect(leg(out, 'ZZ5')[0]).toMatchObject({
      from_key: keyOf(W01), to_key: keyOf(W02), from_lon: -163, from_lat: 12, to_lon: -162, to_lat: 12,
    });
  });

  it('puts a VFR end on the VFR fix itself', () => {
    const { out } = convert(msfs({ extra: { airway: [airway(1000, 'ZZ5', 14, 4)] } }));
    expect(leg(out, 'ZZ5')[0]).toMatchObject({ from_ident: 'ZZV', from_lat: 15, from_lon: -160 });
    expect(leg(out, 'ZZ5')[0].from_key).toBe(wptKey('ZZV', 'ZZ', 15, -160));
  });

  it('keeps a NULL region as the empty string in the endpoint and its key', () => {
    // MSFS preset waypoint 15 (ZZW10) has no region.
    const { out } = convert(msfs({ extra: { airway: [airway(1000, 'ZZ5', 15, 4)] } }));
    const l = leg(out, 'ZZ5')[0];
    expect(l.from_region).toBe('');
    expect(l.from_key).toBe(wptKey('ZZW10', '', 10, -159));
  });

  it('keys an endpoint that is an airport\'s terminal fix like any other', () => {
    const { out } = convert(navigraph({ extra: { airway: [airway(1000, 'ZZ5', 7, 4)] } }));
    expect(leg(out, 'ZZ5')[0]).toMatchObject({ from_ident: 'ZZT01', from_lat: 12.2, from_lon: -165.2 });
  });

  it('keys the end on a NDB that lost its key from that NDB\'s own position, leaving no navaid row for it', () => {
    const { out } = convert(msfs({ extra: {
      ndb: [
        { ndb_id: 1020, ident: 'ZZND', region: 'ZZ', type: 'H', frequency: 30_000, lonx: -143, laty: 6 },
        { ndb_id: 1021, ident: 'ZZND', region: 'ZZ', type: 'H', frequency: 30_000, lonx: -142, laty: 6 },
      ],
      waypoint: [artificial(1020, 'ZZND', 'N', 1020), artificial(1021, 'ZZND', 'N', 1021)],
      airway: [airway(1020, 'ZZ8', 1020, 4), airway(1021, 'ZZ8', 1021, 4)],
    } }));
    const keys = leg(out, 'ZZ8').map(l => l.from_key).sort();
    expect(keys).toEqual([wptKey('ZZND', 'ZZ', 6, -143), wptKey('ZZND', 'ZZ', 6, -142)].sort());
    expect(rows(out, "SELECT lon FROM nav_navaid WHERE kind = 'N' AND ident = 'ZZND'")).toEqual([{ lon: -143 }]);
  });
});

// ── Which rows become legs ───────────────────────────────────────────────────

describe('legs left out and legs kept', () => {
  it('skips a leg with a missing waypoint, and counts it', () => {
    const { out, stats, warnings } = convert(msfs({ extra: { airway: [
      airway(1000, 'ZZ5', 9999, 4), airway(1001, 'ZZ5', 4, 9998), airway(1002, 'ZZ5', 5, 6),
    ] } }));
    expect(leg(out, 'ZZ5')).toHaveLength(1);
    expect(stats[2].skipped['airway legs with an endpoint that does not exist']).toBe(2);
    expect(warnings).toContain('airways: skipped 2 airway legs with an endpoint that does not exist');
  });

  it('skips a leg that starts and ends on one fix, including two rows that share a key', () => {
    const { out, stats } = convert(msfs({ extra: {
      waypoint: [waypoint(1000, 'ZZW01', { lonx: -163, laty: 12 })],
      airway: [airway(1000, 'ZZ5', 4, 4), airway(1001, 'ZZ6', 4, 1000)],
    } }));
    expect(leg(out, 'ZZ5')).toEqual([]);
    expect(leg(out, 'ZZ6')).toEqual([]);
    expect(stats[2].skipped).toEqual({ 'airway legs that start and end on the same fix': 2 });
  });

  it('keeps the first of two rows for one leg, whichever direction they run, and says so', () => {
    const { out, stats } = convert(msfs({ extra: { airway: [
      airway(1000, 'ZZ1', 5, 4), airway(1001, 'ZZ1', 4, 5, { sequence_no: 9 }),
    ] } }));
    // The preset already has ZZ1 from ZZW01 to ZZW02; both extras repeat it.
    const legs = leg(out, 'ZZ1');
    expect(legs).toHaveLength(2);
    expect(legs.map(l => l.from_ident).sort()).toEqual(['ZZW01', 'ZZW02']);
    expect(legs.find(l => l.to_ident === 'ZZW02')).toMatchObject({ from_ident: 'ZZW01' });
    expect(stats[2].skipped).toEqual({ 'airway legs repeating another leg': 2 });
    expect(stats[2].written).toEqual({ nav_airway_leg: 5 });
  });

  it('keeps legs that join the same fixes on different airways', () => {
    const { out } = convert(msfs({ extra: { airway: [airway(1000, 'ZZ7', 4, 5, { airway_type: 'J' })] } }));
    expect(leg(out, 'ZZ7')).toHaveLength(1);
    expect(leg(out, 'ZZ7')[0].airway_type).toBe(2);
    expect(leg(out, 'ZZ1')).toHaveLength(2);
  });

  it('leaves airway_type NULL for a letter that has no code', () => {
    const { out } = convert(msfs({ extra: { airway: [airway(1000, 'ZZ5', 4, 5, { airway_type: 'R' })] } }));
    expect(leg(out, 'ZZ5')[0].airway_type).toBeNull();
  });

  it('calls a leg that spans exactly 180 degrees of longitude no dateline leg', () => {
    const { out } = convert(msfs({ extra: {
      waypoint: [waypoint(1000, 'ZZE1', { lonx: -90, laty: 0 }), waypoint(1001, 'ZZE2', { lonx: 90, laty: 0 })],
      airway: [airway(1000, 'ZZ5', 1000, 1001)],
    } }));
    expect(leg(out, 'ZZ5')[0]).toMatchObject({ dateline: 0, min_lon: -90, max_lon: 90 });
  });

  it('orders the bounding box whichever end comes first', () => {
    const { out } = convert(msfs({ extra: {
      waypoint: [waypoint(1000, 'ZZB1', { lonx: -140, laty: 9 }), waypoint(1001, 'ZZB2', { lonx: -150, laty: 3 })],
      airway: [airway(1000, 'ZZ5', 1000, 1001)],
    } }));
    expect(leg(out, 'ZZ5')[0]).toMatchObject({
      from_ident: 'ZZB1', min_lat: 3, max_lat: 9, min_lon: -150, max_lon: -140, dateline: 0,
    });
  });

  it('writes nothing for a file with no airways', () => {
    const base = msfs();
    const { out, stats } = convert({ ...base, rows: { ...base.rows, airway: [] } });
    expect(rows(out, 'SELECT * FROM nav_airway_leg')).toEqual([]);
    expect(stats[2]).toEqual({ written: { nav_airway_leg: 0 }, skipped: {} });
  });

  it('puts no row value in a warning', () => {
    const { warnings } = convert(msfs({ extra: { airway: [airway(1000, 'ZZ5', 9999, 4), airway(1001, 'ZZ6', 4, 4)] } }));
    const airwayWarnings = warnings.filter(w => w.startsWith('airways:'));
    expect(airwayWarnings).toHaveLength(2);
    for (const w of airwayWarnings) expect(w).not.toMatch(/ZZ/);
  });

  it('gives the same legs on every run', () => {
    const dump = (b: Built): unknown[] => rows(b.out, 'SELECT * FROM nav_airway_leg ORDER BY leg_key');
    expect(dump(convert(navigraph()))).toEqual(dump(convert(navigraph())));
  });
});
