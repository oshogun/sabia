// tests/db/flights.test.ts — src/db/flights.ts against a real scratch
// database. A real database, never mocked (a file that calls
// createScratchDb() must not vi.mock('../src/db')).
//
// src/flightPlans.ts is a different concern: its fs-touching functions
// resolve a path under process.cwd()/flight_plans, which in this checkout
// holds real PDF attachments for the user's actual logbook. deleteFlight()
// and combineFlights() call into it, so it is mocked here rather than left to
// touch those real files during a test run.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Flight, FlightPoint } from '../../src/types';
import {
  insertFlight,
  closeFlight,
  insertPoint,
  updateFlight,
  setFlightPlanName,
  clearFlightPlanName,
  getFlights,
  getFlightById,
  getFlightPointCount,
  getFlightTrackPoints,
  deleteFlight,
  combineFlights,
  getFlightStats,
  searchFlights,
  countSearchFlights,
} from '../../src/db/flights';
import { createScratchDb, destroyScratchDb, seedFlight, seedPoints, type ScratchDb } from '../helpers/db';
import { T0, KSBA, KMRY } from '../helpers/index';

vi.mock('../../src/flightPlans', () => ({
  copyFlightPlanFile: vi.fn(),
  deleteFlightPlanFile: vi.fn(),
}));

import { copyFlightPlanFile, deleteFlightPlanFile } from '../../src/flightPlans';

let scratch: ScratchDb;

beforeEach(() => {
  scratch = createScratchDb();
});

afterEach(() => {
  destroyScratchDb(scratch);
});

function rawFlight(id: number): Flight | undefined {
  return scratch.db.prepare('SELECT * FROM flights WHERE id = ?').get(id) as Flight | undefined;
}

function rawPointCount(flightId: number): number {
  const row = scratch.db
    .prepare('SELECT COUNT(*) as cnt FROM flight_points WHERE flight_id = ?')
    .get(flightId) as { cnt: number };
  return row.cnt;
}

describe('insertFlight / closeFlight / insertPoint', () => {
  it('defaults departureIcao/departureName to null when omitted', () => {
    const id = insertFlight('Cessna 172', KSBA.lat, KSBA.lon, T0);
    const row = rawFlight(id) as Flight;
    expect(row.departure_icao).toBeNull();
    expect(row.departure_name).toBeNull();
    expect(row.end_time).toBeNull();
  });

  it('stores explicit departureIcao/departureName', () => {
    const id = insertFlight('Cessna 172', KSBA.lat, KSBA.lon, T0, 'KSBA', 'Santa Barbara Muni');
    const row = rawFlight(id) as Flight;
    expect(row.departure_icao).toBe('KSBA');
    expect(row.departure_name).toBe('Santa Barbara Muni');
  });

  it('closeFlight() defaults arrivalIcao/arrivalName to null when omitted', () => {
    const id = insertFlight('Cessna 172', KSBA.lat, KSBA.lon, T0);
    closeFlight(id, '2026-09-09T13:00:00.000Z', KMRY.lat, KMRY.lon, 3600, 162.5, 7500, 120, 2);
    const row = rawFlight(id) as Flight;
    expect(row.arrival_icao).toBeNull();
    expect(row.arrival_name).toBeNull();
    expect(row.end_time).toBe('2026-09-09T13:00:00.000Z');
    expect(row.duration_sec).toBe(3600);
  });

  it('closeFlight() stores explicit arrivalIcao/arrivalName', () => {
    const id = insertFlight('Cessna 172', KSBA.lat, KSBA.lon, T0);
    closeFlight(id, '2026-09-09T13:00:00.000Z', KMRY.lat, KMRY.lon, 3600, 162.5, 7500, 120, 2, 'KMRY', 'Monterey Rgnl');
    const row = rawFlight(id) as Flight;
    expect(row.arrival_icao).toBe('KMRY');
    expect(row.arrival_name).toBe('Monterey Rgnl');
  });

  it('insertPoint() stores onGround as 0/1', () => {
    const id = insertFlight('Cessna 172', KSBA.lat, KSBA.lon, T0);
    insertPoint(id, T0, KSBA.lat, KSBA.lon, 1500, 110, 105, 270, 0, false);
    insertPoint(id, '2026-09-09T12:00:10.000Z', KSBA.lat, KSBA.lon, 0, 0, 0, 270, 0, true);
    const points = scratch.db
      .prepare('SELECT * FROM flight_points WHERE flight_id = ? ORDER BY ts ASC')
      .all(id) as FlightPoint[];
    expect(points.map(p => p.on_ground)).toEqual([0, 1]);
  });
});

