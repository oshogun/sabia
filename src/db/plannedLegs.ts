import type {
  PlannedLeg, PlannedWaypoint, PlannedAlternate, PlannedLegWithChildren, PlannedLegListItem, PlannedLegStatus,
  LegMatchCandidate,
} from '../types';
import { getDb } from './connection';

// ── Planned legs ──────────────────────────────────────────────────────────────
//
// CRUD for the planned-leg feature. Deliberately does not import anything
// from src/lnmpln.ts — the parser's ParsedFlightPlan shape lives there and is
// turned into CreatePlannedLegInput by src/server.ts, the only module that
// sees both. The shapes below are structurally compatible with
// ParsedFlightPlan so no conversion boilerplate is needed at the call site,
// but this module never imports the parser's types.
//
// Functions here never read or write flights.flight_plan_name or the
// flight_plans/ directory — that is the unrelated PDF attachment feature.

interface CreatePlannedLegEndpoint {
  ident: string;
  name: string | null;
  lat: number;
  lon: number;
  isAirport: boolean;
}

interface CreatePlannedLegDepartureStart {
  pos: { lat: number; lon: number } | null;
  start: string | null;
  startType: string | null;
}

interface CreatePlannedLegProcedures {
  sidName: string | null;
  sidRunway: string | null;
  sidTransition: string | null;
  sidType: string | null;
  sidCustomDistanceNm: number | null;
  starName: string | null;
  starRunway: string | null;
  starTransition: string | null;
  approachName: string | null;
  approachRunway: string | null;
  approachTransition: string | null;
  approachType: string | null;
  approachArinc: string | null;
  approachSuffix: string | null;
  approachTransitionType: string | null;
  approachCustomDistanceNm: number | null;
  approachCustomAltitudeFt: number | null;
  approachCustomOffsetDeg: number | null;
}

interface CreatePlannedLegWaypoint {
  seq: number;
  ident: string;
  name: string | null;
  region: string | null;
  airway: string | null;
  track: string | null;
  type: string;
  comment: string | null;
  lat: number;
  lon: number;
  altFt: number | null;
}

interface CreatePlannedLegAlternate {
  seq: number;
  ident: string;
  name: string | null;
  type: string | null;
  lat: number | null;
  lon: number | null;
  altFt: number | null;
}

/** Structurally compatible with ParsedFlightPlan (src/lnmpln.ts), not imported. */
export interface CreatePlannedLegPlan {
  departure: CreatePlannedLegEndpoint;
  destination: CreatePlannedLegEndpoint;
  isSnippet: boolean;
  cruiseAltFt: number | null;
  flightplanType: string | null;
  aircraftType: string | null;
  remarks: string | null;
  createdAt: string | null;
  sourceProgram: string | null;
  departureStart: CreatePlannedLegDepartureStart;
  procedures: CreatePlannedLegProcedures;
  waypoints: CreatePlannedLegWaypoint[];
  alternates: CreatePlannedLegAlternate[];
  /** Great-circle sum over the waypoint chain, computed by the parser. Stored as-is. */
  approxDistanceNm: number;
}

/** Everything needed to insert one leg with its children, in one transaction. */
export interface CreatePlannedLegInput {
  /** null creates a loose leg: a prefile that belongs to no trip. */
  tripId: number | null;
  plan: CreatePlannedLegPlan;
  sourceFilename: string;
  sourceSha256: string;
}

function attachPlannedLegChildren(row: PlannedLeg & { linked_flight_id: number | null }): PlannedLegWithChildren {
  const waypoints = getDb().prepare(
    'SELECT * FROM planned_waypoints WHERE planned_leg_id = ? ORDER BY seq ASC'
  ).all(row.id) as PlannedWaypoint[];
  const alternates = getDb().prepare(
    'SELECT * FROM planned_alternates WHERE planned_leg_id = ? ORDER BY seq ASC'
  ).all(row.id) as PlannedAlternate[];
  return { ...row, waypoints, alternates };
}

/**
 * Inserts leg + waypoints + alternates atomically: a failure partway (e.g. a
 * NOT NULL violation on a waypoint) rolls back the whole leg, so no orphan
 * planned_waypoints/planned_alternates rows survive. seq = MAX(seq)+1 for the
 * trip, computed inside the transaction, so the caller controls route order
 * purely by the order it calls this (chainOrderForBatch's order, not upload
 * order). A null tripId computes seq over the loose pool — every leg with no
 * trip — instead of one trip's legs; the two pools are numbered independently
 * and share no meaning by having the same seq.
 */
