import type { Flight, FlightPoint, FlightWithPoints, Trip, TripWithFlights, TripEditPayload } from '../types';
// Imported from the barrel, not './plannedLegs' directly, to avoid a domain-module
// cross-import; resolves fine since it's only called inside function bodies, never
// at module load.
import { clearPlannedLegLink, getPlannedLegsForTrip } from '../db';
import { getDb } from './connection';

// ── Trips ─────────────────────────────────────────────────────────────────────

export function createTrip(name: string, notes: string | null): number {
  const result = getDb().prepare(
    'INSERT INTO trips (name, notes, created_at) VALUES (?, ?, ?)'
  ).run(name, notes, new Date().toISOString());
  return result.lastInsertRowid as number;
}

export function getTrips(): TripWithFlights[] {
  type AggRow = Trip & { flight_count: number; total_distance_nm: number | null; total_duration_sec: number | null; max_altitude_ft: number | null; planned_leg_count: number };
  const rows = getDb().prepare(`
    SELECT t.*,
      COUNT(f.id)            AS flight_count,
      SUM(f.distance_nm)     AS total_distance_nm,
      SUM(f.duration_sec)    AS total_duration_sec,
      MAX(f.max_altitude_ft) AS max_altitude_ft,
      (SELECT COUNT(*) FROM planned_legs pl WHERE pl.trip_id = t.id) AS planned_leg_count
    FROM trips t
    LEFT JOIN flights f ON f.trip_id = t.id
    GROUP BY t.id
    ORDER BY t.created_at DESC
  `).all() as AggRow[];

  // planned_legs stays [] here, mirroring the existing flights[].points = []:
  // this endpoint is deliberately light. GET /api/trips/:id populates it fully.
  const fetchFlights = getDb().prepare('SELECT * FROM flights WHERE trip_id = ? ORDER BY start_time ASC');
  return rows.map(row => ({
    ...row,
    flights: (fetchFlights.all(row.id) as Flight[]).map(f => ({ ...f, points: [] })),
    planned_legs: [],
  }));
}

export function getTripById(id: number): TripWithFlights | null {
  type AggRow = Trip & { flight_count: number; total_distance_nm: number | null; total_duration_sec: number | null; max_altitude_ft: number | null; planned_leg_count: number };
  const row = getDb().prepare(`
    SELECT t.*,
      COUNT(f.id)            AS flight_count,
      SUM(f.distance_nm)     AS total_distance_nm,
      SUM(f.duration_sec)    AS total_duration_sec,
      MAX(f.max_altitude_ft) AS max_altitude_ft,
      (SELECT COUNT(*) FROM planned_legs pl WHERE pl.trip_id = t.id) AS planned_leg_count
    FROM trips t
    LEFT JOIN flights f ON f.trip_id = t.id
    WHERE t.id = ?
    GROUP BY t.id
  `).get(id) as AggRow | undefined;
  if (!row) return null;

  const flightRows = getDb().prepare('SELECT * FROM flights WHERE trip_id = ? ORDER BY start_time ASC').all(id) as Flight[];
  const fetchPoints = getDb().prepare(`
    SELECT id, flight_id, ts, lat, lon, altitude_ft, airspeed_kts, ground_speed_kts,
           heading_deg, vertical_speed_fpm, on_ground
    FROM flight_points WHERE flight_id = ? ORDER BY ts ASC
  `);
  const flights: FlightWithPoints[] = flightRows.map(f => ({
    ...f,
    points: fetchPoints.all(f.id) as FlightPoint[],
  }));

  // Fully populated, unlike getTrips(): the trip page and the trip map both
  // need the whole chain on first paint, and embedding avoids a race with
  // MapReadySignal on the print path.
  const plannedLegs = getPlannedLegsForTrip(id);

  return { ...row, flights, planned_legs: plannedLegs };
}

/**
 * A trip's name alone, for FlightManager's planned-leg live-status cache —
 * that cache is built once at link time and must not pull in a trip's whole
 * flight/point history just to label it.
 */
export function getTripName(tripId: number): string | null {
  const row = getDb().prepare('SELECT name FROM trips WHERE id = ?').get(tripId) as { name: string } | undefined;
  return row?.name ?? null;
}

