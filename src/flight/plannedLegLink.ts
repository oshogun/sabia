import type { SimFrame, PlannedLegWithChildren, PlannedLegLiveStatus } from '../types';
import {
  getActiveTripId, getPlannedLegCandidatesForActiveTrip, getPlannedLegById,
  linkFlightToPlannedLeg, recordPlannedLegArrival, getTripName, getFlightPlannedLegId,
} from '../db';
import { matchPlannedLeg, DEPARTURE_RADIUS_NM, ARRIVAL_RADIUS_NM } from '../legMatcher';
import type { LegMatchResult } from '../legMatcher';
import { haversineNm } from '../geo';
import { buildRemainingFromNm, progressAlongLeg } from './legProgress';

/** What the OUT/OFF/ON/IN messages carry from the link. */
export interface LegRefs {
  destinationIdent: string | null;
  plannedLegId: number | null;
}

/** The outcome of the ground-entry match: the leg it would attach to, and the stand it reports. */
export interface GroundLegMatch {
  plannedLegId: number | null;
  parkingPosition: string | null;
}

/** `result.distanceNm` is unrounded and null before the radius is applied. */
function formatNm(distanceNm: number | null): string {
  return distanceNm === null ? 'unknown distance' : `${distanceNm.toFixed(1)} nm`;
}

/**
 * The parenthetical that follows a refusal's reason code in the log.
 *
 * `nearbyLegIds` does not mean one thing: for AMBIGUOUS it is the *eligible*
 * ids — the choices, which is what the line should name — and for every
 * other outcome reached after the radius test it is every id within the
 * radius. Before the radius is usefully applied it is empty, and then the
 * only thing worth reporting is how far the nearest planned departure was, if
 * the matcher got far enough to measure one.
 */
function describeRefusal(result: LegMatchResult): string {
  const legs = result.nearbyLegIds;
  const named = `${legs.length === 1 ? 'leg' : 'legs'} ${legs.join(', ')} within ${DEPARTURE_RADIUS_NM} nm`;
  if (result.reason === 'AMBIGUOUS') {
    return ` (${named})`;
  }
  if (legs.length > 0) {
    return ` (${named}, nearest ${formatNm(result.distanceNm)})`;
  }
  if (result.distanceNm !== null) {
    return ` (nearest planned departure ${formatNm(result.distanceNm)} away)`;
  }
  return '';
}

/**
 * Live-status cache for the flight currently FLYING, built once — at
 * auto-link time, or refreshed on a manual link/unlink — never re-read from
 * the database per status poll. `waypoints` mirrors the leg's own
 * planned_waypoints order (departure first, destination last, per
 * lnmpln.ts); `remainingFromNm[i]` is the great-circle distance from
 * `waypoints[i]` to the destination, following that same chain.
 */
interface PlannedLegCache {
  flightId: number;
  plannedLegId: number;
  tripId: number | null;
  tripName: string | null;
  destinationIdent: string;
  waypoints: { ident: string; lat: number; lon: number }[];
  remainingFromNm: number[];
}

function buildPlannedLegCache(flightId: number, leg: PlannedLegWithChildren): PlannedLegCache {
  const waypoints = leg.waypoints.map(w => ({ ident: w.ident, lat: w.lat, lon: w.lon }));
  const remainingFromNm = buildRemainingFromNm(waypoints);
  return {
    flightId,
    plannedLegId: leg.id,
    tripId: leg.trip_id,
    tripName: leg.trip_id !== null ? getTripName(leg.trip_id) ?? '' : null,
    destinationIdent: leg.destination_ident,
    waypoints,
    remainingFromNm,
  };
}

/**
 * The planned leg the current flight is linked to: the takeoff auto-match, the
 * ground-entry twin of it, the landing outcome, and the live-status cache the
 * /api/status poll reads. It never notifies anyone of a scope change and never
 * touches flight state; the caller owns both.
 */
export class PlannedLegLink {
  private cache: PlannedLegCache | null = null;

