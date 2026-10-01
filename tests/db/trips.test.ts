// tests/db/trips.test.ts — src/db/trips.ts against a real scratch database.
// A real database, never mocked (a file that calls createScratchDb() must
// not vi.mock('../src/db')).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTrip,
  getTrips,
  getTripById,
  getTripName,
  updateTrip,
  deleteTrip,
  assignFlightToTrip,
  removeFlightFromTrip,
} from '../../src/db/trips';
import { createScratchDb, destroyScratchDb, seedFlight, seedTrip, seedPlannedLeg, type ScratchDb } from '../helpers/db';
import { T0 } from '../helpers';

let scratch: ScratchDb;

beforeEach(() => {
  scratch = createScratchDb();
});

afterEach(() => {
  destroyScratchDb(scratch);
});

describe('createTrip()', () => {
  it('inserts a row and returns its id', () => {
    const id = createTrip('Alaska 2026', 'bush strips');
    const row = scratch.db.prepare('SELECT name, notes, created_at FROM trips WHERE id = ?').get(id) as
      { name: string; notes: string | null; created_at: string };
    expect(row.name).toBe('Alaska 2026');
    expect(row.notes).toBe('bush strips');
    expect(typeof row.created_at).toBe('string');
  });

  it('accepts null notes', () => {
    const id = createTrip('No notes', null);
    const row = scratch.db.prepare('SELECT notes FROM trips WHERE id = ?').get(id) as { notes: string | null };
    expect(row.notes).toBeNull();
  });
});

describe('getTrips()', () => {
  it('aggregates flight counts, sums, max altitude and planned-leg counts per trip', () => {
    const tripId = seedTrip(scratch.db, { name: 'With flights' });
    seedFlight(scratch.db, { trip_id: tripId, distance_nm: 100, duration_sec: 1000, max_altitude_ft: 5000 });
    seedFlight(scratch.db, { trip_id: tripId, distance_nm: 50, duration_sec: 500, max_altitude_ft: 9000 });
    seedPlannedLeg(scratch.db, { trip_id: tripId });

    const [row] = getTrips().filter(t => t.id === tripId);
    expect(row.flight_count).toBe(2);
    expect(row.total_distance_nm).toBe(150);
    expect(row.total_duration_sec).toBe(1500);
    expect(row.max_altitude_ft).toBe(9000);
    expect(row.planned_leg_count).toBe(1);
    expect(row.flights).toHaveLength(2);
    expect(row.flights.every(f => f.points.length === 0)).toBe(true);
    expect(row.planned_legs).toEqual([]);
  });

  it('reports zero flights and null aggregates for a trip with no flights', () => {
    const tripId = seedTrip(scratch.db, { name: 'Empty' });

    const [row] = getTrips().filter(t => t.id === tripId);
    expect(row.flight_count).toBe(0);
    expect(row.total_distance_nm).toBeNull();
    expect(row.total_duration_sec).toBeNull();
    expect(row.max_altitude_ft).toBeNull();
    expect(row.planned_leg_count).toBe(0);
    expect(row.flights).toEqual([]);
  });

  it('orders by created_at DESC', () => {
    const olderId = seedTrip(scratch.db, { name: 'Older', created_at: '2026-01-01T00:00:00.000Z' });
    const newerId = seedTrip(scratch.db, { name: 'Newer', created_at: '2026-06-01T00:00:00.000Z' });

    const ids = getTrips().map(t => t.id);
    expect(ids.indexOf(newerId)).toBeLessThan(ids.indexOf(olderId));
  });
});