export function createPlannedLeg(input: CreatePlannedLegInput): number {
  return getDb().transaction((): number => {
    const { tripId, plan, sourceFilename, sourceSha256 } = input;

    // IS, not =: trip_id = NULL is NULL and never true, so with = every loose
    // leg would compute seq 1 regardless of how many loose legs already
    // exist. IS returns the same rows and the same query plan as = for a
    // non-null tripId, so trip-linked numbering is unaffected.
    const { next_seq: seq } = getDb().prepare(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM planned_legs WHERE trip_id IS ?'
    ).get(tripId) as { next_seq: number };

    const legId = getDb().prepare(`
      INSERT INTO planned_legs (
        trip_id, seq, status,
        departure_ident, departure_name, departure_lat, departure_lon, departure_is_airport,
        departure_start, departure_start_type, departure_pos_lat, departure_pos_lon,
        destination_ident, destination_name, destination_lat, destination_lon, destination_is_airport,
        is_snippet, cruise_alt_ft, flightplan_type, aircraft_type,
        sid_name, sid_runway, sid_transition, sid_type, sid_custom_distance_nm,
        star_name, star_runway, star_transition,
        approach_name, approach_runway, approach_transition, approach_type, approach_arinc, approach_suffix,
        approach_transition_type, approach_custom_distance_nm, approach_custom_altitude_ft, approach_custom_offset_deg,
        waypoint_count, alternate_count, approx_distance_nm,
        remarks, plan_created_at,
        source_filename, source_sha256, source_program, imported_at
      ) VALUES (
        ?, ?, 'planned',
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?
      )
    `).run(
      tripId, seq,
      plan.departure.ident, plan.departure.name, plan.departure.lat, plan.departure.lon, plan.departure.isAirport ? 1 : 0,
      plan.departureStart.start, plan.departureStart.startType,
      plan.departureStart.pos?.lat ?? null, plan.departureStart.pos?.lon ?? null,
      plan.destination.ident, plan.destination.name, plan.destination.lat, plan.destination.lon, plan.destination.isAirport ? 1 : 0,
      plan.isSnippet ? 1 : 0, plan.cruiseAltFt, plan.flightplanType, plan.aircraftType,
      plan.procedures.sidName, plan.procedures.sidRunway, plan.procedures.sidTransition,
      plan.procedures.sidType, plan.procedures.sidCustomDistanceNm,
      plan.procedures.starName, plan.procedures.starRunway, plan.procedures.starTransition,
      plan.procedures.approachName, plan.procedures.approachRunway, plan.procedures.approachTransition,
      plan.procedures.approachType, plan.procedures.approachArinc, plan.procedures.approachSuffix,
      plan.procedures.approachTransitionType, plan.procedures.approachCustomDistanceNm,
      plan.procedures.approachCustomAltitudeFt, plan.procedures.approachCustomOffsetDeg,
      plan.waypoints.length, plan.alternates.length, plan.approxDistanceNm,
      plan.remarks, plan.createdAt,
      sourceFilename, sourceSha256, plan.sourceProgram, new Date().toISOString()
    ).lastInsertRowid as number;

    const insertWaypoint = getDb().prepare(`
      INSERT INTO planned_waypoints (planned_leg_id, seq, ident, name, region, airway, track, type, comment, lat, lon, alt_ft)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const wp of plan.waypoints) {
      insertWaypoint.run(legId, wp.seq, wp.ident, wp.name, wp.region, wp.airway, wp.track, wp.type, wp.comment, wp.lat, wp.lon, wp.altFt);
    }

    const insertAlternate = getDb().prepare(`
      INSERT INTO planned_alternates (planned_leg_id, seq, ident, name, type, lat, lon, alt_ft)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const alt of plan.alternates) {
      insertAlternate.run(legId, alt.seq, alt.ident, alt.name, alt.type, alt.lat, alt.lon, alt.altFt);
    }

    return legId;
  })();
}

/** Legs of a trip, ORDER BY seq ASC, id ASC, children attached. */
export function getPlannedLegsForTrip(tripId: number): PlannedLegWithChildren[] {
  const rows = getDb().prepare(`
    SELECT l.*,
           (SELECT f.id FROM flights f WHERE f.planned_leg_id = l.id) AS linked_flight_id
      FROM planned_legs l
     WHERE l.trip_id = ?
     ORDER BY l.seq ASC, l.id ASC
  `).all(tripId) as (PlannedLeg & { linked_flight_id: number | null })[];
  return rows.map(attachPlannedLegChildren);
}