  /**
   * Auto-match at takeoff — exactly once per flight, never from the frame path.
   * The candidates are loaded here and the matcher works on the legs' own
   * stored coordinates, so findNearestAirport() stays at its three calls per
   * flight (departure at takeoff, the ON station at touchdown, and arrival at
   * the end of the flight — OFF reuses the departure lookup) and the frame
   * path gains nothing at all.
   *
   * Everything is caught, deliberately and without rethrowing. insertFlight()
   * has already run by the time this is reached, and nothing the trip planner
   * does may stand between a sim session and the row that records it: a link
   * that failed is one click to fix in the UI, a flight that was never written
   * is gone with the session. So a throw from either query, from the matcher or
   * from the link write degrades to an unlinked flight and a log line.
   *
   * The cache is not cleared first: the caller clears it before calling this,
   * and a refusal leaves whatever it held.
   */
  autoLink(flightId: number, frame: SimFrame, startTime: string): void {
    try {
      const result = matchPlannedLeg({
        lat: frame.lat,
        lon: frame.lon,
        startTime,
        aircraft: frame.aircraft,
        activeTripId: getActiveTripId(),
        candidates: getPlannedLegCandidatesForActiveTrip(),
        // The flight row was inserted immediately before this call, so a
        // freshly inserted flight cannot already carry a link — this
        // argument is always null here, and step 0 is structurally
        // unreachable from this call site by construction. It stays a real
        // guard for matchPlannedLeg()'s other potential callers and for its
        // own scenario harness (inspect-legmatch.ts), which is a pure
        // function with no database and exercises step 0 directly. Note:
        // linkFlightToPlannedLeg() (the manual PUT path) does not call the
        // matcher at all, so it is not what this guard is for.
        flightAlreadyLinkedTo: null,
      });

      if (result.reason === 'MATCHED' && result.plannedLegId !== null) {
        // The one read the auto-match path doesn't budget for, and only on
        // the matched path: the candidates carry departureIdent but no
        // destination, and the frozen log line names the whole route. Read
        // before the write so that a link which succeeded can never be
        // reported as a failure because the label lookup was the thing that
        // threw.
        const leg = getPlannedLegById(result.plannedLegId);
        linkFlightToPlannedLeg(flightId, result.plannedLegId, 'auto');
        if (leg) this.cache = buildPlannedLegCache(flightId, leg);
        const route = leg ? `${leg.departure_ident}→${leg.destination_ident}, ` : '';
        console.log(
          `[FlightManager] Flight #${flightId} linked to planned leg #${result.plannedLegId} ` +
          `(${route}${formatNm(result.distanceNm)}, ${result.reason})`
        );
        return;
      }

      // A non-match is never silent: every refusal names its reason code, so an
      // unlinked flight is always explainable after the fact.
      console.log(
        `[FlightManager] Flight #${flightId} not linked — ${result.reason}${describeRefusal(result)}`
      );
    } catch (err) {
      console.warn(`[FlightManager] Flight #${flightId} auto-link failed, flight recorded unlinked:`, err);
    }
  }

  /**
   * The ground-session twin of autoLink(): same matcher, same candidates, same
   * radius, but it must never consume a leg the way a real takeoff does — no
   * linkFlightToPlannedLeg(), no status change on the leg, and the cache is
   * left alone. A ground session only records which leg it *would* attach to;
   * the flight itself still matches independently at rotation.
   */
  matchForGround(frame: SimFrame, startedAt: string): GroundLegMatch {
    try {
      const result = matchPlannedLeg({
        lat: frame.lat,
        lon: frame.lon,
        startTime: startedAt,
        aircraft: frame.aircraft,
        activeTripId: getActiveTripId(),
        candidates: getPlannedLegCandidatesForActiveTrip(),
        flightAlreadyLinkedTo: null,
      });

      if (result.reason === 'MATCHED' && result.plannedLegId !== null) {
        const leg = getPlannedLegById(result.plannedLegId);
        const route = leg ? `${leg.departure_ident}→${leg.destination_ident}, ` : '';
        console.log(
          `[FlightManager] Ground session matched planned leg #${result.plannedLegId} (${route}${formatNm(result.distanceNm)}, ${result.reason})`
        );
        // No SimVar publishes the parking spot's name. On this path the only
        // source is the matched leg's filed departure start (departure_start),
        // which can also be a runway, or null.
        return { plannedLegId: result.plannedLegId, parkingPosition: leg?.departure_start ?? null };
      }

      console.log(
        `[FlightManager] Ground session not linked to a planned leg — ${result.reason}${describeRefusal(result)}`
      );
      return { plannedLegId: null, parkingPosition: null };
    } catch (err) {
      console.warn('[FlightManager] Ground session leg match failed:', err);
      return { plannedLegId: null, parkingPosition: null };
    }
  }