describe('getTripById()', () => {
  it('returns null for a trip that does not exist', () => {
    expect(getTripById(999999)).toBeNull();
  });

  it('fully populates flights (with points) and planned_legs', () => {
    const tripId = seedTrip(scratch.db, { name: 'Full' });
    const flightId = seedFlight(scratch.db, { trip_id: tripId, start_time: T0 });
    scratch.db.prepare(`
      INSERT INTO flight_points (flight_id, ts, lat, lon, altitude_ft, airspeed_kts, ground_speed_kts, heading_deg, vertical_speed_fpm, on_ground)
      VALUES (?, ?, 34.4, -119.8, 1500, 110, 105, 270, 0, 0)
    `).run(flightId, T0);
    seedPlannedLeg(scratch.db, { trip_id: tripId });

    const trip = getTripById(tripId);
    expect(trip).not.toBeNull();
    expect(trip!.flights).toHaveLength(1);
    expect(trip!.flights[0].points).toHaveLength(1);
    expect(trip!.planned_legs).toHaveLength(1);
    expect(trip!.planned_legs[0].trip_id).toBe(tripId);
  });

  it('returns points with exactly the API columns, without the interruption mark', () => {
    const tripId = seedTrip(scratch.db);
    const flightId = seedFlight(scratch.db, { trip_id: tripId, start_time: T0 });
    scratch.db.prepare(`
      INSERT INTO flight_points (flight_id, ts, lat, lon, altitude_ft, airspeed_kts, ground_speed_kts, heading_deg, vertical_speed_fpm, on_ground, after_interruption)
      VALUES (?, ?, 34.4, -119.8, 1500, 110, 105, 270, 0, 0, 1)
    `).run(flightId, T0);

    expect(Object.keys(getTripById(tripId)!.flights[0].points[0])).toEqual([
      'id', 'flight_id', 'ts', 'lat', 'lon', 'altitude_ft', 'airspeed_kts',
      'ground_speed_kts', 'heading_deg', 'vertical_speed_fpm', 'on_ground',
    ]);
  });

  it('orders a trip\'s flights by start_time ASC', () => {
    const tripId = seedTrip(scratch.db);
    const laterId = seedFlight(scratch.db, { trip_id: tripId, start_time: '2026-06-01T00:00:00.000Z' });
    const earlierId = seedFlight(scratch.db, { trip_id: tripId, start_time: '2026-01-01T00:00:00.000Z' });

    const trip = getTripById(tripId);
    expect(trip!.flights.map(f => f.id)).toEqual([earlierId, laterId]);
  });
});

describe('getTripName()', () => {
  it('returns the name for an existing trip', () => {
    const tripId = seedTrip(scratch.db, { name: 'Named Trip' });
    expect(getTripName(tripId)).toBe('Named Trip');
  });

  it('returns null for a trip that does not exist', () => {
    expect(getTripName(999999)).toBeNull();
  });
});

describe('updateTrip()', () => {
  it('updates name and notes and returns true', () => {
    const tripId = seedTrip(scratch.db, { name: 'Old', notes: 'old notes' });

    const ok = updateTrip(tripId, { name: 'New', notes: 'new notes' });

    expect(ok).toBe(true);
    const row = scratch.db.prepare('SELECT name, notes FROM trips WHERE id = ?').get(tripId) as
      { name: string; notes: string | null };
    expect(row).toEqual({ name: 'New', notes: 'new notes' });
  });

  it('updates only the fields present in the payload', () => {
    const tripId = seedTrip(scratch.db, { name: 'Keep', notes: 'keep notes' });

    updateTrip(tripId, { name: 'Renamed' });

    const row = scratch.db.prepare('SELECT name, notes FROM trips WHERE id = ?').get(tripId) as
      { name: string; notes: string | null };
    expect(row).toEqual({ name: 'Renamed', notes: 'keep notes' });
  });

  it('returns false and writes nothing when the payload has no allowed keys', () => {
    const tripId = seedTrip(scratch.db, { name: 'Untouched' });

    const ok = updateTrip(tripId, {});

    expect(ok).toBe(false);
    const row = scratch.db.prepare('SELECT name FROM trips WHERE id = ?').get(tripId) as { name: string };
    expect(row.name).toBe('Untouched');
  });

  it('returns false for a trip that does not exist', () => {
    expect(updateTrip(999999, { name: 'Nope' })).toBe(false);
  });
});

describe('deleteTrip()', () => {
  it('returns false for a trip that does not exist', () => {
    expect(deleteTrip(999999)).toBe(false);
  });

  it('deletes the trip and returns true', () => {
    const tripId = seedTrip(scratch.db);

    expect(deleteTrip(tripId)).toBe(true);

    expect(scratch.db.prepare('SELECT id FROM trips WHERE id = ?').get(tripId)).toBeUndefined();
  });

  it('leaves a directly-assigned flight\'s dangling trip_id untouched', () => {
    const tripId = seedTrip(scratch.db);
    const flightId = seedFlight(scratch.db, { trip_id: tripId });

    deleteTrip(tripId);

    const row = scratch.db.prepare('SELECT trip_id FROM flights WHERE id = ?').get(flightId) as { trip_id: number | null };
    expect(row.trip_id).toBe(tripId);
  });

  it('restores a linked flight to planned_leg_prev_trip_id and clears the link', () => {
    const priorTripId = seedTrip(scratch.db, { name: 'Prior' });
    const tripId = seedTrip(scratch.db, { name: 'To delete' });
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId });
    const flightId = seedFlight(scratch.db, {
      trip_id: tripId,
      planned_leg_id: legId,
      planned_leg_link_source: 'auto',
      planned_leg_prev_trip_id: priorTripId,
    });

    expect(deleteTrip(tripId)).toBe(true);

    const row = scratch.db.prepare(`
      SELECT trip_id, planned_leg_id, planned_leg_link_source, planned_leg_prev_trip_id
        FROM flights WHERE id = ?
    `).get(flightId) as {
      trip_id: number | null; planned_leg_id: number | null;
      planned_leg_link_source: string | null; planned_leg_prev_trip_id: number | null;
    };
    expect(row).toEqual({
      trip_id: priorTripId,
      planned_leg_id: null,
      planned_leg_link_source: null,
      planned_leg_prev_trip_id: null,
    });
    expect(scratch.db.prepare('SELECT id FROM planned_legs WHERE id = ?').get(legId)).toBeUndefined();
  });
});

