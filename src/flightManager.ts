import type {
  SimFrame, FlightState, AppState, PlannedLegLiveStatus,
  GroundSessionLiveStatus, GroundSessionEndReason,
} from './types';
import type { FlightStatePayload } from './eventHub';
import type { OpenFlightRow, FlightTrackPoint } from './db';
import { getOpenFlight } from './db';
import { findNearestAirport } from './airports';
import { PlannedLegLink } from './flight/plannedLegLink';
import { GroundTracker } from './flight/groundTracker';
import { FlightRecorder } from './flight/flightRecorder';
import type { RecordedPoint } from './flight/flightRecorder';
import { OooiReporter } from './flight/oooiReporter';

export { MAX_COUNTED_GAP_MS, TAXI_OUT_SPEED_KTS } from './flight/constants';

const AIRBORNE_DEBOUNCE_FRAMES = 3;
const LANDED_DEBOUNCE_FRAMES = 10;

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
  // Notified after every flight/leg scope change (see the call sites below);
  // null while nothing has attached one, which is the case for every existing
  // caller of this class that doesn't care.
  private scopeChangeListener: (() => void) | null = null;
  // The open-flight lookup is attempted exactly once per process, on the first
  // frame this instance evaluates — not once per takeoff. See checkAirborneDebounce().
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
    // Mark here as well as in onFrame: a paused sim may stop sending frames
    // altogether, in which case onFrame never runs to flag the interruption.
    if (paused) this.recorder.markInterrupted();
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
          this.recorder.markInterrupted();
          break;
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

  private startFlight(frame: SimFrame): void {
    const startTime = new Date().toISOString();
    const dep = findNearestAirport(frame.lat, frame.lon);
    const id = this.recorder.begin(frame, dep, startTime);
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
   * Adopts an already-open flights row instead of starting a new one: the
   * server was restarted (or crashed) while this flight was in progress, and
   * the row it inserted at takeoff is still open. Everything the live
   * accumulators would have held is rebuilt from the points already recorded
   * for that flight; the downtime itself is disowned by the recorder's
   * interruption mark, exactly as a pause disowns the gap that spans it.
   *
   * Deliberately NOT a branch inside startFlight(): a resume must not insert a
   * row, must not close a ground session, must not file OUT/OFF, and must not
   * consume a planned leg — all four of those already happened for this flight,
   * before the restart.
   */
  private resumeFlight(row: OpenFlightRow, frame: SimFrame): void {
    const seed = this.recorder.adopt(row, frame);

    this.currentFlightId = row.id;
    this.state = 'FLYING';
    this.appState.flightState = 'FLYING';
    this.appState.currentFlightId = row.id;
    this.airborneStreak = 0;
    this.landedStreak = 0;
    // The outage is an interruption exactly like a pause or a slew: its time
    // must not be counted, even though its distance (added by the writePoint()
    // call below) should be.
    this.recorder.markInterrupted();
    this.acars.resumeFlight();

    // Reloaded read-only: this flight's link (if any) was already made at its
    // real takeoff, and matching again here would consume a leg a second time.
    this.link.clear();
    try {
      this.refreshPlannedLegForFlight(row.id);
    } catch (err) {
      console.warn(`[FlightManager] Flight #${row.id} planned-leg cache not restored:`, err);
    }

    console.log(
      `[FlightManager] Flight #${row.id} resumed after restart — ${seed.pointCount} points, ` +
      `${seed.distanceNm.toFixed(1)} nm, ${Math.round(seed.activeMs / 1000)}s counted before the interruption`
    );

    // Same call startFlight() ends with: it adds the outage's distance,
    // drops its (already-excluded) gap because the recorder is marked
    // interrupted, and clears the mark so the next gap counts normally.
    this.writePoint(frame);
    this.notifyScopeChange();
  }

  private endFlight(frame: SimFrame): void {
    if (this.currentFlightId === null) return;
    const id = this.currentFlightId;

    const tally = this.recorder.stopClock();

    const arr = findNearestAirport(frame.lat, frame.lon);
    if (arr) console.log(`[FlightManager] Arrival airport: ${arr.icao} (${arr.name})`);
    this.recorder.finish(id, frame, arr, tally);

    this.link.recordArrival(id, frame);

    // ON and IN both carry the link's refs, so they are read before the link
    // is cleared below.
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
    const point = this.recorder.maybeRecord(this.currentFlightId, frame);
    if (point) this.reportPosition(frame, point);
  }

  private writePoint(frame: SimFrame): void {
    const point = this.recorder.writePoint(this.currentFlightId, frame);
    if (point) this.reportPosition(frame, point);
  }

  /**
   * The position-report check for a point the recorder just wrote, run with
   * that write's own clock read and timestamp so the report window and the
   * report's `at` agree with the stored point.
   */
  private reportPosition(frame: SimFrame, point: RecordedPoint): void {
    this.acars.maybePositionReport(point.flightId, frame, point.ts, this.recorder.elapsedMs(point.nowMs), this.link);
  }
}
