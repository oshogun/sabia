import type { PlannedLegWithChildren } from '../../types';

/** Select value for the "move to trip" picker: '' = nothing chosen, 'loose' = "No trip", number = trip id. */
export type MoveTargetChoice = number | 'loose' | '';

/**
 * Whether a planned leg can be moved to another trip (or to the loose pool).
 * Mirrors the server's legality rule: only an unlinked leg that is still
 * planned or skipped can move — a flown/diverted leg, or one with a flight
 * already linked to it, cannot.
 */
export function isPlannedLegMovable(
  leg: Pick<PlannedLegWithChildren, 'status' | 'linked_flight_id'>,
): boolean {
  return (leg.status === 'planned' || leg.status === 'skipped') && leg.linked_flight_id === null;
}
