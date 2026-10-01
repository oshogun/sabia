import type { Flight, PlannedLegWithChildren, PlannedLegStatus } from '../types';

/**
 * The four-label badge vocabulary below is used verbatim wherever a planned
 * leg's status is shown. 'linked' has deliberately no badge of its own: a
 * leg that is linked but not yet landed still has status 'planned', so it
 * reads as 'Planned' until FlightManager sets 'flown'/'diverted' at
 * touchdown.
 */
export function plannedLegBadge(status: PlannedLegStatus): { label: string; className: string } {
  switch (status) {
    case 'flown': return { label: 'Flown', className: 'badge-flown' };
    case 'diverted': return { label: 'Diverted', className: 'badge-diverted' };
    case 'skipped': return { label: 'Skipped', className: 'badge-skipped' };
    default: return { label: 'Planned', className: 'badge-planned' };
  }
}

/**
 * How a planned leg interleaves with flown flights in the trip's legs table.
 * Pure, client-side.
 *
 *   1. The base sequence is `flights`, in the order the caller supplies it.
 *      `trip.flights` already arrives ordered by start_time ASC — exactly the
 *      order the legs table has always used — so it is NEVER re-sorted here.
 *      Flown rows keep the numbering/colour they always had, indexed by their
 *      position in `flights`, unaffected by any ghost row inserted around them.
 *   2. Each unflown planned leg (no linked flight — `linked_flight_id === null`)
 *      is inserted immediately before the first flown flight in `flights` that
 *      is linked to a planned leg with a HIGHER seq than it; if there is no
 *      such flight, it goes at the end.
 *   3. Unflown legs that land in the same slot are ordered by seq ASC, id ASC.
 *
 * A trip with zero planned legs must produce byte-identical output to the
 * flights-only mapping that existed before this feature.
 */
export type MergedTripRow =
  | { kind: 'flight'; flight: Flight; flightIndex: number }
  | { kind: 'planned'; leg: PlannedLegWithChildren };

export function interleaveTripRows(
  flights: Flight[],
  plannedLegs: PlannedLegWithChildren[]
): MergedTripRow[] {
  const unflown = plannedLegs
    .filter((leg) => leg.linked_flight_id === null)
    .slice()
    .sort((a, b) => a.seq - b.seq || a.id - b.id); // rule 3

  // The common case, and the one that must be indistinguishable from the
  // pre-feature page: no planned legs (or none left unflown) means no ghost
  // rows and no reordering — just the flights, in the order given.
  if (unflown.length === 0) {
    return flights.map((flight, flightIndex) => ({ kind: 'flight', flight, flightIndex }));
  }

  const legById = new Map(plannedLegs.map((l) => [l.id, l] as const));
  // For each flown flight, the seq of the planned leg it is linked to (or null).
  const anchorSeq = flights.map((f) =>
    f.planned_leg_id != null ? legById.get(f.planned_leg_id)?.seq ?? null : null
  );

  function anchorIndexFor(seq: number): number {
    for (let i = 0; i < anchorSeq.length; i++) {
      const s = anchorSeq[i];
      if (s != null && s > seq) return i;
    }
    return flights.length; // "no such flight" -> the end
  }

  // Bucket index `flights.length` holds legs that land at the very end.
  const buckets: PlannedLegWithChildren[][] = Array.from({ length: flights.length + 1 }, () => []);
  for (const leg of unflown) buckets[anchorIndexFor(leg.seq)].push(leg);

  const rows: MergedTripRow[] = [];
  flights.forEach((flight, flightIndex) => {
    for (const leg of buckets[flightIndex]) rows.push({ kind: 'planned', leg });
    rows.push({ kind: 'flight', flight, flightIndex });
  });
  for (const leg of buckets[flights.length]) rows.push({ kind: 'planned', leg });
  return rows;
}
