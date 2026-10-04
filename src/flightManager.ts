import type {
  SimFrame, FlightState, AppState, PlannedLegLiveStatus,
  GroundSessionLiveStatus, GroundSessionEndReason,
} from './types';
import type { FlightStatePayload } from './eventHub';
import { findNearestAirport } from './airports';
import { PlannedLegLink } from './flight/plannedLegLink';
import { GroundTracker } from './flight/groundTracker';
import { FlightRecorder } from './flight/flightRecorder';
import type { RecordedPoint, ResumeSeed } from './flight/flightRecorder';
import { OooiReporter } from './flight/oooiReporter';
import { isSameFlight } from './flight/sameFlight';
import { SIM_SILENCE_HOLD_MS } from './flight/constants';
import { haversineNm } from './geo';
import { tryResumeOpenFlight } from './flight/bootRecovery';
import type { OpenFlightRow, StoredLastPoint } from './flight/bootRecovery';

export { MAX_COUNTED_GAP_MS, TAXI_OUT_SPEED_KTS } from './flight/constants';

const AIRBORNE_DEBOUNCE_FRAMES = 3;
const LANDED_DEBOUNCE_FRAMES = 10;

// A FLYING flight kept open while the simulator is silent. `frame` and
// `receivedAtMs` are the last frame received before the silence; the hold
// ends and the flight closes at that frame if nothing plausible arrives in time.
interface HeldFlight {
  frame: SimFrame;
  receivedAtMs: number;
  wasPaused: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export class FlightManager {
  private state: FlightState = 'IDLE';
  private currentFlightId: number | null = null;
  private readonly link = new PlannedLegLink();
  private readonly ground = new GroundTracker();
  private readonly recorder = new FlightRecorder();
  private readonly acars = new OooiReporter();
  private airborneStreak = 0;
  private landedStreak = 0;
  private isPaused = false;
  private held: HeldFlight | null = null;
  // Wall-clock time the frame in appState.lastFrame was received.
  private lastFrameReceivedAtMs = 0;
  // Told after every flight/leg scope change; null until something attaches one.
  private scopeChangeListener: (() => void) | null = null;
  // The open-flight lookup runs once per process, not once per takeoff.
  private openFlightCheckedAtBoot = false;

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
    // Mark here as well as in onFlyingFrame: a paused sim may stop sending frames
    // altogether, in which case it never runs to flag the interruption. Not while
    // the flight is held: the hold already excludes the silence, and a held flight
    // is closed back-dated to its last frame, whose tail (flown before the
    // silence) must still count. A continuation marks the interruption itself
    // before it writes its first point.
    if (paused && !this.held) this.recorder.markInterrupted();
    this.isPaused = paused;
    this.appState.paused = paused;
    this.appState.pauseFlags = paused ? flags : 0;
  }

  /** Attach (or detach with null) the callback fired after a scope change. */
  setScopeChangeListener(listener: (() => void) | null): void {
    this.scopeChangeListener = listener;
  }

  /**
   * The current flight/leg scope: the link's cached leg during a flight,
   * otherwise the open ground session's leg (which covers a manual session
   * open before or between flights).
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

  /** True while a FLYING flight is kept open through a sim silence. */
  isHoldingFlight(): boolean {
    return this.held !== null;
  }

  onFrame(frame: SimFrame): void {
    let continued = false;
    if (this.held) {
      const outcome = this.onHeldFrame(frame);
      if (outcome === 'handled') return;
      continued = outcome === 'continued';
    }

    this.appState.lastFrame = frame;
    this.lastFrameReceivedAtMs = Date.now();

    if (frame.simRunning === 0) {
      this.onSimNotRunning(frame);
      return;
    }

    const inSlew = frame.simRunning === 3;

    if (continued) {
      // The silence is an interruption: its time is not counted, the distance
      // from the last point to this frame is.
      this.recorder.markInterrupted();
      if (!inSlew && !this.isPaused) this.writePoint(frame);
      this.landedStreak = 0;
    }

    switch (this.state) {
      case 'IDLE':
        this.onIdleFrame(frame, inSlew);
        break;
      case 'GROUND':
        this.onGroundFrame(frame, inSlew);
        break;
      case 'FLYING':
        this.onFlyingFrame(frame, inSlew);
        break;
    }
  }

