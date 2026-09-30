import type {
  SimFrame, FlightState, AppState, PlannedLegWithChildren, PlannedLegLiveStatus,
  GroundSession, GroundSessionLiveStatus, GroundSessionEndReason,
} from './types';
import type { FlightStatePayload } from './eventHub';
import type { OpenFlightRow, FlightTrackPoint } from './db';
import {
  insertFlight, insertPoint, closeFlight, getFlightPlannedLegId,
  getActiveTripId, getPlannedLegCandidatesForActiveTrip, getPlannedLegById,
  linkFlightToPlannedLeg, recordPlannedLegArrival, getTripName,
  getOpenFlight, getFlightTrackPoints,
} from './db';
import {
  insertGroundSession, getOpenGroundSession, closeOpenGroundSession, fillOpenGroundSessionGaps,
} from './db/groundSessions';
import { findNearestAirport } from './airports';
import { matchPlannedLeg, DEPARTURE_RADIUS_NM, ARRIVAL_RADIUS_NM } from './legMatcher';
import type { LegMatchResult } from './legMatcher';
import { nextParkedStreak, hasParkedDebounce, hasLeftAnchor } from './groundState';
import { buildOooiMessage, buildPositionReportMessage, parsePositionReportIntervalMs } from './acars';
import { fileAcarsMessageOnce } from './acarsEvents';
import { haversineNm } from './geo';
import { MAX_COUNTED_GAP_MS, TAXI_OUT_SPEED_KTS } from './flight/constants';
import { buildRemainingFromNm, progressAlongLeg } from './flight/legProgress';
import { summarizeTrack } from './flight/summarizeTrack';

export { MAX_COUNTED_GAP_MS, TAXI_OUT_SPEED_KTS } from './flight/constants';

const RECORD_INTERVAL_MS = 5000;
const AIRBORNE_DEBOUNCE_FRAMES = 3;
const LANDED_DEBOUNCE_FRAMES = 10;

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
 * GroundSessionLiveStatus doubles as the in-memory cache: its fields are
 * exactly what /api/status needs and nothing this class computes per poll.
 * Built once at ground-session entry (or adoption) and never re-read from
 * the database per frame — same reasoning as PlannedLegCache above.
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

export class FlightManager {
  private state: FlightState = 'IDLE';
  private currentFlightId: number | null = null;
  private plannedLegCache: PlannedLegCache | null = null;
  private airborneStreak = 0;
  private landedStreak = 0;
  // Consecutive parked-qualifying frames while IDLE or GROUND; see groundState.ts.
  private groundStreak = 0;
  // The position recorded at ground-session entry/adoption, held only in
  // memory — used to detect a teleport away from it (hasLeftAnchor).
  private groundAnchor: { lat: number; lon: number } | null = null;
  private groundSessionCache: GroundSessionLiveStatus | null = null;
  // The instant the aircraft first moved under power while GROUND — the
  // off-blocks memo used to timestamp OUT. Null until a taxi-speed frame is
  // seen; reset whenever GROUND is (re-)entered or left.
  private outBlocksAt: string | null = null;
  // Set once ON has been filed for the current flight, from either the
  // touchdown frame or the end-of-flight fallback — keeps whichever fires
  // second from filing ON twice.
  private onEventFiled = false;
  // Resolved once per flight from POSITION_REPORT_INTERVAL_MIN; 0 disables
  // position reports for this flight.
  private positionReportIntervalMs = 0;
  private lastPositionReportWindow = 0;
  private isPaused = false;
  private lastPointTime = 0;
  // Notified after every flight/leg scope change (see the call sites below);
  // null while nothing has attached one, which is the case for every existing
  // caller of this class that doesn't care.
  private scopeChangeListener: (() => void) | null = null;
  // Set whenever recording is skipped, so the following gap is known to be an
  // interruption regardless of how short it was.
  private interrupted = false;
  // The open-flight lookup is attempted exactly once per process, on the first
  // frame this instance evaluates — not once per takeoff. See checkAirborneDebounce().
  private openFlightCheckedAtBoot = false;

