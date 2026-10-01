// tests/helpers/db.ts — real (temp-file) sqlite harness for db-touching tests.
//
// One file, one owner: this module owns the scratch-database lifecycle and
// its five seed helpers; no other test file edits it. It imports the REAL
// ../../src/db, so it must never be imported from ./index (which the mocked
// db/airports test files resolve through vi.mock) — a mocked test file and a
// real-database test file never mix in one file.

import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { initDb, closeDb } from '../../src/db';
import { T0, KSBA, KMRY } from './index';
import { scratchDbRoot } from './scratchRoot';

export { scratchDbRoot } from './scratchRoot';

// ── Lifecycle ────────────────────────────────────────────────────────────────

export interface ScratchDb {
  /** The open handle — the same object src/db/connection.ts's getDb() returns. */
  db: Database.Database;
  /** Absolute path of the database file, i.e. <dir>/flights.db. */
  file: string;
  /** The temp directory holding it; removed whole by destroyScratchDb(). */
  dir: string;
}

/**
 * Makes a temp directory, calls the REAL initDb(file) from '../../src/db' so
 * the connection module's handle is set and every db module can find it, and
 * returns the handle. Runs applySchema() by way of initDb() — the production
 * path, not a copy of it. Sets no environment variable.
 */
export function createScratchDb(): ScratchDb {
  const dir = fs.mkdtempSync(path.join(scratchDbRoot(), 'msfslogger-test-'));
  const file = path.join(dir, 'flights.db');
  const db = initDb(file);
  return { db, file, dir };
}

/**
 * Calls the REAL closeDb() (checkpointing WAL, as production does) and removes
 * the temp directory with { recursive: true, force: true }. Safe to call twice
 * and safe to call when the database is already closed.
 */
export function destroyScratchDb(h: ScratchDb): void {
  try {
    closeDb();
  } catch {
    // Best-effort: the handle may already be closed.
  }
  fs.rmSync(h.dir, { recursive: true, force: true });
}

/**
 * Points FLIGHTS_DB_PATH at `file` and returns a restore function that puts the
 * previous value back (deleting the key if it was unset). Only the four
 * CLI-script test files need this.
 */
export function useScratchDbEnv(file: string): () => void {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'FLIGHTS_DB_PATH');
  const prev = process.env.FLIGHTS_DB_PATH;
  process.env.FLIGHTS_DB_PATH = file;
  return () => {
    if (had) {
      process.env.FLIGHTS_DB_PATH = prev;
    } else {
      delete process.env.FLIGHTS_DB_PATH;
    }
  };
}

// Every application table plus sqlite_sequence, in delete order — children
// before parents matters only for readability here since foreign_keys is off
// for the duration.
const ALL_TABLES = [
  'flight_points',
  'planned_waypoints',
  'planned_alternates',
  'acars_messages',
  'sayintentions_links',
  'flights',
  'planned_legs',
  'trips',
  'auth_session',
  'auth_user',
  'app_secret',
  'app_setting',
  'ingest_tokens',
  'mcp_tokens',
  'sqlite_sequence',
];

/**
 * DELETE FROM every application table plus sqlite_sequence, in one transaction,
 * with foreign_keys off for the duration. ~0.33 ms. Only for the per-file
 * pattern in the beforeAll/resetScratchDb variant.
 */
export function resetScratchDb(h: ScratchDb): void {
  h.db.pragma('foreign_keys = OFF');
  const reset = h.db.transaction(() => {
    for (const table of ALL_TABLES) {
      h.db.exec(`DELETE FROM ${table}`);
    }
  });
  reset();
  h.db.pragma('foreign_keys = ON');
}

// ── Seed helpers ─────────────────────────────────────────────────────────────
//
// Raw SQL, never through the module under test. Each returns the new row id.

export interface SeedFlight {
  aircraft: string | null;
  start_time: string;
  end_time: string | null;
  departure_lat: number | null;
  departure_lon: number | null;
  arrival_lat: number | null;
  arrival_lon: number | null;
  departure_icao: string | null;
  departure_name: string | null;
  arrival_icao: string | null;
  arrival_name: string | null;
  duration_sec: number | null;
  distance_nm: number | null;
  max_altitude_ft: number | null;
  max_airspeed_kts: number | null;
  point_count: number | null;
  notes: string | null;
  trip_id: number | null;
  flight_plan_name: string | null;
  planned_leg_id: number | null;
  planned_leg_link_source: 'auto' | 'manual' | null;
  planned_leg_prev_trip_id: number | null;
}

const SEED_FLIGHT_DEFAULTS: SeedFlight = {
  aircraft: 'Cessna 172',
  start_time: T0,
  end_time: '2026-09-09T13:00:00.000Z',
  departure_lat: KSBA.lat,
  departure_lon: KSBA.lon,
  arrival_lat: KMRY.lat,
  arrival_lon: KMRY.lon,
  departure_icao: 'KSBA',
  departure_name: 'Santa Barbara Muni',
  arrival_icao: 'KMRY',
  arrival_name: 'Monterey Rgnl',
  duration_sec: 3600,
  distance_nm: 162.5,
  max_altitude_ft: 7500,
  max_airspeed_kts: 120,
  point_count: 2,
  notes: null,
  trip_id: null,
  flight_plan_name: null,
  planned_leg_id: null,
  planned_leg_link_source: null,
  planned_leg_prev_trip_id: null,
};