  /**
   * The first frame after a silence began. 'handled' means nothing more is
   * done with it, 'continued' means the flight stays open and the frame is
   * processed as part of it, 'closed' means the held flight was closed at its
   * last frame and the frame is processed as usual.
   */
  private onHeldFrame(frame: SimFrame): 'handled' | 'continued' | 'closed' {
    const held = this.held;
    if (!held) return 'closed';

    if (frame.simRunning === 0) {
      this.endFlight(held.frame, held.receivedAtMs);
      this.appState.lastFrame = frame;
      this.lastFrameReceivedAtMs = Date.now();
      return 'handled';
    }

    const elapsedMs = Date.now() - held.receivedAtMs;
    if (!isSameFlight({ last: held.frame, lastWasPaused: held.wasPaused, next: frame, elapsedMs })) {
      this.endFlight(held.frame, held.receivedAtMs);
      return 'closed';
    }

    this.clearHold();
    console.log(
      `[FlightManager] Flight #${this.currentFlightId} continued after ${Math.round(elapsedMs / 1000)}s of silence — ` +
      `${haversineNm(held.frame.lat, held.frame.lon, frame.lat, frame.lon).toFixed(1)} nm from the last frame`
    );
    return 'continued';
  }

  private clearHold(): void {
    if (!this.held) return;
    clearTimeout(this.held.timer);
    this.held = null;
  }

  private startHold(frame: SimFrame): void {
    const receivedAtMs = this.lastFrameReceivedAtMs;
    const timer = setTimeout(
      () => this.expireHold(),
      Math.max(0, receivedAtMs + SIM_SILENCE_HOLD_MS - Date.now())
    );
    timer.unref?.();
    this.held = { frame, receivedAtMs, wasPaused: this.isPaused, timer };
    console.log(
      `[FlightManager] Flight #${this.currentFlightId} sim silent — ` +
      `holding up to ${SIM_SILENCE_HOLD_MS / 1000}s from the last frame`
    );
  }

  /** The hold ran out: close the flight at the last frame received before the silence. */
  private expireHold(): void {
    const held = this.held;
    if (!held) return;
    const id = this.currentFlightId;
    console.log(
      `[FlightManager] Flight #${id} hold expired after ${SIM_SILENCE_HOLD_MS / 1000}s without data — ` +
      'closing at the last frame'
    );
    try {
      this.endFlight(held.frame, held.receivedAtMs);
    } catch (err) {
      // A throw out of a timer callback would stop the server.
      console.warn(`[FlightManager] Flight #${id} close after the hold failed:`, err);
    } finally {
      this.clearHold();
    }
  }

  private onSimNotRunning(frame: SimFrame): void {
    if (this.state === 'FLYING') this.endFlight(frame);
    // The sim itself reporting not-running is positive telemetry evidence,
    // not mere silence — unlike onCrash()/onSimDisconnect() below, this
    // closes a manual session too.
    else if (this.state === 'GROUND') this.leaveGround('sim-exit');
  }

  private onIdleFrame(frame: SimFrame, inSlew: boolean): void {
    this.checkAirborneDebounce(frame, inSlew);
    if (this.state !== 'IDLE') return; // startFlight() or a resume already ran

    if (this.ground.observeIdle(frame) === 'debounce-met') {
      this.enterGround(frame);
    }
  }

  private onGroundFrame(frame: SimFrame, inSlew: boolean): void {
    if (inSlew) {
      this.leaveGround('slew');
      return;
    }
    if (this.ground.observeGround(frame) === 'left-anchor') {
      this.leaveGround('superseded');
      return;
    }
    // Taxiing does not leave this state — only rotation (below) or one of
    // the two checks above does. The same airborne test as from IDLE.
    this.checkAirborneDebounce(frame, inSlew);
  }

  private onFlyingFrame(frame: SimFrame, inSlew: boolean): void {
    if (inSlew || this.isPaused) {
      this.recorder.markInterrupted();
      return;
    }

    this.recordPoint(frame);

    if (frame.onGround) this.acars.onTouchdown(this.currentFlightId, frame, this.link.refs());

    if (frame.onGround && frame.groundSpeedKnots < 5) {
      this.landedStreak++;
      if (this.landedStreak >= LANDED_DEBOUNCE_FRAMES) {
        this.endFlight(frame);
      }
    } else {
      this.landedStreak = 0;
    }
  }

  onCrash(): void {
    if (this.state === 'FLYING' && this.held) {
      this.endFlight(this.held.frame, this.held.receivedAtMs);
    } else if (this.state === 'FLYING' && this.appState.lastFrame) {
      this.endFlight(this.appState.lastFrame);
    } else if (this.state === 'GROUND') {
      this.leaveGroundAutoOnly('crash');
    }
  }