export function updateTrip(id: number, payload: TripEditPayload): boolean {
  const allowed = ['name', 'notes'] as const;
  const keys = (Object.keys(payload) as (typeof allowed[number])[]).filter(k => allowed.includes(k));
  if (keys.length === 0) return false;
  const setClauses = keys.map(k => `${k} = ?`).join(', ');
  const values: unknown[] = keys.map(k => payload[k] ?? null);
  values.push(id);
  const result = getDb().prepare(`UPDATE trips SET ${setClauses} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

/**
 * Flights the user put in this trip directly (assignFlightToTrip, or never
 * touched by a link) are NOT restored here — they keep their dangling
 * trip_id after the trip is gone, exactly as before this feature; that
 * pre-existing behaviour is unchanged and stays unchanged. But a flight a
 * LINK moved into this trip is different in kind: the link promised that
 * unlinking restores planned_leg_prev_trip_id, and letting the ON DELETE
 * CASCADE / SET NULL combination run unattended would break that promise
 * silently — it clears planned_leg_id but leaves trip_id dangling at the
 * now-deleted trip and discards planned_leg_prev_trip_id unread. So those
 * flights are read and restored to their prior trip_id here, in the same
 * transaction as the delete and BEFORE it runs: once the trip row is gone,
 * the cascade has already removed the planned_legs rows that make "linked
 * into this trip" findable at all.
 */
export function deleteTrip(id: number): boolean {
  return getDb().transaction((): boolean => {
    const linkedFlights = getDb().prepare(`
      SELECT f.id, f.planned_leg_prev_trip_id
        FROM flights f
        JOIN planned_legs l ON l.id = f.planned_leg_id
       WHERE l.trip_id = ?
    `).all(id) as { id: number; planned_leg_prev_trip_id: number | null }[];

    const restore = getDb().prepare(`
      UPDATE flights
         SET trip_id                  = ?,
             planned_leg_id           = NULL,
             planned_leg_link_source  = NULL,
             planned_leg_prev_trip_id = NULL
       WHERE id = ?
    `);
    for (const flight of linkedFlights) {
      restore.run(flight.planned_leg_prev_trip_id, flight.id);
    }

    const result = getDb().prepare('DELETE FROM trips WHERE id = ?').run(id);
    return result.changes > 0;
  })();
}

/**
 * Putting a flight in a trip by hand is the user overruling wherever it sat
 * before — including a planned-leg link, which owns trip_id: the link moved
 * the flight into the leg's trip, and interleaveTripRows (the trip page, and
 * the PDF) shows a leg through its linked flight, so a leg whose flight has
 * wandered off to another trip disappears from its own trip page — not
 * skippable, not reorderable, not deletable (PlannedLegHasLinkedFlightError)
 * and permanently LEG_ALREADY_LINKED to the auto-matcher. So the link is
 * dropped first, through the same clearPlannedLegLink() deleteFlight() uses:
 * the leg returns to 'planned' and this call's tripId is then the last word
 * on trip_id, with no restore from planned_leg_prev_trip_id fighting it.
 *
 * Assigning a linked flight to the trip its own leg already put it in asks
 * for no change at all, so it keeps the link rather than quietly resetting a
 * 'flown' leg.
 */
export function assignFlightToTrip(flightId: number, tripId: number): boolean {
  return getDb().transaction((): boolean => {
    const linkedLeg = getDb().prepare(`
      SELECT l.trip_id AS trip_id
        FROM flights f
        JOIN planned_legs l ON l.id = f.planned_leg_id
       WHERE f.id = ?
    `).get(flightId) as { trip_id: number } | undefined;

    if (linkedLeg && linkedLeg.trip_id !== tripId) {
      clearPlannedLegLink(flightId);
    }

    const result = getDb().prepare('UPDATE flights SET trip_id = ? WHERE id = ?').run(tripId, flightId);
    return result.changes > 0;
  })();
}

/** Removal always contradicts a link (NULL is no leg's trip), so it always clears one. */
export function removeFlightFromTrip(flightId: number): boolean {
  return getDb().transaction((): boolean => {
    clearPlannedLegLink(flightId);
    const result = getDb().prepare('UPDATE flights SET trip_id = NULL WHERE id = ?').run(flightId);
    return result.changes > 0;
  })();
}