export function seedFlight(db: Database.Database, over: Partial<SeedFlight> = {}): number {
  const row = { ...SEED_FLIGHT_DEFAULTS, ...over };
  const cols = Object.keys(row);
  const stmt = db.prepare(
    `INSERT INTO flights (${cols.join(', ')}) VALUES (${cols.map(c => `@${c}`).join(', ')})`,
  );
  const result = stmt.run(row as unknown as Record<string, unknown>);
  return Number(result.lastInsertRowid);
}

export interface SeedPoint {
  ts: string;
  lat: number;
  lon: number;
  altitude_ft: number;
  airspeed_kts: number;
  ground_speed_kts: number;
  heading_deg: number;
  vertical_speed_fpm: number;
  on_ground: 0 | 1;
}

const SEED_POINT_DEFAULTS: Omit<SeedPoint, 'ts'> = {
  lat: KSBA.lat,
  lon: KSBA.lon,
  altitude_ft: 1500,
  airspeed_kts: 110,
  ground_speed_kts: 105,
  heading_deg: 270,
  vertical_speed_fpm: 0,
  on_ground: 0,
};

/** `ts` is always explicit: the gap between points is what backfill-durations decides on. */
export function seedPoints(
  db: Database.Database,
  flightId: number,
  points: Array<Partial<SeedPoint> & { ts: string }>,
): void {
  const stmt = db.prepare(`
    INSERT INTO flight_points
      (flight_id, ts, lat, lon, altitude_ft, airspeed_kts, ground_speed_kts, heading_deg, vertical_speed_fpm, on_ground)
    VALUES
      (@flight_id, @ts, @lat, @lon, @altitude_ft, @airspeed_kts, @ground_speed_kts, @heading_deg, @vertical_speed_fpm, @on_ground)
  `);
  const insertAll = db.transaction((rows: Array<Partial<SeedPoint> & { ts: string }>) => {
    for (const point of rows) {
      const row = { ...SEED_POINT_DEFAULTS, ...point };
      stmt.run({ flight_id: flightId, ...row });
    }
  });
  insertAll(points);
}

export interface SeedTrip {
  name: string;
  notes: string | null;
  created_at: string;
  is_active: 0 | 1;
}

const SEED_TRIP_DEFAULTS: SeedTrip = {
  name: 'Test Trip',
  notes: null,
  created_at: T0,
  is_active: 0,
};

export function seedTrip(db: Database.Database, over: Partial<SeedTrip> = {}): number {
  const row = { ...SEED_TRIP_DEFAULTS, ...over };
  const cols = Object.keys(row);
  const stmt = db.prepare(
    `INSERT INTO trips (${cols.join(', ')}) VALUES (${cols.map(c => `@${c}`).join(', ')})`,
  );
  const result = stmt.run(row as unknown as Record<string, unknown>);
  return Number(result.lastInsertRowid);
}

export interface SeedPlannedLeg {
  trip_id: number | null;
  seq: number;
  status: 'planned' | 'flown' | 'diverted' | 'skipped';
  departure_ident: string;
  departure_lat: number;
  departure_lon: number;
  departure_is_airport: 0 | 1;
  destination_ident: string;
  destination_lat: number;
  destination_lon: number;
  destination_is_airport: 0 | 1;
  source_filename: string;
  source_sha256: string;
  imported_at: string;
}

const SEED_PLANNED_LEG_DEFAULTS: Omit<SeedPlannedLeg, 'trip_id'> = {
  seq: 1,
  status: 'planned',
  departure_ident: 'KSBA',
  departure_lat: KSBA.lat,
  departure_lon: KSBA.lon,
  departure_is_airport: 1,
  destination_ident: 'KMRY',
  destination_lat: KMRY.lat,
  destination_lon: KMRY.lon,
  destination_is_airport: 1,
  source_filename: 'VFR Santa Barbara Muni (KSBA) to Monterey Rgnl (KMRY).lnmpln',
  source_sha256: '0'.repeat(64),
  imported_at: T0,
};

/** trip_id: null seeds a loose leg — a prefile that belongs to no trip is a
 *  supported, reachable state. Still required in `over` (no default) so every
 *  call site says explicitly which pool the seeded leg belongs to. */
export function seedPlannedLeg(
  db: Database.Database,
  over: Partial<SeedPlannedLeg> & { trip_id: number | null },
): number {
  const row = { ...SEED_PLANNED_LEG_DEFAULTS, ...over };
  const cols = Object.keys(row);
  const stmt = db.prepare(
    `INSERT INTO planned_legs (${cols.join(', ')}) VALUES (${cols.map(c => `@${c}`).join(', ')})`,
  );
  const result = stmt.run(row as unknown as Record<string, unknown>);
  return Number(result.lastInsertRowid);
}

export interface SeedAcarsMessage {
  flight_id: number | null;
  planned_leg_id: number | null;
  direction: 'in' | 'out';
  category: string;
  body: string;
  sent_at: string;
  dedup_key: string | null;
  correlation_id: number | null;
}

const SEED_ACARS_MESSAGE_DEFAULTS: SeedAcarsMessage = {
  flight_id: null,
  planned_leg_id: null,
  direction: 'in',
  category: 'freetext',
  body: 'TEST MESSAGE',
  sent_at: T0,
  dedup_key: null,
  correlation_id: null,
};

export function seedAcarsMessage(db: Database.Database, over: Partial<SeedAcarsMessage> = {}): number {
  const row = { ...SEED_ACARS_MESSAGE_DEFAULTS, ...over };
  const cols = Object.keys(row);
  const stmt = db.prepare(
    `INSERT INTO acars_messages (${cols.join(', ')}) VALUES (${cols.map(c => `@${c}`).join(', ')})`,
  );
  const result = stmt.run(row as unknown as Record<string, unknown>);
  return Number(result.lastInsertRowid);
}
