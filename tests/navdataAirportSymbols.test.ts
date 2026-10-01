// The three derived airport-symbol fields (longestRunwayM, surface, towered)
// on both /api/navdata/features and /api/navdata/airports/:ident, against a
// real scratch replica. Synthetic idents and coordinates only.

import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNavdataRouter } from '../src/routes/navdata';
import { requireSameOrigin } from '../src/auth/middleware';
import { SidecarStateStore } from '../src/navdata/sidecarState';
import { applyNavdataSchema } from '../src/navdata/schema';
import { closeNavDb, openNavdata } from '../src/navdata/connection';
import { surfaceBucket } from '../src/navdata/query';
import { scratchDbRoot } from './helpers/scratchRoot';

let dir: string;
let server: Server;
let base: string;
let state: SidecarStateStore;

type Row = Record<string, string | number | null>;

function insert(db: Database.Database, table: string, r: Row): void {
  const cols = Object.keys(r);
  db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(r));
}

function buildReplica(fill: (db: Database.Database) => void): void {
  const file = process.env.NAVDATA_DB_PATH!;
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applyNavdataSchema(db);
  insert(db, 'nav_meta', {
    id: 1, schema_version: 2, snapshot_id: 'epoch-1', rev: 7, sim_id: '2024',
    bulk_completed_at: 5, created_at: 1, updated_at: 2,
  });
  fill(db);
  db.close();
  openNavdata();
}

const ap = (ident: string, extra: Row = {}): Row =>
  ({ ident, lat: 10, lon: 20, name: `Field ${ident}`, detail_state: 'index', rev: 1, ...extra });

const rwy = (key: string, ident: string, lengthM: number | null, surface: number | null, extra: Row = {}): Row =>
  ({ rwy_key: key, airport_ident: ident, lat: 10, lon: 20, length_m: lengthM, surface, rev: 1, ...extra });

const freq = (ident: string, type: number | null, hz: number, extra: Row = {}): Row =>
  ({ freq_key: `${ident}|${type}|${hz}`, airport_ident: ident, freq_type: type, frequency_hz: hz, name: 'STN', rev: 1, ...extra });

const get = (p: string) => fetch(`${base}${p}`);
const features = async (q: string) => (await (await get(`/api/navdata/features?${q}`)).json()) as any;
const detail = async (ident: string) => (await (await get(`/api/navdata/airports/${ident}`)).json()) as any;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(scratchDbRoot(), 'navdata-symbols-'));
  process.env.NAVDATA_DB_PATH = path.join(dir, 'navdata.db');
  closeNavDb();
  openNavdata();
  state = new SidecarStateStore();
  const app = express();
  app.use(express.json());
  app.use(requireSameOrigin);
  app.use('/api', createNavdataRouter(state));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeNavDb();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.NAVDATA_DB_PATH;
});

describe('surfaceBucket()', () => {
  it('buckets a recognised paved code', () => {
    expect(surfaceBucket(4)).toBe('paved');
  });

  it('buckets a recognised soft code', () => {
    expect(surfaceBucket(1)).toBe('soft');
  });

  it('buckets an unrecognised non-null integer as soft, not as unknown', () => {
    expect(surfaceBucket(99)).toBe('soft');
  });

  it('is null only for a null code, never a bucket', () => {
    expect(surfaceBucket(null)).toBeNull();
  });
});