describe('assignFlightToTrip()', () => {
  it('sets trip_id and returns true', () => {
    const tripId = seedTrip(scratch.db);
    const flightId = seedFlight(scratch.db, { trip_id: null });

    expect(assignFlightToTrip(flightId, tripId)).toBe(true);

    const row = scratch.db.prepare('SELECT trip_id FROM flights WHERE id = ?').get(flightId) as { trip_id: number };
    expect(row.trip_id).toBe(tripId);
  });

  it('returns false for a flight that does not exist', () => {
    const tripId = seedTrip(scratch.db);
    expect(assignFlightToTrip(999999, tripId)).toBe(false);
  });

  it('clears a link to a leg in a different trip before reassigning', () => {
    const legTripId = seedTrip(scratch.db, { name: 'Leg trip' });
    const otherTripId = seedTrip(scratch.db, { name: 'Other trip' });
    const legId = seedPlannedLeg(scratch.db, { trip_id: legTripId, status: 'flown' });
    const flightId = seedFlight(scratch.db, {
      trip_id: legTripId,
      planned_leg_id: legId,
      planned_leg_link_source: 'auto',
      planned_leg_prev_trip_id: null,
    });

    expect(assignFlightToTrip(flightId, otherTripId)).toBe(true);

    const flightRow = scratch.db.prepare(`
      SELECT trip_id, planned_leg_id, planned_leg_link_source FROM flights WHERE id = ?
    `).get(flightId) as { trip_id: number; planned_leg_id: number | null; planned_leg_link_source: string | null };
    expect(flightRow).toEqual({ trip_id: otherTripId, planned_leg_id: null, planned_leg_link_source: null });
    const legRow = scratch.db.prepare('SELECT status FROM planned_legs WHERE id = ?').get(legId) as { status: string };
    expect(legRow.status).toBe('planned');
  });

  it('keeps the link when assigning a linked flight to its own leg\'s trip', () => {
    const tripId = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId, status: 'flown' });
    const flightId = seedFlight(scratch.db, {
      trip_id: tripId,
      planned_leg_id: legId,
      planned_leg_link_source: 'auto',
    });

    expect(assignFlightToTrip(flightId, tripId)).toBe(true);

    const row = scratch.db.prepare('SELECT planned_leg_id FROM flights WHERE id = ?').get(flightId) as
      { planned_leg_id: number | null };
    expect(row.planned_leg_id).toBe(legId);
  });
});

describe('removeFlightFromTrip()', () => {
  it('sets trip_id to null and returns true', () => {
    const tripId = seedTrip(scratch.db);
    const flightId = seedFlight(scratch.db, { trip_id: tripId });

    expect(removeFlightFromTrip(flightId)).toBe(true);

    const row = scratch.db.prepare('SELECT trip_id FROM flights WHERE id = ?').get(flightId) as { trip_id: number | null };
    expect(row.trip_id).toBeNull();
  });

  it('returns false for a flight that does not exist', () => {
    expect(removeFlightFromTrip(999999)).toBe(false);
  });

  it('clears an existing planned-leg link', () => {
    const tripId = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId, status: 'flown' });
    const flightId = seedFlight(scratch.db, {
      trip_id: tripId,
      planned_leg_id: legId,
      planned_leg_link_source: 'manual',
    });

    removeFlightFromTrip(flightId);

    const flightRow = scratch.db.prepare('SELECT trip_id, planned_leg_id FROM flights WHERE id = ?').get(flightId) as
      { trip_id: number | null; planned_leg_id: number | null };
    expect(flightRow).toEqual({ trip_id: null, planned_leg_id: null });
    const legRow = scratch.db.prepare('SELECT status FROM planned_legs WHERE id = ?').get(legId) as { status: string };
    expect(legRow.status).toBe('planned');
  });
});
