// A real scratch flights.db and a real scratch replica, never the live files.
// Synthetic idents and coordinates only.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { applyNavdataSchema } from '../src/navdata/schema';
import { applyIncrementalBatch, applyNavRows } from '../src/navdata/store';
import {
  closeNavDb,
  getNavDb,
  incomingNavdataPath,
  openNavdata,
  resolveNavdataPath,
  swapInReplica,
} from '../src/navdata/connection';
import {
  buildDemand, DemandSkipError, GAP_PASS_BUDGET_MS, resetGapCursor, NAVDATA_DEMAND_CAP, NAVDATA_DEMAND_LEG_SCAN, NAVDATA_DEMAND_SKIP_MAX, parseDemandSkip,
} from '../src/navdata/demand';
import { listNavdataRequests, upsertNavdataRequest } from '../src/db/navdataRequests';
import { wptKey } from '../src/navdata/keys';
import { AIRWAY_MAX_HOPS, AIRWAY_MAX_VISITED, AIRWAY_NEIGHBOURS_SQL, walkAirway, type AirwayWalk } from '../src/navdata/routeGeometry';
import { NAVDATA_SCHEMA_VERSION, NAVDATA_WIRE_VERSION, type NavRow, type NavRowType } from '../src/navdata/wire';
import { createScratchDb, destroyScratchDb, seedPlannedLeg, seedTrip, type ScratchDb } from './helpers/db';

let scratch: ScratchDb;
const savedEnv = process.env.NAVDATA_DB_PATH;
const NOW = new Date('2026-02-01T09:00:00.000Z');

type Row = Record<string, string | number | null>;
const row = (t: NavRowType, r: Row): NavRow => ({ t, r: { rev: 1, ...r } });

const airport = (ident: string, detailState = 'detail'): NavRow =>
  row('airport', { ident, lat: 10, lon: 20, detail_state: detailState });
const waypoint = (ident: string, region = 'ZZ', routesState = 'fetched'): NavRow =>
  row('waypoint', { wpt_key: wptKey(ident, region, 11, 21), ident, region, lat: 11, lon: 21, routes_state: routesState });
const minimalCandidate = (ident: string, region: string, lat: number): NavRow =>
  row('waypoint', {
    wpt_key: wptKey(ident, region, lat, 21), ident, region, lat, lon: 21,
    position_source: 'minimal', routes_state: 'unknown', airport_ident: 'ZZAA',
  });
const navaid = (ident: string, region = 'ZZ', kind = 'V', detailState = 'detail'): NavRow =>
  row('navaid', { kind, ident, region, lat: 12, lon: 22, position_source: 'list', detail_state: detailState });
const absent = (kind: 'A' | 'W' | 'V' | 'N', ident: string, region = ''): NavRow =>
  row('absent', { kind, ident, region, reason: 'silent', first_seen_at: 1_000, last_checked_at: 1_000 });

/** Builds a replica file from scratch and leaves it open as the live one. */
function setReplica(rows: NavRow[], snapshotId = 'epoch-1'): void {
  closeNavDb();
  const file = resolveNavdataPath();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  writeReplica(file, rows, snapshotId);
  openNavdata();
}

function writeReplica(file: string, rows: NavRow[], snapshotId: string): void {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applyNavdataSchema(db);
  db.prepare(
    'INSERT INTO nav_meta (id, schema_version, snapshot_id, sim_id, created_at, updated_at)' +
      " VALUES (1, 2, ?, '2024', 1, 1) ON CONFLICT (id) DO UPDATE SET snapshot_id = excluded.snapshot_id",
  ).run(snapshotId);
  if (rows.length > 0) applyNavRows(db, rows);
  db.close();
}

interface SeedWaypoint {
  ident: string;
  type: string;
  region?: string | null;
}

