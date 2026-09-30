import type { SimFrame, GroundSession, GroundSessionLiveStatus, GroundSessionEndReason } from '../types';
import { getPlannedLegById, getTripName } from '../db';
import {
  insertGroundSession, getOpenGroundSession, closeOpenGroundSession, fillOpenGroundSessionGaps,
} from '../db/groundSessions';
import { findNearestAirport } from '../airports';
import { nextParkedStreak, hasParkedDebounce, hasLeftAnchor } from '../groundState';
import { TAXI_OUT_SPEED_KTS } from './constants';
import type { GroundLegMatch } from './plannedLegLink';

/** The ground-entry leg match, run inside enter()'s own try so a throw from it fails the entry too. */
export type GroundLegMatcher = (frame: SimFrame, startedAt: string) => GroundLegMatch;

/** Whether the parked debounce has been met on this frame. */
export type IdleFact = 'debounce-met' | 'not-yet';

/** Whether the aircraft has moved far enough from the entry anchor to invalidate the session. */
export type GroundFact = 'left-anchor' | 'at-anchor';

/** Whether the adopt-or-insert at ground entry succeeded. */
export type EntryFact = 'entered' | 'failed';

/** Whether a ground session is still open after a refresh. */
export type RefreshFact = 'closed' | 'updated';

/** What OUT reports, captured from the ground session before it is closed. */
export interface OutBlocks {
  /** The off-blocks memo, or null when no taxi-speed frame was seen. */
  outAt: string | null;
  airportIcao: string | null;
  stand: string | null;
}

/**
 * GroundSessionLiveStatus doubles as the in-memory cache: its fields are
 * exactly what /api/status needs and nothing this class computes per poll.
 * Built once at ground-session entry (or adoption) and never re-read from
 * the database per frame — same reasoning as the planned-leg link's cache.
 */
function buildGroundSessionCache(session: GroundSession): GroundSessionLiveStatus {
  let tripId: number | null = null;
  let tripName: string | null = null;
  let departureIdent: string | null = null;
  let destinationIdent: string | null = null;

  if (session.planned_leg_id !== null) {
    const leg = getPlannedLegById(session.planned_leg_id);
    if (leg) {
      tripId = leg.trip_id;
      tripName = leg.trip_id !== null ? getTripName(leg.trip_id) ?? null : null;
      departureIdent = leg.departure_ident;
      destinationIdent = leg.destination_ident;
    }
  }

  return {
    groundSessionId: session.id,
    source: session.source,
    airportIcao: session.airport_icao,
    airportName: session.airport_name,
    parkingPosition: session.parking_position,
    parkingPositionSource: session.parking_position_source,
    plannedLegId: session.planned_leg_id,
    plannedLegLinkSource: session.planned_leg_link_source,
    tripId,
    tripName,
    departureIdent,
    destinationIdent,
    startedAt: session.started_at,
  };
}

/**
 * The ground-session bookkeeping for an aircraft parked before a flight: the
 * parked debounce, the session row's adoption or insertion, the anchor used to
 * detect a teleport, the live-status cache and the off-blocks memo. It never
 * decides what state the flight machine is in and never notifies anyone; every
 * method returns a fact (or nothing) and the caller acts on it.
 */
export class GroundTracker {
  // Consecutive parked-qualifying frames while IDLE or GROUND; see groundState.ts.
  private streak = 0;
  // The position recorded at ground-session entry/adoption, held only in
  // memory — used to detect a teleport away from it (hasLeftAnchor).
  private anchor: { lat: number; lon: number } | null = null;
  private cache: GroundSessionLiveStatus | null = null;
  // The instant the aircraft first moved under power while GROUND — the
  // off-blocks memo used to timestamp OUT. Null until a taxi-speed frame is
  // seen; reset whenever GROUND is (re-)entered or left.
  private outBlocksAt: string | null = null;

  /** One more IDLE frame: true once enough consecutive parked frames have accumulated. */
  observeIdle(frame: SimFrame): IdleFact {
    this.streak = nextParkedStreak(this.streak, frame);
    return hasParkedDebounce(this.streak) ? 'debounce-met' : 'not-yet';
  }