describe('updateFlight', () => {
  it('returns false and writes nothing when the payload has no allowed keys', () => {
    const id = seedFlight(scratch.db, { aircraft: 'Cessna 172' });
    expect(updateFlight(id, {})).toBe(false);
    expect((rawFlight(id) as Flight).aircraft).toBe('Cessna 172');
  });

  it('updates aircraft and reports a change', () => {
    const id = seedFlight(scratch.db, { aircraft: 'Cessna 172' });
    expect(updateFlight(id, { aircraft: 'Boeing 738' })).toBe(true);
    expect((rawFlight(id) as Flight).aircraft).toBe('Boeing 738');
  });

  it('returns false for an id that does not exist', () => {
    expect(updateFlight(999999, { aircraft: 'Boeing 738' })).toBe(false);
  });
});

describe('setFlightPlanName / clearFlightPlanName', () => {
  it('sets and clears flight_plan_name', () => {
    const id = seedFlight(scratch.db);
    setFlightPlanName(id, 'KSBA-KMRY.lnmpln');
    expect((rawFlight(id) as Flight).flight_plan_name).toBe('KSBA-KMRY.lnmpln');
    clearFlightPlanName(id);
    expect((rawFlight(id) as Flight).flight_plan_name).toBeNull();
  });
});

describe('getFlights', () => {
  it('orders by start_time DESC', () => {
    const earlier = seedFlight(scratch.db, { start_time: '2026-09-09T10:00:00.000Z' });
    const later = seedFlight(scratch.db, { start_time: '2026-09-09T14:00:00.000Z' });
    expect(getFlights().map(f => f.id)).toEqual([later, earlier]);
  });
});

describe('getFlightById', () => {
  it('returns null when the flight does not exist', () => {
    expect(getFlightById(999999)).toBeNull();
  });

  it('joins flight_points ordered by ts ASC', () => {
    const id = seedFlight(scratch.db);
    seedPoints(scratch.db, id, [
      { ts: '2026-09-09T12:00:10.000Z' },
      { ts: T0 },
    ]);
    const flight = getFlightById(id);
    expect(flight?.id).toBe(id);
    expect(flight?.points.map(p => p.ts)).toEqual([T0, '2026-09-09T12:00:10.000Z']);
  });
});