  /**
   * Called when the manual link/unlink endpoint, which talks to the database
   * directly, changes the flight's link. Without this the cache would stay
   * pointed at whatever autoLink() last set (or at nothing), silently
   * disagreeing with the row the rest of the app now reads. A no-op, with no
   * query, for any flight that isn't `currentFlightId`.
   *
   * The new value is computed in full before the one assignment, so a throw
   * from any of the three reads leaves the cache as it was. Nothing is
   * caught here.
   */
  refreshForFlight(flightId: number, currentFlightId: number | null): void {
    if (flightId !== currentFlightId) return;
    const legId = getFlightPlannedLegId(flightId);
    if (legId === null) { this.cache = null; return; }
    const leg = getPlannedLegById(legId);
    this.cache = leg ? buildPlannedLegCache(flightId, leg) : null;
  }

  /**
   * Landing outcome for a linked flight. Runs after
   * closeFlight() for the same reason the takeoff match runs after
   * insertFlight(): by the time it can fail, the flight is already safely
   * closed, so a throw costs the leg's arrival state and nothing else.
   *
   * The link is read from the flight row rather than remembered from
   * takeoff. The user can link or unlink a flight from the UI while it
   * is still in the air, and the row is the only thing that knows about it —
   * remembering the takeoff match would mark a leg the user had since unlinked.
   * getFlightPlannedLegId() exists so that read costs one integer rather than
   * the flight's whole track.
   *
   * Reached from a crash and a sim disconnect as well as from a normal
   * landing, so `frame` may be anywhere at all — mid-ocean, mid-climb. That is
   * simply a large deviation and a 'diverted' leg: the flight did end that far
   * from its destination, and the record says so. It is not a special case and
   * must not become one.
   */
  recordArrival(flightId: number, frame: SimFrame): void {
    try {
      const legId = getFlightPlannedLegId(flightId);
      if (legId === null) return;

      const leg = getPlannedLegById(legId);
      if (!leg) return;

      const deviationNm = haversineNm(frame.lat, frame.lon, leg.destination_lat, leg.destination_lon);
      // The link is kept either way — a diversion never auto-unlinks, because
      // the link records the intent and that stays true when the destination
      // changed. arrival_deviation_nm is written on both paths.
      const status = deviationNm <= ARRIVAL_RADIUS_NM ? 'flown' : 'diverted';
      recordPlannedLegArrival(legId, status, Math.round(deviationNm * 10) / 10);

      console.log(
        `[FlightManager] Flight #${flightId} landed ${deviationNm.toFixed(1)} nm from ` +
        `planned ${leg.destination_ident} — leg #${legId} marked ${status}`
      );
    } catch (err) {
      console.warn(`[FlightManager] Flight #${flightId} arrival not recorded on its planned leg:`, err);
    }
  }

  /**
   * The live-panel context for /api/status, or null while
   * unlinked. Reads only the cache built at link time plus the two
   * coordinates the caller already has — no query, so a 1 Hz poll costs
   * nothing here. `lat`/`lon` come from the last frame, not stored, since the
   * server already holds it and passing it keeps this method pure.
   *
   * "Next waypoint" is the far end of whichever route segment the current
   * position is nearest to by cross-track distance (see crossTrackNm in
   * ./legProgress), which is what actually tracks progress along a
   * nearly-straight route.
   * `remainingDistanceNm` is then the direct distance to that waypoint plus
   * the rest of the chain from there to the destination — never a fraction
   * of raw distance flown, and always via the file's own waypoint chain.
   */
  status(lat: number, lon: number): PlannedLegLiveStatus | null {
    const cache = this.cache;
    if (!cache) return null;

    const { nextWaypointIdent, remainingDistanceNm } = progressAlongLeg(cache.waypoints, cache.remainingFromNm, lat, lon);

    return {
      plannedLegId: cache.plannedLegId,
      tripId: cache.tripId,
      tripName: cache.tripName,
      destinationIdent: cache.destinationIdent,
      nextWaypointIdent,
      remainingDistanceNm: Math.round(remainingDistanceNm * 10) / 10,
      distanceIsApproximate: true,
    };
  }

  /** What the OUT/OFF/ON/IN messages carry: the destination and leg ids, or nulls while unlinked. */
  refs(): LegRefs {
    return {
      destinationIdent: this.cache?.destinationIdent ?? null,
      plannedLegId: this.cache?.plannedLegId ?? null,
    };
  }

  /** The linked leg's id, or null while unlinked. */
  currentLegId(): number | null {
    return this.cache?.plannedLegId ?? null;
  }

  clear(): void {
    this.cache = null;
  }
}