  /**
   * Reached when GROUND_DEBOUNCE_FRAMES consecutive frames have qualified as
   * parked. Resolves the airport and a planned leg exactly once, the same
   * work a takeoff does — never per frame. The leg match is the caller's,
   * run here so that one failure boundary covers the session lookup, the
   * airport lookup, the match and the write; any throw leaves the caller in
   * IDLE with the parked streak restarted.
   */
  enter(frame: SimFrame, matchLeg: GroundLegMatcher): EntryFact {
    try {
      const startedAt = new Date().toISOString();
      const open = getOpenGroundSession();
      const ap = findNearestAirport(frame.lat, frame.lon);
      const match = matchLeg(frame, startedAt);

      let session: GroundSession;
      if (open) {
        // Adopted, not inserted: an operator may have entered a session by
        // hand before the debounce ever tripped. Only the columns still blank
        // get filled in — anything the operator (or an earlier session)
        // already recorded is left exactly as it is, and `source` is never
        // rewritten.
        //
        // airport_name travels with airport_icao, not independently: if the
        // resolved airport disagrees with an airport_icao the row already
        // has, the operator's code wins outright and no name is attached to
        // it at all — filling in the resolved name here would leave a row
        // whose code and name name two different airports.
        const knownIcao = open.airport_icao;
        const airportAgrees = knownIcao === null || ap === null || knownIcao === ap.icao;
        if (!airportAgrees) {
          console.log(
            `[FlightManager] Ground session #${open.id} — detected airport ${ap!.icao} disagrees with recorded ${knownIcao}; keeping ${knownIcao}`
          );
        }

        const filled = fillOpenGroundSessionGaps({
          airport_icao: airportAgrees ? (ap?.icao ?? null) : null,
          airport_name: airportAgrees ? (ap?.name ?? null) : null,
          lat: frame.lat,
          lon: frame.lon,
          parking_position: match.parkingPosition,
          parking_position_source: match.parkingPosition !== null ? 'auto' : null,
          planned_leg_id: match.plannedLegId,
          planned_leg_link_source: match.plannedLegId !== null ? 'auto' : null,
          aircraft: frame.aircraft,
        });
        session = filled ?? open;
        console.log(`[FlightManager] Ground session #${session.id} adopted (${session.source})`);
      } else {
        session = insertGroundSession({
          source: 'auto',
          airport_icao: ap?.icao ?? null,
          airport_name: ap?.name ?? null,
          lat: frame.lat,
          lon: frame.lon,
          parking_position: match.parkingPosition,
          parking_position_source: match.parkingPosition !== null ? 'auto' : null,
          planned_leg_id: match.plannedLegId,
          planned_leg_link_source: match.plannedLegId !== null ? 'auto' : null,
          aircraft: frame.aircraft,
          started_at: startedAt,
        });
        console.log(
          `[FlightManager] Ground session #${session.id} — ${ap ? `${ap.icao} (${ap.name})` : 'no airport within 10 nm'}`
        );
      }

      this.anchor = { lat: frame.lat, lon: frame.lon };
      this.cache = buildGroundSessionCache(session);
      this.streak = 0;
      this.outBlocksAt = null;
      return 'entered';
    } catch (err) {
      console.warn('[FlightManager] Ground session entry failed, staying IDLE:', err);
      this.streak = 0;
      return 'failed';
    }
  }

  /**
   * One more GROUND frame, after the caller's own slew test. Reports a jump
   * away from the entry anchor; otherwise records the off-blocks memo on the
   * first frame on the ground at taxi speed.
   */
  observeGround(frame: SimFrame): GroundFact {
    if (this.anchor && hasLeftAnchor(this.anchor.lat, this.anchor.lon, frame.lat, frame.lon)) {
      return 'left-anchor';
    }
    if (this.outBlocksAt === null && frame.onGround && frame.groundSpeedKnots >= TAXI_OUT_SPEED_KTS) {
      this.outBlocksAt = new Date().toISOString();
    }
    return 'at-anchor';
  }

