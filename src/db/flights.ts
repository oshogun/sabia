import type { Flight, FlightPoint, FlightWithPoints, FlightEditPayload } from '../types';
import { copyFlightPlanFile, deleteFlightPlanFile } from '../flightPlans';
// Imported from the barrel, not './plannedLegs' directly, to avoid a domain-module
// cross-import; resolves fine since it's only called inside function bodies, never
// at module load.
import { clearPlannedLegLink } from '../db';
import { getDb } from './connection';

// ── Geo helpers ───────────────────────────────────────────────────────────────

function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3440.065;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLon = toRad(lon2 - lon1);
  const la1 = toRad(lat1);
  const la2 = toRad(lat2);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}
// ── Flight CRUD ───────────────────────────────────────────────────────────────

export function insertFlight(aircraft: string, lat: number, lon: number, startTime: string, departureIcao: string | null = null, departureName: string | null = null): number {
  const result = getDb().prepare(`
    INSERT INTO flights (aircraft, departure_lat, departure_lon, departure_icao, departure_name, start_time)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(aircraft, lat, lon, departureIcao, departureName, startTime);
  return result.lastInsertRowid as number;
}

export function closeFlight(
  id: number,
  endTime: string,
  arrivalLat: number,
  arrivalLon: number,
  durationSec: number,
  distanceNm: number,
  maxAltitudeFt: number,
  maxAirspeedKts: number,
  pointCount: number,
  arrivalIcao: string | null = null,
  arrivalName: string | null = null
): void {
  getDb().prepare(`
    UPDATE flights SET
      end_time         = ?,
      arrival_lat      = ?,
      arrival_lon      = ?,
      duration_sec     = ?,
      distance_nm      = ?,
      max_altitude_ft  = ?,
      max_airspeed_kts = ?,
      point_count      = ?,
      arrival_icao     = ?,
      arrival_name     = ?
    WHERE id = ?
  `).run(endTime, arrivalLat, arrivalLon, durationSec, distanceNm, maxAltitudeFt, maxAirspeedKts, pointCount, arrivalIcao, arrivalName, id);
}

export function updateFlight(id: number, payload: FlightEditPayload): boolean {
  const allowed = ['aircraft', 'notes'] as const;
  const keys = (Object.keys(payload) as (typeof allowed[number])[]).filter(k => allowed.includes(k));
  if (keys.length === 0) return false;

  const setClauses = keys.map(k => `${k} = ?`).join(', ');
  const values: unknown[] = keys.map(k => payload[k] ?? null);
  values.push(id);

  const result = getDb().prepare(`UPDATE flights SET ${setClauses} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

export function setFlightPlanName(id: number, name: string): void {
  getDb().prepare('UPDATE flights SET flight_plan_name = ? WHERE id = ?').run(name, id);
}

export function clearFlightPlanName(id: number): void {
  getDb().prepare('UPDATE flights SET flight_plan_name = NULL WHERE id = ?').run(id);
}

export function insertPoint(
  flightId: number,
  ts: string,
  lat: number,
  lon: number,
  altitudeFt: number,
  airspeedKts: number,
  groundSpeedKts: number,
  headingDeg: number,
  verticalSpeedFpm: number,
  onGround: boolean,
  afterInterruption = false
): void {
  getDb().prepare(`
    INSERT INTO flight_points
      (flight_id, ts, lat, lon, altitude_ft, airspeed_kts, ground_speed_kts, heading_deg, vertical_speed_fpm, on_ground, after_interruption)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(flightId, ts, lat, lon, altitudeFt, airspeedKts, groundSpeedKts, headingDeg, verticalSpeedFpm, onGround ? 1 : 0, afterInterruption ? 1 : 0);
}

export function getFlights(): Flight[] {
  return getDb().prepare('SELECT * FROM flights ORDER BY start_time DESC').all() as Flight[];
}

export function getFlightById(id: number): FlightWithPoints | null {
  const flight = getDb().prepare('SELECT * FROM flights WHERE id = ?').get(id) as Flight | undefined;
  if (!flight) return null;
  const points = getDb().prepare(`
    SELECT id, flight_id, ts, lat, lon, altitude_ft, airspeed_kts, ground_speed_kts,
           heading_deg, vertical_speed_fpm, on_ground
    FROM flight_points WHERE flight_id = ? ORDER BY ts ASC
  `).all(id) as FlightPoint[];
  return { ...flight, points };
}

export function getFlightPointCount(id: number): number {
  const row = getDb().prepare('SELECT COUNT(*) as cnt FROM flight_points WHERE flight_id = ?').get(id) as { cnt: number };
  return row.cnt;
}

export function deleteFlight(id: number): boolean {
  // The FK is on flights.planned_leg_id, so deleting the row would drop the
  // link but leave the leg permanently 'flown'/'diverted' by a flight that no
  // longer exists. Same idiom as deleteFlightPlanFile() below.
  clearPlannedLegLink(id);
  const result = getDb().prepare('DELETE FROM flights WHERE id = ?').run(id);
  if (result.changes > 0) deleteFlightPlanFile(id);
  return result.changes > 0;
}

// ── Resuming an interrupted flight ──────────────────────────────────────────

/** The narrow projection of a flights row that resuming an interrupted flight
 *  needs: its identity, when it really began, and where it departed from. */
export interface OpenFlightRow {
  id: number;
  aircraft: string | null;
  start_time: string;
  departure_lat: number | null;
  departure_lon: number | null;
}

/** A strict subset of FlightPoint (src/types.ts:96) plus the stored
 *  interruption mark — the only columns the accumulator reconstruction reads. */
export interface FlightTrackPoint {
  lat: number;
  lon: number;
  altitude_ft: number;
  airspeed_kts: number;
  ts: string;
  /** 1 when the point was written while recording was interrupted; absent means 0. */
  after_interruption?: number;
}

/**
 * The flights row still in progress (end_time IS NULL), or null.
 *
 * Unlike ground_sessions, the flights table has NO partial unique index
 * enforcing at most one open row — verified against the schema: the only
 * unique indexes on flights are idx_flights_planned_leg and (elsewhere)
 * idx_ground_sessions_open, neither of which constrains end_time. So more
 * than one open row is possible, and the anomaly is handled here rather than
 * thrown: the most recently started row is returned and every other open row
 * is named in a warning and left exactly as it is. Nothing in this function
 * may throw on that path — a throw here would be able to stop a real takeoff
 * from ever recording a flight.
 */
export function getOpenFlight(): OpenFlightRow | null {
  const rows = getDb().prepare(`
    SELECT id, aircraft, start_time, departure_lat, departure_lon
    FROM flights
    WHERE end_time IS NULL
    ORDER BY start_time DESC, id DESC
  `).all() as OpenFlightRow[];

  if (rows.length === 0) return null;
  if (rows.length > 1) {
    const orphans = rows.slice(1).map(r => `#${r.id}`).join(', ');
    console.warn(
      `[db/flights] ${rows.length} flights rows are open; adopting #${rows[0].id} ` +
      `(started ${rows[0].start_time}) and leaving ${orphans} untouched as orphans`
    );
  }
  return rows[0];
}

/**
 * Every recorded point of one flight, oldest first, in the six columns the
 * caller needs to rebuild a flight's accumulators. Raw rows only: distance,
 * maxima and the gap-summed duration are computed by the caller, never by
 * SQL. Empty array when the flight has no points.
 */
export function getFlightTrackPoints(flightId: number): FlightTrackPoint[] {
  return getDb().prepare(`
    SELECT lat, lon, altitude_ft, airspeed_kts, ts, after_interruption
    FROM flight_points
    WHERE flight_id = ?
    ORDER BY ts ASC
  `).all(flightId) as FlightTrackPoint[];
}

// ── Combine flights ───────────────────────────────────────────────────────────

type InsertablePoint = Omit<FlightPoint, 'id' | 'flight_id'>;

const FILLER_COUNT = 8;

/**
 * A single flight's own logged duration, never spanning into another flight.
 * Falls back to its own start→end wall clock for rows predating duration_sec.
 *
 * Takes only the three columns it needs (rather than a full Flight) so the
 * stats aggregation below can reuse it against a narrower SELECT.
 */
function ownDurationSec(flight: Pick<Flight, 'duration_sec' | 'end_time' | 'start_time'>): number {
  if (flight.duration_sec != null) return flight.duration_sec;
  if (!flight.end_time) return 0;
  return Math.max(0, Math.round(
    (new Date(flight.end_time).getTime() - new Date(flight.start_time).getTime()) / 1000
  ));
}

export function combineFlights(idA: number, idB: number): number | null {
  return getDb().transaction((): number | null => {
    const flightA = getDb().prepare('SELECT * FROM flights WHERE id = ?').get(idA) as Flight | undefined;
    const flightB = getDb().prepare('SELECT * FROM flights WHERE id = ?').get(idB) as Flight | undefined;
    if (!flightA || !flightB) return null;

    const [first, second] =
      new Date(flightA.start_time) <= new Date(flightB.start_time)
        ? [flightA, flightB]
        : [flightB, flightA];

    const fetchPoints = getDb().prepare('SELECT * FROM flight_points WHERE flight_id = ? ORDER BY ts ASC');
    const firstPts  = fetchPoints.all(first.id)  as FlightPoint[];
    const secondPts = fetchPoints.all(second.id) as FlightPoint[];

    const fillerPts: InsertablePoint[] = [];

    if (firstPts.length > 0 && secondPts.length > 0) {
      const p1 = firstPts[firstPts.length - 1];
      const p2 = secondPts[0];
      const t1 = new Date(p1.ts).getTime();
      const t2 = new Date(p2.ts).getTime();
      // If timestamps are inverted (data anomaly) space fillers 1s apart from p1
      const tStep = t2 > t1 ? (t2 - t1) : 1000;
      const tBase = t1;
      const hdg = bearingDeg(p1.lat, p1.lon, p2.lat, p2.lon);

      for (let i = 1; i <= FILLER_COUNT; i++) {
        const t = i / (FILLER_COUNT + 1);
        fillerPts.push({
          ts:                new Date(tBase + t * tStep).toISOString(),
          lat:               p1.lat + t * (p2.lat - p1.lat),
          lon:               p1.lon + t * (p2.lon - p1.lon),
          altitude_ft:       p1.altitude_ft + t * (p2.altitude_ft - p1.altitude_ft),
          airspeed_kts:      0,
          ground_speed_kts:  0,
          heading_deg:       hdg,
          vertical_speed_fpm: 0,
          on_ground:         0,
        });
      }
    }

    const gapDistNm =
      firstPts.length > 0 && secondPts.length > 0
        ? haversineNm(
            firstPts[firstPts.length - 1].lat, firstPts[firstPts.length - 1].lon,
            secondPts[0].lat, secondPts[0].lon
          )
        : 0;

    const newDistanceNm  = (first.distance_nm  ?? 0) + gapDistNm + (second.distance_nm  ?? 0);
    const newMaxAlt      = Math.max(first.max_altitude_ft  ?? 0, second.max_altitude_ft  ?? 0);
    const newMaxSpeed    = Math.max(first.max_airspeed_kts ?? 0, second.max_airspeed_kts ?? 0);
    const newPointCount  = firstPts.length + fillerPts.length + secondPts.length;
    const effectiveEndTime =
      second.end_time ??
      (secondPts.length > 0 ? secondPts[secondPts.length - 1].ts : first.end_time ?? new Date().toISOString());

    // Sum the legs' own durations rather than measuring first.start → second.end.
    // A long pause can cause one flight to be logged as two, and the wall-clock
    // gap between the halves is exactly that pause — it must not be counted.
    const durationSec = ownDurationSec(first) + ownDurationSec(second);
    const aircraft = first.aircraft ?? second.aircraft ?? null;
    const noteParts = [first.notes, second.notes].filter(Boolean);
    const notes = noteParts.length > 0 ? noteParts.join('\n---\n') : null;

    const newId = getDb().prepare(`
      INSERT INTO flights
        (aircraft, departure_lat, departure_lon, arrival_lat, arrival_lon,
         start_time, end_time, duration_sec, distance_nm,
         max_altitude_ft, max_airspeed_kts, point_count, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      aircraft,
      first.departure_lat,  first.departure_lon,
      second.arrival_lat,   second.arrival_lon,
      first.start_time,     effectiveEndTime,
      durationSec,
      Math.round(newDistanceNm * 10) / 10,
      Math.round(newMaxAlt),
      Math.round(newMaxSpeed),
      newPointCount,
      notes
    ).lastInsertRowid as number;

    const insertPt = getDb().prepare(`
      INSERT INTO flight_points
        (flight_id, ts, lat, lon, altitude_ft, airspeed_kts, ground_speed_kts,
         heading_deg, vertical_speed_fpm, on_ground)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const p of [...firstPts, ...fillerPts, ...secondPts]) {
      insertPt.run(newId, p.ts, p.lat, p.lon, p.altitude_ft,
        p.airspeed_kts, p.ground_speed_kts, p.heading_deg, p.vertical_speed_fpm, p.on_ground);
    }

    // Carry over whichever flight had an attached flight plan (preferring the earlier one)
    const flightPlanSource = first.flight_plan_name ? first : (second.flight_plan_name ? second : null);
    if (flightPlanSource) {
      copyFlightPlanFile(flightPlanSource.id, newId);
      setFlightPlanName(newId, flightPlanSource.flight_plan_name as string);
    }
    deleteFlightPlanFile(first.id);
    deleteFlightPlanFile(second.id);

    // Unlike the PDF attachment above, a planned-leg link is deliberately NOT
    // carried to the combined flight: this INSERT does not carry trip_id
    // either, so a carried-over link would put the new flight in no trip
    // while claiming a leg that belongs to one. Combining is a repair
    // operation; the user re-links by hand with the escape hatch. Do not
    // touch filler-point interpolation or ownDurationSec here.
    clearPlannedLegLink(first.id);
    clearPlannedLegLink(second.id);

    getDb().prepare('DELETE FROM flights WHERE id = ?').run(first.id);
    getDb().prepare('DELETE FROM flights WHERE id = ?').run(second.id);

    return newId;
  })();
}

// ── Stats aggregation ─────────────────────────────────────────────────────────

/** Both bounds already normalised to ISO-8601 UTC; from is inclusive, to is
 *  exclusive, either may be null for "no bound". */
export interface FlightStatsFilter {
  from: string | null;
  to: string | null;
}

export interface AircraftStat {
  /** Exactly as stored in flights.aircraft — never normalised. */
  aircraft: string;
  flights: number;
  duration_sec: number;
  distance_nm: number;
}

export interface RouteStat {
  /** `${departure_icao}-${arrival_icao}`, directional. */
  route: string;
  departure_icao: string;
  arrival_icao: string;
  flights: number;
  duration_sec: number;
  distance_nm: number;
}

export interface FlightStats {
  filter: FlightStatsFilter;
  totals: {
    flights: number;
    completed_flights: number;
    duration_sec: number;
    duration_hours: number;
    distance_nm: number;
    first_flight_start: string | null;
    last_flight_start: string | null;
  };
  top_aircraft: AircraftStat[];
  top_routes: RouteStat[];
}

interface FlightStatsRow {
  id: number;
  aircraft: string | null;
  start_time: string;
  end_time: string | null;
  duration_sec: number | null;
  distance_nm: number | null;
  departure_icao: string | null;
  arrival_icao: string | null;
  point_count: number | null;
}

/** Top-N aggregates, keyed by an arbitrary string; started lazily on first hit. */
function bumpAggregate<K>(map: Map<K, { flights: number; duration_sec: number; distance_nm: number }>, key: K, durationSec: number, distanceNm: number): void {
  const entry = map.get(key) ?? { flights: 0, duration_sec: 0, distance_nm: 0 };
  entry.flights += 1;
  entry.duration_sec += durationSec;
  entry.distance_nm += distanceNm;
  map.set(key, entry);
}

export function getFlightStats(filter: FlightStatsFilter): FlightStats {
  const conditions: string[] = [];
  const params: string[] = [];
  if (filter.from !== null) { conditions.push('start_time >= ?'); params.push(filter.from); }
  if (filter.to !== null) { conditions.push('start_time < ?'); params.push(filter.to); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = getDb().prepare(`
    SELECT id, aircraft, start_time, end_time, duration_sec, distance_nm,
           departure_icao, arrival_icao, point_count
    FROM flights ${where}
  `).all(...params) as FlightStatsRow[];

  let completedFlights = 0;
  let totalDurationSec = 0;
  let totalDistanceNm = 0;
  let firstFlightStart: string | null = null;
  let lastFlightStart: string | null = null;
  const aircraftAgg = new Map<string, { flights: number; duration_sec: number; distance_nm: number }>();
  const routeAgg = new Map<string, { departure_icao: string; arrival_icao: string; flights: number; duration_sec: number; distance_nm: number }>();

  for (const row of rows) {
    if (row.end_time !== null) completedFlights += 1;
    const durationSec = ownDurationSec(row);
    const distanceNm = row.distance_nm ?? 0;
    totalDurationSec += durationSec;
    totalDistanceNm += distanceNm;

    if (firstFlightStart === null || row.start_time < firstFlightStart) firstFlightStart = row.start_time;
    if (lastFlightStart === null || row.start_time > lastFlightStart) lastFlightStart = row.start_time;

    // Skipped (not bucketed under "Unknown") when null or empty — guessing a
    // grouping key would invent data the logbook doesn't have.
    if (row.aircraft) {
      bumpAggregate(aircraftAgg, row.aircraft, durationSec, distanceNm);
    }

    if (row.departure_icao && row.arrival_icao) {
      const key = `${row.departure_icao}-${row.arrival_icao}`;
      const entry = routeAgg.get(key) ?? { departure_icao: row.departure_icao, arrival_icao: row.arrival_icao, flights: 0, duration_sec: 0, distance_nm: 0 };
      entry.flights += 1;
      entry.duration_sec += durationSec;
      entry.distance_nm += distanceNm;
      routeAgg.set(key, entry);
    }
  }

  const topAircraft: AircraftStat[] = [...aircraftAgg.entries()]
    .map(([aircraft, v]) => ({ aircraft, flights: v.flights, duration_sec: v.duration_sec, distance_nm: Math.round(v.distance_nm * 10) / 10 }))
    .sort((a, b) => b.flights - a.flights || b.duration_sec - a.duration_sec || (a.aircraft < b.aircraft ? -1 : a.aircraft > b.aircraft ? 1 : 0))
    .slice(0, 5);

  const topRoutes: RouteStat[] = [...routeAgg.entries()]
    .map(([route, v]) => ({ route, departure_icao: v.departure_icao, arrival_icao: v.arrival_icao, flights: v.flights, duration_sec: v.duration_sec, distance_nm: Math.round(v.distance_nm * 10) / 10 }))
    .sort((a, b) => b.flights - a.flights || (a.route < b.route ? -1 : a.route > b.route ? 1 : 0))
    .slice(0, 5);

  return {
    filter,
    totals: {
      flights: rows.length,
      completed_flights: completedFlights,
      duration_sec: totalDurationSec,
      duration_hours: Math.round((totalDurationSec / 3600) * 10) / 10,
      distance_nm: Math.round(totalDistanceNm * 10) / 10,
      first_flight_start: firstFlightStart,
      last_flight_start: lastFlightStart,
    },
    top_aircraft: topAircraft,
    top_routes: topRoutes,
  };
}

// ── Free-text search ──────────────────────────────────────────────────────────

export interface FlightSearchResult {
  /** The raw q, echoed verbatim. */
  query: string;
  /** Total matches, ignoring limit/offset. */
  total: number;
  limit: number;
  offset: number;
  /** Same shape as GET /api/flights (no points), start_time DESC. */
  flights: Flight[];
}

const SEARCH_COLUMNS = ['notes', 'departure_icao', 'arrival_icao', 'departure_name', 'arrival_name', 'aircraft'] as const;

function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

/** Every token must match at least one of SEARCH_COLUMNS (AND across tokens,
 *  OR across columns). Shared by searchFlights and countSearchFlights so the
 *  two queries can never disagree about which rows match. */
function buildSearchWhere(tokens: readonly string[]): { sql: string; params: string[] } {
  const conditions: string[] = [];
  const params: string[] = [];
  for (const token of tokens) {
    const escaped = escapeLikeTerm(token.toLowerCase());
    conditions.push(`(${SEARCH_COLUMNS.map(col => `COALESCE(${col}, '') LIKE '%' || ? || '%' ESCAPE '\\'`).join(' OR ')})`);
    for (let i = 0; i < SEARCH_COLUMNS.length; i++) params.push(escaped);
  }
  return { sql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

export function searchFlights(tokens: readonly string[], limit: number, offset: number): Flight[] {
  const { sql, params } = buildSearchWhere(tokens);
  return getDb()
    .prepare(`SELECT * FROM flights ${sql} ORDER BY start_time DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Flight[];
}

export function countSearchFlights(tokens: readonly string[]): number {
  const { sql, params } = buildSearchWhere(tokens);
  const row = getDb().prepare(`SELECT COUNT(*) as cnt FROM flights ${sql}`).get(...params) as { cnt: number };
  return row.cnt;
}
