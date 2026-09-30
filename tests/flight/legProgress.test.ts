// tests/flight/legProgress.test.ts — tests src/flight/legProgress.ts.
//
// Pure arithmetic: nothing here is mocked. Expected distances are built from
// haversineNm itself (already covered in tests/geo.test.ts) in the order the
// production code sums them, so a reordered sum shows up in the last bit.

import { describe, it, expect } from 'vitest';
import { haversineNm } from '../../src/geo';
import {
  lonDeltaDeg, crossTrackNm, buildRemainingFromNm, progressAlongLeg,
} from '../../src/flight/legProgress';
import type { LegWaypoint } from '../../src/flight/legProgress';

const wp = (ident: string, lat: number, lon: number): LegWaypoint => ({ ident, lat, lon });

/** Four waypoints due north along one meridian: a straight route with three segments. */
const NORTH_ROUTE: LegWaypoint[] = [
  wp('DEP', 0, 10),
  wp('WPT1', 1, 10),
  wp('WPT2', 2, 10),
  wp('DEST', 3, 10),
];

describe('lonDeltaDeg', () => {
  it('is the plain difference when the two longitudes are close', () => {
    expect(lonDeltaDeg(10, 25)).toBe(15);
    expect(lonDeltaDeg(25, 10)).toBe(-15);
    expect(lonDeltaDeg(-30, -10)).toBe(20);
    expect(lonDeltaDeg(7, 7)).toBe(0);
  });

  it('wraps across the antimeridian: 179E to 179W is +2 degrees, not -358', () => {
    expect(lonDeltaDeg(179, -179)).toBe(2);
    expect(lonDeltaDeg(-179, 179)).toBe(-2);
    expect(lonDeltaDeg(170, -170)).toBe(20);
  });

  it('always lands within a half turn of zero and is congruent to the raw difference mod 360', () => {
    for (let from = -180; from <= 180; from += 30) {
      for (let to = -180; to <= 180; to += 30) {
        const delta = lonDeltaDeg(from, to);
        expect(Math.abs(delta)).toBeLessThanOrEqual(180);
        expect((((delta - (to - from)) % 360) + 360) % 360).toBe(0);
      }
    }
  });
});

describe('crossTrackNm', () => {
  it('is 0 for a point lying on the segment', () => {
    expect(crossTrackNm(0, 1, 0, 0, 0, 2)).toBe(0);
  });

  it('is the perpendicular distance, at 60 nm per degree, from beside the segment', () => {
    expect(crossTrackNm(1, 1, 0, 0, 0, 2)).toBe(60);
    expect(crossTrackNm(-1, 1, 0, 0, 0, 2)).toBe(60);
  });

  it('clamps to the segment rather than the infinite line through it', () => {
    // Beyond either end the nearest point is the end itself, one degree away;
    // against the infinite line both would measure 0.
    expect(crossTrackNm(0, 3, 0, 0, 0, 2)).toBe(60);
    expect(crossTrackNm(0, -1, 0, 0, 0, 2)).toBe(60);
  });

  it('scales longitude by the cosine of the segment mid-latitude', () => {
    // Segment along 60N from lon 0 to lon 2. A point at lon 3 is one degree
    // of longitude past the end, which at 60N is half a degree of flat-plane
    // distance: 30 nm, not 60.
    expect(crossTrackNm(60, 3, 60, 0, 60, 2)).toBeCloseTo(30, 9);
  });

  it('takes the cosine at the mid-latitude of the segment, not at either end', () => {
    // A segment from 0N 0E to 60N 2E, and the point 60N 0E. Worked by hand:
    // cos(30 degrees) = 0.866 gives bx = 1.732 and by = 60, so the point
    // projects to t = 3600 / 3603 and lies 1.7313 degrees from the segment,
    // about 103.88 nm. The cosine at 0N would give 119.93 and at 60N 59.99.
    expect(crossTrackNm(60, 0, 0, 0, 60, 2)).toBeCloseTo(103.8798, 3);
  });

  it('measures across the antimeridian as the short way round', () => {
    // Segment 179E -> 179W is 2 degrees wide; a point 1 degree north of its
    // midpoint at 180 is 60 nm off. A raw subtraction makes the segment
    // -358 degrees wide and the answer a few hundred nm.
    expect(crossTrackNm(1, 180, 0, 179, 0, -179)).toBeCloseTo(60, 9);
    expect(crossTrackNm(0, 180, 0, 179, 0, -179)).toBeCloseTo(0, 9);
    // The point itself is on the far side too: 1.5 degrees east of the start
    // of a 4-degree segment, 1 degree north of it.
    expect(crossTrackNm(1, -179.5, 0, 179, 0, -177)).toBeCloseTo(60, 9);
  });

  it('handles a zero-length segment as a point, not as NaN', () => {
    // a == b makes the segment length zero; dividing by it would be 0/0.
    expect(crossTrackNm(11, 20, 10, 20, 10, 20)).toBe(60);
    const eastOfIt = crossTrackNm(10, 21, 10, 20, 10, 20);
    expect(eastOfIt).not.toBeNaN();
    expect(eastOfIt).toBeCloseTo(60 * Math.cos((10 * Math.PI) / 180), 9);
  });
});