export function getPlannedLegById(legId: number): PlannedLegWithChildren | null {
  const row = getDb().prepare(`
    SELECT l.*,
           (SELECT f.id FROM flights f WHERE f.planned_leg_id = l.id) AS linked_flight_id
      FROM planned_legs l
     WHERE l.id = ?
  `).get(legId) as (PlannedLeg & { linked_flight_id: number | null }) | undefined;
  if (!row) return null;
  return attachPlannedLegChildren(row);
}

/**
 * The existing leg holding these bytes within the same pool: one trip, or the
 * loose pool (tripId null). A duplicate is scoped by trip as well as by hash
 * — the same file may exist once as a loose leg and once in each trip — so
 * IS, not =, the same reasoning as createPlannedLeg's seq query. Null when
 * this pool has never seen these bytes.
 */
export function findPlannedLegBySource(tripId: number | null, sha256: string): PlannedLeg | null {
  const row = getDb().prepare(
    'SELECT * FROM planned_legs WHERE trip_id IS ? AND source_sha256 = ? LIMIT 1'
  ).get(tripId, sha256) as PlannedLeg | undefined;
  return row ?? null;
}

/**
 * Every planned leg, loose and trip-linked, with children attached and the
 * owning trip's name resolved by a LEFT JOIN — an inner join would silently
 * drop every loose leg, which is the one bug this function exists to avoid.
 * trip_name is null exactly when trip_id is null.
 *
 * Ordering: loose legs first as one block, then trip-linked legs grouped by
 * trip id ascending, and within every block by (seq ASC, id ASC) — the same
 * order GET /api/trips/:id/planned-legs returns for one trip's rows, so a
 * trip's legs read identically here and on its own page.
 */
export function getAllPlannedLegs(): PlannedLegListItem[] {
  const rows = getDb().prepare(`
    SELECT l.*,
           t.name AS trip_name,
           (SELECT f.id FROM flights f WHERE f.planned_leg_id = l.id) AS linked_flight_id
      FROM planned_legs l
      LEFT JOIN trips t ON t.id = l.trip_id
     ORDER BY (l.trip_id IS NULL) DESC, l.trip_id ASC, l.seq ASC, l.id ASC
  `).all() as (PlannedLeg & { trip_name: string | null; linked_flight_id: number | null })[];
  return rows.map((row) => ({ ...attachPlannedLegChildren(row), trip_name: row.trip_name }));
}

/**
 * Deletes a leg. Children go by ON DELETE CASCADE and any linked flight is
 * unlinked by ON DELETE SET NULL on flights.planned_leg_id — but that FK
 * action does not know about the other two bookkeeping columns, so they are
 * cleared and the flight's trip_id is restored from
 * planned_leg_prev_trip_id in the same transaction. Deleting a leg must never
 * leave a flight stranded in a trip it was moved into by a link that no
 * longer exists.
 */
export function deletePlannedLeg(legId: number): boolean {
  return getDb().transaction((): boolean => {
    const linkedFlight = getDb().prepare(
      'SELECT id, planned_leg_prev_trip_id FROM flights WHERE planned_leg_id = ?'
    ).get(legId) as { id: number; planned_leg_prev_trip_id: number | null } | undefined;

    const result = getDb().prepare('DELETE FROM planned_legs WHERE id = ?').run(legId);
    if (result.changes === 0) return false;

    if (linkedFlight) {
      getDb().prepare(`
        UPDATE flights
           SET trip_id = ?,
               planned_leg_link_source = NULL,
               planned_leg_prev_trip_id = NULL
         WHERE id = ?
      `).run(linkedFlight.planned_leg_prev_trip_id, linkedFlight.id);
    }

    return true;
  })();
}

/**
 * Full permutation, renumbered 1..N in one transaction. Caller has already
 * checked legIds is exactly this trip's set of leg ids.
 */
export function reorderPlannedLegs(tripId: number, legIds: number[]): boolean {
  return getDb().transaction((): boolean => {
    const update = getDb().prepare('UPDATE planned_legs SET seq = ? WHERE id = ? AND trip_id = ?');
    legIds.forEach((legId, index) => {
      update.run(index + 1, legId, tripId);
    });
    return true;
  })();
}

/**
 * Thrown by setPlannedLegStatus() when asked to change the status of a leg
 * that a flight is still linked to. A linked leg's status is not the
 * caller's to set at all — 'flown' and 'diverted' are written by
 * endFlight(), and the only way to reopen such a leg is to unlink it, which
 * is the only transition that does so. The 409-vs-404 decision belongs to
 * the endpoint; this class exists so the endpoint can tell that
 * refusal apart from "leg not found" (which is a plain boolean `false`) and
 * name the flight in its own error message.
 */
