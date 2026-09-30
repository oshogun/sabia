import type { SimFrame } from '../types';
import { haversineNm } from '../geo';
import { MAX_COUNTED_GAP_MS } from './constants';

/** The columns of a stored track point that the replay reads. */
export interface TrackPointLike {
  lat: number;
  lon: number;
  altitude_ft: number;
  airspeed_kts: number;
  ts: string;
}

/** The columns of the open flight row that the replay reads. */
export interface TrackRowLike {
  start_time: string;
  departure_lat: number | null;
  departure_lon: number | null;
}

export type TrackFrameLike = Pick<SimFrame, 'lat' | 'lon' | 'altitudeFt' | 'airspeedKnots'>;

export interface TrackSummary {
  pointCount: number;
  maxAltitudeFt: number;
  maxAirspeedKts: number;
  lastPointLat: number;
  lastPointLon: number;
  /** Sum of haversineNm over every consecutive pair, whatever their gap. */
  distanceNm: number;
  /** Sum of the gaps that are finite, positive and no longer than MAX_COUNTED_GAP_MS. */
  activeMs: number;
  /** The row's start time in epoch ms, or null when it does not parse. The caller picks the fallback. */
  startMs: number | null;
}

/**
 * Rebuilds the accumulators of an in-progress flight from the points already
 * recorded for it. `frame` only matters when there are no points.
 */
export function summarizeTrack(
  points: readonly TrackPointLike[], row: TrackRowLike, frame: TrackFrameLike,
): TrackSummary {
  const n = points.length;

  let pointCount: number;
  let maxAltitudeFt: number;
  let maxAirspeedKts: number;
  let lastPointLat: number;
  let lastPointLon: number;
  let distanceNm = 0;
  let activeMs = 0;

  if (n === 0) {
    // No point ever made it to disk (a crash between insertFlight() and its
    // first writePoint(), or a hand-edited row): there is no evidence to
    // reconstruct maxima from, so they are seeded from the current frame —
    // the same thing startFlight() does at takeoff. lastPointLat/Lon fall
    // back to the flight's own departure coordinates, taken together, so
    // the first post-resume leg measures from where the flight actually
    // began rather than from Null Island.
    pointCount = 0;
    maxAltitudeFt = frame.altitudeFt;
    maxAirspeedKts = frame.airspeedKnots;
    const hasDeparture = row.departure_lat !== null && row.departure_lon !== null;
    lastPointLat = hasDeparture ? (row.departure_lat as number) : frame.lat;
    lastPointLon = hasDeparture ? (row.departure_lon as number) : frame.lon;
  } else {
    pointCount = n;
    maxAltitudeFt = points[0].altitude_ft;
    maxAirspeedKts = points[0].airspeed_kts;
    for (let i = 1; i < n; i++) {
      if (points[i].altitude_ft > maxAltitudeFt) maxAltitudeFt = points[i].altitude_ft;
      if (points[i].airspeed_kts > maxAirspeedKts) maxAirspeedKts = points[i].airspeed_kts;
    }
    lastPointLat = points[n - 1].lat;
    lastPointLon = points[n - 1].lon;

    // The same counted/uncounted gap rule writePoint() applies live —
    // a gap this long means recording had stopped — applied
    // retroactively across the seeded track, with two additions the live
    // path never needs: a non-positive or unparseable gap (out-of-order or
    // hand-edited timestamps) is skipped rather than let corrupt every
    // later number.
    for (let i = 1; i < n; i++) {
      distanceNm += haversineNm(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
      const gap = Date.parse(points[i].ts) - Date.parse(points[i - 1].ts);
      if (Number.isFinite(gap) && gap > 0 && gap <= MAX_COUNTED_GAP_MS) activeMs += gap;
    }
  }

  // start_time is always written as an ISO instant, but a hand-edited row
  // must not poison the arithmetic downstream with NaN.
  const parsedStartMs = Date.parse(row.start_time);
  const startMs = Number.isNaN(parsedStartMs) ? null : parsedStartMs;

  return { pointCount, maxAltitudeFt, maxAirspeedKts, lastPointLat, lastPointLon, distanceNm, activeMs, startMs };
}
