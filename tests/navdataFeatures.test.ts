// The browser-facing navdata queries against a real scratch replica and a real
// scratch flights.db. Synthetic idents and coordinates only.

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
import { runwayDesignation, totalCells, lonRanges, parseBbox } from '../src/navdata/query';
import {
  AIRPORT_VIEWPORT_BUDGET, airportTierFloor, chooseAirportTier, setAirportTiers,
} from '../src/navdata/airportTiers';
import { listNavdataRequests } from '../src/db/navdataRequests';
import { applyNavRows } from '../src/navdata/store';
import { createScratchDb, destroyScratchDb, type ScratchDb } from './helpers/db';
import { scratchDbRoot } from './helpers/scratchRoot';

const savedEnv = process.env.NAVDATA_DB_PATH;

let scratch: ScratchDb;
let dir: string;
let server: Server;
let base: string;
let state: SidecarStateStore;

type Row = Record<string, string | number | null>;

function insert(db: Database.Database, table: string, r: Row): void {
  const cols = Object.keys(r);
  db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(r));
}

function buildReplica(fill: (db: Database.Database) => void, bulkDone = true): void {
  const file = process.env.NAVDATA_DB_PATH!;
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applyNavdataSchema(db);
  insert(db, 'nav_meta', {
    id: 1, schema_version: 2, snapshot_id: 'epoch-1', rev: 7, sim_id: '2024',
    bulk_completed_at: bulkDone ? 5 : null, created_at: 1, updated_at: 2,
  });
  fill(db);
  db.close();
  openNavdata();
}

const ap = (ident: string, lat: number, lon: number, extra: Row = {}): Row =>
  ({ ident, lat, lon, name: `Field ${ident}`, detail_state: 'index', rev: 1, ...extra });
const leg = (key: string, minLat: number, maxLat: number, minLon: number, maxLon: number, dateline = 0): Row => ({
  leg_key: key, airway: 'ZA1', from_key: 'a', to_key: 'b', from_ident: 'AAA', from_region: 'ZZ', from_lat: minLat,
  from_lon: minLon, to_ident: 'BBB', to_region: 'ZZ', to_lat: maxLat, to_lon: maxLon,
  min_lat: minLat, max_lat: maxLat, min_lon: minLon, max_lon: maxLon, dateline, rev: 1,
});