function seedWaypoints(legId: number, list: SeedWaypoint[]): void {
  const stmt = scratch.db.prepare(
    'INSERT INTO planned_waypoints (planned_leg_id, seq, ident, region, type, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  list.forEach((w, i) => stmt.run(legId, i + 1, w.ident, w.region ?? null, w.type, 11 + i * 0.1, 21 + i * 0.1));
}

function seedAlternates(legId: number, idents: string[]): void {
  const stmt = scratch.db.prepare(
    'INSERT INTO planned_alternates (planned_leg_id, seq, ident, type) VALUES (?, ?, ?, ?)',
  );
  idents.forEach((ident, i) => stmt.run(legId, i + 1, ident, 'AIRPORT'));
}

/** A leg from ZZAA to ZZAB, on no trip and already flown unless told otherwise. */
function seedLeg(over: Partial<Parameters<typeof seedPlannedLeg>[1]> = {}): number {
  return seedPlannedLeg(scratch.db, {
    trip_id: null,
    status: 'flown',
    departure_ident: 'ZZAA',
    departure_lat: 10,
    departure_lon: 20,
    departure_is_airport: 1,
    destination_ident: 'ZZAB',
    destination_lat: 11,
    destination_lon: 21,
    destination_is_airport: 1,
    ...over,
  });
}

beforeEach(() => {
  resetGapCursor();
  scratch = createScratchDb();
  process.env.NAVDATA_DB_PATH = path.join(scratch.dir, 'navdata.db');
  openNavdata();
});

afterEach(() => {
  closeNavDb();
  destroyScratchDb(scratch);
  if (savedEnv === undefined) delete process.env.NAVDATA_DB_PATH;
  else process.env.NAVDATA_DB_PATH = savedEnv;
});

describe('demand from planned legs', () => {
  it('wants only what the replica does not already answer', () => {
    const trip = seedTrip(scratch.db, { is_active: 1 });
    const leg = seedLeg({ trip_id: trip, departure_is_airport: 0, destination_is_airport: 0 });
    seedWaypoints(leg, [
      { ident: 'TESTA', type: 'WAYPOINT' },
      { ident: 'NOTHR', type: 'WAYPOINT' },
      { ident: 'NEVER', type: 'WAYPOINT' },
    ]);
    setReplica([waypoint('TESTA'), absent('W', 'NOTHR')]);

    const demand = buildDemand(NOW);

    expect(demand.waypoints).toEqual([{ ident: 'NEVER', kind: 'W' }]);
    expect(demand).toMatchObject({ v: 1, airports: [], cap: NAVDATA_DEMAND_CAP, more: false, generatedAt: NOW.getTime() });
  });

  it('never demands a USER waypoint', () => {
    const trip = seedTrip(scratch.db, { is_active: 1 });
    const leg = seedLeg({ trip_id: trip, departure_is_airport: 0, destination_is_airport: 0 });
    seedWaypoints(leg, [
      { ident: 'ZZUSR', type: 'USER' },
      { ident: 'ZZVOR', type: 'VOR' },
      { ident: 'ZZNDB', type: 'NDB' },
      { ident: 'ZZAPT', type: 'AIRPORT' },
      { ident: 'ZZUNK', type: 'UNKNOWN' },
    ]);
    setReplica([]);

    const demand = buildDemand(NOW);

    expect(demand.waypoints.map(w => w.ident)).toEqual(['ZZVOR', 'ZZNDB']);
    expect(demand.airports).toEqual(['ZZAPT']);
  });

  it('still wants an airport the replica only holds an index row for', () => {
    const trip = seedTrip(scratch.db, { is_active: 1 });
    seedLeg({ trip_id: trip });
    seedAlternates(seedLeg({ trip_id: trip, seq: 2, departure_ident: 'ZZAC', destination_ident: 'ZZAD' }), ['ZZALT']);
    setReplica([airport('ZZAA', 'index'), airport('ZZAB', 'detail'), absent('A', 'ZZAC')]);

    expect(buildDemand(NOW).airports).toEqual(['ZZAA', 'ZZAD', 'ZZALT']);
  });

  it('matches a waypoint on region only when the plan names one', () => {
    const trip = seedTrip(scratch.db, { is_active: 1 });
    const leg = seedLeg({ trip_id: trip, departure_is_airport: 0, destination_is_airport: 0 });
    seedWaypoints(leg, [
      { ident: 'ZZFIX', type: 'WAYPOINT', region: 'YY' },
      { ident: 'ZZNAV', type: 'VOR', region: null },
      { ident: 'ZZGON', type: 'WAYPOINT', region: 'ZZ' },
    ]);
    setReplica([waypoint('ZZFIX', 'ZZ'), navaid('ZZNAV', 'ZZ'), absent('W', 'ZZGON', 'ZZ')]);

    // ZZFIX is held for another region, so it is still wanted; ZZNAV names no
    // region, so the navaid answers it; ZZGON is recorded missing.
    expect(buildDemand(NOW).waypoints).toEqual([{ ident: 'ZZFIX', region: 'YY', kind: 'W' }]);
  });

  it('is not satisfied by position-only candidates, only by fetched or absent rows', () => {
    const trip = seedTrip(scratch.db, { is_active: 1 });
    const leg = seedLeg({ trip_id: trip, departure_is_airport: 0, destination_is_airport: 0 });
    seedWaypoints(leg, [
      { ident: 'ZZMIN', type: 'WAYPOINT' },
      { ident: 'ZZMIR', type: 'WAYPOINT', region: 'ZZ' },
      { ident: 'ZZFET', type: 'WAYPOINT' },
      { ident: 'ZZFER', type: 'WAYPOINT', region: 'ZZ' },
      { ident: 'ZZABS', type: 'WAYPOINT' },
      { ident: 'ZZABR', type: 'WAYPOINT', region: 'ZZ' },
      { ident: 'ZZNAB', type: 'WAYPOINT' },
      { ident: 'ZZPEN', type: 'WAYPOINT' },
      { ident: 'ZZFAI', type: 'WAYPOINT', region: 'ZZ' },
    ]);
    setReplica([
      minimalCandidate('ZZMIN', 'ZZ', 11), minimalCandidate('ZZMIN', 'YY', 12),
      minimalCandidate('ZZMIR', 'ZZ', 11), minimalCandidate('ZZMIR', 'YY', 12),
      waypoint('ZZFET', 'YY'), waypoint('ZZFER', 'ZZ'),
      waypoint('ZZABS', 'ZZ', 'absent'), waypoint('ZZABR', 'ZZ', 'absent'),
      absent('W', 'ZZNAB'),
      waypoint('ZZPEN', 'ZZ', 'pending'), waypoint('ZZFAI', 'ZZ', 'failed'),
    ]);

    expect(buildDemand(NOW).waypoints).toEqual([
      { ident: 'ZZMIN', kind: 'W' }, { ident: 'ZZMIR', region: 'ZZ', kind: 'W' }, { ident: 'ZZPEN', kind: 'W' },
      { ident: 'ZZFAI', region: 'ZZ', kind: 'W' },
    ]);
  });

  it('emits the kind of each planned waypoint type', () => {
    const trip = seedTrip(scratch.db, { is_active: 1 });
    const leg = seedLeg({ trip_id: trip, departure_is_airport: 0, destination_is_airport: 0 });
    seedWaypoints(leg, [
      { ident: 'ZZFIX', type: 'WAYPOINT' },
      { ident: 'ZZVOR', type: 'VOR', region: 'ZZ' },
      { ident: 'ZZNDB', type: 'NDB' },
    ]);
    setReplica([]);

    expect(buildDemand(NOW).waypoints).toEqual([
      { ident: 'ZZFIX', kind: 'W' }, { ident: 'ZZVOR', region: 'ZZ', kind: 'V' }, { ident: 'ZZNDB', kind: 'N' },
    ]);
  });

  it('satisfies a VOR or NDB want only by a detailed navaid of that kind or a nav_absent row of that kind', () => {
    const trip = seedTrip(scratch.db, { is_active: 1 });
    const leg = seedLeg({ trip_id: trip, departure_is_airport: 0, destination_is_airport: 0 });
    seedWaypoints(leg, [
      { ident: 'ZZV01', type: 'VOR' },                    // a fix row does not answer it
      { ident: 'ZZV02', type: 'VOR' },                    // detailed navaid, any region
      { ident: 'ZZV03', type: 'VOR', region: 'ZZ' },      // detailed navaid, named region
      { ident: 'ZZV04', type: 'VOR', region: 'YY' },      // detailed navaid in another region
      { ident: 'ZZV05', type: 'VOR' },                    // nav_absent V
      { ident: 'ZZV06', type: 'VOR', region: 'ZZ' },      // nav_absent V, named region
      { ident: 'ZZV07', type: 'VOR' },                    // index-only navaid
      { ident: 'ZZV08', type: 'VOR' },                    // pending navaid
      { ident: 'ZZV09', type: 'VOR' },                    // failed navaid
      { ident: 'ZZV10', type: 'VOR' },                    // navaid of the other kind
      { ident: 'ZZN01', type: 'NDB' },                    // detailed NDB
      { ident: 'ZZN02', type: 'NDB' },                    // nav_absent N
      { ident: 'ZZN03', type: 'NDB' },                    // nav_absent V does not answer an NDB
      { ident: 'ZZN04', type: 'NDB' },                    // absent-state navaid
      { ident: 'ZZV11', type: 'VOR', region: 'ZZ' },      // index-only navaid, named region
      { ident: 'ZZF01', type: 'WAYPOINT' },               // a detailed navaid does not answer a fix
    ]);
    setReplica([
      waypoint('ZZV01', 'ZZ'),
      navaid('ZZV02'), navaid('ZZV03', 'ZZ'), navaid('ZZV04', 'ZZ'),
      absent('V', 'ZZV05'), absent('V', 'ZZV06', 'ZZ'),
      navaid('ZZV07', 'ZZ', 'V', 'index'), navaid('ZZV08', 'ZZ', 'V', 'pending'), navaid('ZZV09', 'ZZ', 'V', 'failed'),
      navaid('ZZV10', 'ZZ', 'N'),
      navaid('ZZN01', 'ZZ', 'N'), absent('N', 'ZZN02'), absent('V', 'ZZN03'),
      navaid('ZZN04', 'ZZ', 'N', 'absent'),
      navaid('ZZV11', 'ZZ', 'V', 'index'), navaid('ZZF01'),
    ]);

    expect(buildDemand(NOW).waypoints).toEqual([
      { ident: 'ZZF01', kind: 'W' },
      { ident: 'ZZV01', kind: 'V' }, { ident: 'ZZV04', region: 'YY', kind: 'V' },
      { ident: 'ZZV07', kind: 'V' }, { ident: 'ZZV08', kind: 'V' }, { ident: 'ZZV09', kind: 'V' },
      { ident: 'ZZV10', kind: 'V' }, { ident: 'ZZN03', kind: 'N' },
      { ident: 'ZZV11', region: 'ZZ', kind: 'V' },
    ]);
  });

  it('keeps a VOR and a fix that share an ident as two entries, and a skip removes both', () => {
    const trip = seedTrip(scratch.db, { is_active: 1 });
    const leg = seedLeg({ trip_id: trip, departure_is_airport: 0, destination_is_airport: 0 });
    seedWaypoints(leg, [
      { ident: 'ZZSAM', type: 'WAYPOINT' },
      { ident: 'ZZSAM', type: 'VOR' },
      { ident: 'ZZSAM', type: 'VOR' },
      { ident: 'ZZOTH', type: 'VOR' },
    ]);
    setReplica([]);

    expect(buildDemand(NOW).waypoints).toEqual([
      { ident: 'ZZSAM', kind: 'W' }, { ident: 'ZZSAM', kind: 'V' }, { ident: 'ZZOTH', kind: 'V' },
    ]);
    const skip = { airports: new Set<string>(), waypoints: new Set(['ZZSAM']) };
    expect(buildDemand(NOW, skip).waypoints).toEqual([{ ident: 'ZZOTH', kind: 'V' }]);
  });

  it('lists every fix ahead of any VOR or NDB before the cap, so navaids never starve fixes', () => {
    const trip = seedTrip(scratch.db, { is_active: 1 });
    const leg = seedLeg({ trip_id: trip, departure_is_airport: 0, destination_is_airport: 0 });
    const navs = Array.from({ length: NAVDATA_DEMAND_CAP + 2 }, (_, i) => ({
      ident: `ZZN${String(i).padStart(2, '0')}`, type: i % 2 ? 'NDB' : 'VOR',
    }));
    seedWaypoints(leg, [...navs, { ident: 'ZZFA', type: 'WAYPOINT' }, { ident: 'ZZFB', type: 'WAYPOINT' }, { ident: 'ZZFC', type: 'WAYPOINT' }]);
    setReplica([]);

    const demand = buildDemand(NOW);

    expect(demand.waypoints).toHaveLength(NAVDATA_DEMAND_CAP);
    expect(demand.waypoints.slice(0, 3).map(w => w.ident)).toEqual(['ZZFA', 'ZZFB', 'ZZFC']);
    expect(demand.waypoints[3]).toEqual({ ident: 'ZZN00', kind: 'V' });
    expect(demand.waypoints[NAVDATA_DEMAND_CAP - 1].ident).toBe(`ZZN${String(NAVDATA_DEMAND_CAP - 4).padStart(2, '0')}`);
    expect(demand.more).toBe(true);
  });

  it('keeps manual-then-plan order within the fix group and within the navaid group', () => {
    const trip = seedTrip(scratch.db, { is_active: 1 });
    const leg = seedLeg({ trip_id: trip, departure_is_airport: 0, destination_is_airport: 0 });
    seedWaypoints(leg, [
      { ident: 'ZZPV1', type: 'VOR' }, { ident: 'ZZPF1', type: 'WAYPOINT' },
      { ident: 'ZZPV2', type: 'NDB' }, { ident: 'ZZPF2', type: 'WAYPOINT' },
    ]);
    setReplica([]);
    upsertNavdataRequest('W', 'ZZMF1', null, NOW);
    upsertNavdataRequest('W', 'ZZMF2', null, NOW);

    const idents = buildDemand(NOW).waypoints.map(w => w.ident);
    expect(idents.slice(0, 2).sort()).toEqual(['ZZMF1', 'ZZMF2']);
    expect(idents.slice(2)).toEqual(['ZZPF1', 'ZZPF2', 'ZZPV1', 'ZZPV2']);
  });

  it('gives every entry a kind of exactly W, V or N', () => {
    const trip = seedTrip(scratch.db, { is_active: 1 });
    const leg = seedLeg({ trip_id: trip, departure_is_airport: 0, destination_is_airport: 0 });
    seedWaypoints(leg, [
      { ident: 'ZZFIX', type: 'waypoint' }, { ident: 'ZZVOR', type: ' vor ', region: 'zz' }, { ident: 'ZZNDB', type: 'NDB', region: '  ' },
    ]);
    setReplica([]);
    upsertNavdataRequest('W', 'zzman', 'yy', NOW);

    const { waypoints } = buildDemand(NOW);
    expect(waypoints).toHaveLength(4);
    for (const w of waypoints) expect(['W', 'V', 'N']).toContain(w.kind);
    expect(waypoints.map(w => w.kind)).toEqual(['W', 'W', 'V', 'N']);
  });

  it('wants everything when there is no replica at all', () => {
    const trip = seedTrip(scratch.db, { is_active: 1 });
    const leg = seedLeg({ trip_id: trip });
    seedWaypoints(leg, [{ ident: 'ZZFIX', type: 'WAYPOINT' }]);

    expect(buildDemand(NOW)).toMatchObject({ airports: ['ZZAA', 'ZZAB'], waypoints: [{ ident: 'ZZFIX', kind: 'W' }] });
  });

  it('scans the active trip whatever the leg status, then legs still planned', () => {
    const active = seedTrip(scratch.db, { is_active: 1 });
    const other = seedTrip(scratch.db, { is_active: 0 });
    seedLeg({ trip_id: active, seq: 2, status: 'flown', departure_ident: 'ZZA2', destination_ident: 'ZZB2' });
    seedLeg({ trip_id: active, seq: 1, status: 'diverted', departure_ident: 'ZZA1', destination_ident: 'ZZB1' });
    seedLeg({ trip_id: other, status: 'flown', departure_ident: 'ZZOLD', destination_ident: 'ZZOLE' });
    seedLeg({ trip_id: other, seq: 2, status: 'planned', departure_ident: 'ZZNEW', destination_ident: 'ZZNEX' });
    setReplica([]);

    // Active trip first, in seq order; the flown leg of the other trip is not drawn.
    expect(buildDemand(NOW).airports).toEqual(['ZZA1', 'ZZB1', 'ZZA2', 'ZZB2', 'ZZNEW', 'ZZNEX']);
  });

  it('caps the response and says so', () => {
    const trip = seedTrip(scratch.db, { is_active: 1 });
    const leg = seedLeg({ trip_id: trip, departure_is_airport: 0, destination_is_airport: 0 });
    seedWaypoints(leg, Array.from({ length: 60 }, (_, i) => ({
      ident: `ZZW${String(i).padStart(2, '0')}`,
      type: 'WAYPOINT',
    })));
    setReplica([]);

    const demand = buildDemand(NOW);

    expect(demand.waypoints).toHaveLength(NAVDATA_DEMAND_CAP);
    expect(demand.waypoints[0]).toEqual({ ident: 'ZZW00', kind: 'W' });
    expect(demand.more).toBe(true);
    expect(demand.cap).toBe(50);
  });

  it('looks no further than the leg budget', () => {
    const trip = seedTrip(scratch.db, { is_active: 1 });
    const dep = (i: number) => `ZZ${String(i).padStart(3, '0')}`;
    const dest = (i: number) => `ZY${String(i).padStart(3, '0')}`;
    const held: NavRow[] = [];
    for (let i = 0; i < NAVDATA_DEMAND_LEG_SCAN + 5; i += 1) {
      seedLeg({ trip_id: trip, seq: i + 1, departure_ident: dep(i), destination_ident: dest(i) });
      if (i < NAVDATA_DEMAND_LEG_SCAN) held.push(airport(dep(i)), airport(dest(i)));
    }
    setReplica(held);

    // Every leg inside the budget is answered, and the five past it are never
    // reached — the scan is a bound on cost, not a truncated answer.
    expect(buildDemand(NOW)).toMatchObject({ airports: [], waypoints: [], more: false });

    // The same run finds a gap inside the budget, so the budget really is 200 legs deep.
    setReplica(held.filter(r => r.r.ident !== dest(NAVDATA_DEMAND_LEG_SCAN - 1)));
    expect(buildDemand(NOW).airports).toEqual([dest(NAVDATA_DEMAND_LEG_SCAN - 1)]);
  });

  it('de-duplicates an ident two legs share', () => {
    const trip = seedTrip(scratch.db, { is_active: 1 });
    seedLeg({ trip_id: trip, seq: 1 });
    seedLeg({ trip_id: trip, seq: 2, departure_ident: 'ZZAB', destination_ident: 'ZZAA' });
    setReplica([]);

    expect(buildDemand(NOW).airports).toEqual(['ZZAA', 'ZZAB']);
  });
});

describe('manual requests', () => {
  it('leads the response and survives a replica swap', () => {
    const trip = seedTrip(scratch.db, { is_active: 1 });
    seedLeg({ trip_id: trip });
    upsertNavdataRequest('A', 'ZZREQ', null, NOW);
    setReplica([]);

    expect(buildDemand(NOW).airports).toEqual(['ZZREQ', 'ZZAA', 'ZZAB']);

    const incoming = incomingNavdataPath();
    writeReplica(incoming, [airport('ZZAA')], 'epoch-2');
    swapInReplica(incoming);

    // The request lives in flights.db, so a new epoch cannot lose it.
    expect(buildDemand(NOW).airports).toEqual(['ZZREQ', 'ZZAB']);
    expect(listNavdataRequests(NOW)).toHaveLength(1);
  });

  it('is deleted on the first poll the replica can answer it', () => {
    upsertNavdataRequest('A', 'ZZREQ', null, NOW);
    upsertNavdataRequest('W', 'zzfix', 'zz', NOW);
    setReplica([airport('ZZREQ', 'detail'), waypoint('ZZFIX', 'ZZ')]);

    const demand = buildDemand(NOW);

    expect(demand).toMatchObject({ airports: [], waypoints: [], more: false });
    expect(listNavdataRequests(NOW)).toHaveLength(0);
  });

  it('keeps a request the replica only holds an index row for', () => {
    upsertNavdataRequest('A', 'ZZREQ', null, NOW);
    setReplica([airport('ZZREQ', 'index')]);

    expect(buildDemand(NOW).airports).toEqual(['ZZREQ']);
    expect(listNavdataRequests(NOW)).toHaveLength(1);
  });

  it('prunes an expired request rather than emitting it', () => {
    upsertNavdataRequest('A', 'ZZOLD', null, new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000));
    upsertNavdataRequest('W', 'ZZNEW', null, NOW);
    setReplica([]);

    const demand = buildDemand(NOW);

    expect(demand.airports).toEqual([]);
    expect(demand.waypoints).toEqual([{ ident: 'ZZNEW', kind: 'W' }]);
    expect(listNavdataRequests(NOW).map(r => r.ident)).toEqual(['ZZNEW']);
  });
});

