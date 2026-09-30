import type {
  SimFrame, FlightState, AppState, PlannedLegLiveStatus,
  GroundSessionLiveStatus, GroundSessionEndReason,
} from './types';
import type { FlightStatePayload } from './eventHub';
import type { OpenFlightRow, FlightTrackPoint } from './db';
import {
  insertFlight, insertPoint, closeFlight, getOpenFlight, getFlightTrackPoints,
} from './db';
import { findNearestAirport } from './airports';
import { buildOooiMessage, buildPositionReportMessage, parsePositionReportIntervalMs } from './acars';
import { fileAcarsMessageOnce } from './acarsEvents';
import { haversineNm } from './geo';
import { MAX_COUNTED_GAP_MS } from './flight/constants';
import { summarizeTrack } from './flight/summarizeTrack';
import { PlannedLegLink } from './flight/plannedLegLink';
import { GroundTracker } from './flight/groundTracker';

export { MAX_COUNTED_GAP_MS, TAXI_OUT_SPEED_KTS } from './flight/constants';

const RECORD_INTERVAL_MS = 5000;
const AIRBORNE_DEBOUNCE_FRAMES = 3;
const LANDED_DEBOUNCE_FRAMES = 10;

export class FlightManager {
  private state: FlightState = 'IDLE';
  private currentFlightId: number | null = null;
  private readonly link = new PlannedLegLink();
  private readonly ground = new GroundTracker();
  private airborneStreak = 0;
  private landedStreak = 0;
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
      : this.ground.openSessionLegId();
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
      else if (this.state === 'GROUND') this.leaveGround('sim-exit');
      return;
    }

    const inSlew = frame.simRunning === 3;

    switch (this.state) {
      case 'IDLE':
        this.checkAirborneDebounce(frame, inSlew);
        if (this.state !== 'IDLE') break; // startFlight() already ran

        if (this.ground.observeIdle(frame) === 'debounce-met') {
          this.enterGround(frame);
        }
        break;

      case 'GROUND':
        if (inSlew) {
          this.leaveGround('slew');
          break;
        }
        if (this.ground.observeGround(frame) === 'left-anchor') {
          this.leaveGround('superseded');
          break;
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
      this.leaveGroundAutoOnly('crash');
    }
  }

  onSimDisconnect(): void {
    if (this.state === 'FLYING' && this.appState.lastFrame) {
      this.endFlight(this.appState.lastFrame);
    } else if (this.state === 'GROUND') {
      this.leaveGroundAutoOnly('sim-exit');
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
    return this.ground.status();
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
    if (this.ground.refresh() === 'updated') {
      this.notifyScopeChange();
      return;
    }
    if (this.state === 'GROUND') {
      // resetGroundTracking() already notifies at its own end.
      this.resetGroundTracking();
    } else {
      this.ground.clearCache();
      this.notifyScopeChange();
    }
  }

  /**
   * Reached when GROUND_DEBOUNCE_FRAMES consecutive frames have qualified as
   * parked. The ground tracker resolves the airport and a planned leg exactly
   * once, the same work startFlight() does for a takeoff — never per frame.
   * Only a successful entry changes state.
   */
  private enterGround(frame: SimFrame): void {
    if (this.ground.enter(frame, (f, startedAt) => this.link.matchForGround(f, startedAt)) === 'failed') return;
    this.state = 'GROUND';
    this.appState.flightState = 'GROUND';
    this.notifyScopeChange();
  }

  /**
   * Closes whatever ground session is open, whatever its source, and returns
   * to IDLE: the exits that are themselves positive evidence the aircraft is
   * no longer where the session says it is.
   */
  private leaveGround(reason: GroundSessionEndReason): void {
    this.ground.closeAny(reason);
    this.resetGroundTracking();
  }

  /**
   * Closes the open ground session and returns to IDLE, but only when the
   * session was detected automatically: a vanished agent or a crash is not
   * evidence against a manual session.
   */
  private leaveGroundAutoOnly(reason: GroundSessionEndReason): void {
    this.ground.closeAutoOnly(reason);
    this.resetGroundTracking();
  }

  private resetGroundTracking(): void {
    this.ground.reset();
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

    // Unconditional, whatever this.state was: OUT reports the stand, airport
    // and off-blocks instant of a ground session that may have been adopted
    // while IDLE, and the session is closed and forgotten here.
    const out = this.ground.handOffToFlight(id);

    this.link.clear();
    this.link.autoLink(id, frame, startTime);

    this.currentFlightId = id;
    this.state = 'FLYING';
    this.airborneStreak = 0;
    this.landedStreak = 0;
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

    const outEstimated = out.outAt === null;
    const refs = this.link.refs();
    fileAcarsMessageOnce(buildOooiMessage({
      flightId: id,
      event: 'OUT',
      at: out.outAt ?? startTime,
      airportIcao: out.airportIcao,
      stand: out.stand,
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
   * route from link.status(), can interrupt point recording.
   */
  private maybeFilePositionReport(frame: SimFrame, nowMs: number, ts: string): void {
    try {
      if (this.currentFlightId === null) return;
      if (this.positionReportIntervalMs <= 0) return;
      if (this.link.currentLegId() === null) return;

      const windowIndex = Math.floor((nowMs - this.flightStartMs) / this.positionReportIntervalMs);
      if (windowIndex < 1 || windowIndex <= this.lastPositionReportWindow) return;
      this.lastPositionReportWindow = windowIndex;

      const status = this.link.status(frame.lat, frame.lon);
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