describe('buildRemainingFromNm', () => {
  it('is [] for no waypoints and [0] for one', () => {
    expect(buildRemainingFromNm([])).toEqual([]);
    expect(buildRemainingFromNm([wp('ONLY', 10, 10)])).toEqual([0]);
  });

  it('is 0 at the last waypoint and the chain length to it everywhere else', () => {
    const r = buildRemainingFromNm(NORTH_ROUTE);
    expect(r).toHaveLength(4);
    expect(r[3]).toBe(0);
    expect(r[2]).toBe(haversineNm(2, 10, 3, 10));
    expect(r[2]).toBeCloseTo(60.040461, 5);
    expect(r[0]).toBeGreaterThan(r[1]);
    expect(r[1]).toBeGreaterThan(r[2]);
  });

  it('sums from the destination backwards, to the last bit', () => {
    const route = [
      wp('A', 34.4, -119.8), wp('B', 35.1, -119.3), wp('C', 36.2, -118.7),
      wp('D', 37.05, -118.1), wp('E', 37.9, -117.2),
    ];
    const d = [0, 1, 2, 3].map(i => haversineNm(route[i].lat, route[i].lon, route[i + 1].lat, route[i + 1].lon));
    const backwards = d[3] + d[2] + d[1] + d[0];
    // For this route the order of summation changes the last bit, so this
    // test can tell a backwards sum from a forwards one.
    expect(d[0] + d[1] + d[2] + d[3]).not.toBe(backwards);

    const r = buildRemainingFromNm(route);
    expect(r).toEqual([backwards, d[3] + d[2] + d[1], d[3] + d[2], d[3], 0]);
  });
});