  // Accumulated stats for the current flight
  private distanceNm = 0;
  private maxAltitudeFt = 0;
  private maxAirspeedKts = 0;
  private pointCount = 0;
  private lastPointLat = 0;
  private lastPointLon = 0;
  private flightStartMs = 0;
  // Flight time accumulated from the gaps between recorded points, so that any
  // interruption which stops recording is excluded automatically.
  private activeMs = 0;

  readonly appState: AppState = {
    flightState: 'IDLE',
    currentFlightId: null,
    connected: false,
    lastFrame: null,
    paused: false,
    pauseFlags: 0,
  };

  /**
   * `flags` is the MSFS `Pause_EX1` bitmask: 1 full pause, 2 with sound
   * (legacy), 4 Active Pause (aircraft frozen, sim running), 8 sim frozen
   * (e.g. in a menu); 0 is unpaused.
   * Pausing suppresses point recording, which is what keeps paused time out of
   * the duration; the flags are kept so the UI can name the kind of pause.
   */
  setPaused(paused: boolean, flags = paused ? 1 : 0): void {
    // Mark here as well as in onFrame: a paused sim may stop sending frames
    // altogether, in which case onFrame never runs to flag the interruption.
    if (paused) this.interrupted = true;
    this.isPaused = paused;
    this.appState.paused = paused;
    this.appState.pauseFlags = paused ? flags : 0;
  }

  /** Attach (or detach with null) the callback fired after a scope change. */
  setScopeChangeListener(listener: (() => void) | null): void {
    this.scopeChangeListener = listener;
  }

  /**
   * The current flight/leg scope, resolved the same way at every call: for a
   * flight in progress, the effective leg is whatever this.plannedLegCache
   * holds (never a database read); otherwise it is the open ground session's
   * planned_leg_id, if any, which covers a manual session open before or
   * between flights.
   */
  getFlightStatePayload(): FlightStatePayload {
    const currentFlightId = this.appState.currentFlightId;
    const plannedLegId = currentFlightId !== null
      ? this.plannedLegCache?.plannedLegId ?? null
      : getOpenGroundSession()?.planned_leg_id ?? null;
    return { flightState: this.appState.flightState, currentFlightId, plannedLegId };
  }

  private notifyScopeChange(): void {
    if (!this.scopeChangeListener) return;
    try {
      this.scopeChangeListener();
    } catch (err) {
      console.warn('[FlightManager] scope listener failed:', err);
    }
  }

  onFrame(frame: SimFrame): void {
    this.appState.lastFrame = frame;

    if (frame.simRunning === 0) {
      if (this.state === 'FLYING') this.endFlight(frame);
      // The sim itself reporting not-running is positive telemetry evidence,
      // not mere silence — unlike onCrash()/onSimDisconnect() below, this
      // closes a manual session too.
      else if (this.state === 'GROUND') this.closeGroundSessionAndReturnToIdle('sim-exit');
      return;
    }

    const inSlew = frame.simRunning === 3;

    switch (this.state) {
      case 'IDLE':
        this.checkAirborneDebounce(frame, inSlew);
        if (this.state !== 'IDLE') break; // startFlight() already ran

        this.groundStreak = nextParkedStreak(this.groundStreak, frame);
        if (hasParkedDebounce(this.groundStreak)) {
          this.enterGround(frame);
        }
        break;

      case 'GROUND':
        if (inSlew) {
          this.closeGroundSessionAndReturnToIdle('slew');
          break;
        }
        if (this.groundAnchor && hasLeftAnchor(this.groundAnchor.lat, this.groundAnchor.lon, frame.lat, frame.lon)) {
          this.closeGroundSessionAndReturnToIdle('superseded');
          break;
        }
        if (this.outBlocksAt === null && frame.onGround && frame.groundSpeedKnots >= TAXI_OUT_SPEED_KTS) {
          this.outBlocksAt = new Date().toISOString();
        }
        // Taxiing does not leave this state — only rotation (below) or one of
        // the two checks above does. The same airborne test as from IDLE.
        this.checkAirborneDebounce(frame, inSlew);
        break;

      case 'FLYING':
        if (inSlew || this.isPaused) {
          this.interrupted = true;
          break;
        }

        this.recordPoint(frame);

        if (frame.onGround && !this.onEventFiled) this.fileTouchdownOn(frame);

        if (frame.onGround && frame.groundSpeedKnots < 5) {
          this.landedStreak++;
          if (this.landedStreak >= LANDED_DEBOUNCE_FRAMES) {
            this.endFlight(frame);
          }
        } else {
          this.landedStreak = 0;
        }
        break;
    }
  }

