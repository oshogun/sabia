// tests/db/schema.test.ts — applySchema()'s idempotency and its column
// migrations, exercised directly against a raw better-sqlite3 handle (not
// through initDb()) so a pre-migration table can be hand-built.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/db/schema';
import { scratchDbRoot } from '../helpers/db';

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
}

function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map(t => t.name)
    .sort();
}

describe('applySchema()', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(scratchDbRoot(), 'msfslogger-test-'));
    db = new Database(path.join(dir, 'flights.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates every application table on a fresh database', () => {
    applySchema(db);
    expect(tableNames(db)).toEqual([
      'acars_messages',
      'app_secret',
      'app_setting',
      'auth_session',
      'auth_user',
      'flight_points',
      'flights',
      'ground_sessions',
      'ingest_tokens',
      'mcp_tokens',
      'navdata_requests',
      'planned_alternates',
      'planned_legs',
      'planned_waypoints',
      'sayintentions_links',
      'sqlite_sequence',
      'trips',
    ]);
  });

  it('is idempotent: running it again changes no table and drops no row', () => {
    applySchema(db);
    db.prepare("INSERT INTO flights (start_time) VALUES ('2026-09-09T12:00:00.000Z')").run();
    const before = tableNames(db);

    expect(() => applySchema(db)).not.toThrow();

    expect(tableNames(db)).toEqual(before);
    const row = db.prepare('SELECT COUNT(*) as n FROM flights').get() as { n: number };
    expect(row.n).toBe(1);
  });

  it('adds trip_id and the planned-leg link columns to a flights table that predates them', () => {
    // Hand-built pre-migration table: only the columns the CREATE TABLE
    // statement declares directly, none of the ones added by ALTER TABLE.
    db.exec(`
      CREATE TABLE flights (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        aircraft         TEXT,
        departure_lat    REAL,
        departure_lon    REAL,
        arrival_lat      REAL,
        arrival_lon      REAL,
        start_time       TEXT NOT NULL,
        end_time         TEXT,
        duration_sec     INTEGER,
        distance_nm      REAL,
        max_altitude_ft  REAL,
        max_airspeed_kts REAL,
        point_count      INTEGER,
        notes            TEXT,
        departure_icao   TEXT,
        departure_name   TEXT,
        arrival_icao     TEXT,
        arrival_name     TEXT
      );
    `);
    const before = columnsOf(db, 'flights');
    expect(before).not.toContain('trip_id');
    expect(before).not.toContain('planned_leg_id');

    applySchema(db);

    const after = columnsOf(db, 'flights');
    expect(after).toContain('trip_id');
    expect(after).toContain('flight_plan_name');
    expect(after).toContain('planned_leg_id');
    expect(after).toContain('planned_leg_link_source');
    expect(after).toContain('planned_leg_prev_trip_id');
  });

  it('adds is_active to a trips table that predates it', () => {
    db.exec(`
      CREATE TABLE trips (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        notes      TEXT,
        created_at TEXT NOT NULL
      );
    `);
    expect(columnsOf(db, 'trips')).not.toContain('is_active');

    applySchema(db);

    expect(columnsOf(db, 'trips')).toContain('is_active');
  });

  describe('planned_legs.trip_id rebuild (pre-migration NOT NULL -> nullable)', () => {
    /**
     * Hand-builds the exact pre-run table: trip_id INTEGER NOT NULL, every
     * other column exactly as applySchema's own CREATE TABLE declares them.
     * better-sqlite3 enforces foreign keys by default even on a bare handle
     * that never set the pragma, so a trips row is seeded first.
     */
    function buildPreMigrationPlannedLegs(): void {
      db.exec(`
        CREATE TABLE trips (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL,
          notes      TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE planned_legs (
          id                     INTEGER PRIMARY KEY AUTOINCREMENT,
          trip_id                INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          seq                    INTEGER NOT NULL,
          status                 TEXT    NOT NULL DEFAULT 'planned'
                                   CHECK (status IN ('planned', 'flown', 'diverted', 'skipped')),
          departure_ident        TEXT    NOT NULL,
          departure_name         TEXT,
          departure_lat          REAL    NOT NULL,
          departure_lon          REAL    NOT NULL,
          departure_is_airport   INTEGER NOT NULL DEFAULT 0,
          departure_start        TEXT,
          departure_start_type   TEXT,
          departure_pos_lat      REAL,
          departure_pos_lon      REAL,
          destination_ident      TEXT    NOT NULL,
          destination_name       TEXT,
          destination_lat        REAL    NOT NULL,
          destination_lon        REAL    NOT NULL,
          destination_is_airport INTEGER NOT NULL DEFAULT 0,
          is_snippet             INTEGER NOT NULL DEFAULT 0,
          cruise_alt_ft          REAL,
          flightplan_type        TEXT,
          aircraft_type          TEXT,
          sid_name               TEXT,
          sid_runway             TEXT,
          sid_transition         TEXT,
          sid_type               TEXT,
          sid_custom_distance_nm REAL,
          star_name              TEXT,
          star_runway            TEXT,
          star_transition        TEXT,
          approach_name          TEXT,
          approach_runway        TEXT,
          approach_transition    TEXT,
          approach_type          TEXT,
          approach_arinc         TEXT,
          approach_suffix        TEXT,
          approach_transition_type TEXT,
          approach_custom_distance_nm REAL,
          approach_custom_altitude_ft REAL,
          approach_custom_offset_deg  REAL,
          waypoint_count         INTEGER NOT NULL DEFAULT 0,
          alternate_count        INTEGER NOT NULL DEFAULT 0,
          approx_distance_nm     REAL    NOT NULL DEFAULT 0,
          arrival_deviation_nm   REAL,
          remarks                TEXT,
          plan_created_at        TEXT,
          source_filename        TEXT    NOT NULL,
          source_sha256          TEXT    NOT NULL,
          source_program         TEXT,
          imported_at            TEXT    NOT NULL
        );
        CREATE TABLE planned_waypoints (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          planned_leg_id    INTEGER NOT NULL REFERENCES planned_legs(id) ON DELETE CASCADE,
          seq               INTEGER NOT NULL,
          ident             TEXT    NOT NULL,
          type              TEXT    NOT NULL,
          lat               REAL    NOT NULL,
          lon               REAL    NOT NULL
        );
        CREATE TABLE planned_alternates (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          planned_leg_id    INTEGER NOT NULL REFERENCES planned_legs(id) ON DELETE CASCADE,
          seq               INTEGER NOT NULL,
          ident             TEXT    NOT NULL
        );
      `);
    }

    function seedOneLeg(): { tripId: number; legId: number } {
      const tripId = db.prepare(
        "INSERT INTO trips (name, created_at) VALUES ('Pre-migration trip', '2026-09-16T00:00:00.000Z')"
      ).run().lastInsertRowid as number;
      const legId = db.prepare(`
        INSERT INTO planned_legs (
          trip_id, seq, status, departure_ident, departure_lat, departure_lon,
          destination_ident, destination_lat, destination_lon,
          source_filename, source_sha256, imported_at
        ) VALUES (?, 1, 'planned', 'KSBA', 34.49, -119.84, 'KMRY', 36.59, -121.84,
          'a.lnmpln', ?, '2026-09-16T00:00:00.000Z')
      `).run(tripId, 'a'.repeat(64)).lastInsertRowid as number;
      db.prepare("INSERT INTO planned_waypoints (planned_leg_id, seq, ident, type, lat, lon) VALUES (?, 1, 'KSBA', 'AIRPORT', 34.49, -119.84)").run(legId);
      db.prepare("INSERT INTO planned_alternates (planned_leg_id, seq, ident) VALUES (?, 1, 'KSMX')").run(legId);
      return { tripId, legId };
    }

    it('drops NOT NULL from trip_id, preserving the seeded row and its children byte for byte', () => {
      buildPreMigrationPlannedLegs();
      const { tripId, legId } = seedOneLeg();
      const before = db.prepare('SELECT * FROM planned_legs WHERE id = ?').get(legId);
      const tripIdColBefore = (db.prepare('PRAGMA table_info(planned_legs)').all() as { name: string; notnull: number }[])
        .find(c => c.name === 'trip_id')!;
      expect(tripIdColBefore.notnull).toBe(1);

      applySchema(db);

      const tripIdColAfter = (db.prepare('PRAGMA table_info(planned_legs)').all() as { name: string; notnull: number }[])
        .find(c => c.name === 'trip_id')!;
      expect(tripIdColAfter.notnull).toBe(0);

      const after = db.prepare('SELECT * FROM planned_legs WHERE id = ?').get(legId);
      expect(after).toEqual(before);
      expect((after as { trip_id: number }).trip_id).toBe(tripId);

      const waypointCount = (db.prepare('SELECT COUNT(*) AS n FROM planned_waypoints WHERE planned_leg_id = ?').get(legId) as { n: number }).n;
      const alternateCount = (db.prepare('SELECT COUNT(*) AS n FROM planned_alternates WHERE planned_leg_id = ?').get(legId) as { n: number }).n;
      expect(waypointCount).toBe(1);
      expect(alternateCount).toBe(1);

      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
    });

    it('running applySchema a second (and third) time is a no-op: no rebuild, no error, no row change', () => {
      buildPreMigrationPlannedLegs();
      const { legId } = seedOneLeg();

      applySchema(db);
      const after1 = db.prepare('SELECT * FROM planned_legs WHERE id = ?').get(legId);
      const tables1 = tableNames(db);

      expect(() => applySchema(db)).not.toThrow();
      expect(() => applySchema(db)).not.toThrow();

      expect(tableNames(db)).toEqual(tables1);
      expect(db.prepare('SELECT * FROM planned_legs WHERE id = ?').get(legId)).toEqual(after1);
      const tripIdCol = (db.prepare('PRAGMA table_info(planned_legs)').all() as { name: string; notnull: number }[])
        .find(c => c.name === 'trip_id')!;
      expect(tripIdCol.notnull).toBe(0);
    });

    it('carries sqlite_sequence across the rebuild so a deleted leg\'s id is never reused', () => {
      buildPreMigrationPlannedLegs();
      const { legId: firstLegId } = seedOneLeg();
      const { legId: secondLegId } = seedOneLeg();
      // Simulate "the highest-numbered leg was deleted": sqlite_sequence.seq
      // now reads higher than MAX(id) in the table the migration will copy.
      db.prepare('DELETE FROM planned_legs WHERE id = ?').run(secondLegId);
      expect(secondLegId).toBeGreaterThan(firstLegId);

      applySchema(db);

      const nextId = db.prepare(`
        INSERT INTO planned_legs (
          trip_id, seq, status, departure_ident, departure_lat, departure_lon,
          destination_ident, destination_lat, destination_lon,
          source_filename, source_sha256, imported_at
        ) VALUES (NULL, 1, 'planned', 'KJFK', 40.64, -73.78, 'KBOS', 42.36, -71.01,
          'b.lnmpln', ?, '2026-09-16T00:00:00.000Z')
      `).run('b'.repeat(64)).lastInsertRowid as number;

      expect(nextId).toBeGreaterThan(secondLegId);
    });
  });
});