describe('after_interruption', () => {
  const pointRows = (id: number) => scratch.db
    .prepare('SELECT after_interruption AS a FROM flight_points WHERE flight_id = ? ORDER BY ts ASC')
    .all(id) as { a: number }[];

  it('insertPoint() stores 1 when flagged and 0 for the ten-argument form or an explicit false', () => {
    const id = insertFlight('Cessna 172', KSBA.lat, KSBA.lon, T0);
    insertPoint(id, T0, KSBA.lat, KSBA.lon, 1500, 110, 105, 270, 0, false);
    insertPoint(id, '2026-09-09T12:00:05.000Z', KSBA.lat, KSBA.lon, 1500, 110, 105, 270, 0, false, false);
    insertPoint(id, '2026-09-09T12:00:10.000Z', KSBA.lat, KSBA.lon, 1500, 110, 105, 270, 0, false, true);
    expect(pointRows(id).map(r => r.a)).toEqual([0, 0, 1]);
  });

  it('getFlightTrackPoints() returns the mark as 0 or 1, oldest first', () => {
    const id = insertFlight('Cessna 172', KSBA.lat, KSBA.lon, T0);
    insertPoint(id, '2026-09-09T12:00:10.000Z', KSBA.lat, KSBA.lon, 1500, 110, 105, 270, 0, false, true);
    insertPoint(id, T0, KSBA.lat, KSBA.lon, 1500, 110, 105, 270, 0, false);
    expect(getFlightTrackPoints(id).map(p => p.after_interruption)).toEqual([0, 1]);
  });

  it('getFlightById() points keep exactly the API columns, without the mark', () => {
    const id = insertFlight('Cessna 172', KSBA.lat, KSBA.lon, T0);
    insertPoint(id, T0, KSBA.lat, KSBA.lon, 1500, 110, 105, 270, 0, false, true);
    expect(Object.keys(getFlightById(id)!.points[0])).toEqual([
      'id', 'flight_id', 'ts', 'lat', 'lon', 'altitude_ft', 'airspeed_kts',
      'ground_speed_kts', 'heading_deg', 'vertical_speed_fpm', 'on_ground',
    ]);
  });
});

describe('getFlightPointCount', () => {
  it('counts points for the given flight only', () => {
    const idA = seedFlight(scratch.db);
    const idB = seedFlight(scratch.db);
    seedPoints(scratch.db, idA, [{ ts: T0 }, { ts: '2026-09-09T12:00:10.000Z' }]);
    seedPoints(scratch.db, idB, [{ ts: T0 }]);
    expect(getFlightPointCount(idA)).toBe(2);
    expect(getFlightPointCount(idB)).toBe(1);
  });
});

describe('deleteFlight', () => {
  it('returns false for an id that does not exist', () => {
    expect(deleteFlight(999999)).toBe(false);
  });

  it('deletes the flight row and cascades to its flight_points', () => {
    const id = seedFlight(scratch.db);
    seedPoints(scratch.db, id, [{ ts: T0 }, { ts: '2026-09-09T12:00:10.000Z' }]);
    expect(rawPointCount(id)).toBe(2);

    expect(deleteFlight(id)).toBe(true);

    expect(rawFlight(id)).toBeUndefined();
    expect(rawPointCount(id)).toBe(0);
    expect(deleteFlightPlanFile).toHaveBeenCalledWith(id);
  });
});

describe('combineFlights', () => {
  it('returns null for an invalid combination (neither id exists)', () => {
    expect(combineFlights(999998, 999999)).toBeNull();
  });

  it('merges two flights, carrying stats, points (with fillers) and the flight plan name', () => {
    const idA = seedFlight(scratch.db, {
      start_time: '2026-09-09T12:00:00.000Z',
      end_time: '2026-09-09T12:30:00.000Z',
      duration_sec: 1800,
      max_altitude_ft: 6000,
      max_airspeed_kts: 100,
      notes: 'first leg',
      flight_plan_name: 'KSBA-KMRY.lnmpln',
    });
    seedPoints(scratch.db, idA, [
      { ts: '2026-09-09T12:00:00.000Z', lat: KSBA.lat, lon: KSBA.lon },
      { ts: '2026-09-09T12:15:00.000Z', lat: KSBA.lat, lon: KSBA.lon },
    ]);

    const idB = seedFlight(scratch.db, {
      start_time: '2026-09-09T13:00:00.000Z',
      end_time: '2026-09-09T13:30:00.000Z',
      duration_sec: 1800,
      max_altitude_ft: 7500,
      max_airspeed_kts: 120,
      notes: 'second leg',
    });
    seedPoints(scratch.db, idB, [
      { ts: '2026-09-09T13:00:00.000Z', lat: KMRY.lat, lon: KMRY.lon },
      { ts: '2026-09-09T13:15:00.000Z', lat: KMRY.lat, lon: KMRY.lon },
    ]);

    const newId = combineFlights(idA, idB);
    expect(newId).not.toBeNull();

    const merged = rawFlight(newId as number) as Flight;
    expect(merged.start_time).toBe('2026-09-09T12:00:00.000Z');
    expect(merged.end_time).toBe('2026-09-09T13:30:00.000Z');
    // Sum of both legs' own durations, not the wall-clock span between them.
    expect(merged.duration_sec).toBe(3600);
    expect(merged.max_altitude_ft).toBe(7500);
    expect(merged.max_airspeed_kts).toBe(120);
    expect(merged.notes).toBe('first leg\n---\nsecond leg');
    expect(merged.flight_plan_name).toBe('KSBA-KMRY.lnmpln');
    expect(merged.point_count).toBe(12); // 2 + 8 fillers + 2
    expect(rawPointCount(newId as number)).toBe(12);

    expect(rawFlight(idA)).toBeUndefined();
    expect(rawFlight(idB)).toBeUndefined();
    expect(copyFlightPlanFile).toHaveBeenCalledWith(idA, newId);
    expect(deleteFlightPlanFile).toHaveBeenCalledWith(idA);
    expect(deleteFlightPlanFile).toHaveBeenCalledWith(idB);
  });
});