  onCrash(): void {
    if (this.state === 'FLYING' && this.appState.lastFrame) {
      this.endFlight(this.appState.lastFrame);
    } else if (this.state === 'GROUND') {
      this.closeAutoGroundSessionAndReturnToIdle('crash');
    }
  }

  onSimDisconnect(): void {
    if (this.state === 'FLYING' && this.appState.lastFrame) {
      this.endFlight(this.appState.lastFrame);
    } else if (this.state === 'GROUND') {
      this.closeAutoGroundSessionAndReturnToIdle('sim-exit');
    }
  }

  /**
   * The airborne debounce, identical whether reached from IDLE or from
   * GROUND: three consecutive qualifying frames start a flight. Factored out
   * so the two call sites cannot drift apart from each other.
   */
  private checkAirborneDebounce(frame: SimFrame, inSlew: boolean): void {
    if (!this.openFlightCheckedAtBoot) {
      // One attempt per process, whatever this frame looks like: a flight that
      // landed while the server was down never produces an airborne frame
      // again, so a check gated on the airborne condition would never see it.
      // The flag is set before the query, not after, so a failing database is
      // asked once rather than at frame rate.
      this.openFlightCheckedAtBoot = true;
      try {
        const open = getOpenFlight();
        if (open) {
          this.resumeFlight(open, frame);
          return;
        }
      } catch (err) {
        console.warn('[FlightManager] Open-flight check failed; starting fresh if a takeoff follows:', err);
      }
    }

    if (!inSlew && !frame.onGround && frame.airspeedKnots > 30) {
      this.airborneStreak++;
      if (this.airborneStreak >= AIRBORNE_DEBOUNCE_FRAMES) {
        this.startFlight(frame);
      }
    } else {
      this.airborneStreak = 0;
    }
  }

  /**
   * The ground-session live-status cache, or null while no session is
   * tracked as GROUND. Read-only, no query per call — same reasoning as
   * getPlannedLegStatus().
   */
  getGroundSessionStatus(): GroundSessionLiveStatus | null {
    return this.groundSessionCache;
  }

  /**
   * Called by the ground-sessions routes after every write, which talk to
   * the database directly and never go through FlightManager. Without this,
   * a refine, a correction, or a manual close would leave the live-status
   * cache pointed at whatever enterGround() last built, silently disagreeing
   * with the row the rest of the app now reads — the same problem
   * refreshPlannedLegForFlight() solves for a manual leg link.
   *
   * An open row is adopted into the cache whatever this.state currently is —
   * a manual session may exist with no agent connected at all, and this is
   * how a poll started after that write still sees it once the machine does
   * reach GROUND. Only the reverse direction touches state: finding no open
   * row while this machine is GROUND means the operator (or a correction)
   * closed the very session this machine was tracking, so it returns to
   * IDLE, exactly as a slew or a re-anchor would.
   */
  refreshGroundSession(): void {
    const open = getOpenGroundSession();
    if (!open) {
      if (this.state === 'GROUND') {
        // resetGroundTracking() already notifies at its own end.
        this.resetGroundTracking();
      } else {
        this.groundSessionCache = null;
        this.notifyScopeChange();
      }
      return;
    }
    this.groundSessionCache = buildGroundSessionCache(open);
    this.notifyScopeChange();
  }

  /**
   * Reached when GROUND_DEBOUNCE_FRAMES consecutive frames have qualified as
   * parked. Resolves the airport and a planned leg exactly once, the same
   * work startFlight() does for a takeoff — never per frame.
   */
  private enterGround(frame: SimFrame): void {
    try {
      const startedAt = new Date().toISOString();
      const open = getOpenGroundSession();
      const ap = findNearestAirport(frame.lat, frame.lon);
      const match = this.matchGroundPlannedLeg(frame, startedAt);

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

      this.groundAnchor = { lat: frame.lat, lon: frame.lon };
      this.groundSessionCache = buildGroundSessionCache(session);
      this.groundStreak = 0;
      this.outBlocksAt = null;
      this.state = 'GROUND';
      this.appState.flightState = 'GROUND';
      this.notifyScopeChange();
    } catch (err) {
      console.warn('[FlightManager] Ground session entry failed, staying IDLE:', err);
      this.groundStreak = 0;
    }
  }

