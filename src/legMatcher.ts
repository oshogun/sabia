// ── Planned-leg auto-matcher ──────────────────────────────────────────────────
//
// Chooses the planned leg a just-started flight belongs to, or refuses with a
// reason code. Pure and deterministic: same input, same output, no I/O, no
// clock, no randomness. The callers (PlannedLegLink.autoLink() for a takeoff,
// which also writes the link, and matchForGround() for a ground entry, which
// never does; both in src/flight/plannedLegLink.ts) load the candidates;
// everything in here is arithmetic over the values they were handed, which
// is what lets src/inspect-legmatch.ts exercise every refusal without a
// database.
//
// It imports ./geo and ./types and nothing else — no ./db, no ./airports, no
// fs, no http. See src/geo.ts's header for why the distance helper is imported
// rather than copied again.
//
// The algorithm below is frozen. The two properties worth keeping in mind
// while reading it:
//
//   * `reason` is always set, including on success (MATCHED). No path returns a
//     bare null. That is what makes every refusal loggable and explainable in
//     the UI rather than a silent non-event.
//   * Ambiguity is refused, never guessed — no nearest-wins, no lowest-seq
//     tie-break. Two legs departing the same field is the ordinary shape of this
//     domain (A→B, B→A, A→C), and the costs are asymmetric: an unlinked flight
//     is one click to fix, a wrongly linked flight corrupts a trip's record and
//     the user may never notice.

import { haversineNm } from './geo';
import type { LegMatchCandidate } from './types';

export type { LegMatchCandidate };

/**
 * The contract between the matcher, the [FlightManager] log, the API and the
 * UI. Do not rename these, do not localise them at the source, and do not add
 * a new one without careful review — it is a frozen contract.
 */
export type LegMatchReason =
  | 'MATCHED'
  | 'NO_ACTIVE_TRIP'
  | 'NO_PLANNED_LEGS'
  | 'NO_LEG_IN_RADIUS'
  | 'AMBIGUOUS'
  | 'LEG_ALREADY_FLOWN'
  | 'LEG_ALREADY_LINKED'
  | 'LEG_SKIPPED'
  | 'SNIPPET_NO_DEPARTURE_AIRPORT'
  | 'FLIGHT_ALREADY_LINKED';

export interface LegMatchInput {
  /** Takeoff position, from the frame that tripped the airborne debounce. */
  lat: number;
  lon: number;
  /** ISO. Carried for the log; does not influence the result in v1. */
  startTime: string;
  /** Carried for the log; does not influence the result in v1. */
  aircraft: string | null;
  /** null means no trip is marked active -> NO_ACTIVE_TRIP. */
  activeTripId: number | null;
  /** Non-null means the flight already has a link -> FLIGHT_ALREADY_LINKED. */
  flightAlreadyLinkedTo: number | null;
  /** Loaded once at takeoff, ordered seq ASC, id ASC. Includes ineligible legs. */
  candidates: LegMatchCandidate[];
  /** Overrides DEPARTURE_RADIUS_NM. For the scenario harness and tuning only. */
  radiusNm?: number;
}

export interface LegMatchResult {
  /** Non-null only when reason === 'MATCHED'. */
  plannedLegId: number | null;
  tripId: number | null;
  /** Always set, including on success. No path returns a bare null. */
  reason: LegMatchReason;
  /** Distance to the chosen leg, or to the nearest candidate on a refusal. */
  distanceNm: number | null;
  /** Ids within the radius, ascending. Lets an AMBIGUOUS refusal name its candidates. */
  nearbyLegIds: number[];
}

/**
 * Departure radius in nautical miles, compared against the great-circle
 * distance from the takeoff position to the leg's departure *waypoint*
 * (the airport reference point) — not departure_pos_lat/lon, which is the
 * parking spot and is NULL in every real Little Navmap export seen so far.
 *
 * Calibrated against three things, none of them arbitrary:
 *   * startFlight() fires ~3 s after rotation (AIRBORNE_DEBOUNCE_FRAMES = 3 at
 *     1 Hz) — ~0.15 nm at 150 kts, so the ordinary case is over the field and
 *     nowhere near this number. The radius is sized for the ragged cases: a
 *     ~3 nm-wide airport, an agent reconnect (RECONNECT_DELAY_MS = 5000) that
 *     misses the rotation entirely, an aircraft loaded already airborne, a
 *     circuit that never touches down.
 *   * findNearestAirport's own default maxNm = 10. Sharing the number means the
 *     flight's departure_icao and the leg's departure_ident are resolved from
 *     the same neighbourhood, so they agree or both abstain.
 *   * Widening it is not how a wrong match happens: two planned departures
 *     within 10 nm of each other refuse as AMBIGUOUS. The realistic failure is
 *     the opposite — recording started 200 nm out gives NO_LEG_IN_RADIUS and
 *     the user links by hand, which is the correct direction to fail in.
 *
 * This is a single exported constant plus a per-call `radiusNm` override so
 * that tuning is a one-line change plus a harness re-run.
 */
export const DEPARTURE_RADIUS_NM = 10;

/**
 * Arrival radius for the landing outcome (flown vs diverted). Same rationale
 * as the departure radius and deliberately the same number: the two ends of a
 * leg are judged by one standard. Used by PlannedLegLink.recordArrival()
 * (src/flight/plannedLegLink.ts); it lives here so both radii are tuned in
 * one file.
 */
export const ARRIVAL_RADIUS_NM = 10;