export class PlannedLegHasLinkedFlightError extends Error {
  constructor(readonly legId: number, readonly flightId: number) {
    super(`Planned leg ${legId} cannot have its status changed: linked to flight ${flightId}`);
    this.name = 'PlannedLegHasLinkedFlightError';
  }
}

/**
 * Thrown by linkFlightToPlannedLeg() when the target leg already belongs to a
 * different flight. idx_flights_planned_leg would catch this too, but that
 * constraint error can't name the offending flight — this check runs first so
 * the thrown error can, which is what lets the endpoint turn it into a 409
 * that says which flight.
 */
export class PlannedLegAlreadyLinkedError extends Error {
  constructor(readonly legId: number, readonly flightId: number) {
    super(`Planned leg ${legId} is already linked to flight ${flightId}`);
    this.name = 'PlannedLegAlreadyLinkedError';
  }
}

// ── Active trip ───────────────────────────────────────────────────────────────

/**
 * Clear first, then set — never the reverse. With idx_trips_active in place,
 * clearing after setting would raise SQLITE_CONSTRAINT_UNIQUE the moment
 * another trip is already active; clearing first makes "at most one active
 * trip" hold at every intermediate point in the transaction, not just at
 * commit.
 *
 * Setting a trip that does not exist changes nothing — the existence
 * check has to run BEFORE the clearing UPDATE, inside the same transaction,
 * because the clear-then-set order above means there is no later point to
 * discover the target is missing and undo it. The HTTP endpoint already
 * pre-checks existence and 404s, but this function must honour its own
 * contract for a caller that reaches it directly.
 */
export function setActiveTrip(tripId: number | null): void {
  getDb().transaction(() => {
    if (tripId !== null) {
      const exists = getDb().prepare('SELECT 1 FROM trips WHERE id = ?').get(tripId);
      if (!exists) return;
    }
    getDb().prepare('UPDATE trips SET is_active = 0 WHERE is_active = 1').run();
    if (tripId !== null) {
      getDb().prepare('UPDATE trips SET is_active = 1 WHERE id = ?').run(tripId);
    }
  })();
}

export function getActiveTripId(): number | null {
  const row = getDb().prepare('SELECT id FROM trips WHERE is_active = 1').get() as { id: number } | undefined;
  return row ? row.id : null;
}

// ── Planned-leg status ────────────────────────────────────────────────────────

/**
 * 'planned' | 'skipped' only; 'flown' and 'diverted' are system-set and this
 * function has no runtime path that accepts them (the parameter type already
 * forbids it at compile time). Refuses — by throwing
 * PlannedLegHasLinkedFlightError — whenever the leg still has a linked
 * flight, regardless of which of the two statuses was requested. This is
 * not just the skip guard widened: a still-linked leg is either 'planned'
 * (being flown right now) or 'flown'/'diverted' (just landed), and in every
 * one of those cases the status and the link are the system's to manage,
 * not a PATCH's — resetting a flown/diverted leg to 'planned' while the
 * link stays would destroy arrival_deviation_nm and produce a state that
 * has no defined meaning (a "landed" leg rendering as "being flown"). The
 * only way back from flown/diverted to planned is: unlink, which clears the
 * deviation because the link is going away too. A skip that quietly failed
 * would likewise leave the caller believing the leg was skipped when it was
 * not.
 *
 * Always clears arrival_deviation_nm alongside status, in the same statement
 * as the update, for the unlinked legs that do reach here: a leg PATCHed
 * back to 'planned' from 'flown'/'diverted' after its flight was deleted or
 * combined must not keep reading "planned, 47 nm from plan" — the same
 * clearing already done by unlinkFlightFromPlannedLeg() and
 * clearPlannedLegLink(), applied uniformly on this path too.
 */
export function setPlannedLegStatus(legId: number, status: 'planned' | 'skipped'): boolean {
  return getDb().transaction((): boolean => {
    const row = getDb().prepare(`
      SELECT l.id, (SELECT f.id FROM flights f WHERE f.planned_leg_id = l.id) AS linked_flight_id
        FROM planned_legs l
       WHERE l.id = ?
    `).get(legId) as { id: number; linked_flight_id: number | null } | undefined;
    if (!row) return false;

    if (row.linked_flight_id != null) {
      throw new PlannedLegHasLinkedFlightError(legId, row.linked_flight_id);
    }

    const result = getDb().prepare(
      'UPDATE planned_legs SET status = ?, arrival_deviation_nm = NULL WHERE id = ?'
    ).run(status, legId);
    return result.changes > 0;
  })();
}