describe('the airport-symbol truth table', () => {
  it('row 1: an index-only airport reports all three fields null', async () => {
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZ01'));
      insert(db, 'nav_runway', rwy('ZZ01|9|1', 'ZZ01', 2000, 4, { primary_number: 9, primary_designator: 1 }));
      insert(db, 'nav_airport_frequency', freq('ZZ01', 6, 120500000));
    });
    const body = await features('bbox=19,9,21,11&zoom=6');
    expect(body.airports).toEqual([
      expect.objectContaining({ ident: 'ZZ01', hasDetail: false, longestRunwayM: null, surface: null, towered: null }),
    ]);
    expect(await detail('ZZ01')).toMatchObject({ longestRunwayM: null, surface: null, towered: null });
  });

  it('row 2: detail, runways present, a tower frequency exists -> towered true', async () => {
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZ02', { detail_state: 'detail' }));
      insert(db, 'nav_runway', rwy('ZZ02|9|1', 'ZZ02', 2000, 4, { primary_number: 9, primary_designator: 1 }));
      insert(db, 'nav_airport_frequency', freq('ZZ02', 1, 118000000));
      insert(db, 'nav_airport_frequency', freq('ZZ02', 6, 120500000));
    });
    const body = await features('bbox=19,9,21,11&zoom=6');
    expect(body.airports[0]).toMatchObject({ longestRunwayM: 2000, surface: 'paved', towered: true });
    expect(await detail('ZZ02')).toMatchObject({ longestRunwayM: 2000, surface: 'paved', towered: true });
  });

  it('row 3: detail, frequencies exist but none is a tower -> towered false, not null', async () => {
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZ03', { detail_state: 'detail' }));
      insert(db, 'nav_runway', rwy('ZZ03|9|1', 'ZZ03', 1500, 1, { primary_number: 9, primary_designator: 1 }));
      insert(db, 'nav_airport_frequency', freq('ZZ03', 1, 118000000));
      insert(db, 'nav_airport_frequency', freq('ZZ03', 3, 121000000));
    });
    const body = await features('bbox=19,9,21,11&zoom=6');
    expect(body.airports[0]).toMatchObject({ longestRunwayM: 1500, surface: 'soft', towered: false });
    expect(await detail('ZZ03')).toMatchObject({ towered: false });
  });

  it('row 4: detail, zero frequency rows -> towered null, not false', async () => {
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZ04', { detail_state: 'detail' }));
      insert(db, 'nav_runway', rwy('ZZ04|9|1', 'ZZ04', 900, 12, { primary_number: 9, primary_designator: 1 }));
    });
    const body = await features('bbox=19,9,21,11&zoom=6');
    expect(body.airports[0]).toMatchObject({ longestRunwayM: 900, surface: 'soft', towered: null });
    expect(await detail('ZZ04')).toMatchObject({ towered: null });
  });

  it('row 5: the longest runway itself has a NULL surface -> surface null, not soft', async () => {
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZ05', { detail_state: 'detail' }));
      insert(db, 'nav_runway', rwy('ZZ05|9|1', 'ZZ05', 2000, null, { primary_number: 9, primary_designator: 1 }));
      insert(db, 'nav_runway', rwy('ZZ05|18|0', 'ZZ05', 1900, 4, { primary_number: 18, primary_designator: 0 }));
      insert(db, 'nav_airport_frequency', freq('ZZ05', 6, 120500000));
    });
    const body = await features('bbox=19,9,21,11&zoom=6');
    expect(body.airports[0]).toMatchObject({ longestRunwayM: 2000, surface: null, towered: true });
  });

  it('row 6: every runway row has a NULL length_m -> longestRunwayM and surface both null', async () => {
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZ06', { detail_state: 'detail' }));
      insert(db, 'nav_runway', rwy('ZZ06|9|1', 'ZZ06', null, 4, { primary_number: 9, primary_designator: 1 }));
      insert(db, 'nav_runway', rwy('ZZ06|18|0', 'ZZ06', null, 0, { primary_number: 18, primary_designator: 0 }));
    });
    const body = await features('bbox=19,9,21,11&zoom=6');
    expect(body.airports[0]).toMatchObject({ longestRunwayM: null, surface: null });
  });

  it('row 7: detail with zero runway rows -> longestRunwayM and surface both null', async () => {
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZ07', { detail_state: 'detail' }));
      insert(db, 'nav_airport_frequency', freq('ZZ07', 6, 120500000));
    });
    const body = await features('bbox=19,9,21,11&zoom=6');
    expect(body.airports[0]).toMatchObject({ longestRunwayM: null, surface: null, towered: true });
  });

  it('a re-fetch in progress (detail_state pending) with old runway/frequency rows still on disk stays null', async () => {
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZ08', { detail_state: 'pending' }));
      insert(db, 'nav_runway', rwy('ZZ08|9|1', 'ZZ08', 2000, 4, { primary_number: 9, primary_designator: 1 }));
      insert(db, 'nav_airport_frequency', freq('ZZ08', 6, 120500000));
    });
    const body = await features('bbox=19,9,21,11&zoom=6');
    expect(body.airports[0]).toMatchObject({ hasDetail: false, longestRunwayM: null, surface: null, towered: null });
  });
});