describe('getFlightStats', () => {
  it('returns zeros, nulls and empty top_* arrays for an empty logbook', () => {
    const stats = getFlightStats({ from: null, to: null });
    expect(stats.totals).toEqual({
      flights: 0,
      completed_flights: 0,
      duration_sec: 0,
      duration_hours: 0,
      distance_nm: 0,
      first_flight_start: null,
      last_flight_start: null,
    });
    expect(stats.top_aircraft).toEqual([]);
    expect(stats.top_routes).toEqual([]);
  });

  it('aggregates totals, top_aircraft and top_routes across several flights', () => {
    seedFlight(scratch.db, {
      aircraft: 'Cessna 172',
      start_time: '2026-09-09T10:00:00.000Z',
      end_time: '2026-09-09T11:00:00.000Z',
      duration_sec: 3600,
      distance_nm: 100,
      departure_icao: 'KSBA',
      arrival_icao: 'KMRY',
    });
    seedFlight(scratch.db, {
      aircraft: 'Cessna 172',
      start_time: '2026-09-10T10:00:00.000Z',
      end_time: '2026-09-10T12:00:00.000Z',
      duration_sec: 7200,
      distance_nm: 100,
      departure_icao: 'KSBA',
      arrival_icao: 'KMRY',
    });
    // In-progress flight: no end_time, no duration_sec — counted in `flights`
    // but not `completed_flights`, and contributes 0 to duration/distance.
    seedFlight(scratch.db, {
      aircraft: 'Boeing 738',
      start_time: '2026-09-11T10:00:00.000Z',
      end_time: null,
      duration_sec: null,
      distance_nm: null,
      departure_icao: 'KMRY',
      arrival_icao: 'KSBA',
    });

    const stats = getFlightStats({ from: null, to: null });
    expect(stats.totals).toEqual({
      flights: 3,
      completed_flights: 2,
      duration_sec: 10800,
      duration_hours: 3,
      distance_nm: 200,
      first_flight_start: '2026-09-09T10:00:00.000Z',
      last_flight_start: '2026-09-11T10:00:00.000Z',
    });
    expect(stats.top_aircraft).toEqual([
      { aircraft: 'Cessna 172', flights: 2, duration_sec: 10800, distance_nm: 200 },
      { aircraft: 'Boeing 738', flights: 1, duration_sec: 0, distance_nm: 0 },
    ]);
    expect(stats.top_routes).toEqual([
      { route: 'KSBA-KMRY', departure_icao: 'KSBA', arrival_icao: 'KMRY', flights: 2, duration_sec: 10800, distance_nm: 200 },
      { route: 'KMRY-KSBA', departure_icao: 'KMRY', arrival_icao: 'KSBA', flights: 1, duration_sec: 0, distance_nm: 0 },
    ]);
  });

  it('bounds start_time with from inclusive and to exclusive', () => {
    seedFlight(scratch.db, { start_time: '2026-01-01T00:00:00.000Z' });
    seedFlight(scratch.db, { start_time: '2026-01-15T00:00:00.000Z' });
    seedFlight(scratch.db, { start_time: '2026-02-01T00:00:00.000Z' });

    const stats = getFlightStats({ from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' });
    expect(stats.totals.flights).toBe(2);
  });

  it('skips a null/empty aircraft, and skips a route missing either ICAO', () => {
    // Valid route, no aircraft: counted in top_routes, absent from top_aircraft.
    seedFlight(scratch.db, { aircraft: null, departure_icao: 'KSBA', arrival_icao: 'KMRY' });
    // Valid aircraft, no departure_icao: counted in top_aircraft, absent from top_routes.
    seedFlight(scratch.db, { aircraft: 'Cessna 172', departure_icao: null, arrival_icao: 'KMRY' });

    const stats = getFlightStats({ from: null, to: null });
    expect(stats.totals.flights).toBe(2);
    expect(stats.top_aircraft).toEqual([{ aircraft: 'Cessna 172', flights: 1, duration_sec: 3600, distance_nm: 162.5 }]);
    expect(stats.top_routes).toEqual([{ route: 'KSBA-KMRY', departure_icao: 'KSBA', arrival_icao: 'KMRY', flights: 1, duration_sec: 3600, distance_nm: 162.5 }]);
  });
});

describe('searchFlights / countSearchFlights', () => {
  it('returns no matches and a zero count for an empty logbook', () => {
    expect(searchFlights(['ksba'], 25, 0)).toEqual([]);
    expect(countSearchFlights(['ksba'])).toBe(0);
  });

  it('matches a token against notes, an ICAO or the aircraft, case-insensitively, ANDing across tokens', () => {
    const bumpy = seedFlight(scratch.db, {
      aircraft: 'Airbus A320neo',
      start_time: '2026-09-09T10:00:00.000Z',
      departure_icao: 'EGLL',
      arrival_icao: 'LFPG',
      notes: 'Bumpy descent into Paris',
    });
    seedFlight(scratch.db, {
      aircraft: 'Cessna 172',
      start_time: '2026-09-10T10:00:00.000Z',
      departure_icao: 'KSBA',
      arrival_icao: 'KMRY',
      notes: 'Smooth VFR trip',
    });

    const results = searchFlights(['EGLL', 'bumpy'], 25, 0);
    expect(results.map(f => f.id)).toEqual([bumpy]);
    expect(countSearchFlights(['EGLL', 'bumpy'])).toBe(1);

    expect(searchFlights(['egll', 'smooth'], 25, 0)).toEqual([]);
  });

  it('treats a literal % or _ in the query as a literal, not a wildcard', () => {
    seedFlight(scratch.db, { notes: 'Fuel burn 100% as planned' });
    seedFlight(scratch.db, { notes: 'Descent rate steady' });

    expect(searchFlights(['100%'], 25, 0)).toHaveLength(1);
    expect(countSearchFlights(['100%'])).toBe(1);
  });

  it('orders by start_time DESC and pages with limit/offset against a stable total', () => {
    const older = seedFlight(scratch.db, { notes: 'shared term', start_time: '2026-09-09T10:00:00.000Z' });
    const newer = seedFlight(scratch.db, { notes: 'shared term', start_time: '2026-09-10T10:00:00.000Z' });

    expect(countSearchFlights(['shared'])).toBe(2);
    expect(searchFlights(['shared'], 25, 0).map(f => f.id)).toEqual([newer, older]);
    expect(searchFlights(['shared'], 1, 0).map(f => f.id)).toEqual([newer]);
    expect(searchFlights(['shared'], 1, 1).map(f => f.id)).toEqual([older]);
  });
});