/** Why movePlannedLeg() refused. The route maps each to an HTTP status. */
export type PlannedLegMoveRefusal =
  | 'TRIP_NOT_FOUND'
  | 'SAME_POOL'
  | 'LINKED_FLIGHT'
  | 'NOT_MOVABLE_STATUS'
  | 'DUPLICATE_IN_TARGET';

/**
 * Thrown by movePlannedLeg() for every refusal that isn't a plain "leg not
 * found" (that stays a boolean `false`, matching every other function here).
 * `flightId` is set only for LINKED_FLIGHT, `existingSeq` only for
 * DUPLICATE_IN_TARGET — the route reads whichever one its `code` promises and
 * ignores the other.
 */
export class PlannedLegMoveError extends Error {
  readonly flightId: number | null;
  readonly existingSeq: number | null;
  constructor(
    readonly legId: number,
    readonly code: PlannedLegMoveRefusal,
    message: string,
    extra?: { flightId?: number; existingSeq?: number },
  ) {
    super(message);
    this.name = 'PlannedLegMoveError';
    this.flightId = extra?.flightId ?? null;
    this.existingSeq = extra?.existingSeq ?? null;
  }
}

/**
 * Moves a leg between pools (a trip, or the loose pool when tripId is null),
 * rewriting only trip_id and seq — every other column, every child row
 * (planned_waypoints/planned_alternates), every acars_messages/ground_sessions
 * row keyed by the leg id, is untouched. Lands the leg at the end of the
 * target pool (MAX(seq)+1 there, the same query createPlannedLeg uses) and
 * deliberately does not renumber the source pool: the gap it leaves behind is
 * harmless, since ordering only has to be dense within a pool that still
 * exists, not globally.
 *
 * false = leg not found, nothing changed. Every other refusal throws
 * PlannedLegMoveError with nothing changed; the checks run in this order so
 * the first one that applies is the one reported:
 *   1. tripId is not null and that trip does not exist -> TRIP_NOT_FOUND.
 *   2. tripId already equals the leg's current trip_id (loose-to-loose
 *      included) -> SAME_POOL, checked before the legality rules below so a
 *      true no-op always reads as a no-op, not as "linked" or "duplicate".
 *   3. A flight is linked to the leg -> LINKED_FLIGHT.
 *   4. status is neither 'planned' nor 'skipped' (a flown/diverted leg whose
 *      flight was since deleted or combined) -> NOT_MOVABLE_STATUS.
 *   5. The target pool already holds a leg with this leg's source_sha256
 *      (findPlannedLegBySource) -> DUPLICATE_IN_TARGET.
 */
export function movePlannedLeg(legId: number, tripId: number | null): boolean {
  return getDb().transaction((): boolean => {
    const row = getDb().prepare(`
      SELECT l.id, l.trip_id, l.status, l.source_sha256,
             (SELECT f.id FROM flights f WHERE f.planned_leg_id = l.id) AS linked_flight_id
        FROM planned_legs l
       WHERE l.id = ?
    `).get(legId) as {
      id: number; trip_id: number | null; status: PlannedLegStatus; source_sha256: string; linked_flight_id: number | null;
    } | undefined;
    if (!row) return false;

    if (tripId !== null) {
      const trip = getDb().prepare('SELECT 1 FROM trips WHERE id = ?').get(tripId);
      if (!trip) {
        throw new PlannedLegMoveError(legId, 'TRIP_NOT_FOUND', 'Trip not found');
      }
    }

    if (tripId === row.trip_id) {
      const message = tripId !== null
        ? `Planned leg ${legId} is already in this trip`
        : `Planned leg ${legId} is already a loose leg`;
      throw new PlannedLegMoveError(legId, 'SAME_POOL', message);
    }

    if (row.linked_flight_id != null) {
      throw new PlannedLegMoveError(
        legId, 'LINKED_FLIGHT',
        `Planned leg ${legId} cannot be moved: linked to flight ${row.linked_flight_id}. Unlink the flight first.`,
        { flightId: row.linked_flight_id },
      );
    }

    if (row.status !== 'planned' && row.status !== 'skipped') {
      throw new PlannedLegMoveError(
        legId, 'NOT_MOVABLE_STATUS',
        `Planned leg ${legId} cannot be moved: its status is '${row.status}'. Only a planned or skipped leg can be moved.`,
      );
    }

    const existing = findPlannedLegBySource(tripId, row.source_sha256);
    if (existing) {
      const message = tripId !== null
        ? `Planned leg ${legId} cannot be moved: the target trip already holds the same plan as leg ${existing.seq}`
        : `Planned leg ${legId} cannot be moved: the loose legs already hold the same plan as leg ${existing.seq}`;
      throw new PlannedLegMoveError(legId, 'DUPLICATE_IN_TARGET', message, { existingSeq: existing.seq });
    }

    const { next_seq: seq } = getDb().prepare(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM planned_legs WHERE trip_id IS ?'
    ).get(tripId) as { next_seq: number };

    getDb().prepare('UPDATE planned_legs SET trip_id = ?, seq = ? WHERE id = ?').run(tripId, seq, legId);
    return true;
  })();
}