describe('skipping idents the sidecar has parked', () => {
  const skip = (airports: string[] = [], waypoints: string[] = []) => ({
    airports: new Set(airports),
    waypoints: new Set(waypoints),
  });

  function seedAirportLegs(count: number): string[] {
    const trip = seedTrip(scratch.db, { is_active: 1 });
    const idents: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const dep = `ZZ${String(i).padStart(3, '0')}`;
      const dest = `ZY${String(i).padStart(3, '0')}`;
      seedLeg({ trip_id: trip, seq: i + 1, departure_ident: dep, destination_ident: dest });
      idents.push(dep, dest);
    }
    return idents;
  }

  it('does not let parked airports at the head of the list block the tail', () => {
    const idents = seedAirportLegs(30);
    setReplica([]);
    const parked = idents.slice(0, NAVDATA_DEMAND_CAP);

    expect(buildDemand(NOW).airports).toEqual(parked);

    const demand = buildDemand(NOW, skip(parked));
    expect(demand.airports).toEqual(idents.slice(NAVDATA_DEMAND_CAP));
    expect(demand.more).toBe(false);
  });

  it('applies the cap and recomputes more over what is left', () => {
    const idents = seedAirportLegs(40);
    setReplica([]);
    const parked = idents.slice(0, 10);

    const demand = buildDemand(NOW, skip(parked));

    expect(demand.airports).toEqual(idents.slice(10, 10 + NAVDATA_DEMAND_CAP));
    expect(demand.more).toBe(true);

    // Skipping all but the first cap's worth leaves nothing beyond the cap.
    expect(buildDemand(NOW, skip(idents.slice(NAVDATA_DEMAND_CAP))).more).toBe(false);
  });

  it('skips waypoints by ident whatever their region, and keeps kinds apart', () => {
    const trip = seedTrip(scratch.db, { is_active: 1 });
    const leg = seedLeg({ trip_id: trip, departure_is_airport: 0, destination_is_airport: 0 });
    seedWaypoints(leg, [
      { ident: 'ZZFIX', region: 'ZA', type: 'WAYPOINT' },
      { ident: 'ZZFIX', region: 'ZB', type: 'WAYPOINT' },
      { ident: 'ZZOTH', type: 'WAYPOINT' },
      { ident: 'ZZAA', type: 'AIRPORT' },
    ]);
    setReplica([]);

    // An airport skip does not hide a waypoint of the same ident, or the reverse.
    expect(buildDemand(NOW, skip(['ZZOTH'], ['ZZFIX']))).toMatchObject({
      airports: ['ZZAA'],
      waypoints: [{ ident: 'ZZOTH', kind: 'W' }],
    });
    expect(buildDemand(NOW, skip(['ZZAA'], [])).waypoints).toHaveLength(3);
  });

  it('leaves a skipped manual request in place, and still skips it', () => {
    upsertNavdataRequest('A', 'ZZREQ', null, NOW);
    upsertNavdataRequest('A', 'ZZHELD', null, NOW);
    setReplica([airport('ZZHELD', 'detail')]);

    const demand = buildDemand(NOW, skip(['ZZREQ', 'ZZHELD']));

    expect(demand.airports).toEqual([]);
    expect(listNavdataRequests(NOW).map(r => r.ident).sort()).toEqual(['ZZHELD', 'ZZREQ']);

    // Without the skip the answered request is deleted and the open one is wanted.
    expect(buildDemand(NOW).airports).toEqual(['ZZREQ']);
    expect(listNavdataRequests(NOW).map(r => r.ident)).toEqual(['ZZREQ']);
  });

  it('is byte-identical to the unskipped answer when nothing is skipped', () => {
    seedAirportLegs(30);
    setReplica([]);
    const plain = JSON.stringify(buildDemand(NOW));
    expect(JSON.stringify(buildDemand(NOW, skip()))).toBe(plain);
    expect(JSON.stringify(buildDemand(NOW, parseDemandSkip({})))).toBe(plain);
  });
});