const get = (p: string) => fetch(`${base}${p}`);
const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/navdata/request`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
const features = async (q: string) => (await (await get(`/api/navdata/features?${q}`)).json()) as any;

beforeEach(async () => {
  scratch = createScratchDb();
  dir = fs.mkdtempSync(path.join(scratchDbRoot(), 'navdata-features-'));
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
  destroyScratchDb(scratch);
  fs.rmSync(dir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.NAVDATA_DB_PATH;
  else process.env.NAVDATA_DB_PATH = savedEnv;
  setAirportTiers([]);
});

describe('bbox and cells', () => {
  it('parses a legal box and refuses the rest', () => {
    expect(parseBbox('-10,-5,10,5')).toEqual([-10, -5, 10, 5]);
    for (const bad of ['1,2,3', '1,2,3,x', '1,5,3,2', '-181,0,0,1', '0,-91,1,1', '0,0,1,91', ',,,', undefined]) {
      expect(parseBbox(bad)).toBeNull();
    }
  });

  it('splits an antimeridian box and treats w === e as empty', () => {
    expect(lonRanges(170, -170)).toEqual([[170, 180], [-180, -170]]);
    expect(lonRanges(5, 5)).toEqual([]);
  });

  it('counts 0.5 degree cells: a known box, a split box, and the clamp', () => {
    expect(totalCells([10, 20, 11, 21])).toBe(9);
    expect(totalCells([10.1, 20.1, 10.4, 20.4])).toBe(1);
    // 179 to 180E is 2 columns (the 180 edge clamps into the last one), -180 to -179 is 3; 3 rows.
    expect(totalCells([179, 0, -179, 1])).toBe(3 * (2 + 3));
    expect(totalCells([-180, -90, 180, 90])).toBe(259_200);
    expect(totalCells([5, 0, 5, 1])).toBe(0);
  });
});

describe('GET /features', () => {
  it('returns rows on both sides of the antimeridian', async () => {
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZE1', 10, 179.5));
      insert(db, 'nav_airport', ap('ZZW1', 10, -179.5));
      insert(db, 'nav_airport', ap('ZZM1', 10, 0));
    });
    const body = await features('bbox=178,5,-178,15&zoom=6');
    expect(body.airports.map((a: any) => a.ident)).toEqual(['ZZE1', 'ZZW1']);
    expect(body.bbox).toEqual([178, 5, -178, 15]);
  });

  it('matches a dateline airway row only where its wrapped longitude interval reaches the box', async () => {
    buildReplica(db => {
      // Crosses the antimeridian from 170E to 170W; min/max_lon are meaningless.
      insert(db, 'nav_airway_leg', leg('a|x|y', 40, 50, 170, -170, 1));
      insert(db, 'nav_airway_leg', leg('a|x|z', 40, 50, 0, 10, 0));
      insert(db, 'nav_airway_leg', leg('a|x|w', 60, 70, 170, 175, 0));
    });
    const hit = async (bbox: string) =>
      (await features(`bbox=${bbox}&zoom=7&kinds=airways`)).airways.filter((a: any) => a.dateline).length;
    expect(await hit('179,41,180,49')).toBe(1);
    expect(await hit('-180,41,-179,49')).toBe(1);
    expect(await hit('175,41,-175,49')).toBe(1);
    expect(await hit('110,41,120,49')).toBe(0);
    expect(await hit('-120,41,-110,49')).toBe(0);
    expect(await hit('179,60,180,70')).toBe(0);
    const body = await features('bbox=179,41,180,49&zoom=7&kinds=airways');
    expect(body.airways[0]).toMatchObject({ dateline: true, from: [40, 170], to: [50, -170] });
  });

  it('reports coverage: nothing harvested vs fully harvested', async () => {
    buildReplica(() => undefined);
    let body = await features('bbox=10,20,11,21&zoom=0');
    expect(body.coverage.totalCells).toBe(9);
    expect(body.coverage.byKind.W).toEqual({ harvestedCells: 0, fraction: 0, oldestHarvestAt: null, newestHarvestAt: null });
    expect(body.coverage.airportsComplete).toBe(true);

    buildReplica(db => {
      for (let r = Math.floor((20 + 90) * 2); r <= Math.floor((21 + 90) * 2); r++) {
        for (let c = Math.floor((10 + 180) * 2); c <= Math.floor((11 + 180) * 2); c++) {
          insert(db, 'nav_coverage_cell', { kind: 'W', cell_id: r * 720 + c, harvested_at: 100 + c, rev: 1 });
        }
      }
      // A cell outside the box, and another kind, must not count.
      insert(db, 'nav_coverage_cell', { kind: 'W', cell_id: 0, harvested_at: 1, rev: 1 });
      insert(db, 'nav_coverage_cell', { kind: 'V', cell_id: Math.floor(110 * 2) * 720 + 380, harvested_at: 50, rev: 1 });
    }, false);
    body = await features('bbox=10,20,11,21&zoom=0');
    expect(body.coverage.totalCells).toBe(9);
    expect(body.coverage.byKind.W).toMatchObject({ harvestedCells: 9, fraction: 1, oldestHarvestAt: 480, newestHarvestAt: 482 });
    expect(body.coverage.byKind.V.harvestedCells).toBe(1);
    expect(body.coverage.byKind.N.harvestedCells).toBe(0);
    expect(body.coverage.airportsComplete).toBe(false);
  });

  it('counts coverage on both sides of the antimeridian', async () => {
    buildReplica(db => {
      insert(db, 'nav_coverage_cell', { kind: 'N', cell_id: 200 * 720 + 719, harvested_at: 9, rev: 1 });
      insert(db, 'nav_coverage_cell', { kind: 'N', cell_id: 200 * 720 + 0, harvested_at: 9, rev: 1 });
      insert(db, 'nav_coverage_cell', { kind: 'N', cell_id: 200 * 720 + 300, harvested_at: 9, rev: 1 });
    });
    const body = await features('bbox=179.5,10,-179.5,10.2&zoom=0');
    expect(body.coverage.byKind.N.harvestedCells).toBe(2);
    expect(body.coverage.totalCells).toBe(3);
  });

  it('gates kinds below their zoom, naming them and returning []', async () => {
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZA1', 10, 20));
      insert(db, 'nav_waypoint', { wpt_key: 'W1', ident: 'W1', region: 'ZZ', lat: 10, lon: 20, rev: 1 });
    });
    const body = await features('bbox=19,9,21,11&zoom=6');
    expect(body.gated.sort()).toEqual(['airways', 'navaids', 'runways', 'waypoints']);
    expect(body.airports).toHaveLength(1);
    for (const k of ['navaids', 'waypoints', 'airways', 'runways']) expect(body[k]).toEqual([]);
    const only = await features('bbox=19,9,21,11&zoom=9&kinds=waypoints');
    expect(only.gated).toEqual([]);
    expect(only.waypoints).toHaveLength(1);
    expect(only.airports).toEqual([]);
  });

  it('truncates at the limit, deterministically by key', async () => {
    buildReplica(db => {
      for (const id of ['ZZ03', 'ZZ01', 'ZZ02']) insert(db, 'nav_airport', ap(id, 10, 20));
    });
    let body = await features('bbox=19,9,21,11&zoom=6&limit=2');
    expect(body.truncated).toBe(true);
    expect(body.limit).toBe(2);
    expect(body.airports.map((a: any) => a.ident)).toEqual(['ZZ01', 'ZZ02']);
    body = await features('bbox=19,9,21,11&zoom=6&limit=3');
    expect(body.truncated).toBe(false);
    expect((await features('bbox=19,9,21,11&zoom=6&limit=99999')).limit).toBe(5000);
  });

  it('derives the runway designation from the columns', async () => {
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZA1', 10, 20));
      insert(db, 'nav_runway', {
        rwy_key: 'ZZA1|9|1', airport_ident: 'ZZA1', lat: 10, lon: 20, heading_deg: 90, length_m: 3000, width_m: 45,
        primary_number: 9, primary_designator: 1, rev: 1,
      });
      insert(db, 'nav_runway', { rwy_key: 'ZZA1|x', airport_ident: 'ZZA1', lat: null, lon: null, rev: 1 });
    });
    const body = await features('bbox=19,9,21,11&zoom=12&kinds=runways');
    expect(body.runways).toEqual([
      { airport: 'ZZA1', lat: 10, lon: 20, headingDeg: 90, lengthM: 3000, widthM: 45, designation: '09L', secondaryDesignation: '' },
    ]);
    expect(runwayDesignation(27, 2)).toBe('27R');
    expect(runwayDesignation(38, 0)).toBe('NE');
    expect(runwayDesignation(null, null)).toBe('');
  });

  it('derives the secondary runway designation alongside the primary, and blanks it when the columns are null', async () => {
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZA1', 10, 20));
      insert(db, 'nav_runway', {
        rwy_key: 'ZZA1|9|27', airport_ident: 'ZZA1', lat: 10, lon: 20, heading_deg: 90, length_m: 3000, width_m: 45,
        primary_number: 9, primary_designator: 1, secondary_number: 27, secondary_designator: 2, rev: 1,
      });
      insert(db, 'nav_runway', {
        rwy_key: 'ZZA1|18', airport_ident: 'ZZA1', lat: 10.1, lon: 20.1, heading_deg: 180, length_m: 2000, width_m: 30,
        primary_number: 18, primary_designator: 0, secondary_number: null, secondary_designator: null, rev: 1,
      });
    });
    const body = await features('bbox=19,9,21,11&zoom=12&kinds=runways');
    const runways = body.runways.sort((a: any, b: any) => a.headingDeg - b.headingDeg);
    expect(runways).toEqual([
      { airport: 'ZZA1', lat: 10, lon: 20, headingDeg: 90, lengthM: 3000, widthM: 45, designation: '09L', secondaryDesignation: '27R' },
      { airport: 'ZZA1', lat: 10.1, lon: 20.1, headingDeg: 180, lengthM: 2000, widthM: 30, designation: '18', secondaryDesignation: '' },
    ]);
  });

  it('answers empty with computed coverage when there is no replica, and 400 on bad input', async () => {
    const body = await features('bbox=10,20,11,21&zoom=12');
    expect(body).toMatchObject({ airports: [], navaids: [], waypoints: [], airways: [], runways: [], gated: [], truncated: false });
    expect(body.coverage.totalCells).toBe(9);
    expect(body.coverage.airportsComplete).toBe(false);
    expect((await get('/api/navdata/features?zoom=5')).status).toBe(400);
    expect((await get('/api/navdata/features?bbox=1,2,3,4')).status).toBe(400);
    expect((await get('/api/navdata/features?bbox=1,2,3,4&zoom=21')).status).toBe(400);
    expect((await get('/api/navdata/features?bbox=1,2,3,4&zoom=5&kinds=bogus')).status).toBe(400);
  });
});

describe('airport tiering', () => {
  afterEach(() => setAirportTiers([]));

  const runway = (ident: string, lat: number, lon: number, lengthM: number): Row => ({
    rwy_key: `${ident}|len${lengthM}`, airport_ident: ident, lat, lon, length_m: lengthM, rev: 1,
  });

  it("prefers the sim's own runway length over the OurAirports label, and reports 'unknown' for an ident neither source knows", async () => {
    // RJBE is labelled large_airport upstream but its longest fetched runway
    // (2487 m) is a medium by the sim thresholds — the sim wins.
    setAirportTiers([['ZZLRG', 1], ['RJBE', 1]]);
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZLRG', 10, 20));
      insert(db, 'nav_airport', ap('RJBE', 10, 21, { detail_state: 'detail' }));
      insert(db, 'nav_runway', runway('RJBE', 10, 21, 2487));
      insert(db, 'nav_airport', ap('ZZUNK', 10, 22));
    });
    const body = await features('bbox=19,9,23,11&zoom=9'); // full reveal: no filter runs
    const tierByIdent = Object.fromEntries(body.airports.map((a: any) => [a.ident, a.tier]));
    expect(tierByIdent).toEqual({ ZZLRG: 'large', RJBE: 'medium', ZZUNK: 'unknown' });
    expect(body.airportThinning).toEqual({ mode: 'none', through: null, hidden: 0, byTier: null, nextZoom: null });
  });

  it('gates an unmatched ident to the full-reveal zoom, never hiding it past that zoom and never promoting it early', async () => {
    setAirportTiers([['ZZLRG', 1]]);
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZLRG', 10, 20));
      insert(db, 'nav_airport', ap('ZZUNK', 10, 20.01));
    });
    const thin = await features('bbox=19,9,21,11&zoom=6');
    expect(thin.airports.map((a: any) => a.ident)).toEqual(['ZZLRG']);
    expect(thin.airportThinning).toMatchObject({ mode: 'tier', hidden: 1, nextZoom: 9 });
    expect(thin.airportThinning.byTier).toEqual({ large: 1, medium: 0, small: 0, unknown: 1, other: 0 });

    const full = await features('bbox=19,9,21,11&zoom=9');
    expect(full.airports.map((a: any) => a.ident).sort()).toEqual(['ZZLRG', 'ZZUNK']);
    expect(full.airportThinning).toEqual({ mode: 'none', through: null, hidden: 0, byTier: null, nextZoom: null });
  });

  it('filters and histograms by the sim tier, not the label, when a viewport is dense enough that the budget cannot lift the floor', async () => {
    const fillerCount = AIRPORT_VIEWPORT_BUDGET + 1;
    const fillerIdent = (i: number): string => `ZZ${String(i).padStart(4, '0')}`;
    setAirportTiers([
      ...Array.from({ length: fillerCount }, (_, i) => [fillerIdent(i), 1] as const),
      ['RJBE', 1], // labelled large upstream; the sim will say medium
    ]);
    buildReplica(db => {
      const insertAirport = db.prepare(
        "INSERT INTO nav_airport (ident, lat, lon, name, detail_state, rev) VALUES (?, 10, ?, ?, 'index', 1)",
      );
      const insertMany = db.transaction((n: number) => {
        for (let i = 0; i < n; i++) insertAirport.run(fillerIdent(i), 20 + i * 0.0001, `Field ${i}`);
      });
      insertMany(fillerCount);
      insert(db, 'nav_airport', ap('RJBE', 10, 20.5, { detail_state: 'detail' }));
      insert(db, 'nav_runway', runway('RJBE', 10, 20.5, 2487));
    });
    const body = await features('bbox=19,9,21,11&zoom=6'); // floor = large; the large bucket alone exceeds the budget
    expect(body.airportThinning).toMatchObject({ mode: 'tier', through: 'large', hidden: 1, nextZoom: 7 });
    expect(body.airportThinning.byTier).toEqual({ large: fillerCount, medium: 1, small: 0, unknown: 0, other: 0 });
    expect(body.airports).toHaveLength(fillerCount);
    expect(body.airports.some((a: any) => a.ident === 'RJBE')).toBe(false);
  });

  it("keeps the SQL filter's result identical to a JS post-filter over the unlimited population, for a viewport well under any limit", async () => {
    setAirportTiers([['ZZL1', 1], ['ZZL2', 1], ['ZZM1', 2], ['ZZM2', 2]]);
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZL1', 10, 20));
      insert(db, 'nav_airport', ap('ZZL2', 10, 20.01));
      insert(db, 'nav_airport', ap('ZZM1', 10, 20.02));
      insert(db, 'nav_airport', ap('ZZM2', 10, 20.03));
      insert(db, 'nav_airport', ap('ZZQ1', 10, 20.04)); // unmatched -> 'unknown', excluded at zoom 7
      insert(db, 'nav_airport', ap('ZZQ2', 10, 20.05));
    });
    const body = await features('bbox=19,9,21,11&zoom=7&limit=2000');
    expect(body.truncated).toBe(false);
    // Nothing here reaches the budget, so the floor (medium) lifts all the way
    // to small; only the two unmatched idents are excluded.
    const sqlFiltered = body.airports.map((a: any) => a.ident).sort();
    const expected = ['ZZL1', 'ZZL2', 'ZZM1', 'ZZM2'].sort();
    expect(sqlFiltered).toEqual(expected);
    expect(body.airportThinning).toMatchObject({ mode: 'tier', through: 'small', hidden: 2 });
  });

  it('runs unfiltered with tier: null when no classification file is loaded, and still classifies a detail-fetched airport from the sim', async () => {
    // setAirportTiers([]) in the outer afterEach already left the map empty;
    // no call here at all is the point of this test.
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZIDX', 10, 20));
      insert(db, 'nav_airport', ap('ZZDET', 10, 20.01, { detail_state: 'detail' }));
      insert(db, 'nav_runway', runway('ZZDET', 10, 20.01, 3000));
    });
    const body = await features('bbox=19,9,21,11&zoom=6');
    const tierByIdent = Object.fromEntries(body.airports.map((a: any) => [a.ident, a.tier]));
    expect(tierByIdent).toEqual({ ZZIDX: null, ZZDET: 'large' });
    expect(body.airportThinning).toEqual({ mode: 'none', through: null, hidden: 0, byTier: null, nextZoom: null });
  });

  it('reproduces the frozen tier decision for a measured sample viewport (Bogotá, zoom 6)', () => {
    // cum L/M/S/unk/other = 54/260/976/1903/1946 -> per-tier counts:
    const byTierCounts = { 1: 54, 2: 260 - 54, 3: 976 - 260, 4: 1903 - 976, 5: 1946 - 1903 };
    expect(airportTierFloor(6)).toBe(1);
    expect(chooseAirportTier(byTierCounts, 6)).toBe(2); // 'medium' — matches the frozen table's "shown through medium"
  });
});

describe('GET /status', () => {
  it('is present:false with sidecar reported when there is no replica', async () => {
    state.report({ v: 1, state: 'nav.off', reason: 'disabled', snapshotId: null, rev: null, sentAt: 1 });
    const body = (await (await get('/api/navdata/status')).json()) as any;
    expect(body).toMatchObject({ present: false, counts: null, snapshotId: null, sidecar: { state: 'nav.off', reason: 'disabled' } });
  });

  it('counts tables and reports the shared sidecar store; sidecar is null when never reported', async () => {
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZA1', 10, 20, { detail_state: 'detail' }));
      insert(db, 'nav_airport', ap('ZZA2', 11, 21));
    });
    let body = (await (await get('/api/navdata/status')).json()) as any;
    expect(body).toMatchObject({
      present: true, schemaVersion: 2, snapshotId: 'epoch-1', rev: 7, simId: '2024', sidecar: null, lastRowsAt: null,
      counts: { airports: 2, airportsWithDetail: 1, navaids: 0, absent: 0 },
    });
    state.markRowsApplied(1234);
    state.report({ v: 1, state: 'nav.ready', reason: null, snapshotId: 'epoch-1', rev: 7, sentAt: 1 });
    body = (await (await get('/api/navdata/status')).json()) as any;
    expect(body.lastRowsAt).toBe(1234);
    expect(body.sidecar).toEqual({ state: 'nav.ready', reason: null });
  });
});

describe('GET /airports/:ident', () => {
  it('404s an unknown ident or a missing replica, and details a known one', async () => {
    expect((await get('/api/navdata/airports/ZZA1')).status).toBe(404);
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZA1', 10, 20, { detail_state: 'detail', detail_fetched_at: 9, alt_m: 5 }));
      insert(db, 'nav_runway', {
        rwy_key: 'ZZA1|9|1', airport_ident: 'ZZA1', lat: 10, lon: 20, primary_number: 9, primary_designator: 1, rev: 1,
      });
      insert(db, 'nav_airport_frequency', { freq_key: 'ZZA1|1|118000000', airport_ident: 'ZZA1', freq_type: 1, frequency_hz: 118000000, name: 'TWR', rev: 1 });
      insert(db, 'nav_procedure', { proc_key: 'P1', airport_ident: 'ZZA1', kind: 'SID', name: 'ZZSID1', runway_number: 9, runway_designator: 1, rev: 1 });
      insert(db, 'nav_procedure_transition', { trans_key: 'P1|common|', proc_key: 'P1', role: 'common', name: '', n_legs: null, rev: 1 });
      insert(db, 'nav_procedure_leg', { trans_key: 'P1|common|', seq: 0, leg_type: 4, rev: 1 });
    });
    expect((await get('/api/navdata/airports/ZZNO')).status).toBe(404);
    const body = (await (await get('/api/navdata/airports/zza1')).json()) as any;
    expect(body).toMatchObject({ ident: 'ZZA1', detailState: 'detail', detailFetchedAt: 9, altM: 5 });
    expect(body.runways[0].designation).toBe('09L');
    expect(body.frequencies).toEqual([{ type: 1, frequencyHz: 118000000, name: 'TWR' }]);
    expect(body.procedures).toEqual([{
      key: 'P1', kind: 'SID', name: 'ZZSID1', runway: '09L',
      transitions: [{ key: 'P1|common|', role: 'common', name: '', legs: 1 }],
    }]);
  });
});

describe('POST /request', () => {
  it('queues, is idempotent, and reports already-present and known-absent', async () => {
    buildReplica(db => {
      insert(db, 'nav_airport', ap('ZZHELD', 10, 20, { detail_state: 'detail' }));
      insert(db, 'nav_airport', ap('ZZIDX', 10, 20));
      insert(db, 'nav_waypoint', { wpt_key: 'k', ident: 'ZZWPT', region: 'ZZ', lat: 1, lon: 1, rev: 1 });
      insert(db, 'nav_absent', { kind: 'A', ident: 'ZZGONE', region: '', reason: 'silent', first_seen_at: 1, last_checked_at: 1, rev: 1 });
    });
    const call = async (body: unknown) => (await (await post(body)).json()) as any;

    expect(await call({ kind: 'A', ident: 'zzidx' })).toEqual({ ok: true, state: 'queued', ident: 'ZZIDX' });
    expect(await call({ kind: 'A', ident: 'ZZIDX' })).toEqual({ ok: true, state: 'queued', ident: 'ZZIDX' });
    expect(listNavdataRequests().filter(r => r.ident === 'ZZIDX')).toHaveLength(1);

    expect((await call({ kind: 'A', ident: 'ZZHELD' })).state).toBe('already-present');
    expect((await call({ kind: 'W', ident: 'ZZWPT', region: 'zz' })).state).toBe('already-present');
    expect((await call({ kind: 'W', ident: 'ZZWPT', region: 'QQ' })).state).toBe('queued');
    expect((await call({ kind: 'A', ident: 'ZZGONE' })).state).toBe('known-absent');
    expect(listNavdataRequests().some(r => r.ident === 'ZZHELD' || r.ident === 'ZZGONE')).toBe(false);

    expect((await call({ kind: 'A', ident: 'ZZGONE', force: true })).state).toBe('queued');
    expect(listNavdataRequests().some(r => r.ident === 'ZZGONE')).toBe(true);
  });

  it('queues with no replica and validates the body', async () => {
    expect((await (await post({ kind: 'A', ident: 'ZZA1' })).json())).toEqual({ ok: true, state: 'queued', ident: 'ZZA1' });
    for (const bad of [{ kind: 'X', ident: 'ZZA1' }, { kind: 'A', ident: 'bad ident' }, { kind: 'A', ident: '' },
      { kind: 'W', ident: 'ZZA1', region: 'TOOLONG' }, { ident: 'ZZA1' }, 'nope']) {
      expect((await post(bad)).status).toBe(400);
    }
  });

  it('is rejected cross-origin by requireSameOrigin', async () => {
    const res = await post({ kind: 'A', ident: 'ZZA1' }, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(listNavdataRequests()).toHaveLength(0);
  });
});

describe('an airport the simulator does not have, sent with no coordinates', () => {
  const ABSENT_ROWS = [
    { t: 'airport', r: { ident: 'ZZAB', detail_state: 'absent', rev: 2 } },
    { t: 'absent', r: { kind: 'A', ident: 'ZZAB', region: '', reason: 'silent', first_seen_at: 1, last_checked_at: 1, rev: 2 } },
  ] as const;

  const seed = () => buildReplica(db => {
    insert(db, 'nav_airport', ap('ZZHELD', 10, 20, { detail_state: 'detail' }));
    applyNavRows(db, ABSENT_ROWS as any);
  });

  it('stays out of a wide features query without breaking it', async () => {
    seed();
    const res = await get('/api/navdata/features?bbox=-179,-89,179,89&zoom=6');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.airports.map((a: any) => a.ident)).toEqual(['ZZHELD']);
  });

  it('answers the airport detail with null coordinates and detailState absent', async () => {
    seed();
    const res = await get('/api/navdata/airports/zzab');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ident: 'ZZAB', lat: null, lon: null, detailState: 'absent', runways: [], procedures: [] });
  });

  it('is answered known-absent to a manual request when both the airport row and a nav_absent row exist, and nothing is queued', async () => {
    seed();
    expect(await (await post({ kind: 'A', ident: 'ZZAB' })).json()).toMatchObject({ ok: true, state: 'known-absent' });
    expect(listNavdataRequests().some(r => r.ident === 'ZZAB')).toBe(false);
  });

  it('is reported known-absent from the airport row alone, before its absent row arrives', async () => {
    buildReplica(db => { applyNavRows(db, [ABSENT_ROWS[0]] as any); });
    expect(await (await post({ kind: 'A', ident: 'ZZAB' })).json()).toMatchObject({ state: 'known-absent' });
    expect(listNavdataRequests().some(r => r.ident === 'ZZAB')).toBe(false);
  });
});