// ── Auto-match candidates ─────────────────────────────────────────────────────

/**
 * Candidates for the auto-matcher: EVERY leg of the active trip, with no
 * status filtering at all — 'flown', 'diverted', 'skipped' and already-linked
 * legs are all included. Eligibility is entirely step 5's job: the matcher
 * is what turns a 'flown' candidate into the LEG_ALREADY_FLOWN reason code,
 * a 'skipped' one into LEG_SKIPPED, and so on. Filtering any status out here
 * would make that reason code unreachable in production and surface a
 * misleading NO_LEG_IN_RADIUS instead. This query stays one indexed read
 * with no per-row business logic.
 * ORDER BY seq ASC, id ASC because determinism of the matcher's
 * AMBIGUOUS/nearbyLegIds output depends on candidates arriving in a defined
 * order. Returns [] when no trip is active — the JOIN on is_active = 1
 * simply matches nothing.
 */
export function getPlannedLegCandidatesForActiveTrip(): LegMatchCandidate[] {
  type Row = {
    plannedLegId: number;
    tripId: number;
    seq: number;
    departureIdent: string;
    departureIsAirport: number;
    departureLat: number;
    departureLon: number;
    status: PlannedLegStatus;
    linkedFlightId: number | null;
    aircraftType: string | null;
  };
  const rows = getDb().prepare(`
    SELECT
      l.id                    AS plannedLegId,
      l.trip_id               AS tripId,
      l.seq                   AS seq,
      l.departure_ident       AS departureIdent,
      l.departure_is_airport  AS departureIsAirport,
      l.departure_lat         AS departureLat,
      l.departure_lon         AS departureLon,
      l.status                AS status,
      (SELECT f.id FROM flights f WHERE f.planned_leg_id = l.id) AS linkedFlightId,
      l.aircraft_type         AS aircraftType
    FROM planned_legs l
    JOIN trips t ON t.id = l.trip_id AND t.is_active = 1
    ORDER BY l.seq ASC, l.id ASC
  `).all() as Row[];

  return rows.map(row => ({
    ...row,
    departureIdent: row.departureIsAirport ? row.departureIdent : null,
    departureIsAirport: !!row.departureIsAirport,
  }));
}

// ── Flight <-> planned-leg link ───────────────────────────────────────────────

/**
 * The flight's link, and nothing else. getFlightById() would answer this too,
 * but it returns FlightWithPoints and so loads every flight_points row to
 * read one integer — thousands of them on a long haul at a 5 s recording
 * interval. endFlight() asks this question on its way out, including
 * from onCrash() and onSimDisconnect(), which is the worst moment to allocate
 * a track nobody reads.
 *
 * NULL means "no link", and it also means "no such flight". Every caller
 * treats the two alike: recordArrival() returns, refreshForFlight() clears its
 * cache, and src/inspect-acars.ts prints null. So collapsing them loses no
 * information any caller uses.
 */
export function getFlightPlannedLegId(flightId: number): number | null {
  const row = getDb().prepare(
    'SELECT planned_leg_id FROM flights WHERE id = ?'
  ).get(flightId) as { planned_leg_id: number | null } | undefined;
  return row?.planned_leg_id ?? null;
}