describe('progressAlongLeg', () => {
  const remaining = buildRemainingFromNm(NORTH_ROUTE);

  it('names the far end of the segment the position is beside, for each segment in turn', () => {
    // 0.05 degrees east of the track, beside segments 1, 2 and 3.
    expect(progressAlongLeg(NORTH_ROUTE, remaining, 0.5, 10.05).nextWaypointIdent).toBe('WPT1');
    expect(progressAlongLeg(NORTH_ROUTE, remaining, 1.5, 10.05).nextWaypointIdent).toBe('WPT2');
    expect(progressAlongLeg(NORTH_ROUTE, remaining, 2.5, 10.05).nextWaypointIdent).toBe('DEST');
  });

  it('reports the unrounded direct distance to that waypoint plus the chain beyond it', () => {
    const p = progressAlongLeg(NORTH_ROUTE, remaining, 0.5, 10.05);
    expect(p.remainingDistanceNm).toBe(haversineNm(0.5, 10.05, 1, 10) + remaining[1]);
    const last = progressAlongLeg(NORTH_ROUTE, remaining, 2.5, 10.05);
    expect(last.remainingDistanceNm).toBe(haversineNm(2.5, 10.05, 3, 10));
  });

  it('picks the nearest segment, not the nearest waypoint', () => {
    // 0.4 degrees along the first segment the nearest waypoint is DEP, which
    // has just been passed; the next one is WPT1.
    const early = progressAlongLeg(NORTH_ROUTE, remaining, 0.4, 10);
    expect(haversineNm(0.4, 10, 0, 10)).toBeLessThan(haversineNm(0.4, 10, 1, 10));
    expect(early.nextWaypointIdent).toBe('WPT1');

    // The other obvious rule, minimising distance-to-waypoint plus the chain
    // from it to the destination, is smallest at the LAST waypoint on a
    // nearly straight route (triangle inequality), so it would report DEST
    // from the moment of takeoff. Here it would answer DEST while the
    // aircraft is between WPT1 and WPT2.
    const lat = 1.6;
    const lon = 10.05;
    const viaSum = NORTH_ROUTE.map((w, i) => haversineNm(lat, lon, w.lat, w.lon) + remaining[i]);
    expect(viaSum.indexOf(Math.min(...viaSum))).toBe(NORTH_ROUTE.length - 1);
    const mid = progressAlongLeg(NORTH_ROUTE, remaining, lat, lon);
    expect(mid.nextWaypointIdent).toBe('WPT2');
    expect(mid.nextWaypointIdent).not.toBe('DEST');
  });

  it('remaining-distance total when standing exactly on a waypoint is the whole chain from it', () => {
    // On WPT1 the cross-track distance to segment 1 (ending there) and to
    // segment 2 (starting there) are both 0; the earlier one wins, so WPT1
    // itself is still "next" and the remaining distance is its whole chain.
    const p = progressAlongLeg(NORTH_ROUTE, remaining, 1, 10);
    expect(p.nextWaypointIdent).toBe('WPT1');
    expect(p.remainingDistanceNm).toBe(remaining[1]);
    expect(p.remainingDistanceNm).toBeCloseTo(2 * 60.040461, 4);
  });

  it('breaks an exact cross-track tie towards the earlier segment', () => {
    // Three waypoints on one parallel: a position abeam the middle one is the
    // same distance from both segments, so the strict comparison keeps the
    // first and progress is never reported further along than it was proved.
    const route = [wp('DEP', 35, -121), wp('MID', 35, -120), wp('END', 35, -119)];
    const p = progressAlongLeg(route, buildRemainingFromNm(route), 35.1, -120);
    expect(crossTrackNm(35.1, -120, 35, -121, 35, -120))
      .toBe(crossTrackNm(35.1, -120, 35, -120, 35, -119));
    expect(p.nextWaypointIdent).toBe('MID');
  });

  it('lets a zero-length segment win when it is the nearest, rather than skipping it as NaN', () => {
    const route = [wp('A', 10, 20), wp('B', 10, 20), wp('C', 10, 21)];
    const p = progressAlongLeg(route, buildRemainingFromNm(route), 10, 20);
    expect(p.nextWaypointIdent).toBe('B');
    expect(p.remainingDistanceNm).toBe(haversineNm(10, 20, 10, 21));
  });

  it('follows the route across the antimeridian rather than the 360-degree-wide segment', () => {
    const route = [
      wp('DEP', 10, 178.5),
      wp('EAST', 10, 179.5),
      wp('WEST', 10, -179.5), // 1 degree on from EAST, not 359 back
      wp('DEST', 10, -178.5),
    ];
    const r = buildRemainingFromNm(route);
    const p = progressAlongLeg(route, r, 10.05, 179.9);
    expect(p.nextWaypointIdent).toBe('WEST');
    expect(p.remainingDistanceNm).toBe(haversineNm(10.05, 179.9, 10, -179.5) + r[2]);
  });

  it('throws a TypeError reading .lat for a route with fewer than two waypoints', () => {
    expect(() => progressAlongLeg([], [], 10, 10)).toThrow(TypeError);
    expect(() => progressAlongLeg([], [], 10, 10)).toThrow(/reading 'lat'/);
    const one = [wp('ONLY', 10, 10)];
    expect(() => progressAlongLeg(one, [0], 10, 10)).toThrow(TypeError);
    expect(() => progressAlongLeg(one, [0], 10, 10)).toThrow(/reading 'lat'/);
  });
});
