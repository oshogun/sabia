import { haversineNm } from '../geo';

/** One route point, as the planned-leg cache holds it. */
export interface LegWaypoint {
  ident: string;
  lat: number;
  lon: number;
}

/** Where the aircraft is along the route. Unrounded; the caller rounds. */
export interface LegProgress {
  /** The far end of the route segment with the smallest crossTrackNm. */
  nextWaypointIdent: string;
  /** haversineNm to that waypoint plus the chain from it to the destination. */
  remainingDistanceNm: number;
}

/**
 * Signed east-positive longitude difference `to - from`, wrapped into
 * [-180, 180). Raw longitude subtraction is forbidden everywhere in this tree
 * (src/geo.ts, legMatcher.ts step 3) for the same reason it is forbidden here:
 * across the antimeridian 179°E → 179°W subtracts to -358° rather than the
 * 2° it is, which would make a Pacific route segment read as ~360° wide and
 * hand getPlannedLegStatus() the wrong segment — and so the wrong next
 * waypoint and remaining distance — on /api/status.
 */
export function lonDeltaDeg(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/**
 * Approximate cross-track distance (nm) from (lat, lon) to the segment
 * a->b, clamped to the segment itself rather than the infinite line through
 * it. Flat-plane (equirectangular) projection, not great-circle — adequate
 * here because it is used only to rank which leg of the route the aircraft is
 * nearest to, never reported as a distance itself (that's haversineNm, on the
 * chosen waypoint). Longitudes go through lonDeltaDeg, so the projection is
 * flat but still antimeridian-safe.
 *
 * Why not simply pick whichever waypoint minimises dist(pos, waypoint) +
 * dist(waypoint, destination)? Triangle inequality means that sum is
 * smallest for the LAST waypoint unless the aircraft is off to the side of
 * the direct line — and a real planned route is nearly straight (the
 * KSFO->KLAX waypoint list is 293.48 nm against a 293.23 nm direct great
 * circle).
 * That approach would report the destination as "next waypoint" from the
 * moment of takeoff on almost every real leg, which is exactly backwards.
 */
export function crossTrackNm(lat: number, lon: number, aLat: number, aLon: number, bLat: number, bLon: number): number {
  const cosLat = Math.cos(((aLat + bLat) / 2 * Math.PI) / 180);
  const bx = lonDeltaDeg(aLon, bLon) * cosLat, by = bLat - aLat;
  const px = lonDeltaDeg(aLon, lon) * cosLat, py = lat - aLat;
  const abLenSq = bx * bx + by * by;
  const t = abLenSq === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / abLenSq));
  const dx = px - t * bx, dy = py - t * by;
  return Math.sqrt(dx * dx + dy * dy) * 60; // ~60 nm per degree
}

/**
 * `remainingFromNm[i]` is the great-circle distance from `waypoints[i]` to the
 * last waypoint, following the route's own chain; the last entry is 0. The sum
 * runs from the destination backwards, so the floating-point result is the
 * same one the planned-leg cache has always held.
 */
export function buildRemainingFromNm(waypoints: readonly LegWaypoint[]): number[] {
  const remainingFromNm = new Array<number>(waypoints.length).fill(0);
  for (let i = waypoints.length - 2; i >= 0; i--) {
    remainingFromNm[i] =
      remainingFromNm[i + 1] + haversineNm(waypoints[i].lat, waypoints[i].lon, waypoints[i + 1].lat, waypoints[i + 1].lon);
  }
  return remainingFromNm;
}

/**
 * "Next waypoint" is the far end of whichever route segment the position is
 * nearest to by cross-track distance, which is what actually tracks progress
 * along a nearly-straight route. `remainingDistanceNm` is then the direct
 * distance to that waypoint plus the rest of the chain from there to the
 * destination — never a fraction of raw distance flown, and always via the
 * route's own waypoint chain. A tie keeps the earlier segment.
 *
 * A route with fewer than two waypoints has no segment to be nearest to and
 * throws a TypeError reading `.lat` of a missing waypoint; the caller decides
 * what a malformed cache means.
 */
export function progressAlongLeg(
  waypoints: readonly LegWaypoint[], remainingFromNm: readonly number[], lat: number, lon: number,
): LegProgress {
  let bestSegment = 0;
  let bestCrossTrackNm = Infinity;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const d = crossTrackNm(lat, lon, waypoints[i].lat, waypoints[i].lon, waypoints[i + 1].lat, waypoints[i + 1].lon);
    if (d < bestCrossTrackNm) { bestCrossTrackNm = d; bestSegment = i; }
  }
  const nextIdx = bestSegment + 1;
  const remainingDistanceNm = haversineNm(lat, lon, waypoints[nextIdx].lat, waypoints[nextIdx].lon) + remainingFromNm[nextIdx];
  return { nextWaypointIdent: waypoints[nextIdx].ident, remainingDistanceNm };
}
