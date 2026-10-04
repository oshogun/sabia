import type { SimFrame } from '../types';
import type { OpenFlightRow } from '../db';
import { insertFlight, insertPoint, closeFlight, getFlightTrackPoints } from '../db';
import { haversineNm } from '../geo';
import { summarizeTrack } from './summarizeTrack';
import { MAX_COUNTED_GAP_MS } from './constants';

const RECORD_INTERVAL_MS = 5000;

/** findNearestAirport()'s non-null result. */
export interface AirportRef {
  icao: string;
  name: string;
}

/** The point writePoint() or maybeRecord() just inserted. */
export interface RecordedPoint {
  flightId: number;
  /** The single clock read of that write. */
  nowMs: number;
  /** The point's own timestamp, the ISO form of nowMs. */
  ts: string;
}

/** What adopt() rebuilt, for the "resumed after restart" log line. */
export interface ResumeSeed {
  pointCount: number;
  distanceNm: number;
  activeMs: number;
}

/** stopClock()'s result: the end instant and the duration split, fixed before the arrival lookup. */
export interface FlightTally {
  endTime: string;
  durationSec: number;
  excludedSec: number;
}

/**
 * The flights row and the points of the flight in progress: the accumulators
 * closeFlight() is handed, and the clock that turns the gaps between points
 * into flight time. It owns no flight id; the caller passes it in.
 *
 * insertFlight(), insertPoint() and closeFlight() throw through. Nothing in
 * this class catches: the caller decides what a failed write means.
 */
export class FlightRecorder {
  private distanceNm = 0;
  private maxAltitudeFt = 0;
  private maxAirspeedKts = 0;
  private pointCount = 0;
  private lastPointLat = 0;
  private lastPointLon = 0;
  private lastPointTime = 0;
  private flightStartMs = 0;
  // Flight time accumulated from the gaps between recorded points, so that any
  // interruption which stops recording is excluded automatically.
  private activeMs = 0;
  // Set whenever recording is skipped, so the following gap is known to be an
  // interruption regardless of how short it was. Only markInterrupted() sets
  // it; only begin() and writePoint() clear it.
  private interrupted = false;

  /**
   * Inserts the flights row, then resets every accumulator to the takeoff
   * frame. Does not read the clock: startClock() does, once the caller has
   * finished the work that sits between the insert and the first point. A
   * throw from the insert leaves everything as it was.
   */
  begin(frame: SimFrame, dep: AirportRef | null, startTime: string): number {
    const id = insertFlight(frame.aircraft, frame.lat, frame.lon, startTime, dep?.icao ?? null, dep?.name ?? null);
    this.distanceNm = 0;
    this.maxAltitudeFt = frame.altitudeFt;
    this.maxAirspeedKts = frame.airspeedKnots;
    this.pointCount = 0;
    this.lastPointLat = frame.lat;
    this.lastPointLon = frame.lon;
    this.activeMs = 0;
    // A pause can set the flag while no flight exists; it must not leak into
    // the next flight's first gap or tail.
    this.interrupted = false;
    return id;
  }

  /** Starts the point clock and the flight clock: two reads, the point clock first. */
  startClock(): void {
    this.lastPointTime = Date.now();
    this.flightStartMs = Date.now();
  }

  /**
   * Rebuilds the accumulators of a flight that was already open when the
   * server started, from the points recorded for it. Leaves `interrupted`
   * alone: the caller marks the outage with markInterrupted(). A throw from
   * the track read leaves everything as it was.
   */
  adopt(row: OpenFlightRow, frame: SimFrame): ResumeSeed {
    const summary = summarizeTrack(getFlightTrackPoints(row.id), row, frame);

    // An unparseable start_time (a hand-edited row) falls back to now rather
    // than poison the arithmetic with NaN.
    const flightStartMs = summary.startMs ?? Date.now();

    this.distanceNm = summary.distanceNm;
    this.maxAltitudeFt = summary.maxAltitudeFt;
    this.maxAirspeedKts = summary.maxAirspeedKts;
    this.pointCount = summary.pointCount;
    this.lastPointLat = summary.lastPointLat;
    this.lastPointLon = summary.lastPointLon;
    // Overwritten by the first point written after the adoption; the only thing
    // this value does first is feed that point's own gap computation, and
    // Date.now() makes that gap ~0 rather than the whole outage. It also keeps
    // the recording interval running if that first write fails.
    this.lastPointTime = Date.now();
    this.flightStartMs = flightStartMs;
    this.activeMs = summary.activeMs;
    return { pointCount: summary.pointCount, distanceNm: summary.distanceNm, activeMs: summary.activeMs };
  }

  /**
   * Marks the time since the last point as an interruption: the next gap is
   * not counted and neither is a tail that ends the flight first. Its
   * distance still counts. A pause, a slew and a restart all come through here.
   */
  markInterrupted(): void {
    this.interrupted = true;
  }