  /**
   * The flight starting: captures what OUT reports, closes whatever ground
   * session is open, and forgets all ground tracking.
   *
   * The capture comes first, because the close is followed by clearing the
   * cache it reads from — OUT still has to report the stand and airport the
   * aircraft was parked at. It is unconditional, whatever state the caller
   * was in: a manual session adopted while IDLE feeds OUT just the same.
   *
   * The close is unconditional too, and swallowed: a manual ground session
   * may exist with no agent ever having connected, so it is never known only
   * from in-memory tracking, and nothing about a ground session may stand
   * between a sim session and the flight row that records it. The captured
   * values are returned even when the close threw.
   */
  handOffToFlight(flightId: number): OutBlocks {
    const out: OutBlocks = {
      outAt: this.outBlocksAt,
      airportIcao: this.cache?.airportIcao ?? null,
      stand: this.cache?.parkingPosition ?? null,
    };
    try {
      closeOpenGroundSession('flight-started', flightId);
    } catch (err) {
      console.warn(`[FlightManager] Flight #${flightId} ground session close failed:`, err);
    }
    this.anchor = null;
    this.cache = null;
    this.streak = 0;
    this.outBlocksAt = null;
    return out;
  }

  /**
   * Closes whatever ground session is open, whatever its source. Used for the
   * exits that are themselves positive evidence the aircraft is no longer
   * where the session says it is: a slew, a jump far enough away that the
   * place recorded at entry is no longer credible, or the sim reporting
   * itself not running.
   */
  closeAny(reason: GroundSessionEndReason): void {
    try {
      closeOpenGroundSession(reason);
    } catch (err) {
      console.warn(`[FlightManager] Ground session close (${reason}) failed:`, err);
    }
  }

  /**
   * Closes the open ground session, but only when it was detected
   * automatically. A vanished agent or a crash is an absence of evidence, not
   * evidence against something the operator typed by hand — a manual session
   * is left open for them to close explicitly.
   *
   * The gate reads the row that is actually open right now
   * (getOpenGroundSession()), never the in-memory cache: a manual correction
   * over an open session can turn an auto session into a fresh manual one
   * without the machine ever leaving GROUND, and the cache built at the
   * earlier entry would still say 'auto' long after the row it described
   * was closed.
   */
  closeAutoOnly(reason: GroundSessionEndReason): void {
    try {
      const open = getOpenGroundSession();
      if (open?.source === 'auto') {
        closeOpenGroundSession(reason);
      }
    } catch (err) {
      console.warn(`[FlightManager] Ground session close (${reason}) failed:`, err);
    }
  }

  /**
   * Re-reads the open session after a write made behind this tracker's back
   * (the ground-sessions routes talk to the database directly). An open row is
   * adopted into the cache whatever state the caller is in — a manual session
   * may exist with no agent connected at all. Finding no open row changes
   * nothing here: whether that means the caller's own session was closed, or
   * only that the cache should be dropped, is the caller's call. Not wrapped:
   * a failing read reaches the caller, and a failing cache build leaves the
   * previous cache in place.
   */
  refresh(): RefreshFact {
    const open = getOpenGroundSession();
    if (!open) return 'closed';
    this.cache = buildGroundSessionCache(open);
    return 'updated';
  }

  clearCache(): void {
    this.cache = null;
  }

  /**
   * The ground-session live-status cache, or null while no session is
   * tracked. Read-only, no query per call.
   */
  status(): GroundSessionLiveStatus | null {
    return this.cache;
  }

  /**
   * The open ground session's planned leg, read from the database on every
   * call: it covers a manual session open before or between flights, which
   * the cache may not know about.
   */
  openSessionLegId(): number | null {
    return getOpenGroundSession()?.planned_leg_id ?? null;
  }

  reset(): void {
    this.anchor = null;
    this.cache = null;
    this.streak = 0;
    this.outBlocksAt = null;
  }
}