/** A candidate paired with its great-circle distance from the takeoff position. */
interface Scored {
  candidate: LegMatchCandidate;
  distanceNm: number;
}

/**
 * The obstacle this leg presents, or null when it is a usable candidate.
 * Precedence is the order of the checks and is part of the frozen design: a leg
 * that is both flown and linked reports LEG_ALREADY_FLOWN, because "you already
 * flew that one" is the fact the user needs, and the link is merely its
 * consequence.
 */
function refusalFor(c: LegMatchCandidate): LegMatchReason | null {
  if (c.status === 'flown' || c.status === 'diverted') return 'LEG_ALREADY_FLOWN';
  if (c.status === 'skipped') return 'LEG_SKIPPED';
  if (c.linkedFlightId !== null) return 'LEG_ALREADY_LINKED';
  if (!c.departureIsAirport) return 'SNIPPET_NO_DEPARTURE_AIRPORT';
  return null;
}

/**
 * Nearest by distance, first-listed on an exact tie. Candidates arrive in
 * `seq ASC, id ASC`, so the tie-break is the trip's own order rather than
 * whatever order the array happened to be built in — a strict `<` keeps the
 * earlier element and no step of the algorithm depends on iteration order.
 */
function nearest(scored: Scored[]): Scored {
  let best = scored[0];
  for (const s of scored) if (s.distanceNm < best.distanceNm) best = s;
  return best;
}

const idsAscending = (scored: Scored[]): number[] =>
  scored.map((s) => s.candidate.plannedLegId).sort((a, b) => a - b);

export function matchPlannedLeg(input: LegMatchInput): LegMatchResult {
  // startTime and aircraft are read nowhere below. They are carried for the log
  // line and for a possible future tie-break, and must not be quietly promoted
  // into the decision.

  // 0. The flight already carries a link. Re-matching would silently re-target
  //    it, so this is refused ahead of everything, including "no active trip".
  if (input.flightAlreadyLinkedTo !== null) {
    return refusal('FLIGHT_ALREADY_LINKED');
  }

  // 1. No active trip: the feature is off for this flight. Not an error.
  if (input.activeTripId === null) {
    return refusal('NO_ACTIVE_TRIP');
  }

  // 2. The loader returns every leg of the active trip, but it is the matcher
  //    that owns the trip filter too — a candidate from another trip must
  //    never be matchable, whatever the caller passed in.
  const pool = input.candidates.filter((c) => c.tripId === input.activeTripId);
  if (pool.length === 0) {
    return refusal('NO_PLANNED_LEGS');
  }

  // 3. Great-circle distance, always. Never a degree delta: at 179°E → 179°W a
  //    raw longitude subtraction reads 358° and refuses a leg that is 120 nm
  //    away. haversineNm is antimeridian-safe by construction (src/geo.ts).
  const scored: Scored[] = pool.map((candidate) => ({
    candidate,
    distanceNm: haversineNm(input.lat, input.lon, candidate.departureLat, candidate.departureLon),
  }));

  // 4. Radius. The override exists for the harness and the tuning pass; ?? and
  //    not ||, so a deliberate 0 is honoured rather than silently replaced.
  const radius = input.radiusNm ?? DEPARTURE_RADIUS_NM;
  const near = scored.filter((s) => s.distanceNm <= radius);
  if (near.length === 0) {
    // The distance to the nearest leg we did *not* take is the whole value of
    // this log line: "42 nm from the nearest planned departure" is diagnosable,
    // a bare refusal is not.
    return { ...refusal('NO_LEG_IN_RADIUS'), distanceNm: nearest(scored).distanceNm };
  }

  // 5. Eligibility is decided here and only here: the loader hands over flown,
  //    diverted and skipped legs precisely so that each refusal can name its
  //    specific obstacle instead of degrading into NO_LEG_IN_RADIUS.
  const eligible = near.filter((s) => refusalFor(s.candidate) === null);
  if (eligible.length === 0) {
    // The nearest leg's obstacle, not the highest-precedence one: the user is
    // standing on a field, and the leg that departs from where they are is the
    // one whose refusal reason explains why nothing matched.
    const blocker = nearest(near);
    return {
      plannedLegId: null,
      tripId: null,
      reason: refusalFor(blocker.candidate) as LegMatchReason,
      distanceNm: blocker.distanceNm,
      nearbyLegIds: idsAscending(near),
    };
  }

  // 6. Two or more usable legs from the same field: refuse, never guess. This
  //    survives only when the user genuinely has two unflown plans departing the
  //    same place — by the time leg 3 is flown, leg 1 is flown and linked and
  //    step 5 has already removed it. nearbyLegIds names the eligible ones,
  //    because those are the choices the UI offers.
  if (eligible.length >= 2) {
    return {
      plannedLegId: null,
      tripId: null,
      reason: 'AMBIGUOUS',
      distanceNm: nearest(eligible).distanceNm,
      nearbyLegIds: idsAscending(eligible),
    };
  }

  // 7. Exactly one.
  const winner = eligible[0];
  return {
    plannedLegId: winner.candidate.plannedLegId,
    tripId: winner.candidate.tripId,
    reason: 'MATCHED',
    distanceNm: winner.distanceNm,
    nearbyLegIds: idsAscending(near),
  };
}

/** A refusal with nothing to report but its reason. */
function refusal(reason: LegMatchReason): LegMatchResult {
  return { plannedLegId: null, tripId: null, reason, distanceNm: null, nearbyLegIds: [] };
}