describe('parseDemandSkip', () => {
  it('trims, upper-cases, ignores empties and de-duplicates', () => {
    const parsed = parseDemandSkip({ skipAirports: ' zzaa, ZZAA,,zzab ,', skipWaypoints: 'fix1' });
    expect([...parsed.airports]).toEqual(['ZZAA', 'ZZAB']);
    expect([...parsed.waypoints]).toEqual(['FIX1']);
    expect(parseDemandSkip({}).airports.size).toBe(0);
    expect(parseDemandSkip({ skipAirports: '' }).airports.size).toBe(0);
  });

  it('rejects malformed idents and non-string values', () => {
    for (const bad of ['ZZ-AA', 'ZZAAAAAAA', 'ZZ AA', 'ZZ\u00c9A']) {
      expect(() => parseDemandSkip({ skipAirports: `ZZAA,${bad}` }), bad).toThrow(DemandSkipError);
      expect(() => parseDemandSkip({ skipWaypoints: bad }), bad).toThrow(DemandSkipError);
    }
    expect(() => parseDemandSkip({ skipAirports: ['ZZAA', 'ZZAB'] })).toThrow(DemandSkipError);
    expect(() => parseDemandSkip({ skipWaypoints: { a: 'b' } })).toThrow(DemandSkipError);
  });

  it('accepts exactly the cap and rejects one more', () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `ZZ${i}`).join(',');
    expect(parseDemandSkip({ skipAirports: list(NAVDATA_DEMAND_SKIP_MAX) }).airports.size).toBe(NAVDATA_DEMAND_SKIP_MAX);
    expect(() => parseDemandSkip({ skipAirports: list(NAVDATA_DEMAND_SKIP_MAX + 1) })).toThrow(DemandSkipError);
    expect(() => parseDemandSkip({ skipWaypoints: list(NAVDATA_DEMAND_SKIP_MAX + 1) })).toThrow(DemandSkipError);
    // Duplicates do not count towards the cap.
    expect(parseDemandSkip({ skipAirports: Array(300).fill('ZZAA').join(',') }).airports.size).toBe(1);
  });
});

describe('an airport the simulator does not have, sent with no coordinates', () => {
  it('is not demanded, whether or not its absent row has arrived', () => {
    const trip = seedTrip(scratch.db, { is_active: 1 });
    seedLeg({ trip_id: trip, departure_ident: 'ZZAB', destination_ident: 'ZZAC' });
    upsertNavdataRequest('A', 'ZZAB', null, NOW);
    setReplica([
      { t: 'airport', r: { rev: 1, ident: 'ZZAB', detail_state: 'absent' } },
      absent('A', 'ZZAB'),
    ]);
    expect(buildDemand(NOW).airports).toEqual(['ZZAC']);
    expect(listNavdataRequests(NOW)).toHaveLength(0);

    setReplica([{ t: 'airport', r: { rev: 1, ident: 'ZZAB', detail_state: 'absent' } }], 'epoch-2');
    expect(buildDemand(NOW).airports).toEqual(['ZZAC']);
  });
});

