import type { SimFrame } from '../types';
import { haversineNm } from '../geo';
import { SIM_SILENCE_HOLD_MS, SAME_FLIGHT_BASE_NM } from './constants';

interface SameFlightInput {
  last: SimFrame;
  lastWasPaused: boolean;
  next: SimFrame;
  elapsedMs: number;
}

/**
 * Whether the first frame after a silence belongs to the flight that was
 * open: same aircraft, back within the hold window, and not farther from the
 * last frame than the base allowance. A paused sim does not move the
 * aircraft, so the allowance stays at the base; otherwise it grows by the
 * distance the last ground speed covers in the silence. Both limits are
 * inclusive.
 */
export function isSameFlight({ last, lastWasPaused, next, elapsedMs }: SameFlightInput): boolean {
  if (next.aircraft !== last.aircraft) return false;
  if (elapsedMs > SIM_SILENCE_HOLD_MS) return false;

  const speedKts = Number.isFinite(last.groundSpeedKnots) ? Math.max(0, last.groundSpeedKnots) : 0;
  const travelNm = lastWasPaused ? 0 : speedKts * elapsedMs / 3_600_000;
  const allowanceNm = SAME_FLIGHT_BASE_NM + travelNm;

  return haversineNm(last.lat, last.lon, next.lat, next.lon) <= allowanceNm;
}
