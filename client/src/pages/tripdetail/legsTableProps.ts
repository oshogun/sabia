import type { MoveTargetChoice } from '../../components/legs';
import type { Flight, PlannedLegListItem, PlannedLegWithChildren, Trip } from '../../types';

/** Rows per page of the legs table. The page passes `page`; the table windows its own rows. */
export const LEGS_PER_PAGE = 20;

/** State of the "link a flight" picker opened from a planned (ghost) leg row. */
export interface LegLinkPicker {
  /** Leg whose picker is open, or null. */
  openLegId: number | null;
  /** Flights not yet linked to any leg; null while still loading. */
  flights: Flight[] | null;
  flightsError: string;
  choice: number | '';
  busyLegId: number | null;
  errorByLeg: Record<number, string>;
  onToggle: (legId: number) => void;
  onChoiceChange: (flightId: number | '') => void;
  onConfirm: (legId: number) => void;
}

/**
 * State of the "link to leg" picker opened from a flown row. The leg list is
 * deliberately not scoped to this trip: it is also how a mislinked flight is
 * re-targeted to any unflown leg of any trip.
 */
export interface FlightLinkPicker {
  openFlightId: number | null;
  /** Unlinked planned legs of every trip; null while still loading. */
  legs: PlannedLegListItem[] | null;
  legsError: string;
  choice: number | '';
  busyFlightId: number | null;
  errorByFlight: Record<number, string>;
  onToggle: (flightId: number) => void;
  onChoiceChange: (legId: number | '') => void;
  onConfirm: (flightId: number) => void;
}

/** State of the "move to trip" picker opened from a planned (ghost) leg row. */
export interface LegMovePicker {
  openLegId: number | null;
  /** Every trip; null while still loading. */
  trips: Trip[] | null;
  tripsError: string;
  choice: MoveTargetChoice;
  busyLegId: number | null;
  errorByLeg: Record<number, string>;
  onToggle: (legId: number) => void;
  onChoiceChange: (choice: MoveTargetChoice) => void;
  onConfirm: (legId: number) => void;
}

/**
 * Everything the trip page hands its legs table. The table is presentational:
 * it never talks to the server and never confirms anything. Destructive or
 * status-changing actions are "requests" (`onRequest*`): the page opens the
 * confirmation dialog, performs the change, reloads the trip and passes the
 * new `flights` / `plannedLegs` back down.
 */
export interface LegsTableProps {
  trip: Pick<Trip, 'id' | 'name' | 'is_active'>;
  /**
   * The trip's flown legs in leg order. Track points are attached (the map
   * needs them); the table should not rely on them.
   */
  flights: Flight[];
  /**
   * All planned legs of the trip in `seq ASC, id ASC` order, flown-linked
   * ones included. Only unflown ones render as ghost rows, but reorder swaps
   * against this full list (`canMoveUp` / `canMoveDown` come from it).
   */
  plannedLegs: PlannedLegWithChildren[];

  /** 1-based page from `?page=`; the table clamps it into range. */
  page: number;
  /** Writes `?page=`; page 1 removes the parameter. */
  onPageChange: (page: number) => void;

  /** Move a planned leg one place in the full ordering (full-permutation PATCH on the server). */
  onMoveLeg: (legId: number, direction: 'up' | 'down') => void;
  /** Leg whose move request is in flight, or null; disables that row's arrows. */
  reorderingLegId: number | null;

  /** Ask to skip or unskip an unflown leg (page opens the confirm dialog). */
  onRequestSkip: (legId: number) => void;
  skipBusyLegId: number | null;
  skipErrorByLeg: Record<number, string>;

  /** Ask to delete a planned leg (page opens the confirm dialog). */
  onRequestDeleteLeg: (legId: number) => void;
  /** Ask to unlink a flown leg from its planned leg (page opens the confirm dialog). */
  onRequestUnlink: (flightId: number) => void;
  unlinkBusyFlightId: number | null;
  unlinkErrorByFlight: Record<number, string>;
  /** Ask to remove a flight from the trip (the flight itself is kept; page opens the confirm dialog). */
  onRequestRemoveFlight: (flightId: number) => void;

  legPicker: LegLinkPicker;
  flightPicker: FlightLinkPicker;
  legMovePicker: LegMovePicker;

  /** Reload the trip from the server, e.g. after the table changes something itself. */
  onRefresh: () => void;
  /** True while the trip is being reloaded after a mutation. */
  refreshing: boolean;
}
