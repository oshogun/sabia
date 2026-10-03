// Scratch replica files in the OS temp dir, never flights.db. Synthetic
// idents and coordinates only — no real navdata is committed to this repo.

import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { applyNavdataSchema } from '../src/navdata/schema';
import { wptKey, legKey } from '../src/navdata/keys';
import {
  closeNavDb,
  getNavDb,
  openNavdata,
  resolveNavdataPath,
} from '../src/navdata/connection';
import {
  applyIncrementalBatch,
  applyNavRows,
  NavdataStoreError,
  readNavMeta,
  verifyNavdataColumns,
} from '../src/navdata/store';
import { importNavdataSnapshot } from '../src/navdata/snapshot';
import type { NavRow, NavRowType } from '../src/navdata/wire';
import { scratchDbRoot } from './helpers/scratchRoot';

const dirs: string[] = [];
const handles: Database.Database[] = [];
const savedEnv = process.env.NAVDATA_DB_PATH;

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(scratchDbRoot(), 'navdata-store-'));
  dirs.push(d);
  return d;
}

/** A standalone replica file for the row-level rules. */
function scratchReplica(): Database.Database {
  const db = new Database(path.join(tempDir(), 'rows.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applyNavdataSchema(db);
  handles.push(db);
  return db;
}

/** Points NAVDATA_DB_PATH at a fresh directory and returns it. */
function replicaDir(): string {
  const d = tempDir();
  process.env.NAVDATA_DB_PATH = path.join(d, 'navdata.db');
  return d;
}

type Row = Record<string, string | number | null>;
const row = (t: NavRowType, r: Row): NavRow => ({ t, r: { rev: 1, ...r } });

const apply = (db: Database.Database, ...rows: NavRow[]) => applyNavRows(db, rows);
const one = (db: Database.Database, sql: string, ...args: unknown[]) =>
  db.prepare(sql).get(...args) as Record<string, string | number | null> | undefined;
const count = (db: Database.Database, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const ZZAA_DETAIL: Row = {
  ident: 'ZZAA',
  name: 'Zulu Alpha Field',
  n_runways: 2,
  detail_state: 'detail',
  detail_fetched_at: 1_000,
  detail_runways: 2,
  rev: 1,
};
const ZZAA_POSITION: Row = { ident: 'ZZAA', lat: 10.5, lon: 20.25, position_source: 'list', rev: 2 };

// ── Snapshot fixtures ────────────────────────────────────────────────────────

interface SnapshotParts {
  snapshotId?: string;
  rev?: number;
  schemaVersion?: number;
  rows?: NavRow[];
  footerRows?: number;
  footerCounts?: Partial<Record<NavRowType, number>>;
}

/** Writes a gzipped NDJSON snapshot outside the replica directory. */
function writeSnapshot(parts: SnapshotParts = {}): string {
  const rows = parts.rows ?? [row('airport', { ident: 'ZZAA', name: 'Zulu Alpha Field' })];
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.t] = (counts[r.t] ?? 0) + 1;
  const header = {
    kind: 'header',
    v: 1,
    schemaVersion: parts.schemaVersion ?? 2,
    snapshotId: parts.snapshotId ?? 'snapshot-1',
    rev: parts.rev ?? 7,
    simId: '2024',
    simAppName: 'Test Sim',
    simAppVersion: '1.0.0',
    sidecarVersion: '0.0.1-test',
    createdAt: 1_700_000_000_000,
    counts,
  };
  const footer = {
    kind: 'footer',
    rows: parts.footerRows ?? rows.length,
    counts: parts.footerCounts ?? counts,
  };
  const lines = [header, ...rows, footer].map(o => JSON.stringify(o)).join('\n');
  const file = path.join(tempDir(), 'navdata-snapshot.ndjson.gz');
  fs.writeFileSync(file, zlib.gzipSync(`${lines}\n`));
  return file;
}

afterEach(() => {
  closeNavDb();
  for (const h of handles.splice(0)) if (h.open) h.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.NAVDATA_DB_PATH;
  else process.env.NAVDATA_DB_PATH = savedEnv;
});

describe('constraint violations', () => {
  it('a snapshot whose last rows violate a foreign key is a 400 bad batch and swaps nothing', async () => {
    const dir = tempDir();
    process.env.NAVDATA_DB_PATH = path.join(dir, 'navdata.db');
    openNavdata();
    const file = writeSnapshot({
      rows: [
        row('airport', { ident: 'ZZAA', name: 'Zulu Alpha Field' }),
        row('runway', { rwy_key: 'NOSUCH|9|0', airport_ident: 'NOSUCH', heading_deg: 90, length_m: 2000 }),
      ],
    });
    await expect(importNavdataSnapshot(file)).rejects.toMatchObject({
      name: 'NavdataStoreError', code: 'NAVDATA_BAD_BATCH', status: 400,
    });
    expect(getNavDb()).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('merge rules for airport, navaid and waypoint', () => {
  it('merges detail then position without losing either', () => {
    const db = scratchReplica();
    apply(db, row('airport', ZZAA_DETAIL));
    const result = apply(db, row('airport', ZZAA_POSITION));

    expect(result).toEqual({ applied: 1, counts: { airport: 1 } });
    expect(one(db, 'SELECT * FROM nav_airport WHERE ident = ?', 'ZZAA')).toMatchObject({
      name: 'Zulu Alpha Field',
      n_runways: 2,
      detail_state: 'detail',
      lat: 10.5,
      lon: 20.25,
      position_source: 'list',
      rev: 2,
    });
  });

  it('merges position then detail without losing either', () => {
    const db = scratchReplica();
    apply(db, row('airport', ZZAA_POSITION));
    apply(db, row('airport', { ...ZZAA_DETAIL, rev: 3 }));

    expect(one(db, 'SELECT * FROM nav_airport WHERE ident = ?', 'ZZAA')).toMatchObject({
      name: 'Zulu Alpha Field',
      detail_state: 'detail',
      lat: 10.5,
      lon: 20.25,
      position_source: 'list',
      rev: 3,
    });
  });

  it('leaves stored values alone on a thin re-fetch', () => {
    const db = scratchReplica();
    apply(db, row('airport', ZZAA_DETAIL), row('airport', ZZAA_POSITION));
    const before = one(db, 'SELECT * FROM nav_airport WHERE ident = ?', 'ZZAA');

    const result = apply(db, row('airport', { ident: 'ZZAA', rev: 9 }));

    expect(result.applied).toBe(0);
    expect(one(db, 'SELECT * FROM nav_airport WHERE ident = ?', 'ZZAA')).toEqual(before);
  });

  it('writes nothing, and does not bump rev, when the merged row is unchanged', () => {
    const db = scratchReplica();
    apply(db, row('airport', ZZAA_DETAIL));

    const result = apply(db, row('airport', { ...ZZAA_DETAIL, rev: 42 }));

    expect(result).toEqual({ applied: 0, counts: {} });
    expect(one(db, 'SELECT rev FROM nav_airport WHERE ident = ?', 'ZZAA')).toEqual({ rev: 1 });
  });

  it('keeps a facility position against a list report, and takes the next facility one', () => {
    const db = scratchReplica();
    apply(db, row('navaid', {
      kind: 'V', ident: 'ZZV', region: 'ZZ', lat: 11, lon: 21, alt_m: 100,
      position_source: 'facility', position_fetched_at: 500, rev: 1,
    }));

    apply(db, row('navaid', {
      kind: 'V', ident: 'ZZV', region: 'ZZ', lat: 99, lon: 99, position_source: 'list', rev: 2,
    }));
    expect(one(db, 'SELECT * FROM nav_navaid WHERE ident = ?', 'ZZV')).toMatchObject({
      lat: 11, lon: 21, position_source: 'facility',
    });

    apply(db, row('navaid', {
      kind: 'V', ident: 'ZZV', region: 'ZZ', lat: 12, lon: 22,
      position_source: 'facility', position_fetched_at: 900, rev: 3,
    }));
    expect(one(db, 'SELECT * FROM nav_navaid WHERE ident = ?', 'ZZV')).toMatchObject({
      lat: 12, lon: 22, position_fetched_at: 900,
    });
  });

  it('fills a position when the stored row has no source to demote', () => {
    const db = scratchReplica();
    apply(db, row('navaid', { kind: 'N', ident: 'ZZN', region: 'ZZ', name: 'Zulu November', rev: 1 }));

    apply(db, row('navaid', {
      kind: 'N', ident: 'ZZN', region: 'ZZ', lat: 13, lon: 23, position_source: 'minimal', rev: 2,
    }));

    expect(one(db, 'SELECT * FROM nav_navaid WHERE ident = ?', 'ZZN')).toMatchObject({
      name: 'Zulu November', lat: 13, lon: 23, position_source: 'minimal',
    });
  });

  it('ignores a position source that arrives without a position', () => {
    const db = scratchReplica();
    apply(db, row('navaid', {
      kind: 'V', ident: 'ZZW', region: 'ZZ', lat: 14, lon: 24, position_source: 'list', rev: 1,
    }));

    apply(db, row('navaid', {
      kind: 'V', ident: 'ZZW', region: 'ZZ', name: 'Zulu Whiskey',
      position_source: 'facility', position_fetched_at: 700, rev: 2,
    }));
    expect(one(db, 'SELECT * FROM nav_navaid WHERE ident = ?', 'ZZW')).toMatchObject({
      lat: 14, lon: 24, position_source: 'list', position_fetched_at: null, name: 'Zulu Whiskey',
    });

    apply(db, row('navaid', {
      kind: 'V', ident: 'ZZW', region: 'ZZ', lat: 15, lon: 25, position_source: 'list', rev: 3,
    }));
    expect(one(db, 'SELECT * FROM nav_navaid WHERE ident = ?', 'ZZW')).toMatchObject({
      lat: 15, lon: 25, position_source: 'list',
    });
  });

  it('keeps three same-ident waypoints apart by position', () => {
    const db = scratchReplica();
    const at = (lat: number, lon: number): NavRow =>
      row('waypoint', { wpt_key: wptKey('ZZFIX', 'ZZ', lat, lon), ident: 'ZZFIX', region: 'ZZ', lat, lon });

    apply(db, at(30.1, 40.1), at(30.2, 40.2), at(30.3, 40.3));

    expect(count(db, 'nav_waypoint')).toBe(3);
    expect(db.prepare('SELECT lat FROM nav_waypoint ORDER BY lat').all()).toEqual([
      { lat: 30.1 }, { lat: 30.2 }, { lat: 30.3 },
    ]);
    // 4e-7 degrees is inside the key's ~1.1 m resolution: the same fix, not a fourth.
    apply(db, at(30.1 + 4e-7, 40.1));
    expect(count(db, 'nav_waypoint')).toBe(3);
  });

  it('never deletes an airport row when the airport is touched again', () => {
    const db = scratchReplica();
    apply(db,
      row('airport', ZZAA_DETAIL),
      row('runway', { rwy_key: 'ZZAA|9|0', airport_ident: 'ZZAA', heading_deg: 90, length_m: 2000 }),
      row('frequency', { freq_key: 'ZZAA|1|118000000', airport_ident: 'ZZAA', freq_type: 1, frequency_hz: 118_000_000 }),
      row('procedure', { proc_key: 'ZZAA|SID|ZZONE1||||', airport_ident: 'ZZAA', kind: 'SID', name: 'ZZONE1' }),
      row('procedure_transition', { trans_key: 'ZZAA|SID|ZZONE1||||common|', proc_key: 'ZZAA|SID|ZZONE1||||', role: 'common', name: '' }),
      row('procedure_leg', { trans_key: 'ZZAA|SID|ZZONE1||||common|', seq: 0, leg_type: 18, fix_ident: 'ZZFIX', fix_lat: 30.1, fix_lon: 40.1 }),
    );

    // A later touch of the airport row must not cascade its children away.
    expect(apply(db, row('airport', { ident: 'ZZAA', name: 'Zulu Alpha Intl', rev: 5 })).applied).toBe(1);

    expect(one(db, 'SELECT name FROM nav_airport WHERE ident = ?', 'ZZAA')).toEqual({ name: 'Zulu Alpha Intl' });
    expect(count(db, 'nav_runway')).toBe(1);
    expect(count(db, 'nav_airport_frequency')).toBe(1);
    expect(count(db, 'nav_procedure')).toBe(1);
    expect(count(db, 'nav_procedure_transition')).toBe(1);
    expect(count(db, 'nav_procedure_leg')).toBe(1);
  });
});

describe('the same merge rules on every other table', () => {
  it('dedupes an airway leg reported from either end', () => {
    const db = scratchReplica();
    const a = wptKey('ZZAAA', 'ZZ', 31, 41);
    const b = wptKey('ZZBBB', 'ZZ', 32, 42);
    const base = {
      leg_key: legKey('ZZ1', a, b), airway: 'ZZ1',
      min_lat: 31, max_lat: 32, min_lon: 41, max_lon: 42,
    };

    apply(db, row('airway_leg', {
      ...base, from_key: a, to_key: b,
      from_ident: 'ZZAAA', from_region: 'ZZ', from_lat: 31, from_lon: 41,
      to_ident: 'ZZBBB', to_region: 'ZZ', to_lat: 32, to_lon: 42,
    }));
    const second = apply(db, row('airway_leg', {
      ...base, from_key: b, to_key: a,
      from_ident: 'ZZBBB', from_region: 'ZZ', from_lat: 32, from_lon: 42,
      to_ident: 'ZZAAA', to_region: 'ZZ', to_lat: 31, to_lon: 41,
    }));

    expect(count(db, 'nav_airway_leg')).toBe(1);
    expect(second.applied).toBe(1);
    expect(one(db, 'SELECT from_ident FROM nav_airway_leg')).toEqual({ from_ident: 'ZZBBB' });

    // A report identical to the stored row is not a write.
    expect(apply(db, row('airway_leg', {
      ...base, from_key: b, to_key: a,
      from_ident: 'ZZBBB', from_region: 'ZZ', from_lat: 32, from_lon: 42,
      to_ident: 'ZZAAA', to_region: 'ZZ', to_lat: 31, to_lon: 41,
    })).applied).toBe(0);
  });

  it('stores displaced-threshold columns exactly and keeps NULL distinct from 0', () => {
    const db = scratchReplica();
    apply(db, row('airport', { ident: 'ZZAA' }));
    const q = 'SELECT primary_threshold_m p, secondary_threshold_m s FROM nav_runway';
    const base = { rwy_key: 'ZZAA|9|0', airport_ident: 'ZZAA' };

    apply(db, row('runway', { ...base, primary_threshold_m: 60.5, secondary_threshold_m: 200.25 }));
    expect(one(db, q)).toEqual({ p: 60.5, s: 200.25 });

    // A zero is a value and replaces what is stored; an omitted key is not a
    // value at all, so the other end keeps its displacement.
    apply(db, row('runway', { ...base, primary_threshold_m: 0, rev: 2 }));
    expect(one(db, q)).toEqual({ p: 0, s: 200.25 });

    apply(db, row('runway', { ...base, primary_threshold_m: 60.5, rev: 3 }));
    expect(one(db, q)).toEqual({ p: 60.5, s: 200.25 });

    // A row that mentions neither end changes nothing at all, rev included.
    expect(apply(db, row('runway', { ...base, rev: 4 })).applied).toBe(0);
    expect(one(db, q)).toEqual({ p: 60.5, s: 200.25 });
    expect(one(db, 'SELECT rev FROM nav_runway')).toEqual({ rev: 3 });
  });

  it('keeps a column the next runway or frequency row leaves out', () => {
    const db = scratchReplica();
    apply(db, row('airport', { ident: 'ZZAA' }));
    apply(db, row('runway', { rwy_key: 'ZZAA|9|0', airport_ident: 'ZZAA', length_m: 2000, width_m: 45 }));
    apply(db, row('runway', { rwy_key: 'ZZAA|9|0', airport_ident: 'ZZAA', length_m: 2500, rev: 2 }));
    expect(one(db, 'SELECT length_m, width_m FROM nav_runway')).toEqual({ length_m: 2500, width_m: 45 });

    apply(db, row('frequency', {
      freq_key: 'ZZAA|1|118000000', airport_ident: 'ZZAA', freq_type: 1,
      frequency_hz: 118_000_000, name: 'ZZAA TOWER',
    }));
    apply(db, row('frequency', {
      freq_key: 'ZZAA|1|118000000', airport_ident: 'ZZAA', frequency_hz: 118_000_000, rev: 2,
    }));
    expect(one(db, 'SELECT freq_type, name FROM nav_airport_frequency')).toEqual({
      freq_type: 1, name: 'ZZAA TOWER',
    });
  });

  it('keeps a column the next procedure, transition or leg row leaves out', () => {
    const db = scratchReplica();
    const proc = 'ZZAA|SID|ZZONE1||||';
    const trans = `${proc}|common|`;
    apply(db,
      row('airport', { ident: 'ZZAA' }),
      row('procedure', { proc_key: proc, airport_ident: 'ZZAA', kind: 'SID', name: 'ZZONE1', faf_ident: 'ZZFAF', n_transitions: 2 }),
      row('procedure_transition', { trans_key: trans, proc_key: proc, role: 'common', name: '', n_legs: 3, iaf_ident: 'ZZIAF' }),
      row('procedure_leg', { trans_key: trans, seq: 0, leg_type: 18, fix_ident: 'ZZFIX', fix_lat: 30.1, fix_lon: 40.1, altitude1_m: 900 }),
    );

    apply(db,
      row('procedure', { proc_key: proc, airport_ident: 'ZZAA', kind: 'SID', name: 'ZZONE1', n_transitions: 3, rev: 2 }),
      row('procedure_transition', { trans_key: trans, proc_key: proc, role: 'common', name: '', n_legs: 4, rev: 2 }),
      row('procedure_leg', { trans_key: trans, seq: 0, leg_type: 18, fix_lat: 30.2, rev: 2 }),
    );

    expect(one(db, 'SELECT faf_ident, n_transitions FROM nav_procedure')).toEqual({
      faf_ident: 'ZZFAF', n_transitions: 3,
    });
    expect(one(db, 'SELECT iaf_ident, n_legs FROM nav_procedure_transition')).toEqual({
      iaf_ident: 'ZZIAF', n_legs: 4,
    });
    expect(one(db, 'SELECT fix_ident, fix_lat, fix_lon, altitude1_m FROM nav_procedure_leg')).toEqual({
      fix_ident: 'ZZFIX', fix_lat: 30.2, fix_lon: 40.1, altitude1_m: 900,
    });
  });

  it('keeps a column the next airway-leg or coverage-cell row leaves out', () => {
    const db = scratchReplica();
    const a = wptKey('ZZAAA', 'ZZ', 31, 41);
    const b = wptKey('ZZBBB', 'ZZ', 32, 42);
    apply(db, row('airway_leg', {
      leg_key: legKey('ZZ1', a, b), airway: 'ZZ1', airway_type: 2, dateline: 0,
      from_key: a, to_key: b,
      from_ident: 'ZZAAA', from_region: 'ZZ', from_lat: 31, from_lon: 41,
      to_ident: 'ZZBBB', to_region: 'ZZ', to_lat: 32, to_lon: 42,
      min_lat: 31, max_lat: 32, min_lon: 41, max_lon: 42,
    }));
    apply(db, row('airway_leg', { leg_key: legKey('ZZ1', a, b), airway: 'ZZ1', max_lat: 33, rev: 2 }));
    expect(one(db, 'SELECT airway_type, from_ident, max_lat FROM nav_airway_leg')).toEqual({
      airway_type: 2, from_ident: 'ZZAAA', max_lat: 33,
    });

    // The sidecar's own running totals arrive on every report, so they still
    // land exactly as sent — including a genuine zero.
    apply(db, row('coverage_cell', { kind: 'W', cell_id: 1234, harvested_at: 500, harvest_count: 4, row_count: 9 }));
    apply(db, row('coverage_cell', { kind: 'W', cell_id: 1234, harvested_at: 600, harvest_count: 1, row_count: 0, rev: 2 }));
    expect(one(db, 'SELECT harvested_at, harvest_count, row_count FROM nav_coverage_cell')).toEqual({
      harvested_at: 600, harvest_count: 1, row_count: 0,
    });

    // A report that omits them leaves the stored totals alone.
    expect(apply(db, row('coverage_cell', { kind: 'W', cell_id: 1234, rev: 3 })).applied).toBe(0);
    expect(one(db, 'SELECT harvested_at, harvest_count, row_count FROM nav_coverage_cell')).toEqual({
      harvested_at: 600, harvest_count: 1, row_count: 0,
    });
  });

  it('never moves nav_absent.first_seen_at forward, and keeps what a report omits', () => {
    const db = scratchReplica();
    const absent = (over: Row): NavRow =>
      row('absent', { kind: 'W', ident: 'ZZGONE', region: 'ZZ', reason: 'silent', first_seen_at: 1_000, last_checked_at: 1_000, attempts: 1, ...over });

    apply(db, absent({}));
    apply(db, absent({ first_seen_at: 5_000, last_checked_at: 5_000, attempts: 3, reason: 'exception', rev: 2 }));
    expect(one(db, 'SELECT * FROM nav_absent')).toMatchObject({
      first_seen_at: 1_000, last_checked_at: 5_000, attempts: 3, reason: 'exception',
    });

    apply(db, absent({ first_seen_at: 200, last_checked_at: 6_000, attempts: 4, rev: 3 }));
    expect(one(db, 'SELECT first_seen_at FROM nav_absent')).toEqual({ first_seen_at: 200 });

    // A report with no first_seen_at of its own leaves the stored one, and the
    // attempts count it also omits.
    apply(db, row('absent', {
      kind: 'W', ident: 'ZZGONE', region: 'ZZ', reason: 'silent', last_checked_at: 7_000, rev: 4,
    }));
    expect(one(db, 'SELECT first_seen_at, attempts, last_checked_at FROM nav_absent')).toEqual({
      first_seen_at: 200, attempts: 4, last_checked_at: 7_000,
    });
  });

  it("marks an airport absent only when the airport already has a row", () => {
    const db = scratchReplica();
    apply(db, row('airport', { ident: 'ZZAA', detail_state: 'pending' }));

    apply(db,
      row('absent', { kind: 'A', ident: 'ZZAA', reason: 'silent', first_seen_at: 1_000, last_checked_at: 1_000, rev: 4 }),
      row('absent', { kind: 'A', ident: 'ZZNONE', reason: 'silent', first_seen_at: 1_000, last_checked_at: 1_000, rev: 4 }),
    );

    expect(one(db, 'SELECT detail_state, rev FROM nav_airport WHERE ident = ?', 'ZZAA')).toEqual({
      detail_state: 'absent', rev: 4,
    });
    expect(count(db, 'nav_airport')).toBe(1);
    expect(one(db, 'SELECT 1 AS hit FROM nav_absent WHERE ident = ?', 'ZZNONE')).toEqual({ hit: 1 });
  });
});

describe('an airport the simulator does not have', () => {
  const absentAirport: Row = { ident: 'ZZAB', detail_state: 'absent', rev: 3 };
  const absentRow = (): NavRow =>
    row('absent', { kind: 'A', ident: 'ZZAB', reason: 'silent', first_seen_at: 1_000, last_checked_at: 1_000, rev: 3 });

  it('is accepted with no coordinates, in either order with its absent row', () => {
    for (const rows of [
      [row('airport', absentAirport), absentRow()],
      [absentRow(), row('airport', absentAirport)],
    ]) {
      const db = scratchReplica();
      apply(db, ...rows);
      expect(one(db, 'SELECT lat, lon, position_source, detail_state FROM nav_airport WHERE ident = ?', 'ZZAB')).toEqual({
        lat: null, lon: null, position_source: null, detail_state: 'absent',
      });
      expect(one(db, "SELECT 1 AS hit FROM nav_absent WHERE kind = 'A' AND ident = ?", 'ZZAB')).toEqual({ hit: 1 });
    }
  });

  it('takes coordinates from a later row, and a null never erases them', () => {
    const db = scratchReplica();
    apply(db, row('airport', absentAirport), absentRow());
    apply(db, row('airport', { ident: 'ZZAB', lat: 11.5, lon: 21.25, position_source: 'list', rev: 4 }));
    expect(one(db, 'SELECT lat, lon, position_source, detail_state FROM nav_airport WHERE ident = ?', 'ZZAB')).toEqual({
      lat: 11.5, lon: 21.25, position_source: 'list', detail_state: 'absent',
    });

    apply(db, row('airport', { ident: 'ZZAB', lat: null, lon: null, position_source: null, detail_state: 'absent', rev: 5 }));
    expect(one(db, 'SELECT lat, lon, position_source FROM nav_airport WHERE ident = ?', 'ZZAB')).toEqual({
      lat: 11.5, lon: 21.25, position_source: 'list',
    });
  });
});

describe('row validation', () => {
  it('refuses an unknown table, an unknown column and a missing rev', () => {
    const db = scratchReplica();
    expect(() => apply(db, { t: 'airfield' as NavRowType, r: { ident: 'ZZAA', rev: 1 } }))
      .toThrow(/unknown type/);
    expect(() => apply(db, row('airport', { ident: 'ZZAA', elevation: 100 })))
      .toThrow(/unknown column "elevation"/);
    expect(() => apply(db, { t: 'airport', r: { ident: 'ZZAA' } })).toThrow(/no integer rev/);
    expect(count(db, 'nav_airport')).toBe(0);
  });

  it('rolls the whole batch back when one row is bad', () => {
    const db = scratchReplica();
    expect(() => apply(db, row('airport', { ident: 'ZZAA' }), row('airport', { ident: 'ZZAB', bogus: 1 })))
      .toThrow(NavdataStoreError);
    expect(count(db, 'nav_airport')).toBe(0);
  });

  it('refuses a replica whose columns are not the shipped ones', () => {
    const db = scratchReplica();
    expect(() => verifyNavdataColumns(db)).not.toThrow();
    db.exec('ALTER TABLE nav_airport ADD COLUMN elevation_ft REAL');
    expect(() => verifyNavdataColumns(db)).toThrow(/nav_airport has columns/);
  });
});

describe('snapshot import', () => {
  it('builds and swaps in a replica, leaving no incoming or stale files', () => {
    const d = replicaDir();
    openNavdata();

    return importNavdataSnapshot(writeSnapshot({
      rows: [
        row('airport', { ident: 'ZZAA', name: 'Zulu Alpha Field', lat: 10.5, lon: 20.25, position_source: 'list' }),
        row('runway', { rwy_key: 'ZZAA|9|0', airport_ident: 'ZZAA', length_m: 2000 }),
      ],
    })).then(ack => {
      expect(ack).toMatchObject({ ok: true, snapshotId: 'snapshot-1', rev: 7, counts: { airport: 1, runway: 1 } });
      expect(readNavMeta(getNavDb()!)).toMatchObject({ snapshot_id: 'snapshot-1', rev: 7, sim_id: '2024' });
      expect(count(getNavDb()!, 'nav_airport')).toBe(1);

      const fresh = new Database(resolveNavdataPath(), { readonly: true });
      handles.push(fresh);
      expect(count(fresh, 'nav_runway')).toBe(1);
      fresh.close();

      closeNavDb();
      expect(fs.readdirSync(d)).toEqual(['navdata.db']);
    });
  });

  it('replaces the replica when the snapshot carries the epoch already held', async () => {
    replicaDir();
    openNavdata();
    await importNavdataSnapshot(writeSnapshot({ rows: [row('airport', { ident: 'ZZAA' })] }));

    await importNavdataSnapshot(writeSnapshot({ rows: [row('airport', { ident: 'ZZAB' })] }));

    expect(readNavMeta(getNavDb()!)).toMatchObject({ snapshot_id: 'snapshot-1' });
    expect(count(getNavDb()!, 'nav_airport')).toBe(1);
    expect(one(getNavDb()!, 'SELECT ident FROM nav_airport')).toEqual({ ident: 'ZZAB' });
  });

  it('leaves the previous replica intact when the footer count is wrong', async () => {
    const d = replicaDir();
    openNavdata();
    await importNavdataSnapshot(writeSnapshot({ snapshotId: 'snapshot-1', rows: [row('airport', { ident: 'ZZAA' })] }));

    await expect(importNavdataSnapshot(writeSnapshot({
      snapshotId: 'snapshot-2',
      rows: [row('airport', { ident: 'ZZAB' }), row('airport', { ident: 'ZZAC' })],
      footerRows: 3,
    }))).rejects.toMatchObject({ code: 'NAVDATA_BAD_BATCH', status: 400 });

    expect(readNavMeta(getNavDb()!)).toMatchObject({ snapshot_id: 'snapshot-1' });
    expect(one(getNavDb()!, 'SELECT ident FROM nav_airport')).toEqual({ ident: 'ZZAA' });
    closeNavDb();
    expect(fs.readdirSync(d)).toEqual(['navdata.db']);
  });

  it('refuses a snapshot built to another schema version', async () => {
    replicaDir();
    openNavdata();
    await importNavdataSnapshot(writeSnapshot({ snapshotId: 'snapshot-1' }));

    await expect(importNavdataSnapshot(writeSnapshot({ snapshotId: 'snapshot-9', schemaVersion: 1 })))
      .rejects.toMatchObject({ code: 'NAVDATA_SCHEMA_UNSUPPORTED', status: 409, serverSchemaVersion: 2 });

    expect(readNavMeta(getNavDb()!)).toMatchObject({ snapshot_id: 'snapshot-1' });
  });

  it('replaces a file whose schema version the server does not serve', async () => {
    replicaDir();
    const stale = new Database(resolveNavdataPath());
    applyNavdataSchema(stale);
    stale.prepare(
      "INSERT INTO nav_meta (id, schema_version, snapshot_id, sim_id, created_at, updated_at) VALUES (1, 1, 'old', '2024', 1, 1)",
    ).run();
    stale.close();
    openNavdata();
    expect(getNavDb()).toBeNull();

    await importNavdataSnapshot(writeSnapshot({ snapshotId: 'snapshot-fresh' }));

    expect(readNavMeta(getNavDb()!)).toMatchObject({ snapshot_id: 'snapshot-fresh', schema_version: 2 });
  });

  it('refuses a zero-row snapshot over a populated replica and leaves it untouched', async () => {
    const d = replicaDir();
    openNavdata();
    await importNavdataSnapshot(writeSnapshot({
      snapshotId: 'snapshot-1',
      rows: [row('airport', { ident: 'ZZAA' }), row('runway', { rwy_key: 'ZZAA|9|0', airport_ident: 'ZZAA' })],
    }));

    await expect(importNavdataSnapshot(writeSnapshot({ snapshotId: 'snapshot-2', rows: [] })))
      .rejects.toMatchObject({ code: 'NAVDATA_BAD_BATCH', status: 400, message: /empty snapshot/ });

    expect(readNavMeta(getNavDb()!)).toMatchObject({ snapshot_id: 'snapshot-1' });
    expect(count(getNavDb()!, 'nav_airport')).toBe(1);
    expect(count(getNavDb()!, 'nav_runway')).toBe(1);
    closeNavDb();
    expect(fs.readdirSync(d)).toEqual(['navdata.db']);
  });

  it('accepts a zero-row snapshot when there is no replica', async () => {
    replicaDir();
    openNavdata();
    expect(getNavDb()).toBeNull();

    await expect(importNavdataSnapshot(writeSnapshot({ snapshotId: 'snapshot-1', rows: [] })))
      .resolves.toMatchObject({ ok: true, snapshotId: 'snapshot-1' });

    expect(readNavMeta(getNavDb()!)).toMatchObject({ snapshot_id: 'snapshot-1' });
  });

  it('accepts a zero-row snapshot over a replica that holds no rows', async () => {
    replicaDir();
    openNavdata();
    await importNavdataSnapshot(writeSnapshot({ snapshotId: 'snapshot-1', rows: [] }));

    await expect(importNavdataSnapshot(writeSnapshot({ snapshotId: 'snapshot-2', rows: [] })))
      .resolves.toMatchObject({ ok: true, snapshotId: 'snapshot-2' });

    expect(readNavMeta(getNavDb()!)).toMatchObject({ snapshot_id: 'snapshot-2' });
  });

  it('refuses a stream with no footer and cleans the incoming file up', async () => {
    const d = replicaDir();
    openNavdata();
    const file = path.join(tempDir(), 'truncated.ndjson.gz');
    const header = JSON.stringify({
      kind: 'header', v: 1, schemaVersion: 2, snapshotId: 'snapshot-3', rev: 1,
      simId: '2024', simAppName: null, simAppVersion: null, sidecarVersion: 't', createdAt: 1, counts: {},
    });
    fs.writeFileSync(file, zlib.gzipSync(`${header}\n${JSON.stringify(row('airport', { ident: 'ZZAA' }))}\n`));

    await expect(importNavdataSnapshot(file)).rejects.toMatchObject({ code: 'NAVDATA_BAD_BATCH' });

    expect(getNavDb()).toBeNull();
    expect(fs.readdirSync(d)).toEqual([]);
  });
});

describe('incremental batches', () => {
  const batch = (over: Record<string, unknown> = {}) => ({
    v: 1 as const, schemaVersion: 2 as const, snapshotId: 'snapshot-1',
    fromRev: 7, toRev: 8, rows: [] as NavRow[], more: false, ...over,
  });

  it('applies rows, in parents-first order, and moves nav_meta.rev', async () => {
    replicaDir();
    openNavdata();
    await importNavdataSnapshot(writeSnapshot({ snapshotId: 'snapshot-1', rev: 7, rows: [] }));

    const ack = applyIncrementalBatch(getNavDb(), batch({
      rows: [
        row('runway', { rwy_key: 'ZZAA|9|0', airport_ident: 'ZZAA', length_m: 2000, rev: 8 }),
        row('airport', { ident: 'ZZAA', name: 'Zulu Alpha Field', rev: 8 }),
      ],
    }), 1_700_000_001_000);

    expect(ack).toEqual({ ok: true, snapshotId: 'snapshot-1', rev: 8, applied: 2 });
    expect(readNavMeta(getNavDb()!)).toMatchObject({ rev: 8, updated_at: 1_700_000_001_000 });
    expect(count(getNavDb()!, 'nav_runway')).toBe(1);
  });

  it('refuses a batch for another epoch, naming the epoch it holds', async () => {
    replicaDir();
    openNavdata();
    await importNavdataSnapshot(writeSnapshot({ snapshotId: 'snapshot-1', rev: 7 }));

    expect(() => applyIncrementalBatch(getNavDb(), batch({ snapshotId: 'snapshot-other' }))).toThrow(NavdataStoreError);
    try {
      applyIncrementalBatch(getNavDb(), batch({ snapshotId: 'snapshot-other' }));
    } catch (err) {
      expect(err).toMatchObject({
        code: 'NAVDATA_SNAPSHOT_MISMATCH', status: 409, serverSnapshotId: 'snapshot-1', serverRev: 7,
      });
    }
  });

  it('refuses a batch when no replica is present, with a null server epoch', () => {
    replicaDir();
    openNavdata();
    try {
      applyIncrementalBatch(getNavDb(), batch());
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toMatchObject({
        code: 'NAVDATA_SNAPSHOT_MISMATCH', status: 409, serverSnapshotId: null, serverRev: 0,
      });
    }
  });

  it('refuses another schema version', async () => {
    replicaDir();
    openNavdata();
    await importNavdataSnapshot(writeSnapshot({ snapshotId: 'snapshot-1', rev: 7 }));

    expect(() => applyIncrementalBatch(getNavDb(), batch({ schemaVersion: 1 }) as never))
      .toThrow(expect.objectContaining({ code: 'NAVDATA_SCHEMA_UNSUPPORTED', serverSchemaVersion: 2 }));
  });

  describe('row-count limits', () => {
    const absentRows = (n: number, rev: (i: number) => number): NavRow[] =>
      Array.from({ length: n }, (_, i) => row('absent', {
        kind: 'W', ident: `ZZ${i}`, region: 'ZZ', reason: 'silent',
        first_seen_at: 1, last_checked_at: 1, attempts: 1, rev: rev(i),
      }));
    const absentCount = () => count(getNavDb()!, 'nav_absent');

    async function ready() {
      replicaDir();
      openNavdata();
      await importNavdataSnapshot(writeSnapshot({ snapshotId: 'snapshot-1', rev: 7 }));
    }

    it('accepts a single-rev batch above the sender target and acks it whole', async () => {
      await ready();
      const ack = applyIncrementalBatch(getNavDb(), batch({ toRev: 9, rows: absentRows(2400, () => 9) }));
      expect(ack).toEqual({ ok: true, snapshotId: 'snapshot-1', rev: 9, applied: 2400 });
      expect(absentCount()).toBe(2400);
      expect(readNavMeta(getNavDb()!)).toMatchObject({ rev: 9 });
    });

    it('refuses more than the target rows that span two revs, writing nothing', async () => {
      await ready();
      let err: unknown;
      try {
        applyIncrementalBatch(getNavDb(), batch({ rows: absentRows(2001, i => (i === 0 ? 8 : 9)) }));
      } catch (e) { err = e; }
      expect(err).toMatchObject({ code: 'NAVDATA_BAD_BATCH', status: 400 });
      expect((err as Error).message).toContain('spans more than one rev');
      expect(absentCount()).toBe(0);
      expect(readNavMeta(getNavDb()!)).toMatchObject({ rev: 7 });
    });

    it('still accepts exactly the target rows across several revs', async () => {
      await ready();
      const ack = applyIncrementalBatch(getNavDb(), batch({ rows: absentRows(2000, i => 8 + (i % 3)) }));
      expect(ack.applied).toBe(2000);
      expect(absentCount()).toBe(2000);
    });

    // Imports a snapshot (a replica build), then applies a batch of exactly the
    // production ceiling, NAVDATA_BATCH_HARD_ROW_CEILING = 20,000 rows. The apply is
    // CPU-bound and measured up to ~11 s on a loaded dev machine (issue #9), so this
    // one test gets 30 s; the global 5 s testTimeout stays for everything else.
    it('accepts exactly the ceiling and refuses one row more', async () => {
      await ready();
      const ack = applyIncrementalBatch(getNavDb(), batch({ rows: absentRows(20000, () => 8) }));
      expect(ack.applied).toBe(20000);
      let err: unknown;
      try {
        applyIncrementalBatch(getNavDb(), batch({ rows: absentRows(20001, () => 9) }));
      } catch (e) { err = e; }
      expect(err).toMatchObject({ code: 'NAVDATA_BAD_BATCH', status: 400 });
      expect((err as Error).message).toBe('batch carries 20001 rows, more than 20000');
      expect(absentCount()).toBe(20000);
    }, 30_000);

    it('does not let a row without an integer rev pass as single-rev', async () => {
      await ready();
      const rows = absentRows(2001, () => 8);
      delete rows[1000].r.rev;
      expect(() => applyIncrementalBatch(getNavDb(), batch({ rows })))
        .toThrow(expect.objectContaining({ code: 'NAVDATA_BAD_BATCH' }));
      expect(absentCount()).toBe(0);
      const small = absentRows(3, () => 8);
      delete small[1].r.rev;
      expect(() => applyIncrementalBatch(getNavDb(), batch({ rows: small })))
        .toThrow(expect.objectContaining({ message: expect.stringContaining('no integer rev') }));
    });
  });
});