/**
 * Captures the flight's current trip_id (whatever it is, including NULL) into
 * planned_leg_prev_trip_id BEFORE moving the flight into the leg's trip, so
 * unlink can restore it. If the flight is already linked to a different leg,
 * re-targeting is a full unlink of the old link followed by a full link to
 * the new one, in this same transaction — so planned_leg_prev_trip_id ends up
 * holding the flight's ORIGINAL trip, never a trip the old link itself
 * assigned. Throws PlannedLegAlreadyLinkedError if the target leg already
 * belongs to a different flight.
 *
 * Linking a flight to the leg it ALREADY holds is a no-op, not a
 * re-target: re-targeting means putting a DIFFERENT leg onto an
 * already-linked flight, and running the unlink-then-link sequence anyway would
 * silently reset a 'flown'/'diverted' leg back to 'planned' and discard its
 * recorded arrival_deviation_nm for a request that asked for no change. This
 * guard has to live here rather than in the endpoint: the auto-matcher calls
 * this function directly with source: 'auto', bypassing any endpoint-level
 * check entirely.
 *
 * `source` is NOT applied on that no-op path either, which the signature
 * invites you to expect. It records how the link came about, and a same-leg
 * re-link did not change that. Writing it would also make this a guard that
 * returns early except when it performs an UPDATE — a narrower version of the
 * bug it closes.
 */
export function linkFlightToPlannedLeg(flightId: number, legId: number, source: 'auto' | 'manual'): void {
  getDb().transaction(() => {
    const current = getDb().prepare(
      'SELECT planned_leg_id FROM flights WHERE id = ?'
    ).get(flightId) as { planned_leg_id: number | null } | undefined;
    if (!current) {
      throw new Error(`Flight ${flightId} not found`);
    }
    if (current.planned_leg_id === legId) {
      return;
    }
    if (current.planned_leg_id != null) {
      unlinkFlightFromPlannedLeg(flightId);
    }

    // idx_flights_planned_leg enforces this too, but checking explicitly is
    // what lets the thrown error name the flight already holding the leg.
    const holder = getDb().prepare(
      'SELECT id FROM flights WHERE planned_leg_id = ?'
    ).get(legId) as { id: number } | undefined;
    if (holder) {
      throw new PlannedLegAlreadyLinkedError(legId, holder.id);
    }

    const leg = getDb().prepare('SELECT trip_id FROM planned_legs WHERE id = ?').get(legId) as { trip_id: number | null } | undefined;
    if (!leg) {
      throw new Error(`Planned leg ${legId} not found`);
    }

    // Read again: if we just unlinked this same flight above, its trip_id is
    // now the restored ORIGINAL trip (or NULL) — exactly what must be
    // captured as the new planned_leg_prev_trip_id.
    const flight = getDb().prepare('SELECT trip_id FROM flights WHERE id = ?').get(flightId) as { trip_id: number | null };

    getDb().prepare(`
      UPDATE flights
         SET planned_leg_prev_trip_id = ?,
             trip_id                  = ?,
             planned_leg_id           = ?,
             planned_leg_link_source  = ?
       WHERE id = ?
    `).run(flight.trip_id, leg.trip_id, legId, source, flightId);
  })();
}

/**
 * Restores trip_id from planned_leg_prev_trip_id, then NULLs all three
 * planned_leg_* columns, and resets the leg to 'planned' with
 * arrival_deviation_nm cleared — this is how the user reopens a
 * 'flown'/'diverted' leg. Returns false when the flight has no link.
 */
export function unlinkFlightFromPlannedLeg(flightId: number): boolean {
  return getDb().transaction((): boolean => {
    const flight = getDb().prepare(
      'SELECT planned_leg_id, planned_leg_prev_trip_id FROM flights WHERE id = ?'
    ).get(flightId) as { planned_leg_id: number | null; planned_leg_prev_trip_id: number | null } | undefined;
    if (!flight || flight.planned_leg_id == null) return false;

    getDb().prepare(
      "UPDATE planned_legs SET status = 'planned', arrival_deviation_nm = NULL WHERE id = ?"
    ).run(flight.planned_leg_id);

    getDb().prepare(`
      UPDATE flights
         SET trip_id                  = ?,
             planned_leg_id           = NULL,
             planned_leg_link_source  = NULL,
             planned_leg_prev_trip_id = NULL
       WHERE id = ?
    `).run(flight.planned_leg_prev_trip_id, flightId);

    return true;
  })();
}

/**
 * Same as unlinkFlightFromPlannedLeg() EXCEPT trip_id is deliberately NOT
 * restored — for the two kinds of caller that must not have it restored:
 * those about to destroy the flight row (deleteFlight(), or combineFlights()
 * for both source flights), where no row is left for a restored trip_id to
 * mean anything on; and assignFlightToTrip()/removeFlightFromTrip(), which
 * are themselves setting trip_id to something the user just chose and would
 * only have to overwrite the restored value.
 */
