import type { SimFrame, PlannedLegLiveStatus } from '../types';
import { findNearestAirport } from '../airports';
import { buildOooiMessage, buildPositionReportMessage, parsePositionReportIntervalMs } from '../acars';
import { fileAcarsMessageOnce } from '../acarsEvents';
import type { LegRefs } from './plannedLegLink';
import type { OutBlocks } from './groundTracker';
import type { AirportRef } from './flightRecorder';

/** What the position report needs from the planned-leg link. PlannedLegLink satisfies it. */
export interface LegStatusSource {
  currentLegId(): number | null;
  status(lat: number, lon: number): PlannedLegLiveStatus | null;
}

/**
 * The server-generated ACARS messages of one flight: OUT/OFF at takeoff,
 * ON at touchdown, IN at the end, and the periodic position reports. It owns
 * the "ON already filed" flag and the position-report cadence, and reads the
 * leg's destination and id from the refs the caller passes at file time.
 *
 * Every message is built immediately before its own fileAcarsMessageOnce()
 * call, which never throws. Only the position report has a try/catch of its
 * own; the touchdown ON is not wrapped, so a failed airport lookup propagates.
 */
export class OooiReporter {
  // Set once ON has been filed for the current flight, from either the
  // touchdown frame or the end-of-flight fallback — keeps whichever fires
  // second from filing ON twice.
  private onEventFiled = false;
  // Resolved once per flight from POSITION_REPORT_INTERVAL_MIN; 0 disables
  // position reports for this flight.
  private positionReportIntervalMs = 0;
  private lastPositionReportWindow = 0;

  /** A new flight: clears the ON flag and the window, resolves the interval from the environment, and logs it. */
  beginFlight(flightId: number): void {
    this.reset();
    if (this.positionReportIntervalMs > 0) {
      console.log(`[FlightManager] Flight #${flightId} position reports every ${(this.positionReportIntervalMs / 60_000).toFixed(1)} min`);
    } else {
      console.log(`[FlightManager] Flight #${flightId} position reports disabled (POSITION_REPORT_INTERVAL_MIN=0)`);
    }
  }

  /** An adopted flight: the same resets as beginFlight(), without the log line. */
  resumeFlight(): void {
    this.reset();
  }

  private reset(): void {
    this.onEventFiled = false;
    this.positionReportIntervalMs = parsePositionReportIntervalMs(process.env.POSITION_REPORT_INTERVAL_MIN);
    this.lastPositionReportWindow = 0;
  }

  /**
   * OUT, then OFF. OUT is estimated, and taken at the takeoff instant, when no
   * off-blocks instant was ever recorded; its airport and stand are the ones
   * the ground session had. OFF is the takeoff itself.
   */
  fileOutOff(
    flightId: number,
    frame: SimFrame,
    out: OutBlocks,
    startTime: string,
    dep: AirportRef | null,
    refs: LegRefs,
  ): void {
    const outEstimated = out.outAt === null;
    fileAcarsMessageOnce(buildOooiMessage({
      flightId,
      event: 'OUT',
      at: out.outAt ?? startTime,
      airportIcao: out.airportIcao,
      stand: out.stand,
      aircraft: frame.aircraft,
      destinationIdent: refs.destinationIdent,
      plannedLegId: refs.plannedLegId,
      estimated: outEstimated,
    }), `Flight #${flightId} OUT`);
    fileAcarsMessageOnce(buildOooiMessage({
      flightId,
      event: 'OFF',
      at: startTime,
      airportIcao: dep?.icao ?? null,
      stand: null,
      aircraft: frame.aircraft,
      destinationIdent: refs.destinationIdent,
      plannedLegId: refs.plannedLegId,
      estimated: false,
    }), `Flight #${flightId} OFF`);
  }

  /**
   * Fired at most once per flight, on the first frame back on the ground; a
   * no-op once ON has been filed. The flag is set before the airport lookup
   * (and before the null-id return) so a rollout that stays onGround for many
   * frames still resolves the airport and files ON exactly once — the dedup
   * key (src/acars.ts) is the backstop, not the mechanism.
   */
  onTouchdown(flightId: number | null, frame: SimFrame, refs: LegRefs): void {
    if (this.onEventFiled) return;
    this.onEventFiled = true;
    if (flightId === null) return;

    const at = new Date().toISOString();
    const ap = findNearestAirport(frame.lat, frame.lon);
    const msg = buildOooiMessage({
      flightId,
      event: 'ON',
      at,
      airportIcao: ap?.icao ?? null,
      stand: null,
      aircraft: frame.aircraft,
      destinationIdent: refs.destinationIdent,
      plannedLegId: refs.plannedLegId,
      estimated: false,
    });
    fileAcarsMessageOnce(msg, `Flight #${flightId} ON`);
  }

  /**
   * ON's fallback: only when no touchdown frame was ever seen (crash, sim
   * exit or agent loss while airborne) — onTouchdown() already filed it
   * otherwise. Either way IN follows immediately, sharing the end instant.
   */
  fileArrival(
    flightId: number,
    frame: SimFrame,
    endTime: string,
    arr: AirportRef | null,
    refs: LegRefs,
  ): void {
    if (!this.onEventFiled) {
      fileAcarsMessageOnce(buildOooiMessage({
        flightId,
        event: 'ON',
        at: endTime,
        airportIcao: arr?.icao ?? null,
        stand: null,
        aircraft: frame.aircraft,
        destinationIdent: refs.destinationIdent,
        plannedLegId: refs.plannedLegId,
        estimated: true,
      }), `Flight #${flightId} ON`);
      this.onEventFiled = true;
    }
    fileAcarsMessageOnce(buildOooiMessage({
      flightId,
      event: 'IN',
      at: endTime,
      airportIcao: arr?.icao ?? null,
      stand: null,
      aircraft: frame.aircraft,
      destinationIdent: refs.destinationIdent,
      plannedLegId: refs.plannedLegId,
      estimated: false,
    }), `Flight #${flightId} IN`);
  }

  /**
   * Files a position report at most once per configured interval window, and
   * only for a flight linked to a planned leg — an unlinked flight gets
   * clean OOOI-only reporting, never a thrown error and never a log line.
   * `elapsedMs` and `ts` are the just-written point's own, so the window and
   * the report's `at` agree with the stored point.
   *
   * A window is consumed as soon as it opens, before the status is read: a
   * status that throws or comes back null is not asked again until the next
   * window. Wrapped in its own try/catch so nothing here, including a
   * degenerate route from the status, can interrupt point recording.
   */
  maybePositionReport(
    flightId: number,
    frame: SimFrame,
    ts: string,
    elapsedMs: number,
    leg: LegStatusSource,
  ): void {
    try {
      if (this.positionReportIntervalMs <= 0) return;
      if (leg.currentLegId() === null) return;

      const windowIndex = Math.floor(elapsedMs / this.positionReportIntervalMs);
      if (windowIndex < 1 || windowIndex <= this.lastPositionReportWindow) return;
      this.lastPositionReportWindow = windowIndex;

      const status = leg.status(frame.lat, frame.lon);
      if (status === null) return;

      fileAcarsMessageOnce(buildPositionReportMessage({
        flightId,
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
      }), `Flight #${flightId} position report`);
    } catch (err) {
      console.warn('[FlightManager] Position report not filed:', err);
    }
  }
}
