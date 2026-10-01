// ── Hand-close gate for a planned leg ────────────────────────────────────────
//
// This is the whole of the risky logic here — who may close a hand-linked leg
// by hand, and how far off plan they landed — kept pure so it is falsifiable
// from the command line (src/inspect-manual-mark.ts) with no sim, no browser,
// no server.
//
// Imports ONLY ./geo. No ./db, no ./server, no ./flightManager, no ./types,
// no ./legMatcher, no fs, no http. The composition — pairing this gate with
// the writer in src/db/plannedLegs.ts — happens in the endpoint
// (src/routes/plannedLegs.ts), which is what lets this file and
// src/db/plannedLegs.ts be written independently of each other.
//
// This module must not import or reference ARRIVAL_RADIUS_NM, and 'diverted'
// must never appear as an output: a hand-mark is ALWAYS the status the user
// requested, however large the deviation. That rule is the one place the
// hand path deliberately differs from the touchdown rule in
// PlannedLegLink.recordArrival() (src/flight/plannedLegLink.ts), which does
// use ARRIVAL_RADIUS_NM to choose between 'flown' and 'diverted'.

import { haversineNm } from './geo';

/** The only two statuses a hand close-out may request. Never 'diverted'. */
export type HandCloseRequest = 'flown' | 'planned';

/**
 * Why a request was refused. Internal contract between this module and
 * src/inspect-manual-mark.ts. NOT sent on the wire: the endpoint puts only
 * `message` in the 409 body.
 *
 * Evaluated in this exact order; the first match wins.
 */
export type HandCloseRefusal =
  | 'NOT_LINKED'
  | 'LINK_NOT_MANUAL'
  | 'FLIGHT_NOT_ENDED'
  | 'LEG_NOT_PLANNED'
  | 'LEG_NOT_FLOWN';

/**
 * A structural subset of src/types.ts `Flight` — same field names, same
 * types, same nullability (src/types.ts:27-53). Declared locally so this
 * module stays free of ./types; the endpoint passes getFlightById(id)
 * straight in and TypeScript accepts it structurally.
 */
export interface HandCloseFlight {
  id: number;
  end_time: string | null;
  planned_leg_id: number | null;
  planned_leg_link_source: 'auto' | 'manual' | null;
  arrival_lat: number | null;
  arrival_lon: number | null;
}

/**
 * A structural subset of src/types.ts `PlannedLeg` / `PlannedLegWithChildren`
 * (src/types.ts:121, :146-147). `status` is spelled out rather than imported
 * as `PlannedLegStatus` for the same reason.
 */
export interface HandCloseLeg {
  id: number;
  status: 'planned' | 'flown' | 'diverted' | 'skipped';
  destination_lat: number;
  destination_lon: number;
}

/**
 * On `allowed: true`, `status` is ALWAYS the requested one and
 * `deviationNm` is:
 *   - null when the request is 'planned' (the reverse clears the deviation);
 *   - null when either arrival coordinate is null;
 *   - otherwise Math.round(haversineNm(...) * 10) / 10.
 */
export type HandCloseDecision =
  | { allowed: true; legId: number; status: HandCloseRequest; deviationNm: number | null }
  | { allowed: false; reason: HandCloseRefusal; message: string };

/**
 * The whole gate, pure. `leg` is the row `planned_legs.id =
 * flight.planned_leg_id`, or null when the flight has no link at all (or the
 * caller could not find the leg row despite `planned_leg_id` being set;
 * the endpoint intercepts that shape with its own 404 before ever calling
 * this function, so from here it is indistinguishable from "not linked" and
 * refused the same way).
 *
 * Refusal order, normative:
 *   1 NOT_LINKED · 2 LINK_NOT_MANUAL · 3 FLIGHT_NOT_ENDED ·
 *   4 LEG_NOT_PLANNED (request 'flown') / LEG_NOT_FLOWN (request 'planned')
 *
 * Message text is frozen and asserted by src/inspect-manual-mark.ts.
 */
export function decideHandClose(
  requested: HandCloseRequest,
  flight: HandCloseFlight,
  leg: HandCloseLeg | null
): HandCloseDecision {
  if (flight.planned_leg_id == null || leg == null) {
    return {
      allowed: false,
      reason: 'NOT_LINKED',
      message: `Flight ${flight.id} is not linked to a planned leg`,
    };
  }

  if (flight.planned_leg_link_source !== 'manual') {
    return {
      allowed: false,
      reason: 'LINK_NOT_MANUAL',
      message:
        `Flight ${flight.id} was not linked to its planned leg by hand: only a ` +
        `hand-linked flight's leg can be closed by hand`,
    };
  }

  if (flight.end_time == null) {
    return {
      allowed: false,
      reason: 'FLIGHT_NOT_ENDED',
      message: `Flight ${flight.id} has not ended: its planned leg is closed at touchdown`,
    };
  }

  if (requested === 'flown' && leg.status !== 'planned') {
    return {
      allowed: false,
      reason: 'LEG_NOT_PLANNED',
      message:
        `Planned leg ${leg.id} is '${leg.status}', not 'planned': only a planned ` +
        `leg can be marked flown by hand`,
    };
  }

  if (requested === 'planned' && leg.status !== 'flown') {
    return {
      allowed: false,
      reason: 'LEG_NOT_FLOWN',
      message:
        `Planned leg ${leg.id} is '${leg.status}', not 'flown': only a flown leg ` +
        `can be returned to planned`,
    };
  }

  return {
    allowed: true,
    legId: leg.id,
    status: requested,
    deviationNm: requested === 'planned' ? null : handCloseDeviationNm(flight, leg),
  };
}

/**
 * The deviation, character for character:
 *
 *   Math.round(haversineNm(flight.arrival_lat, flight.arrival_lon,
 *                          leg.destination_lat, leg.destination_lon) * 10) / 10
 *
 * Character-identical to the rounding in PlannedLegLink.recordArrival()
 * (src/flight/plannedLegLink.ts)
 * (`Math.round(deviationNm * 10) / 10`). Not `toFixed(1)`, not
 * `Number(x.toFixed(1))`, not a `round(x, 1)` helper — those disagree with
 * this expression at specific x.x5 boundaries (src/inspect-manual-mark.ts's
 * rounding-boundary row demonstrates one).
 *
 * Returns null when either arrival coordinate is null. Exported separately
 * so the inspector can measure the deviation without going through the gate.
 */
export function handCloseDeviationNm(
  flight: Pick<HandCloseFlight, 'arrival_lat' | 'arrival_lon'>,
  leg: Pick<HandCloseLeg, 'destination_lat' | 'destination_lon'>
): number | null {
  if (flight.arrival_lat == null || flight.arrival_lon == null) return null;
  return (
    Math.round(
      haversineNm(flight.arrival_lat, flight.arrival_lon, leg.destination_lat, leg.destination_lon) * 10
    ) / 10
  );
}