  /**
   * The ground-session twin of autoLinkPlannedLeg(): same matcher, same
   * candidates, same radius, but it must never consume a leg the way a real
   * takeoff does — no linkFlightToPlannedLeg(), no status change on the leg.
   * A ground session only records which leg it *would* attach to; the flight
   * itself still matches independently at rotation.
   */
  private matchGroundPlannedLeg(frame: SimFrame, startTime: string): { plannedLegId: number | null; parkingPosition: string | null } {
    try {
      const result = matchPlannedLeg({
        lat: frame.lat,
        lon: frame.lon,
        startTime,
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
        // No SimVar publishes the parking spot's name. The one honest source
        // on this path is the matched leg's own filed departure stand.
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
   * Closes whatever ground session is open, whatever its source, and returns
   * to IDLE. Used for the exits that are themselves positive evidence the
   * aircraft is no longer where the session says it is: a slew, or a jump
   * far enough away that the place recorded at entry is no longer credible.
   */
  private closeGroundSessionAndReturnToIdle(reason: GroundSessionEndReason): void {
    try {
      closeOpenGroundSession(reason);
    } catch (err) {
      console.warn(`[FlightManager] Ground session close (${reason}) failed:`, err);
    }
    this.resetGroundTracking();
  }

  /**
   * Closes the open ground session and returns to IDLE, but only when the
   * session was detected automatically. A vanished agent or a crash is an
   * absence of evidence, not evidence against something the operator typed
   * by hand — a manual session is left open for them to close explicitly.
   *
   * The gate reads the row that is actually open right now
   * (getOpenGroundSession()), never the in-memory cache: a manual correction
   * over an open session can turn an auto session into a fresh manual one
   * without this machine ever leaving GROUND, and the cache built at the
   * earlier entry would still say 'auto' long after the row it described
   * was closed.
   */
  private closeAutoGroundSessionAndReturnToIdle(reason: GroundSessionEndReason): void {
    try {
      const open = getOpenGroundSession();
      if (open?.source === 'auto') {
        closeOpenGroundSession(reason);
      }
    } catch (err) {
      console.warn(`[FlightManager] Ground session close (${reason}) failed:`, err);
    }
    this.resetGroundTracking();
  }

  private resetGroundTracking(): void {
    this.groundAnchor = null;
    this.groundSessionCache = null;
    this.groundStreak = 0;
    this.outBlocksAt = null;
    this.state = 'IDLE';
    this.appState.flightState = 'IDLE';
    this.notifyScopeChange();
  }

  /**
   * A plain `this.plannedLegCache?.x` read is fine almost everywhere, but not
   * right after `this.plannedLegCache = null;` followed by a call to
   * autoLinkPlannedLeg() (startFlight()'s own reset-then-relink sequence):
   * TypeScript's control-flow narrowing there types a direct read as
   * always-null, since it cannot see into the called method. Going through a
   * separate method call breaks that stale narrowing instead of masking it
   * with a cast.
   */
  private plannedLegRefs(): { destinationIdent: string | null; plannedLegId: number | null } {
    return {
      destinationIdent: this.plannedLegCache?.destinationIdent ?? null,
      plannedLegId: this.plannedLegCache?.plannedLegId ?? null,
    };
  }

  /**
   * Fired at most once per flight, on the first frame back on the ground.
   * The flag is set before anything else so a rollout that stays onGround
   * for many frames still resolves the airport and files ON exactly once —
   * the dedup key (src/acars.ts) is the backstop, not the mechanism.
   */
  private fileTouchdownOn(frame: SimFrame): void {
    this.onEventFiled = true;
    if (this.currentFlightId === null) return;

    const at = new Date().toISOString();
    const ap = findNearestAirport(frame.lat, frame.lon);
    const msg = buildOooiMessage({
      flightId: this.currentFlightId,
      event: 'ON',
      at,
      airportIcao: ap?.icao ?? null,
      stand: null,
      aircraft: frame.aircraft,
      destinationIdent: this.plannedLegCache?.destinationIdent ?? null,
      plannedLegId: this.plannedLegCache?.plannedLegId ?? null,
      estimated: false,
    });
    fileAcarsMessageOnce(msg, `Flight #${this.currentFlightId} ON`);
  }

  private startFlight(frame: SimFrame): void {
    const startTime = new Date().toISOString();
    const dep = findNearestAirport(frame.lat, frame.lon);
    const id = insertFlight(frame.aircraft, frame.lat, frame.lon, startTime, dep?.icao ?? null, dep?.name ?? null);
    if (dep) console.log(`[FlightManager] Departure airport: ${dep.icao} (${dep.name})`);

    // Captured before the ground session is closed and its cache nulled
    // below, so OUT can still report the stand and airport the aircraft was
    // parked at — the off-blocks memo itself (outAt) was set earlier still,
    // on the GROUND branch of onFrame().
    const outAirportIcao = this.groundSessionCache?.airportIcao ?? null;
    const outStand = this.groundSessionCache?.parkingPosition ?? null;
    const outAt = this.outBlocksAt;

    // Unconditional, whatever this.state was: a manual ground session may
    // exist with no agent ever having connected, so it is never known only
    // from in-memory ground-tracking. Wrapped and swallowed for the same
    // reason autoLinkPlannedLeg() is below — nothing about a ground session
    // may stand between a sim session and the flight row that records it.
    try {
      closeOpenGroundSession('flight-started', id);
    } catch (err) {
      console.warn(`[FlightManager] Flight #${id} ground session close failed:`, err);
    }
    this.groundAnchor = null;
    this.groundSessionCache = null;

    this.plannedLegCache = null;
    this.autoLinkPlannedLeg(id, frame, startTime);

    this.currentFlightId = id;
    this.state = 'FLYING';
    this.airborneStreak = 0;
    this.landedStreak = 0;
    this.groundStreak = 0;
    this.distanceNm = 0;
    this.maxAltitudeFt = frame.altitudeFt;
    this.maxAirspeedKts = frame.airspeedKnots;
    this.pointCount = 0;
    this.lastPointLat = frame.lat;
    this.lastPointLon = frame.lon;
    this.lastPointTime = Date.now();
    this.flightStartMs = Date.now();
    this.activeMs = 0;
    this.interrupted = false;

    this.appState.flightState = 'FLYING';
    this.appState.currentFlightId = id;
    this.notifyScopeChange();

    this.onEventFiled = false;
    this.positionReportIntervalMs = parsePositionReportIntervalMs(process.env.POSITION_REPORT_INTERVAL_MIN);
    this.lastPositionReportWindow = 0;
    if (this.positionReportIntervalMs > 0) {
      console.log(`[FlightManager] Flight #${id} position reports every ${(this.positionReportIntervalMs / 60_000).toFixed(1)} min`);
    } else {
      console.log(`[FlightManager] Flight #${id} position reports disabled (POSITION_REPORT_INTERVAL_MIN=0)`);
    }

    const outEstimated = outAt === null;
    const link = this.plannedLegRefs();
    fileAcarsMessageOnce(buildOooiMessage({
      flightId: id,
      event: 'OUT',
      at: outAt ?? startTime,
      airportIcao: outAirportIcao,
      stand: outStand,
      aircraft: frame.aircraft,
      destinationIdent: link.destinationIdent,
      plannedLegId: link.plannedLegId,
      estimated: outEstimated,
    }), `Flight #${id} OUT`);
    fileAcarsMessageOnce(buildOooiMessage({
      flightId: id,
      event: 'OFF',
      at: startTime,
      airportIcao: dep?.icao ?? null,
      stand: null,
      aircraft: frame.aircraft,
      destinationIdent: link.destinationIdent,
      plannedLegId: link.plannedLegId,
      estimated: false,
    }), `Flight #${id} OFF`);
    this.outBlocksAt = null;

    console.log(`[FlightManager] Flight #${id} started — ${frame.aircraft}`);

    // Record the first point immediately
    this.writePoint(frame);
  }

  /**
   * Adopts an already-open flights row instead of starting a new one: the
   * server was restarted (or crashed) while this flight was in progress, and
   * the row it inserted at takeoff is still open. Everything the live
   * accumulators would have held is rebuilt from the points already recorded
   * for that flight; the downtime itself is disowned by `interrupted`, exactly
   * as a pause disowns the gap that spans it.
   *
   * Deliberately NOT a branch inside startFlight(): a resume must not insert a
   * row, must not close a ground session, must not file OUT/OFF, and must not
   * consume a planned leg — all four of those already happened for this flight,
   * before the restart.
   */
  private resumeFlight(row: OpenFlightRow, frame: SimFrame): void {
    const summary = summarizeTrack(getFlightTrackPoints(row.id), row, frame);

    // An unparseable start_time (a hand-edited row) falls back to now rather
    // than poison the arithmetic below with NaN.
    const flightStartMs = summary.startMs ?? Date.now();

    this.currentFlightId = row.id;
    this.state = 'FLYING';
    this.appState.flightState = 'FLYING';
    this.appState.currentFlightId = row.id;
    this.airborneStreak = 0;
    this.landedStreak = 0;
    this.groundStreak = 0;
    this.distanceNm = summary.distanceNm;
    this.maxAltitudeFt = summary.maxAltitudeFt;
    this.maxAirspeedKts = summary.maxAirspeedKts;
    this.pointCount = summary.pointCount;
    this.lastPointLat = summary.lastPointLat;
    this.lastPointLon = summary.lastPointLon;
    // Overwritten by the writePoint() call below; the only thing this value
    // does first is feed that call's own gap computation, and Date.now() makes
    // that gap ~0 rather than the whole outage.
    this.lastPointTime = Date.now();
    this.flightStartMs = flightStartMs;
    this.activeMs = summary.activeMs;
    // The outage is an interruption exactly like a pause or a slew: its time
    // must not be counted, even though its distance (added by the writePoint()
    // call below) should be.
    this.interrupted = true;
    this.onEventFiled = false;
    this.positionReportIntervalMs = parsePositionReportIntervalMs(process.env.POSITION_REPORT_INTERVAL_MIN);
    this.lastPositionReportWindow = 0;

    // Reloaded read-only: this flight's link (if any) was already made at its
    // real takeoff, and matching again here would consume a leg a second time.
    this.plannedLegCache = null;
    try {
      this.refreshPlannedLegForFlight(row.id);
    } catch (err) {
      console.warn(`[FlightManager] Flight #${row.id} planned-leg cache not restored:`, err);
    }

    console.log(
      `[FlightManager] Flight #${row.id} resumed after restart — ${summary.pointCount} points, ` +
      `${summary.distanceNm.toFixed(1)} nm, ${Math.round(summary.activeMs / 1000)}s counted before the interruption`
    );

    // Same call startFlight() ends with: it adds the outage's distance,
    // drops its (already-excluded) gap because interrupted is true, and
    // clears interrupted so the next gap counts normally.
    this.writePoint(frame);
    this.notifyScopeChange();
  }

  private endFlight(frame: SimFrame): void {
    if (this.currentFlightId === null) return;

    const endTime = new Date().toISOString();
    // Include the final partial interval between the last point and touchdown
    const tailMs = Date.now() - this.lastPointTime;
    if (!this.interrupted && tailMs <= MAX_COUNTED_GAP_MS) this.activeMs += tailMs;

    const durationSec = Math.round(this.activeMs / 1000);
    const excludedSec = Math.max(0,
      Math.round((Date.now() - this.flightStartMs) / 1000) - durationSec);

    const arr = findNearestAirport(frame.lat, frame.lon);
    if (arr) console.log(`[FlightManager] Arrival airport: ${arr.icao} (${arr.name})`);
    closeFlight(
      this.currentFlightId,
      endTime,
      frame.lat,
      frame.lon,
      durationSec,
      Math.round(this.distanceNm * 10) / 10,
      Math.round(this.maxAltitudeFt),
      Math.round(this.maxAirspeedKts),
      this.pointCount,
      arr?.icao ?? null,
      arr?.name ?? null
    );

    console.log(
      `[FlightManager] Flight #${this.currentFlightId} ended — ` +
      `${this.pointCount} points, ${this.distanceNm.toFixed(1)} nm, ${durationSec}s` +
      (excludedSec > 0 ? ` (${excludedSec}s interrupted, excluded)` : '')
    );

    this.recordArrivalOnPlannedLeg(this.currentFlightId, frame);

    // ON's fallback: only when no touchdown frame was ever seen (crash, sim
    // exit or agent loss while airborne) — the touchdown path (fileTouchdownOn)
    // already filed it. Either way IN follows immediately, sharing endTime.
    if (!this.onEventFiled) {
      fileAcarsMessageOnce(buildOooiMessage({
        flightId: this.currentFlightId,
        event: 'ON',
        at: endTime,
        airportIcao: arr?.icao ?? null,
        stand: null,
        aircraft: frame.aircraft,
        destinationIdent: this.plannedLegCache?.destinationIdent ?? null,
        plannedLegId: this.plannedLegCache?.plannedLegId ?? null,
        estimated: true,
      }), `Flight #${this.currentFlightId} ON`);
      this.onEventFiled = true;
    }
    fileAcarsMessageOnce(buildOooiMessage({
      flightId: this.currentFlightId,
      event: 'IN',
      at: endTime,
      airportIcao: arr?.icao ?? null,
      stand: null,
      aircraft: frame.aircraft,
      destinationIdent: this.plannedLegCache?.destinationIdent ?? null,
      plannedLegId: this.plannedLegCache?.plannedLegId ?? null,
      estimated: false,
    }), `Flight #${this.currentFlightId} IN`);

    this.currentFlightId = null;
    this.plannedLegCache = null;
    this.state = 'IDLE';
    this.appState.flightState = 'IDLE';
    this.appState.currentFlightId = null;
    this.notifyScopeChange();
    this.airborneStreak = 0;
    this.landedStreak = 0;
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
   * src/flight/legProgress.ts), which is what actually tracks progress along a
   * nearly-straight route.
   * `remainingDistanceNm` is then the direct distance to that waypoint plus
   * the rest of the chain from there to the destination — never a fraction
   * of raw distance flown, and always via the file's own waypoint chain.
   */
  getPlannedLegStatus(lat: number, lon: number): PlannedLegLiveStatus | null {
    const cache = this.plannedLegCache;
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

  /**
   * Called by the manual link/unlink endpoint, which talks
   * to the database directly and never goes through FlightManager. Without
   * this, linking or unlinking the in-progress flight by hand would leave the
   * live-status cache pointed at whatever autoLinkPlannedLeg last set (or at
   * nothing), silently disagreeing with the row the rest of the app now
   * reads. A no-op for any flight that isn't the one currently flying.
   */
  refreshPlannedLegForFlight(flightId: number): void {
    if (flightId !== this.currentFlightId) { this.notifyScopeChange(); return; }
    const legId = getFlightPlannedLegId(flightId);
    if (legId === null) { this.plannedLegCache = null; this.notifyScopeChange(); return; }
    const leg = getPlannedLegById(legId);
    this.plannedLegCache = leg ? buildPlannedLegCache(flightId, leg) : null;
    this.notifyScopeChange();
  }

  /**
   * Auto-match at takeoff — exactly once per flight, never from
   * onFrame/recordPoint/writePoint. The candidates are loaded here and the
   * matcher works on the legs' own stored coordinates, so
   * findNearestAirport() stays at its three calls per flight (departure in
   * startFlight(), the ON station in fileTouchdownOn(), and arrival in
   * endFlight() — OFF reuses startFlight()'s own `dep`) and the frame path
   * gains nothing at all.
   *
   * Everything is caught, deliberately and without rethrowing. insertFlight()
   * has already run by the time this is reached, and nothing the trip planner
   * does may stand between a sim session and the row that records it: a link
   * that failed is one click to fix in the UI, a flight that was never written
   * is gone with the session. So a throw from either query, from the matcher or
   * from the link write degrades to an unlinked flight and a log line.
   */
  private autoLinkPlannedLeg(flightId: number, frame: SimFrame, startTime: string): void {
    try {
      const result = matchPlannedLeg({
        lat: frame.lat,
        lon: frame.lon,
        startTime,
        aircraft: frame.aircraft,
        activeTripId: getActiveTripId(),
        candidates: getPlannedLegCandidatesForActiveTrip(),
        // startFlight() inserted the flight row immediately before this call,
        // so a freshly inserted flight cannot already carry a link — this
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
        if (leg) this.plannedLegCache = buildPlannedLegCache(flightId, leg);
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
   * Landing outcome for a linked flight. Runs after
   * closeFlight() for the same reason the takeoff match runs after
   * insertFlight(): by the time it can fail, the flight is already safely
   * closed, so a throw costs the leg's arrival state and nothing else.
   *
   * The link is read from the flight row rather than remembered from
   * startFlight(). The user can link or unlink a flight from the UI while it
   * is still in the air, and the row is the only thing that knows about it —
   * remembering the takeoff match would mark a leg the user had since unlinked.
   * getFlightPlannedLegId() exists so that read costs one integer rather than
   * the flight's whole track.
   *
   * Reached from onCrash() and onSimDisconnect() as well as from a normal
   * landing, so `frame` may be anywhere at all — mid-ocean, mid-climb. That is
   * simply a large deviation and a 'diverted' leg, which is the honest record;
   * it is not a special case and must not become one.
   */
  private recordArrivalOnPlannedLeg(flightId: number, frame: SimFrame): void {
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

  private recordPoint(frame: SimFrame): void {
    if (Date.now() - this.lastPointTime < RECORD_INTERVAL_MS) return;
    this.writePoint(frame);
  }

  private writePoint(frame: SimFrame): void {
    if (this.currentFlightId === null) return;

    const now = Date.now();
    const ts = new Date(now).toISOString();

    if (this.pointCount > 0) {
      this.distanceNm += haversineNm(this.lastPointLat, this.lastPointLon, frame.lat, frame.lon);

      // Flight time is built from the gaps between points rather than the wall
      // clock. A gap far longer than the recording interval means recording had
      // stopped — a pause, slew, a frozen sim, a crashed agent — and that time
      // was not flown, so it is not counted.
      const gap = now - this.lastPointTime;
      if (!this.interrupted && gap <= MAX_COUNTED_GAP_MS) this.activeMs += gap;
    }

    if (frame.altitudeFt > this.maxAltitudeFt) this.maxAltitudeFt = frame.altitudeFt;
    if (frame.airspeedKnots > this.maxAirspeedKts) this.maxAirspeedKts = frame.airspeedKnots;

    insertPoint(
      this.currentFlightId,
      ts,
      frame.lat,
      frame.lon,
      frame.altitudeFt,
      frame.airspeedKnots,
      frame.groundSpeedKnots,
      frame.headingDeg,
      frame.verticalSpeedFpm,
      frame.onGround
    );

    this.lastPointLat = frame.lat;
    this.lastPointLon = frame.lon;
    this.lastPointTime = now;
    this.pointCount++;
    this.interrupted = false;

    this.maybeFilePositionReport(frame, now, ts);
  }

  /**
   * Files a position report at most once per configured interval window, and
   * only for a flight linked to a planned leg — an unlinked flight gets
   * clean OOOI-only reporting, never a thrown error and never a log line.
   * Wrapped in its own try/catch so nothing here, including a degenerate
   * route from getPlannedLegStatus(), can interrupt point recording.
   */
  private maybeFilePositionReport(frame: SimFrame, nowMs: number, ts: string): void {
    try {
      if (this.currentFlightId === null) return;
      if (this.positionReportIntervalMs <= 0) return;
      if (this.plannedLegCache === null) return;

      const windowIndex = Math.floor((nowMs - this.flightStartMs) / this.positionReportIntervalMs);
      if (windowIndex < 1 || windowIndex <= this.lastPositionReportWindow) return;
      this.lastPositionReportWindow = windowIndex;

      const status = this.getPlannedLegStatus(frame.lat, frame.lon);
      if (status === null) return;

      fileAcarsMessageOnce(buildPositionReportMessage({
        flightId: this.currentFlightId,
        windowIndex,
        at: ts,
        lat: frame.lat,
        lon: frame.lon,
        altitudeFt: frame.altitudeFt,
        groundSpeedKnots: frame.groundSpeedKnots,
        headingDeg: frame.headingDeg,
        nextWaypointIdent: status.nextWaypointIdent,
        destinationIdent: status.destinationIdent,
        remainingDistanceNm: status.remainingDistanceNm,
        plannedLegId: status.plannedLegId,
      }), `Flight #${this.currentFlightId} position report`);
    } catch (err) {
      console.warn('[FlightManager] Position report not filed:', err);
    }
  }
}