export function clearPlannedLegLink(flightId: number): void {
  getDb().transaction(() => {
    const flight = getDb().prepare(
      'SELECT planned_leg_id FROM flights WHERE id = ?'
    ).get(flightId) as { planned_leg_id: number | null } | undefined;
    if (!flight || flight.planned_leg_id == null) return;

    getDb().prepare(
      "UPDATE planned_legs SET status = 'planned', arrival_deviation_nm = NULL WHERE id = ?"
    ).run(flight.planned_leg_id);

    getDb().prepare(`
      UPDATE flights
         SET planned_leg_id           = NULL,
             planned_leg_link_source  = NULL,
             planned_leg_prev_trip_id = NULL
       WHERE id = ?
    `).run(flightId);
  })();
}

/**
 * Called by endFlight() for a linked flight, after closeFlight().
 * arrival_deviation_nm is written on both the 'flown' and 'diverted' path —
 * the link is kept either way; a diversion never auto-unlinks.
 */
export function recordPlannedLegArrival(legId: number, status: 'flown' | 'diverted', deviationNm: number): void {
  getDb().prepare(
    'UPDATE planned_legs SET status = ?, arrival_deviation_nm = ? WHERE id = ?'
  ).run(status, deviationNm, legId);
}

/**
 * Thrown by setPlannedLegHandOutcome() when the leg stopped qualifying
 * between the endpoint's decision and this transaction — e.g. a concurrent
 * PUT /api/flights/:id/planned-leg {plannedLegId: null} unlinked the flight
 * in the window between the endpoint's read and this write.
 *
 * This is NOT a second copy of the gate: it re-asserts only the three
 * persistent invariants this transaction reads anyway (still linked, still
 * manual, still ended). The transition rule — which source status may become
 * which target status — stays in src/plannedLegClose.ts and is deliberately
 * NOT re-checked here.
 */
export class PlannedLegHandCloseConflictError extends Error {
  constructor(readonly legId: number, readonly detail: string) {
    super(`Planned leg ${legId} cannot be closed by hand: ${detail}`);
    this.name = 'PlannedLegHandCloseConflictError';
  }
}

/**
 * The hand-driven sibling of recordPlannedLegArrival(): writes the status and
 * the deviation a hand close-out (src/plannedLegClose.ts, decideHandClose())
 * decided, instead of the touchdown measurement endFlight() writes. Never
 * writes 'diverted' — the touchdown rule is not mirrored here. The link
 * itself is never touched: after the reverse transition,
 * flights.planned_leg_id and flights.planned_leg_link_source are exactly
 * what they were (frozen decision 3).
 *
 * Both columns move in one UPDATE inside one getDb().transaction(), preceded by a
 * re-read of the three invariants above — the atomic re-assertion this
 * requires. Returns false when the leg row does not exist or the UPDATE
 * changed nothing; throws PlannedLegHandCloseConflictError when an invariant
 * no longer holds.
 *
 * CALLER SET: exactly one — PUT /api/flights/:id/planned-leg-status in
 * src/server.ts, after decideHandClose() has returned `allowed: true`. Any
 * new caller must go through decideHandClose() first.
 */
export function setPlannedLegHandOutcome(
  legId: number,
  status: 'planned' | 'flown',
  deviationNm: number | null
): boolean {
  return getDb().transaction((): boolean => {
    const row = getDb().prepare(`
      SELECT l.id,
             (SELECT f.id                      FROM flights f WHERE f.planned_leg_id = l.id) AS linked_flight_id,
             (SELECT f.planned_leg_link_source FROM flights f WHERE f.planned_leg_id = l.id) AS link_source,
             (SELECT f.end_time                FROM flights f WHERE f.planned_leg_id = l.id) AS end_time
        FROM planned_legs l
       WHERE l.id = ?
    `).get(legId) as { id: number; linked_flight_id: number | null; link_source: string | null; end_time: string | null } | undefined;
    if (!row) return false;

    if (row.linked_flight_id == null) {
      throw new PlannedLegHandCloseConflictError(legId, 'it has no linked flight');
    }
    if (row.link_source !== 'manual') {
      throw new PlannedLegHandCloseConflictError(legId, 'its flight was not linked by hand');
    }
    if (row.end_time == null) {
      throw new PlannedLegHandCloseConflictError(legId, 'its flight has not ended');
    }

    const result = getDb().prepare(
      'UPDATE planned_legs SET status = ?, arrival_deviation_nm = ? WHERE id = ?'
    ).run(status, deviationNm, legId);
    return result.changes > 0;
  })();
}
