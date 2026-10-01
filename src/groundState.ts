// ── Ground-state decision helpers ────────────────────────────────────────────
//
// Pure predicates for the parked / ground-session state: whether a telemetry
// frame counts as "parked", the debounce streak arithmetic, and the
// anchor-drift check that invalidates a ground session once the aircraft has
// moved somewhere else entirely. No I/O, no clock, no db or express import —
// src/flightManager.ts owns the state machine and GroundTracker
// (src/flight/groundTracker.ts) the persistence; this module only decides, the
// same separation src/legMatcher.ts keeps.

import { haversineNm } from './geo';
import type { SimFrame } from './types';

/**
 * Consecutive qualifying frames needed before a parked aircraft is trusted
 * enough to open (or adopt) a ground session. Deliberately above the airborne
 * debounce (3, in src/flightManager.ts) — nothing is lost taking five seconds
 * to recognise a gate — and below the landed debounce (10) — a parked
 * aircraft is a far quieter signal than a landing rollout, so it needs less
 * settling than a touchdown does.
 */
export const GROUND_DEBOUNCE_FRAMES = 5;

/**
 * Ground-speed threshold, compared strictly less-than, against
 * groundSpeedKnots only. Indicated airspeed is never used here: a parked
 * aircraft in a stiff headwind reads a nonzero IAS, and a rule built on it
 * would never fire at an exposed stand.
 */
export const GROUND_SPEED_MAX_KTS = 1;

/**
 * Nautical miles the aircraft may move from a ground session's anchor
 * position before the session is considered to describe somewhere else
 * entirely — a teleport to a different flight, not a taxi. No real taxi
 * covers this distance, and a real departure leaves through the airborne
 * debounce long before it would.
 */
export const GROUND_REANCHOR_NM = 10;

/**
 * True when a frame describes a parked aircraft: running (not shut down),
 * not in slew, on the ground, essentially stationary, and either the
 * engines are confirmed off or the parking brake is set. Either clause alone
 * is enough — cold-and-dark and ready-for-taxi-at-the-gate are both real
 * pre-flight states. When neither field is present (an agent that predates
 * this telemetry, or a sim build that rejected the SimVar) the clause is
 * false and parked is never detected — the intended degradation, not a bug.
 */
export function isParkedFrame(frame: SimFrame): boolean {
  return (
    frame.simRunning !== 0 &&
    frame.simRunning !== 3 && // not slew
    frame.onGround === true &&
    frame.groundSpeedKnots < GROUND_SPEED_MAX_KTS &&
    ((frame.enginesRunning !== undefined && frame.enginesRunning === 0) ||
      frame.parkingBrake === true)
  );
}

/**
 * The next streak value: one more than before when this frame still
 * qualifies as parked, reset to zero otherwise. There is no hysteresis and
 * the counter is never decremented — a single non-qualifying frame (a lurch
 * on a slope, a momentary sensor blip) costs the full debounce window again,
 * which costs nothing. Pure; the caller holds the counter between frames.
 */
export function nextParkedStreak(streak: number, frame: SimFrame): number {
  return isParkedFrame(frame) ? streak + 1 : 0;
}

/** True once the streak has run long enough to trust. */
export function hasParkedDebounce(streak: number): boolean {
  return streak >= GROUND_DEBOUNCE_FRAMES;
}

/**
 * True once the aircraft has moved far enough from the position recorded at
 * ground-session entry (or adoption) that the session can no longer be
 * trusted to describe where the aircraft is now.
 */
export function hasLeftAnchor(
  anchorLat: number, anchorLon: number, lat: number, lon: number,
): boolean {
  return haversineNm(anchorLat, anchorLon, lat, lon) > GROUND_REANCHOR_NM;
}