describe('longestRunwayHeadingDeg', () => {
  it('reports the longest runway\'s own heading when known', async () => {
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZ11', { detail_state: 'detail' }));
      insert(db, 'nav_runway', rwy('ZZ11|9|1', 'ZZ11', 2000, 4, { primary_number: 9, primary_designator: 1, heading_deg: 93.4 }));
    });
    const body = await features('bbox=19,9,21,11&zoom=6');
    expect(body.airports[0]).toMatchObject({ longestRunwayM: 2000, surface: 'paved', longestRunwayHeadingDeg: 93.4 });
    expect(await detail('ZZ11')).toMatchObject({ longestRunwayHeadingDeg: 93.4 });
  });

  it('is null when the longest runway\'s own heading_deg column is NULL, even though length and surface are known', async () => {
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZ12', { detail_state: 'detail' }));
      insert(db, 'nav_runway', rwy('ZZ12|9|1', 'ZZ12', 1800, 4, { primary_number: 9, primary_designator: 1, heading_deg: null }));
    });
    const body = await features('bbox=19,9,21,11&zoom=6');
    expect(body.airports[0]).toMatchObject({ longestRunwayM: 1800, surface: 'paved', longestRunwayHeadingDeg: null });
    expect(await detail('ZZ12')).toMatchObject({ longestRunwayM: 1800, surface: 'paved', longestRunwayHeadingDeg: null });
  });

  it('returns the LONGEST runway\'s own heading, not MIN/MAX(heading_deg) over all of the airport\'s runways', async () => {
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZ13', { detail_state: 'detail' }));
      // Longest (3000 m) points 250deg; the two shorter runways point 10deg
      // and 310deg. Neither MIN(heading_deg) (10) nor MAX(heading_deg) (310)
      // over all three rows agrees with the correct answer (250, taken from
      // the longest row alone) — an implementation that mins/maxes the
      // heading column independently of length_m fails this fixture
      // regardless of which direction it picks.
      insert(db, 'nav_runway', rwy('ZZ13|25|0', 'ZZ13', 3000, 4, { primary_number: 25, primary_designator: 0, heading_deg: 250 }));
      insert(db, 'nav_runway', rwy('ZZ13|1|0', 'ZZ13', 2900, 4, { primary_number: 1, primary_designator: 0, heading_deg: 10 }));
      insert(db, 'nav_runway', rwy('ZZ13|31|0', 'ZZ13', 1000, 4, { primary_number: 31, primary_designator: 0, heading_deg: 310 }));
    });
    const body = await features('bbox=19,9,21,11&zoom=6');
    expect(body.airports[0]).toMatchObject({ longestRunwayM: 3000, longestRunwayHeadingDeg: 250 });
    expect(await detail('ZZ13')).toMatchObject({ longestRunwayM: 3000, longestRunwayHeadingDeg: 250 });
  });

  it('is null when the longest row\'s heading is NULL, even though a SHORTER row has a known heading', async () => {
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZ14', { detail_state: 'detail' }));
      insert(db, 'nav_runway', rwy('ZZ14|9|1', 'ZZ14', 2200, 4, { primary_number: 9, primary_designator: 1, heading_deg: null }));
      insert(db, 'nav_runway', rwy('ZZ14|18|0', 'ZZ14', 1600, 0, { primary_number: 18, primary_designator: 0, heading_deg: 175 }));
    });
    const body = await features('bbox=19,9,21,11&zoom=6');
    expect(body.airports[0]).toMatchObject({ longestRunwayM: 2200, surface: 'paved', longestRunwayHeadingDeg: null });
    expect(await detail('ZZ14')).toMatchObject({ longestRunwayM: 2200, surface: 'paved', longestRunwayHeadingDeg: null });
  });
});

describe('longest runway wins, not an independently-maxed surface', () => {
  it('returns the LONGEST runway\'s surface, not an aggregate over all of the airport\'s runways', async () => {
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZ09', { detail_state: 'detail' }));
      // Longest (1500 m) is dirt (12, soft); the two shorter runways are
      // concrete (0, paved) and river (30, water). Neither MAX(surface) (30,
      // water) nor MIN(surface) (0, paved) over all three rows agrees with
      // the correct answer (soft, taken from the longest row alone) — an
      // implementation that maxes/mins the surface column independently of
      // length_m fails this fixture regardless of which direction it picks.
      insert(db, 'nav_runway', rwy('ZZ09|9|1', 'ZZ09', 1500, 12, { primary_number: 9, primary_designator: 1 }));
      insert(db, 'nav_runway', rwy('ZZ09|18|0', 'ZZ09', 1400, 0, { primary_number: 18, primary_designator: 0 }));
      insert(db, 'nav_runway', rwy('ZZ09|27|0', 'ZZ09', 1000, 30, { primary_number: 27, primary_designator: 0 }));
    });
    const body = await features('bbox=19,9,21,11&zoom=6');
    expect(body.airports[0]).toMatchObject({ longestRunwayM: 1500, surface: 'soft' });
  });

  it('ties on length break by rwy_key ascending, deterministically', async () => {
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZ10', { detail_state: 'detail' }));
      insert(db, 'nav_runway', rwy('ZZ10|9|1', 'ZZ10', 2000, 4, { primary_number: 9, primary_designator: 1 }));
      insert(db, 'nav_runway', rwy('ZZ10|27|0', 'ZZ10', 2000, 1, { primary_number: 27, primary_designator: 0 }));
    });
    const body = await features('bbox=19,9,21,11&zoom=6');
    // 'ZZ10|27|0' < 'ZZ10|9|1' lexicographically, so the 27 end (surface 1, soft) wins the tie.
    expect(body.airports[0]).toMatchObject({ longestRunwayM: 2000, surface: 'soft' });
  });
});
