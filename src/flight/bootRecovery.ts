import type { SimFrame } from '../types';
import type { OpenFlightRow, LastFlightPoint } from '../db';
import { getOpenFlight, getLastFlightPoint } from '../db';
import { haversineNm } from '../geo';
import { isSameFlight } from './sameFlight';
import { RESTART_RESUME_MAX_MS } from './constants';

export type { OpenFlightRow } from '../db';

/** The last position stored for an open flight, as a frame, and when it was stored. */
export interface StoredLastPoint {
  frame: SimFrame;
  atMs: number;
}

/**
 * The open flight's last stored position: its newest point, or, when it has
 * none, its departure coordinates at its start time with every speed at 0.
 * The frame carries the row's aircraft, or an empty string when the row has
 * none. Null when there is nothing to compare against: no points and no
 * departure coordinates, or a time that does not parse.
 */
export function storedLastPoint(row: OpenFlightRow, point: LastFlightPoint | null): StoredLastPoint | null {
  const aircraft = row.aircraft ?? '';
  if (point) {
    const atMs = Date.parse(point.ts);
    if (Number.isNaN(atMs)) return null;
    return {
      atMs,
      frame: {
        lat: point.lat,
        lon: point.lon,
        altitudeFt: point.altitude_ft,
        airspeedKnots: point.airspeed_kts,
        groundSpeedKnots: point.ground_speed_kts,
        headingDeg: point.heading_deg,
        verticalSpeedFpm: point.vertical_speed_fpm,
        onGround: point.on_ground === 1,
        simRunning: 1,
        aircraft,
      },
    };
  }

  if (row.departure_lat === null || row.departure_lon === null) return null;
  const atMs = Date.parse(row.start_time);
  if (Number.isNaN(atMs)) return null;
  return {
    atMs,
    frame: {
      lat: row.departure_lat,
      lon: row.departure_lon,
      altitudeFt: 0,
      airspeedKnots: 0,
      groundSpeedKnots: 0,
      headingDeg: 0,
      verticalSpeedFpm: 0,
      onGround: true,
      simRunning: 1,
      aircraft,
    },
  };
}

/**
 * Why `next`, the first running frame after a restart, does not continue the
 * open flight whose last stored position is `last`, or null when it does. The
 * hold's same-flight test with the restart's own time limit. Pause state is
 * not stored, so the last point is taken as not paused, and a row with no
 * aircraft skips the aircraft comparison. A negative elapsed time (the clock
 * set back while the server was down) counts as 0.
 */
export function restartMismatch(
  row: OpenFlightRow, last: StoredLastPoint, next: SimFrame, nowMs: number,
): string | null {
  const elapsedMs = Math.max(0, nowMs - last.atMs);
  const compared: SimFrame = row.aircraft === null ? { ...last.frame, aircraft: next.aircraft } : last.frame;
  if (isSameFlight({
    last: compared, lastWasPaused: false, next, elapsedMs, maxElapsedMs: RESTART_RESUME_MAX_MS,
  })) return null;

  // Named in the order isSameFlight() applies its checks.
  if (next.aircraft !== compared.aircraft) return `aircraft changed (${compared.aircraft} -> ${next.aircraft})`;
  if (elapsedMs > RESTART_RESUME_MAX_MS) {
    return `${(elapsedMs / 60_000).toFixed(1)} min since the last point (limit ${RESTART_RESUME_MAX_MS / 60_000} min)`;
  }
  return `${haversineNm(last.frame.lat, last.frame.lon, next.lat, next.lon).toFixed(1)} nm from the last point`;
}

/**
 * Looks for a flight left open by a previous run and decides what `next`, the
 * first running frame since this process started, does with it: continue it
 * through `resume`, or, when the frame fails the same-flight test against the
 * flight's last stored position, end it there through `close` with the
 * reason. A row with no position or time to compare against is resumed.
 *
 * One try/catch covers the lookup, the last-point read and the callback
 * together, so a failing database read, a failing track read, a failing
 * point write while adopting or a failing close are all warned about and
 * swallowed: the caller carries on as if there were nothing to resume.
 *
 * Returns true only when an open row was found and `resume` returned
 * normally; after a close the caller processes the frame as usual. It keeps
 * no state; asking once per process is the caller's job.
 */
export function tryResumeOpenFlight(
  next: SimFrame,
  resume: (row: OpenFlightRow) => void,
  close: (row: OpenFlightRow, last: StoredLastPoint, reason: string) => void,
): boolean {
  try {
    const open = getOpenFlight();
    if (open) {
      const last = storedLastPoint(open, getLastFlightPoint(open.id));
      const reason = last ? restartMismatch(open, last, next, Date.now()) : null;
      if (last && reason !== null) {
        close(open, last, reason);
        return false;
      }
      resume(open);
      return true;
    }
  } catch (err) {
    console.warn('[FlightManager] Open-flight check failed; starting fresh if a takeoff follows:', err);
  }
  return false;
}