describe('airway gaps between planned waypoints', () => {
  type Pt = { ident: string; lon: number; region?: string };
  const LAT = 30;
  const pt = (ident: string, lon: number, region?: string): Pt => ({ ident, lon, region });
  const regionOf = (p: Pt): string => p.region ?? 'ZZ';
  const key = (p: Pt): string => wptKey(p.ident, regionOf(p), LAT, p.lon);

  const fix = (p: Pt, routesState = 'fetched'): NavRow =>
    row('waypoint', { wpt_key: key(p), ident: p.ident, region: regionOf(p), lat: LAT, lon: p.lon, routes_state: routesState });

  const airwayLeg = (airway: string, a: Pt, b: Pt): NavRow => {
    const [lo, hi] = key(a) < key(b) ? [a, b] : [b, a];
    return row('airway_leg', {
      leg_key: `${airway}|${key(lo)}|${key(hi)}`, airway, airway_type: 1,
      from_key: key(a), to_key: key(b),
      from_ident: a.ident, from_region: regionOf(a), from_lat: LAT, from_lon: a.lon,
      to_ident: b.ident, to_region: regionOf(b), to_lat: LAT, to_lon: b.lon,
      min_lat: LAT, max_lat: LAT, min_lon: Math.min(a.lon, b.lon), max_lon: Math.max(a.lon, b.lon), dateline: 0,
    });
  };

  interface PlanWaypoint { p: Pt; type?: string; airway?: string | null; region?: string | null }

  /** A plan whose waypoints sit at the given longitudes on the shared latitude. */
  function seedPlan(list: PlanWaypoint[], legOver: Parameters<typeof seedLeg>[0] = {}, seq = 1): number {
    const trip = (scratch.db.prepare('SELECT id FROM trips WHERE is_active = 1').get() as { id: number } | undefined)?.id
      ?? seedTrip(scratch.db, { is_active: 1 });
    const leg = seedLeg({ trip_id: trip, seq, departure_is_airport: 0, destination_is_airport: 0, ...legOver });
    const stmt = scratch.db.prepare(
      'INSERT INTO planned_waypoints (planned_leg_id, seq, ident, region, airway, type, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    list.forEach((w, i) =>
      stmt.run(leg, i + 1, w.p.ident, w.region === undefined ? 'ZZ' : w.region, w.airway ?? null, w.type ?? 'WAYPOINT', LAT, w.p.lon));
    return leg;
  }

  const setLegColumn = (leg: number, column: string, value: string): void => {
    scratch.db.prepare(`UPDATE planned_legs SET ${column} = ? WHERE id = ?`).run(value, leg);
  };

  const A = pt('ZZA', 40), M1 = pt('ZZM1', 40.1), M2 = pt('ZZM2', 40.2), B = pt('ZZB', 40.3);
  const ends = (airway: string | null = 'ZZY1'): PlanWaypoint[] => [{ p: A }, { p: B, airway }];
  const ends2 = { fixes: [fix(A), fix(B)], legs: [airwayLeg('ZZY1', A, M1), airwayLeg('ZZY1', M2, B)] };
  const wants = (ident: string): { ident: string; region: string; kind: 'W' } => ({ ident, region: 'ZZ', kind: 'W' });

  it('asks for the fixes in the middle of an airway whose legs stop at both ends, and stops once they are fetched', () => {
    seedPlan(ends());
    setReplica([...ends2.fixes, ...ends2.legs]);
    expect(buildDemand(NOW).waypoints).toEqual([wants('ZZM1'), wants('ZZM2')]);

    setReplica([...ends2.fixes, ...ends2.legs, fix(M1), fix(M2), airwayLeg('ZZY1', M1, M2)], 'epoch-2');
    expect(buildDemand(NOW).waypoints).toEqual([]);
  });

  it('wants nothing for a pair the airway already connects', () => {
    seedPlan(ends());
    setReplica([
      ...ends2.fixes, ...ends2.legs, airwayLeg('ZZY1', M1, M2),
    ]);
    // ZZM1 and ZZM2 are unfetched but no longer a gap.
    expect(buildDemand(NOW).waypoints).toEqual([]);
  });

  it('joins endpoint keys that differ by a unit in the fifth decimal when checking the connection', () => {
    seedPlan(ends());
    const shifted = airwayLeg('ZZY1', M1, M2);
    // Same fix, key written one unit off on the second leg.
    const near = row('airway_leg', {
      ...shifted.r, leg_key: 'ZZY1|shifted', from_key: wptKey('ZZM1', 'ZZ', LAT, M1.lon + 0.00001),
    });
    setReplica([...ends2.fixes, ...ends2.legs, near]);
    expect(buildDemand(NOW).waypoints).toEqual([]);
  });

  it.each([
    ['DCT', 'DCT'],
    ['an empty airway', ''],
    ['a null airway', null],
  ])('wants nothing across %s', (_name, airway) => {
    seedPlan(ends(airway));
    setReplica([...ends2.fixes, ...ends2.legs]);
    expect(buildDemand(NOW).waypoints).toEqual([]);
  });

  it('wants nothing across the name of the plan\'s own SID, STAR or transition', () => {
    for (const field of ['sid_name', 'sid_transition', 'star_name', 'star_transition'] as const) {
      scratch.db.exec('DELETE FROM planned_waypoints; DELETE FROM planned_legs;');
      setLegColumn(seedPlan(ends('ZZY1')), field, 'zzy1');
      setReplica([...ends2.fixes, ...ends2.legs], `epoch-${field}`);
      expect(buildDemand(NOW).waypoints, field).toEqual([]);
    }
    // A different procedure name does not silence a real airway.
    scratch.db.exec('DELETE FROM planned_waypoints; DELETE FROM planned_legs;');
    setLegColumn(seedPlan(ends('ZZY1')), 'sid_name', 'ZZSID1');
    setReplica([...ends2.fixes, ...ends2.legs], 'epoch-other');
    expect(buildDemand(NOW).waypoints).toEqual([wants('ZZM1'), wants('ZZM2')]);
  });

  it('wants nothing when an end is an airport or a user point', () => {
    seedPlan([{ p: A, type: 'AIRPORT' }, { p: B, airway: 'ZZY1' }]);
    setReplica([...ends2.fixes, ...ends2.legs, airport('ZZA')]);
    expect(buildDemand(NOW).waypoints).toEqual([]);

    scratch.db.exec('DELETE FROM planned_waypoints; DELETE FROM planned_legs;');
    seedPlan([{ p: A }, { p: B, type: 'USER', airway: 'ZZY1' }]);
    setReplica([...ends2.fixes, ...ends2.legs], 'epoch-2');
    expect(buildDemand(NOW).waypoints).toEqual([]);

    scratch.db.exec('DELETE FROM planned_waypoints; DELETE FROM planned_legs;');
    seedPlan([{ p: A, type: 'USER' }, { p: B, airway: 'ZZY1' }]);
    setReplica([...ends2.fixes, ...ends2.legs], 'epoch-3');
    expect(buildDemand(NOW).waypoints).toEqual([]);
  });

  it('does not ask again for a frontier fix recorded absent, in either table', () => {
    seedPlan(ends());
    setReplica([...ends2.fixes, ...ends2.legs, absent('W', 'ZZM1', 'ZZ')]);
    expect(buildDemand(NOW).waypoints).toEqual([wants('ZZM2')]);

    setReplica([...ends2.fixes, ...ends2.legs, fix(M2, 'absent'), absent('W', 'ZZM1', 'ZZ')], 'epoch-2');
    expect(buildDemand(NOW).waypoints).toEqual([]);
  });

  it('matches an absent row with no region only against a fix that has no region', () => {
    seedPlan(ends());
    setReplica([...ends2.fixes, ...ends2.legs, absent('W', 'ZZM1', '')]);
    expect(buildDemand(NOW).waypoints).toEqual([wants('ZZM1'), wants('ZZM2')]);

    const [E1, E2] = [pt('ZZE1', 40.1, ''), pt('ZZE2', 40.2, '')];
    scratch.db.exec('DELETE FROM planned_waypoints; DELETE FROM planned_legs;');
    seedPlan([{ p: A }, { p: B, airway: 'ZZY1' }]);
    setReplica([...ends2.fixes, airwayLeg('ZZY1', A, E1), airwayLeg('ZZY1', E2, B), absent('W', 'ZZE1', '')], 'epoch-2');
    expect(buildDemand(NOW).waypoints).toEqual([{ ident: 'ZZE2', kind: 'W' }]);
  });

  it('asks again for a fix of the same ident recorded absent under another region', () => {
    seedPlan(ends());
    setReplica([...ends2.fixes, ...ends2.legs, absent('W', 'ZZM1', 'YY')]);
    expect(buildDemand(NOW).waypoints).toEqual([wants('ZZM1'), wants('ZZM2')]);
  });

  it('skips a pair it cannot resolve, without throwing', () => {
    seedPlan([{ p: pt('ZZNOWHERE', 55) }, { p: pt('ZZNOEND', 56), airway: 'ZZY1' }]);
    setReplica([fix(A), ...ends2.legs], 'epoch-2');
    expect(buildDemand(NOW).waypoints.map((w) => w.ident)).toEqual(['ZZNOWHERE', 'ZZNOEND']);

    scratch.db.exec('DELETE FROM planned_waypoints; DELETE FROM planned_legs;');
    seedPlan([{ p: A }, { p: pt('ZZNOEND', 56), airway: 'ZZY1' }]);
    setReplica([fix(A), ...ends2.legs], 'epoch-3');
    expect(buildDemand(NOW).waypoints.map((w) => w.ident)).toEqual(['ZZNOEND']);
  });

  it('wants nothing for a plan whose waypoints resolve to the same key', () => {
    seedPlan([{ p: A }, { p: A, airway: 'ZZY1' }]);
    setReplica([fix(A), airwayLeg('ZZY1', A, M1)]);
    expect(buildDemand(NOW).waypoints).toEqual([]);
  });

  it('asks only for fixes nobody has answered, the two nearest the far end on each side', () => {
    const [N1, N2, N3, N4, F, P1] = [
      pt('ZZN1', 40.1), pt('ZZN2', 40.2), pt('ZZN3', 40.3), pt('ZZN4', 40.4), pt('ZZF', 40.5), pt('ZZP1', 40.8),
    ];
    const far = pt('ZZFAR', 41);
    seedPlan([{ p: A }, { p: far, airway: 'ZZY1' }]);
    setReplica([
      fix(A), fix(far), fix(F),
      // A - N1 - N2 - N3 - N4 chain, with the fetched ZZF closer to the far end than any of them but N4's tail.
      airwayLeg('ZZY1', A, N1), airwayLeg('ZZY1', N1, N2), airwayLeg('ZZY1', N2, N3), airwayLeg('ZZY1', N3, N4),
      airwayLeg('ZZY1', N4, F),
      airwayLeg('ZZY1', far, P1),
    ]);
    // A side: N4 and N3 are nearest the far end (ZZF is fetched, ZZA is fetched); the far side: only P1.
    expect(buildDemand(NOW).waypoints).toEqual([wants('ZZN4'), wants('ZZN3'), wants('ZZP1')]);
  });

  it('is asked only about fixes on the named airway', () => {
    seedPlan(ends());
    setReplica([
      ...ends2.fixes, ...ends2.legs,
      airwayLeg('ZZOTHER', A, pt('ZZO1', 40.05)), airwayLeg('ZZOTHER', B, pt('ZZO2', 40.25)),
    ]);
    expect(buildDemand(NOW).waypoints).toEqual([wants('ZZM1'), wants('ZZM2')]);
  });

  it('places gap fixes after every plan fix and before navaids, inside the cap and under skip lists', () => {
    seedPlan([...ends(), { p: pt('ZZVOR', 45), type: 'VOR' }]);
    seedPlan([{ p: pt('ZZOWN', 46) }], {}, 2);
    setReplica([...ends2.fixes, ...ends2.legs]);
    expect(buildDemand(NOW).waypoints.map((w) => w.ident)).toEqual(['ZZOWN', 'ZZM1', 'ZZM2', 'ZZVOR']);

    const skipped = buildDemand(NOW, parseDemandSkip({ skipWaypoints: 'zzm1' }));
    expect(skipped.waypoints.map((w) => w.ident)).toEqual(['ZZOWN', 'ZZM2', 'ZZVOR']);
  });

  it('gives a gap fix the cap slot after the plan fixes and reports the rest as more', () => {
    const many = Array.from({ length: NAVDATA_DEMAND_CAP - 1 }, (_, i) => ({ p: pt(`ZZQ${i}`, 50 + i * 0.01) }));
    seedPlan(ends());
    seedPlan(many, {}, 2);
    setReplica([...ends2.fixes, ...ends2.legs]);
    const demand = buildDemand(NOW);
    expect(demand.waypoints).toHaveLength(NAVDATA_DEMAND_CAP);
    expect(demand.waypoints.slice(0, NAVDATA_DEMAND_CAP - 1).map((w) => w.ident)).toEqual(many.map((w) => w.p.ident));
    expect(demand.waypoints[NAVDATA_DEMAND_CAP - 1]).toEqual(wants('ZZM1'));
    expect(demand.more).toBe(true);
  });

  it('never asks for gap fixes when the plans alone overflow the cap', () => {
    seedPlan(ends());
    seedPlan(Array.from({ length: NAVDATA_DEMAND_CAP + 1 }, (_, i) => ({ p: pt(`ZZQ${i}`, 50 + i * 0.01) })), {}, 2);
    setReplica([...ends2.fixes, ...ends2.legs]);
    const demand = buildDemand(NOW);
    expect(demand.waypoints.map((w) => w.ident)).not.toContain('ZZM1');
    expect(demand.more).toBe(true);
  });

  describe('a frontier fix that is a navaid', () => {
    const V = (ident: string, region = 'ZZ'): { ident: string; region: string; kind: 'V' } => ({ ident, region, kind: 'V' });
    const both = [...ends2.fixes, ...ends2.legs];

    it('is asked for as the navaid its ident and region match, and not at all once that navaid is answered', () => {
      seedPlan(ends());
      setReplica([...both, navaid('ZZM1', 'ZZ', 'V', 'index')]);
      expect(buildDemand(NOW).waypoints).toEqual([wants('ZZM2'), V('ZZM1')]);

      setReplica([...both, navaid('ZZM1', 'ZZ', 'V', 'detail')], 'epoch-2');
      expect(buildDemand(NOW).waypoints).toEqual([wants('ZZM2')]);

      setReplica([...both, navaid('ZZM1', 'ZZ', 'V', 'index'), absent('V', 'ZZM1', 'ZZ')], 'epoch-3');
      expect(buildDemand(NOW).waypoints).toEqual([wants('ZZM2')]);
    });

    it('is judged by the navaid rule, so a fetched waypoint row of that ident does not answer it', () => {
      seedPlan(ends());
      setReplica([...both, navaid('ZZM1', 'ZZ', 'V', 'index'), fix(M1)]);
      expect(buildDemand(NOW).waypoints).toEqual([wants('ZZM2'), V('ZZM1')]);
    });

    it('is asked for as an NDB when the row is an NDB', () => {
      seedPlan(ends());
      setReplica([...both, navaid('ZZM1', 'ZZ', 'N', 'index')]);
      expect(buildDemand(NOW).waypoints).toEqual([wants('ZZM2'), { ident: 'ZZM1', region: 'ZZ', kind: 'N' }]);
      setReplica([...both, navaid('ZZM1', 'ZZ', 'N', 'detail')], 'epoch-2');
      expect(buildDemand(NOW).waypoints).toEqual([wants('ZZM2')]);
    });

    it('is asked for as a waypoint when no navaid row matches, or the only match is another region', () => {
      seedPlan(ends());
      setReplica(both);
      expect(buildDemand(NOW).waypoints).toEqual([wants('ZZM1'), wants('ZZM2')]);
      setReplica([...both, navaid('ZZM1', 'ZZX', 'V', 'index')], 'epoch-2');
      expect(buildDemand(NOW).waypoints).toEqual([wants('ZZM1'), wants('ZZM2')]);
    });

    it('is left out as a waypoint when a plan wants the same ident and region as a VOR', () => {
      seedPlan([...ends(), { p: pt('ZZM1', 45), type: 'VOR', region: 'ZZ' }]);
      setReplica(both);
      expect(buildDemand(NOW).waypoints).toEqual([wants('ZZM2'), V('ZZM1')]);
    });

    it('is left out as a waypoint when a plan wants the ident as a region-less navaid, in any region', () => {
      seedPlan([...ends(), { p: pt('ZZM1', 45), type: 'NDB', region: null }]);
      setReplica(both);
      expect(buildDemand(NOW).waypoints).toEqual([wants('ZZM2'), { ident: 'ZZM1', kind: 'N' }]);
    });

    it('is still asked for as a waypoint when the plan navaid is another region', () => {
      seedPlan([...ends(), { p: pt('ZZM1', 45), type: 'VOR', region: 'ZZX' }]);
      setReplica(both);
      expect(buildDemand(NOW).waypoints).toEqual([wants('ZZM1'), wants('ZZM2'), V('ZZM1', 'ZZX')]);
    });

    it('comes after every waypoint and airport, and drops out by ident across kinds under a skip list', () => {
      seedPlan([...ends(), { p: pt('ZZVOR', 45), type: 'VOR' }], { departure_is_airport: 1 });
      seedPlan([{ p: pt('ZZOWN', 46) }], {}, 2);
      setReplica([...both, navaid('ZZM1', 'ZZ', 'V', 'index')]);
      const demand = buildDemand(NOW);
      expect(demand.airports).toEqual(['ZZAA']);
      expect(demand.waypoints.map((w) => `${w.kind}:${w.ident}`)).toEqual(['W:ZZOWN', 'W:ZZM2', 'V:ZZVOR', 'V:ZZM1']);

      const skipped = buildDemand(NOW, parseDemandSkip({ skipWaypoints: 'zzm1,zzvor' }));
      expect(skipped.waypoints.map((w) => w.ident)).toEqual(['ZZOWN', 'ZZM2']);
    });

    it('is pushed out by the cap after the waypoints', () => {
      const many = Array.from({ length: NAVDATA_DEMAND_CAP - 1 }, (_, i) => ({ p: pt(`ZZQ${i}`, 50 + i * 0.01) }));
      seedPlan(ends());
      seedPlan(many, {}, 2);
      setReplica([...both, navaid('ZZM1', 'ZZ', 'V', 'index')]);
      const demand = buildDemand(NOW);
      expect(demand.waypoints).toHaveLength(NAVDATA_DEMAND_CAP);
      expect(demand.waypoints[NAVDATA_DEMAND_CAP - 1]).toEqual(wants('ZZM2'));
      expect(demand.waypoints.map((w) => w.ident)).not.toContain('ZZM1');
      expect(demand.more).toBe(true);
    });

    it('is asked once when both ends of the gap reach it', () => {
      seedPlan(ends());
      setReplica([...both, navaid('ZZM1', 'ZZ', 'V', 'index')]);
      expect(buildDemand(NOW).waypoints.filter((w) => w.ident === 'ZZM1')).toHaveLength(1);
    });

    it('follows a navaid row added between polls, warm or cold', () => {
      seedPlan(ends());
      setReplica(both);
      expect(buildDemand(NOW).waypoints).toEqual([wants('ZZM1'), wants('ZZM2')]);

      applyIncrementalBatch(
        getNavDb(),
        { v: NAVDATA_WIRE_VERSION, schemaVersion: NAVDATA_SCHEMA_VERSION, snapshotId: 'epoch-1', fromRev: 0, toRev: 0, rows: [navaid('ZZM1', 'ZZ', 'V', 'index')], more: false },
        1,
      );
      const warm = buildDemand(NOW).waypoints;
      expect(warm).toEqual([wants('ZZM2'), V('ZZM1')]);
      resetGapCursor();
      expect(buildDemand(NOW).waypoints).toEqual(warm);
    });

    it('is classified with one lookup that uses the ident index and never scans nav_navaid', () => {
      seedPlan(ends());
      setReplica([...both, navaid('ZZM1', 'ZZ', 'V', 'index')]);
      const proto = Object.getPrototypeOf(scratch.db.prepare('SELECT 1')) as { all: (...a: unknown[]) => unknown };
      const original = proto.all;
      const sources = new Set<string>();
      proto.all = function (this: { source: string }, ...args: unknown[]) {
        if (this.source.includes('FROM nav_navaid WHERE ident = ?')) sources.add(this.source);
        return original.apply(this, args);
      };
      try {
        buildDemand(NOW);
      } finally {
        proto.all = original;
      }
      expect(sources.size).toBe(1);
      const raw = new Database(resolveNavdataPath(), { readonly: true });
      const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${[...sources][0]}`).all('ZZM1', 'ZZ') as { detail: string }[])
        .map((r) => r.detail).join('\n');
      raw.close();
      expect(plan).toContain('nav_navaid_ident');
      expect(plan).not.toMatch(/SCAN nav_navaid/);
    });
  });

  it('answers with the same fields as before', () => {
    seedPlan(ends());
    setReplica([...ends2.fixes, ...ends2.legs]);
    expect(Object.keys(buildDemand(NOW)).sort()).toEqual(['airports', 'cap', 'generatedAt', 'more', 'v', 'waypoints']);
  });

  it('spends the gap pass across polls when it runs out of time, starting each poll where the last stopped', () => {
    const legs = [0, 1, 2].map((k) => {
      const [a, b] = [pt(`ZZA${k}`, 60 + k * 5), pt(`ZZB${k}`, 60.3 + k * 5)];
      const [m1, m2] = [pt(`ZZM${k}1`, 60.1 + k * 5), pt(`ZZM${k}2`, 60.2 + k * 5)];
      return { a, b, m1, m2, airway: `ZZY${k}` };
    });
    const rows: NavRow[] = [];
    legs.forEach((l, k) => {
      seedPlan([{ p: l.a }, { p: l.b, airway: l.airway }], {}, k + 1);
      rows.push(fix(l.a), fix(l.b), airwayLeg(l.airway, l.a, l.m1), airwayLeg(l.airway, l.m2, l.b));
    });
    setReplica(rows);
    let t = 0;
    const slow = (): number => (t += GAP_PASS_BUDGET_MS + 1);
    const idents = (): string[] => buildDemand(NOW, undefined, slow).waypoints.map((w) => w.ident);

    expect(idents()).toEqual(['ZZM01', 'ZZM02']);
    expect(idents()).toEqual(['ZZM11', 'ZZM12']);
    expect(idents()).toEqual(['ZZM21', 'ZZM22']);
    expect(idents()).toEqual(['ZZM01', 'ZZM02']);
    // A poll with time to spare covers every leg, beginning at the leg the last one stopped before.
    expect(buildDemand(NOW).waypoints.map((w) => w.ident)).toEqual(['ZZM11', 'ZZM12', 'ZZM21', 'ZZM22', 'ZZM01', 'ZZM02']);
  });

  it('carries on with the next leg when a poll is cut short inside a leg', () => {
    const [a, b, c] = [pt('ZZA', 40), pt('ZZB', 40.3), pt('ZZC', 40.6)];
    seedPlan([{ p: a }, { p: b, airway: 'ZZY1' }, { p: c, airway: 'ZZY2' }], {}, 1);
    const [a2, b2, m1, m2] = [pt('ZZA2', 70), pt('ZZB2', 70.3), pt('ZZN1', 70.1), pt('ZZN2', 70.2)];
    seedPlan([{ p: a2 }, { p: b2, airway: 'ZZY3' }], {}, 2);
    setReplica([
      fix(a), fix(b), fix(c), airwayLeg('ZZY1', a, M1), airwayLeg('ZZY1', M2, b), airwayLeg('ZZY2', b, pt('ZZO1', 40.4)),
      airwayLeg('ZZY2', pt('ZZO2', 40.5), c),
      fix(a2), fix(b2), airwayLeg('ZZY3', a2, m1), airwayLeg('ZZY3', m2, b2),
    ]);
    let t = 0;
    const slow = (): number => (t += GAP_PASS_BUDGET_MS + 1);
    expect(buildDemand(NOW, undefined, slow).waypoints.map((w) => w.ident)).toEqual(['ZZM1', 'ZZM2']);
    expect(buildDemand(NOW, undefined, slow).waypoints.map((w) => w.ident)).toEqual(['ZZN1', 'ZZN2']);
  });

  it('keeps the rotation across a replica change', () => {
    const [a2, b2, m21, m22] = [pt('ZZA2', 70), pt('ZZB2', 70.3), pt('ZZM21', 70.1), pt('ZZM22', 70.2)];
    seedPlan(ends(), {}, 1);
    seedPlan([{ p: a2 }, { p: b2, airway: 'ZZY2' }], {}, 2);
    const rows = [...ends2.fixes, ...ends2.legs, fix(a2), fix(b2), airwayLeg('ZZY2', a2, m21), airwayLeg('ZZY2', m22, b2)];
    setReplica(rows);
    let t = 0;
    const slow = (): number => (t += GAP_PASS_BUDGET_MS + 1);
    expect(buildDemand(NOW, undefined, slow).waypoints.map((w) => w.ident)).toEqual(['ZZM1', 'ZZM2']);
    setReplica(rows, 'epoch-2');
    expect(buildDemand(NOW, undefined, slow).waypoints.map((w) => w.ident)).toEqual(['ZZM21', 'ZZM22']);
  });

  it('keeps the rotation where it was when a poll stops at the cap', () => {
    const legs = [0, 1, 2].map((k) => ({
      a: pt(`ZZA${k}`, 60 + k * 5), b: pt(`ZZB${k}`, 60.3 + k * 5),
      m1: pt(`ZZM${k}1`, 60.1 + k * 5), m2: pt(`ZZM${k}2`, 60.2 + k * 5), airway: `ZZY${k}`,
    }));
    const rows: NavRow[] = [];
    legs.forEach((l, k) => {
      seedPlan([{ p: l.a }, { p: l.b, airway: l.airway }], {}, k + 1);
      rows.push(fix(l.a), fix(l.b), airwayLeg(l.airway, l.a, l.m1), airwayLeg(l.airway, l.m2, l.b));
    });
    setReplica(rows);
    let t = 0;
    const slow = (): number => (t += GAP_PASS_BUDGET_MS + 1);
    expect(buildDemand(NOW, undefined, slow).waypoints.map((w) => w.ident)).toEqual(['ZZM01', 'ZZM02']);

    // Forty-nine plan fixes leave room for one gap fix, so the pass stops inside leg 1 at the cap.
    seedPlan(Array.from({ length: NAVDATA_DEMAND_CAP - 1 }, (_, i) => ({ p: pt(`ZZQ${i}`, 50 + i * 0.01) })), {}, 4);
    for (let i = 0; i < 2; i++) {
      const wanted = buildDemand(NOW).waypoints.map((w) => w.ident);
      expect(wanted).toHaveLength(NAVDATA_DEMAND_CAP);
      expect(wanted[NAVDATA_DEMAND_CAP - 1], `poll ${i}`).toBe('ZZM11');
    }
  });

  it('does not reuse a walk made for another target', () => {
    const C = pt('ZZC', 40.05);
    seedPlan([{ p: A }, { p: C, airway: 'ZZY1' }], {}, 1);
    seedPlan(ends(), {}, 2);
    setReplica([...ends2.fixes, fix(C), ...ends2.legs, airwayLeg('ZZY1', A, C)]);
    expect(buildDemand(NOW).waypoints).toEqual([wants('ZZM1'), wants('ZZM2')]);
  });

  describe('rows changed under an unchanged snapshot id, revision and timestamp', () => {
    const extra = pt('ZZM3', 40.15);
    const change = [airwayLeg('ZZY1', M1, extra)];
    const expected = [wants('ZZM3'), wants('ZZM1'), wants('ZZM2')];

    function cold(): unknown {
      resetGapCursor();
      return buildDemand(NOW).waypoints;
    }

    it('a batch that keeps the revision', () => {
      seedPlan(ends());
      setReplica([...ends2.fixes, ...ends2.legs]);
      expect(buildDemand(NOW).waypoints).toEqual([wants('ZZM1'), wants('ZZM2')]);

      applyIncrementalBatch(
        getNavDb(),
        { v: NAVDATA_WIRE_VERSION, schemaVersion: NAVDATA_SCHEMA_VERSION, snapshotId: 'epoch-1', fromRev: 0, toRev: 0, rows: change, more: false },
        1,
      );
      const warm = buildDemand(NOW).waypoints;
      expect(warm).toEqual(expected);
      expect(warm).toEqual(cold());
    });

    it('a snapshot of the same epoch swapped in', () => {
      seedPlan(ends());
      setReplica([...ends2.fixes, ...ends2.legs]);
      expect(buildDemand(NOW).waypoints).toEqual([wants('ZZM1'), wants('ZZM2')]);

      const incoming = incomingNavdataPath();
      writeReplica(incoming, [...ends2.fixes, ...ends2.legs, ...change], 'epoch-1');
      swapInReplica(incoming);
      const warm = buildDemand(NOW).waypoints;
      expect(warm).toEqual(expected);
      expect(warm).toEqual(cold());
    });

    it('a new timestamp alone', () => {
      seedPlan(ends());
      setReplica([...ends2.fixes, ...ends2.legs]);
      buildDemand(NOW);
      const raw = new Database(resolveNavdataPath());
      raw.prepare('UPDATE nav_meta SET updated_at = updated_at + 1 WHERE id = 1').run();
      raw.exec(`DELETE FROM nav_airway_leg`);
      raw.close();
      expect(buildDemand(NOW).waypoints).toEqual([]);
    });
  });

  /** Counts the statement runs whose text contains `match` while `fn` runs. */
  function countQueries(match: string, fn: () => void): number {
    const statementProto = Object.getPrototypeOf(scratch.db.prepare('SELECT 1')) as { all: (...a: unknown[]) => unknown };
    const original = statementProto.all;
    let walks = 0;
    statementProto.all = function (this: { source: string }, ...args: unknown[]) {
      if (this.source.includes(match)) walks++;
      return original.apply(this, args);
    };
    try {
      fn();
    } finally {
      statementProto.all = original;
    }
    return walks;
  }

  const countWalkQueries = (fn: () => void): number => countQueries('+airway', fn);

  it('walks a repeated pair once per poll', () => {
    seedPlan(ends(), {}, 1);
    setReplica([...ends2.fixes, ...ends2.legs]);
    const single = countWalkQueries(() => buildDemand(NOW));
    resetGapCursor();
    seedPlan(ends(), {}, 2);
    seedPlan(ends(), {}, 3);
    expect(single).toBeGreaterThan(0);
    expect(countWalkQueries(() => buildDemand(NOW))).toBe(single);
  });

  it('remembers walks between polls while the replica is unchanged and repeats them once it changes', () => {
    seedPlan(ends());
    setReplica([...ends2.fixes, ...ends2.legs]);
    const first = countWalkQueries(() => buildDemand(NOW));
    expect(first).toBeGreaterThan(0);
    expect(countWalkQueries(() => buildDemand(NOW))).toBe(0);
    expect(countQueries('SELECT wpt_key, lat, lon FROM nav_waypoint', () => buildDemand(NOW))).toBe(0);

    // A new revision of the same snapshot invalidates it as well.
    const meta = new Database(resolveNavdataPath());
    meta.prepare('UPDATE nav_meta SET rev = rev + 1 WHERE id = 1').run();
    meta.close();
    expect(countWalkQueries(() => buildDemand(NOW))).toBe(first);

    setReplica([...ends2.fixes, ...ends2.legs, fix(M1), fix(M2), airwayLeg('ZZY1', M1, M2)], 'epoch-2');
    expect(countWalkQueries(() => buildDemand(NOW))).toBeGreaterThan(0);
    expect(buildDemand(NOW).waypoints).toEqual([]);
  });
});

describe('walkAirway', () => {
  const LAT = 30;
  const pt = (ident: string, lon: number): { ident: string; lon: number } => ({ ident, lon });
  type P = ReturnType<typeof pt>;
  const key = (p: P): string => wptKey(p.ident, 'ZZ', LAT, p.lon);
  const leg = (a: P, b: P, airway = 'ZZY1'): NavRow => {
    const [lo, hi] = key(a) < key(b) ? [a, b] : [b, a];
    return row('airway_leg', {
      leg_key: `${airway}|${key(lo)}|${key(hi)}`, airway, airway_type: 1, from_key: key(a), to_key: key(b),
      from_ident: a.ident, from_region: 'ZZ', from_lat: LAT, from_lon: a.lon,
      to_ident: b.ident, to_region: 'ZZ', to_lat: LAT, to_lon: b.lon,
      min_lat: LAT, max_lat: LAT, min_lon: Math.min(a.lon, b.lon), max_lon: Math.max(a.lon, b.lon), dateline: 0,
    });
  };
  const chain = (prefix: string, n: number, lon0: number): P[] =>
    Array.from({ length: n }, (_, i) => pt(`${prefix}${i}`, lon0 + i * 0.001));
  const links = (nodes: P[]): NavRow[] => nodes.slice(1).map((p, i) => leg(nodes[i], p));

  let nav: Database.Database;
  beforeEach(() => {
    nav = new Database(':memory:');
    applyNavdataSchema(nav);
  });
  afterEach(() => nav.close());

  const countedWalk = (from: P, target?: P): { queries: number; walk: AirwayWalk } => {
    let queries = 0;
    const spy = {
      prepare: (sql: string) => {
        const stmt = nav.prepare(sql);
        return { all: (...args: unknown[]) => { queries++; return stmt.all(...args); } };
      },
    } as unknown as Database.Database;
    const walk = walkAirway(spy, 'ZZY1', key(from), target ? key(target) : undefined);
    return { queries, walk };
  };

  it('stops at the target without exploring the rest of the component', () => {
    const main = chain('ZZR', 4, 40);
    const branch = chain('ZZS', 150, 41);
    applyNavRows(nav, [...links(main), ...links([main[0], ...branch])]);

    const early = countedWalk(main[0], main[3]);
    expect(early.walk.reached).toBe(true);
    expect(early.queries).toBeLessThanOrEqual(6);

    const full = countedWalk(main[0]);
    expect(full.walk.reached).toBe(false);
    expect(full.queries).toBeGreaterThan(100);
  });

  it('returns the whole component when the target is not in it', () => {
    const main = chain('ZZR', 4, 40);
    applyNavRows(nav, [...links(main), leg(pt('ZZO1', 50), pt('ZZO2', 50.1))]);
    const walk = walkAirway(nav, 'ZZY1', key(main[0]), key(pt('ZZO1', 50)));
    expect(walk.reached).toBe(false);
    expect(walk.nodes.map((n) => n.ident).sort()).toEqual(['ZZR0', 'ZZR1', 'ZZR2', 'ZZR3']);
  });

  it('stops at the hop bound: the fix AIRWAY_MAX_HOPS hops away is reached, the next is not', () => {
    const long = chain('ZZL', AIRWAY_MAX_HOPS + 50, 40);
    applyNavRows(nav, links(long));
    expect(walkAirway(nav, 'ZZY1', key(long[0]), key(long[AIRWAY_MAX_HOPS])).reached).toBe(true);
    expect(walkAirway(nav, 'ZZY1', key(long[0]), key(long[AIRWAY_MAX_HOPS + 1])).reached).toBe(false);
    const all = walkAirway(nav, 'ZZY1', key(long[0])).nodes;
    expect(all).toHaveLength(AIRWAY_MAX_HOPS + 1);
  });

  it('stops at the visit bound on a wide component', () => {
    const hub = pt('ZZHUB', 40);
    const spokes = Array.from({ length: AIRWAY_MAX_VISITED + 100 }, (_, i) => pt(`ZZK${i}`, 41 + i * 0.001));
    applyNavRows(nav, spokes.map((s) => leg(hub, s)));
    const walk = walkAirway(nav, 'ZZY1', key(hub));
    expect(walk.nodes).toHaveLength(AIRWAY_MAX_VISITED);
    expect(walkAirway(nav, 'ZZY1', key(hub), key(spokes[AIRWAY_MAX_VISITED + 50])).reached).toBe(false);
  });

  it('joins endpoint keys within the position tolerance and no further', () => {
    const [a, x, b] = [pt('ZZA', 40), pt('ZZX', 40.1), pt('ZZB', 40.2)];
    const xNear = { ...x, lon: x.lon + 0.0001 };
    const xFar = { ...x, lon: x.lon + 0.00011 };
    applyNavRows(nav, [leg(a, x), leg(xNear, b)]);
    expect(walkAirway(nav, 'ZZY1', key(a), key(b)).reached).toBe(true);

    nav.exec('DELETE FROM nav_airway_leg');
    applyNavRows(nav, [leg(a, x), leg(xFar, b)]);
    expect(walkAirway(nav, 'ZZY1', key(a), key(b)).reached).toBe(false);
  });

  it('counts a target within the tolerance of the start as reached at once', () => {
    const a = pt('ZZA', 40);
    applyNavRows(nav, [leg(a, pt('ZZB', 40.1))]);
    const walk = walkAirway(nav, 'ZZY1', key(a), key({ ...a, lon: a.lon + 0.0001 }));
    expect(walk).toEqual({ nodes: [], reached: true });
  });

  it('follows only the named airway', () => {
    const [a, b] = [pt('ZZA', 40), pt('ZZB', 40.1)];
    applyNavRows(nav, [leg(a, b, 'ZZOTHER')]);
    expect(walkAirway(nav, 'ZZY1', key(a), key(b)).reached).toBe(false);
  });

  it('is served by the key indexes, not the airway-name index', () => {
    const plan = nav
      .prepare(`EXPLAIN QUERY PLAN ${AIRWAY_NEIGHBOURS_SQL}`)
      .all({ airway: 'ZZY1', lo: 'ZZA|ZZ|', hi: 'ZZA|ZZ}' }) as { detail: string }[];
    const details = plan.map((r) => r.detail).join('\n');
    expect(details).toMatch(/SEARCH .*USING (COVERING )?INDEX nav_airway_leg_from/);
    expect(details).toMatch(/SEARCH .*USING (COVERING )?INDEX nav_airway_leg_to/);
    expect(details).not.toMatch(/nav_airway_leg_name/);
  });
});