  /**
   * The sim's data stopped (stale check or the client's 'disconnected' event).
   * A FLYING flight is held open rather than closed, see onHeldFrame().
   */
  onSimDisconnect(): void {
    if (this.state === 'FLYING' && this.appState.lastFrame) {
      // Already holding: the window stays counted from the last frame received.
      if (!this.held) this.startHold(this.appState.lastFrame);
    } else if (this.state === 'GROUND') {
      this.leaveGroundAutoOnly('sim-exit');
    }
  }

  /**
   * The airborne debounce, shared by IDLE and GROUND: three consecutive
   * qualifying frames start a flight.
   */
  private checkAirborneDebounce(frame: SimFrame, inSlew: boolean): void {
    if (!this.openFlightCheckedAtBoot) {
      // One attempt per process, whatever this frame looks like: a flight that
      // landed while the server was down never produces an airborne frame
      // again, so a check gated on the airborne condition would never see it.
      // The flag is set before the query, not after, so a failing database is
      // asked once rather than at frame rate.
      this.openFlightCheckedAtBoot = true;
      // After a close the frame carries on below, as the first frame of a fresh start.
      if (tryResumeOpenFlight(
        frame,
        row => this.resumeFlight(row, frame),
        (row, last, reason) => this.closeOpenFlightAtRestart(row, last, reason),
      )) return;
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

  /** The ground-session live-status cache, or null; read-only, no query per call. */
  getGroundSessionStatus(): GroundSessionLiveStatus | null {
    return this.ground.status();
  }

  /**
   * Called by the ground-sessions routes after every write, which bypass this
   * class. An open row is adopted into the cache in any state; no open row
   * while GROUND means the tracked session was closed under us, so return to
   * IDLE, otherwise just drop the cache.
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

  /** Reached once the parked debounce is met; only a successful entry changes state. */
  private enterGround(frame: SimFrame): void {
    if (this.ground.enter(frame, (f, startedAt) => this.link.matchForGround(f, startedAt)) === 'failed') return;
    this.state = 'GROUND';
    this.appState.flightState = 'GROUND';
    this.notifyScopeChange();
  }

  /**
   * Closes any ground session, whatever its source, and returns to IDLE: the
   * exits that are themselves positive evidence the aircraft moved.
   */
  private leaveGround(reason: GroundSessionEndReason): void {
    this.ground.closeAny(reason);
    this.resetGroundTracking();
  }

  /**
   * Closes only an auto-detected session and returns to IDLE: a crash or a
   * vanished agent is no evidence against a manual one.
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

  private startFlight(frame: SimFrame): void {
    const startTime = new Date().toISOString();
    const dep = findNearestAirport(frame.lat, frame.lon);
    const id = this.recorder.begin(frame, dep, startTime);
    if (dep) console.log(`[FlightManager] Departure airport: ${dep.icao} (${dep.name})`);

    // Unconditional, whatever the state was: a session adopted while IDLE still feeds OUT.
    const out = this.ground.handOffToFlight(id);

    this.link.clear();
    this.link.autoLink(id, frame, startTime);

    this.currentFlightId = id;
    this.state = 'FLYING';
    this.airborneStreak = 0;
    this.landedStreak = 0;
    this.recorder.startClock();

    this.appState.flightState = 'FLYING';
    this.appState.currentFlightId = id;
    this.notifyScopeChange();

    this.acars.beginFlight(id);
    this.acars.fileOutOff(id, frame, out, startTime, dep, this.link.refs());

    console.log(`[FlightManager] Flight #${id} started — ${frame.aircraft}`);

    // Record the first point immediately
    this.writePoint(frame);
  }

  /**
   * Adopts the flight row left open by a previous run. Deliberately not a
   * branch inside startFlight(): a resume must not insert a row, close a
   * ground session, file OUT/OFF or consume a planned leg again.
   */
  private resumeFlight(row: OpenFlightRow, frame: SimFrame): void {
    const seed = this.adoptOpenFlight(row, frame);
    // The outage is an interruption like a pause: its time is not counted,
    // its distance (added by the point written below) is.
    this.recorder.markInterrupted();

    console.log(
      `[FlightManager] Flight #${row.id} resumed after restart — ${seed.pointCount} points, ` +
      `${seed.distanceNm.toFixed(1)} nm, ${Math.round(seed.activeMs / 1000)}s counted before the interruption`
    );

    // Same call startFlight() ends with; it clears the interruption mark so the
    // next gap counts normally.
    this.writePoint(frame);
    this.notifyScopeChange();
  }

  /**
   * Makes the open row the current flight: the recorder seeded from its
   * stored points (`frame` only fills the maxima when there are none), the
   * ACARS state reset and the leg link reloaded.
   */
  private adoptOpenFlight(row: OpenFlightRow, frame: SimFrame): ResumeSeed {
    const seed = this.recorder.adopt(row, frame);

    this.currentFlightId = row.id;
    this.state = 'FLYING';
    this.appState.flightState = 'FLYING';
    this.appState.currentFlightId = row.id;
    this.airborneStreak = 0;
    this.landedStreak = 0;
    this.acars.resumeFlight();

    // Reloaded read-only: matching again would consume a leg a second time.
    this.link.clear();
    try {
      this.refreshPlannedLegForFlight(row.id);
    } catch (err) {
      console.warn(`[FlightManager] Flight #${row.id} planned-leg cache not restored:`, err);
    }
    return seed;
  }

  /**
   * The first frame after a restart is not the open flight's (another
   * aircraft, too late or too far): the flight is adopted from its stored
   * points and closed at its last stored position, the way an expired hold
   * closes one, so ON/IN and the leg arrival are filed and the totals are the
   * stored track's alone. If the close throws, the manager goes back to IDLE
   * with no current flight before the error propagates, so the row stays open
   * and nothing more is written to it.
   */
  private closeOpenFlightAtRestart(row: OpenFlightRow, last: StoredLastPoint, reason: string): void {
    console.log(
      `[FlightManager] Flight #${row.id} not resumed after restart — ${reason}; ` +
      'closing at the last stored point'
    );
    try {
      this.adoptOpenFlight(row, last.frame);
      // Nothing is recorded between the last stored point and the close, so
      // no tail is added to the stored duration, even when that point is
      // stamped later than now (the host clock set back while the server was down).
      this.recorder.markInterrupted();
      this.endFlight(last.frame, last.atMs);
    } catch (err) {
      if (this.currentFlightId !== null) {
        this.currentFlightId = null;
        this.link.clear();
        this.state = 'IDLE';
        this.appState.flightState = 'IDLE';
        this.appState.currentFlightId = null;
        this.notifyScopeChange();
      }
      throw err;
    }
  }

  /**
   * `atMs` backdates the end to the receive time of `frame`, for a flight that
   * closes after a silence; without it the flight ends now.
   */
  private endFlight(frame: SimFrame, atMs?: number): void {
    this.clearHold();
    if (this.currentFlightId === null) return;
    const id = this.currentFlightId;

    const tally = this.recorder.stopClock(atMs);

    const arr = findNearestAirport(frame.lat, frame.lon);
    if (arr) console.log(`[FlightManager] Arrival airport: ${arr.icao} (${arr.name})`);
    this.recorder.finish(id, frame, arr, tally);

    this.link.recordArrival(id, frame);

    // ON and IN carry the link's refs, so they go out before the link is cleared.
    this.acars.fileArrival(id, frame, tally.endTime, arr, this.link.refs());

    this.currentFlightId = null;
    this.link.clear();
    this.state = 'IDLE';
    this.appState.flightState = 'IDLE';
    this.appState.currentFlightId = null;
    this.notifyScopeChange();
    this.airborneStreak = 0;
    this.landedStreak = 0;
  }

  /** The live-panel context for /api/status, or null while unlinked; reads the link's cache only. */
  getPlannedLegStatus(lat: number, lon: number): PlannedLegLiveStatus | null {
    return this.link.status(lat, lon);
  }

  /**
   * Called by the manual link/unlink endpoint, which bypasses this class. The
   * scope listener is told after every call, even for a flight that is not
   * current; a throw from the link's reads propagates with no notification.
   */
  refreshPlannedLegForFlight(flightId: number): void {
    this.link.refreshForFlight(flightId, this.currentFlightId);
    this.notifyScopeChange();
  }

  private recordPoint(frame: SimFrame): void {
    const point = this.recorder.maybeRecord(this.currentFlightId, frame);
    if (point) this.reportPosition(frame, point);
  }

  private writePoint(frame: SimFrame): void {
    const point = this.recorder.writePoint(this.currentFlightId, frame);
    if (point) this.reportPosition(frame, point);
  }

  /** Runs the position-report check with the point's own clock read and timestamp. */
  private reportPosition(frame: SimFrame, point: RecordedPoint): void {
    this.acars.maybePositionReport(point.flightId, frame, point.ts, this.recorder.elapsedMs(point.nowMs), this.link);
  }
}
