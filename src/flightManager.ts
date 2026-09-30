import type {
  SimFrame, FlightState, AppState, PlannedLegLiveStatus,
  GroundSession, GroundSessionLiveStatus, GroundSessionEndReason,
} from './types';
import type { FlightStatePayload } from './eventHub';
import type { OpenFlightRow, FlightTrackPoint } from './db';
import {
  insertFlight, insertPoint, closeFlight, getPlannedLegById, getTripName,
  getOpenFlight, getFlightTrackPoints,
} from './db';
import {
  insertGroundSession, getOpenGroundSession, closeOpenGroundSession, fillOpenGroundSessionGaps,
} from './db/groundSessions';
import { findNearestAirport } from './airports';
import { nextParkedStreak, hasParkedDebounce, hasLeftAnchor } from './groundState';
import { buildOooiMessage, buildPositionReportMessage, parsePositionReportIntervalMs } from './acars';
import { fileAcarsMessageOnce } from './acarsEvents';
import { haversineNm } from './geo';
import { MAX_COUNTED_GAP_MS, TAXI_OUT_SPEED_KTS } from './flight/constants';
import { summarizeTrack } from './flight/summarizeTrack';
import { PlannedLegLink } from './flight/plannedLegLink';

export { MAX_COUNTED_GAP_MS, TAXI_OUT_SPEED_KTS } from './flight/constants';

const RECORD_INTERVAL_MS = 5000;
const AIRBORNE_DEBOUNCE_FRAMES = 3;
const LANDED_DEBOUNCE_FRAMES = 10;

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

export class FlightManager {
  private state: FlightState = 'IDLE';
  private currentFlightId: number | null = null;
  private readonly link = new PlannedLegLink();
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
   * flight in progress, the effective leg is whatever the planned-leg link's
   * cache holds (never a database read); otherwise it is the open ground session's
   * planned_leg_id, if any, which covers a manual session open before or
   * between flights.
   */
  getFlightStatePayload(): FlightStatePayload {
    const currentFlightId = this.appState.currentFlightId;
    const plannedLegId = currentFlightId !== null
      ? this.link.currentLegId()
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
      const match = this.link.matchForGround(frame, startedAt);

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
    const refs = this.link.refs();
    const msg = buildOooiMessage({
      flightId: this.currentFlightId,
      event: 'ON',
      at,
      airportIcao: ap?.icao ?? null,
      stand: null,
      aircraft: frame.aircraft,
      destinationIdent: refs.destinationIdent,
      plannedLegId: refs.plannedLegId,
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
    // reason link.autoLink() is below — nothing about a ground session
    // may stand between a sim session and the flight row that records it.
    try {
      closeOpenGroundSession('flight-started', id);
    } catch (err) {
      console.warn(`[FlightManager] Flight #${id} ground session close failed:`, err);
    }
    this.groundAnchor = null;
    this.groundSessionCache = null;

    this.link.clear();
    this.link.autoLink(id, frame, startTime);

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
    const refs = this.link.refs();
    fileAcarsMessageOnce(buildOooiMessage({
      flightId: id,
      event: 'OUT',
      at: outAt ?? startTime,
      airportIcao: outAirportIcao,
      stand: outStand,
      aircraft: frame.aircraft,
      destinationIdent: refs.destinationIdent,
      plannedLegId: refs.plannedLegId,
      estimated: outEstimated,
    }), `Flight #${id} OUT`);
    fileAcarsMessageOnce(buildOooiMessage({
      flightId: id,
      event: 'OFF',
      at: startTime,
      airportIcao: dep?.icao ?? null,
      stand: null,
      aircraft: frame.aircraft,
      destinationIdent: refs.destinationIdent,
      plannedLegId: refs.plannedLegId,
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
    this.link.clear();
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

    this.link.recordArrival(this.currentFlightId, frame);

    // ON and IN both carry the link's refs, so they are read before the link
    // is cleared below.
    const refs = this.link.refs();

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
        destinationIdent: refs.destinationIdent,
        plannedLegId: refs.plannedLegId,
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
      destinationIdent: refs.destinationIdent,
      plannedLegId: refs.plannedLegId,
      estimated: false,
    }), `Flight #${this.currentFlightId} IN`);

    this.currentFlightId = null;
    this.link.clear();
    this.state = 'IDLE';
    this.appState.flightState = 'IDLE';
    this.appState.currentFlightId = null;
    this.notifyScopeChange();
    this.airborneStreak = 0;
    this.landedStreak = 0;
  }

  /**
   * The live-panel context for /api/status, or null while unlinked. Reads the
   * link's cache only, so a 1 Hz poll costs nothing here; see
   * PlannedLegLink.status() in src/flight/plannedLegLink.ts.
   */
  getPlannedLegStatus(lat: number, lon: number): PlannedLegLiveStatus | null {
    return this.link.status(lat, lon);
  }

  /**
   * Called by the manual link/unlink endpoint, which talks
   * to the database directly and never goes through FlightManager. Without
   * this, linking or unlinking the in-progress flight by hand would leave the
   * live-status cache pointed at whatever link.autoLink last set (or at
   * nothing), silently disagreeing with the row the rest of the app now
   * reads. A no-op for any flight that isn't the one currently flying.
   *
   * The scope listener is told after every call, including one for a flight
   * that is not current; a throw from the link's reads propagates with no
   * notification.
   */
  refreshPlannedLegForFlight(flightId: number): void {
    this.link.refreshForFlight(flightId, this.currentFlightId);
    this.notifyScopeChange();
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
      if (this.link.currentLegId() === null) return;

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