  /** writePoint(), but at most one point per recording interval. */
  maybeRecord(flightId: number | null, frame: SimFrame): RecordedPoint | null {
    if (Date.now() - this.lastPointTime < RECORD_INTERVAL_MS) return null;
    return this.writePoint(flightId, frame);
  }

  /**
   * Inserts one point and folds it into the accumulators. Null, and no clock
   * read, when there is no current flight. The clock is read once; the point's
   * gap and its timestamp both come from that read.
   */
  writePoint(flightId: number | null, frame: SimFrame): RecordedPoint | null {
    if (flightId === null) return null;

    const now = Date.now();
    const ts = new Date(now).toISOString();

    // Everything this point adds is worked out first and committed only after
    // the insert succeeds: a point that fails to store leaves the recorder as it
    // was, and the retry counts the whole segment from the last stored point.
    let segmentNm = 0;
    let countedGapMs = 0;
    if (this.pointCount > 0) {
      segmentNm = haversineNm(this.lastPointLat, this.lastPointLon, frame.lat, frame.lon);

      // Flight time is built from the gaps between points rather than the wall
      // clock. A gap far longer than the recording interval means recording had
      // stopped — a pause, slew, a frozen sim, a crashed agent — and that time
      // was not flown, so it is not counted.
      const gap = now - this.lastPointTime;
      if (!this.interrupted && gap <= MAX_COUNTED_GAP_MS) countedGapMs = gap;
    }

    insertPoint(
      flightId,
      ts,
      frame.lat,
      frame.lon,
      frame.altitudeFt,
      frame.airspeedKnots,
      frame.groundSpeedKnots,
      frame.headingDeg,
      frame.verticalSpeedFpm,
      frame.onGround,
      this.interrupted
    );

    this.distanceNm += segmentNm;
    this.activeMs += countedGapMs;
    if (frame.altitudeFt > this.maxAltitudeFt) this.maxAltitudeFt = frame.altitudeFt;
    if (frame.airspeedKnots > this.maxAirspeedKts) this.maxAirspeedKts = frame.airspeedKnots;
    this.lastPointLat = frame.lat;
    this.lastPointLon = frame.lon;
    this.lastPointTime = now;
    this.pointCount++;
    this.interrupted = false;

    return { flightId, nowMs: now, ts };
  }

  /** Milliseconds since the flight clock started, at the caller's own clock read. */
  elapsedMs(nowMs: number): number {
    return nowMs - this.flightStartMs;
  }

  /**
   * Fixes the end instant and the duration. Without `atMs`, three clock reads,
   * in this order: the end instant, the tail, then the wall-clock span behind
   * excludedSec. With `atMs` (the receive time of the last frame before a
   * silence) the flight is ended at that instant and the clock is not read.
   */
  stopClock(atMs?: number): FlightTally {
    if (atMs !== undefined) {
      const tailMs = Math.max(0, atMs - this.lastPointTime);
      if (!this.interrupted && tailMs <= MAX_COUNTED_GAP_MS) this.activeMs += tailMs;

      const durationSec = Math.round(this.activeMs / 1000);
      const excludedSec = Math.max(0,
        Math.round((atMs - this.flightStartMs) / 1000) - durationSec);
      return { endTime: new Date(atMs).toISOString(), durationSec, excludedSec };
    }

    const endTime = new Date().toISOString();
    // Include the final partial interval between the last point and touchdown
    const tailMs = Date.now() - this.lastPointTime;
    if (!this.interrupted && tailMs <= MAX_COUNTED_GAP_MS) this.activeMs += tailMs;

    const durationSec = Math.round(this.activeMs / 1000);
    const excludedSec = Math.max(0,
      Math.round((Date.now() - this.flightStartMs) / 1000) - durationSec);
    return { endTime, durationSec, excludedSec };
  }

  /** Closes the flights row with the accumulators and the tally, then logs the summary. */
  finish(flightId: number, frame: SimFrame, arr: AirportRef | null, tally: FlightTally): void {
    closeFlight(
      flightId,
      tally.endTime,
      frame.lat,
      frame.lon,
      tally.durationSec,
      Math.round(this.distanceNm * 10) / 10,
      Math.round(this.maxAltitudeFt),
      Math.round(this.maxAirspeedKts),
      this.pointCount,
      arr?.icao ?? null,
      arr?.name ?? null
    );

    console.log(
      `[FlightManager] Flight #${flightId} ended — ` +
      `${this.pointCount} points, ${this.distanceNm.toFixed(1)} nm, ${tally.durationSec}s` +
      (tally.excludedSec > 0 ? ` (${tally.excludedSec}s interrupted, excluded)` : '')
    );
  }
}
