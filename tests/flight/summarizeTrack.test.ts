// tests/flight/summarizeTrack.test.ts — tests src/flight/summarizeTrack.ts.
//
// The resume replay as a pure function: no clock, no database. Expected
// distances are built from haversineNm; expected times are written out.

import { describe, it, expect } from 'vitest';
import { haversineNm } from '../../src/geo';
import { MAX_COUNTED_GAP_MS } from '../../src/flight/constants';
import { summarizeTrack } from '../../src/flight/summarizeTrack';
import type { TrackPointLike, TrackRowLike, TrackFrameLike } from '../../src/flight/summarizeTrack';

const T0 = Date.parse('2026-03-01T12:00:00.000Z');

const ROW: TrackRowLike = {
  start_time: '2026-03-01T11:58:00.000Z',
  departure_lat: 34.4,
  departure_lon: -119.8,
};

const FRAME: TrackFrameLike = { lat: 40.5, lon: -100.25, altitudeFt: 12_345, airspeedKnots: 250 };

/** A track point `offsetMs` after T0; `ts` overrides the derived timestamp. */
function pt(offsetMs: number, lat: number, lon: number, extra: Partial<TrackPointLike> = {}): TrackPointLike {
  return {
    lat, lon, altitude_ft: 1000, airspeed_kts: 100, ts: new Date(T0 + offsetMs).toISOString(), ...extra,
  };
}

const nm = (a: TrackPointLike, b: TrackPointLike) => haversineNm(a.lat, a.lon, b.lat, b.lon);

describe('summarizeTrack with no points', () => {
  it('seeds the maxima from the frame and restarts from the departure coordinates', () => {
    expect(summarizeTrack([], ROW, FRAME)).toEqual({
      pointCount: 0,
      maxAltitudeFt: 12_345,
      maxAirspeedKts: 250,
      lastPointLat: 34.4,
      lastPointLon: -119.8,
      distanceNm: 0,
      activeMs: 0,
      startMs: Date.parse('2026-03-01T11:58:00.000Z'),
    });
  });

  it('falls back to the frame position when the row has no departure coordinates', () => {
    const s = summarizeTrack([], { ...ROW, departure_lat: null, departure_lon: null }, FRAME);
    expect(s.lastPointLat).toBe(40.5);
    expect(s.lastPointLon).toBe(-100.25);
  });

  it('takes the departure pair only when both halves are present', () => {
    const onlyLat = summarizeTrack([], { ...ROW, departure_lon: null }, FRAME);
    expect([onlyLat.lastPointLat, onlyLat.lastPointLon]).toEqual([40.5, -100.25]);
    const onlyLon = summarizeTrack([], { ...ROW, departure_lat: null }, FRAME);
    expect([onlyLon.lastPointLat, onlyLon.lastPointLon]).toEqual([40.5, -100.25]);
  });

  it('keeps a departure at 0,0 rather than mistaking it for missing', () => {
    const s = summarizeTrack([], { ...ROW, departure_lat: 0, departure_lon: 0 }, FRAME);
    expect([s.lastPointLat, s.lastPointLon]).toEqual([0, 0]);
  });
});

describe('summarizeTrack with points', () => {
  it('a single point has no distance or time, and the last point is that point', () => {
    const s = summarizeTrack([pt(0, 35, -120, { altitude_ft: 500, airspeed_kts: 60 })], ROW, FRAME);
    expect(s).toMatchObject({
      pointCount: 1, maxAltitudeFt: 500, maxAirspeedKts: 60,
      lastPointLat: 35, lastPointLon: -120, distanceNm: 0, activeMs: 0,
    });
  });

  it('takes the maxima over the whole track, the first and last points included', () => {
    const first = summarizeTrack([
      pt(0, 35, -120, { altitude_ft: 9000, airspeed_kts: 300 }),
      pt(5000, 35.1, -120, { altitude_ft: 8000, airspeed_kts: 200 }),
      pt(10_000, 35.2, -120, { altitude_ft: 7000, airspeed_kts: 100 }),
    ], ROW, FRAME);
    expect([first.maxAltitudeFt, first.maxAirspeedKts]).toEqual([9000, 300]);

    const last = summarizeTrack([
      pt(0, 35, -120, { altitude_ft: 1000, airspeed_kts: 100 }),
      pt(5000, 35.1, -120, { altitude_ft: 2000, airspeed_kts: 120 }),
      pt(10_000, 35.2, -120, { altitude_ft: 3000, airspeed_kts: 140 }),
    ], ROW, FRAME);
    expect([last.maxAltitudeFt, last.maxAirspeedKts]).toEqual([3000, 140]);

    const middle = summarizeTrack([
      pt(0, 35, -120, { altitude_ft: 1000, airspeed_kts: 100 }),
      pt(5000, 35.1, -120, { altitude_ft: 5000, airspeed_kts: 180 }),
      pt(10_000, 35.2, -120, { altitude_ft: 3000, airspeed_kts: 140 }),
    ], ROW, FRAME);
    expect([middle.maxAltitudeFt, middle.maxAirspeedKts]).toEqual([5000, 180]);
  });

  it('seeds the maxima from the first point, so an all-negative track does not report 0', () => {
    const s = summarizeTrack([
      pt(0, 35, -120, { altitude_ft: -50, airspeed_kts: -3 }),
      pt(5000, 35.1, -120, { altitude_ft: -20, airspeed_kts: -9 }),
      pt(10_000, 35.2, -120, { altitude_ft: -80, airspeed_kts: -1 }),
    ], ROW, FRAME);
    expect([s.maxAltitudeFt, s.maxAirspeedKts]).toEqual([-20, -1]);
  });

  it('ignores the frame for the maxima once there are points', () => {
    const s = summarizeTrack([pt(0, 35, -120), pt(5000, 35.1, -119.9)], ROW, FRAME);
    expect([s.maxAltitudeFt, s.maxAirspeedKts]).toEqual([1000, 100]);
    expect([s.lastPointLat, s.lastPointLon]).toEqual([35.1, -119.9]);
  });

  it('sums the distance of every consecutive pair and the time of every ordinary gap', () => {
    const p = [pt(0, 35.0, -120), pt(5000, 35.1, -120), pt(10_000, 35.1, -119.9), pt(17_000, 35.3, -119.9)];
    const s = summarizeTrack(p, ROW, FRAME);
    expect(s.pointCount).toBe(4);
    expect(s.distanceNm).toBe(nm(p[0], p[1]) + nm(p[1], p[2]) + nm(p[2], p[3]));
    expect(s.activeMs).toBe(5000 + 5000 + 7000);
  });

  it('counts a gap of exactly the maximum but not one millisecond more', () => {
    const at = summarizeTrack([pt(0, 35, -120), pt(MAX_COUNTED_GAP_MS, 35.1, -120)], ROW, FRAME);
    expect(at.activeMs).toBe(MAX_COUNTED_GAP_MS);

    const over = summarizeTrack([pt(0, 35, -120), pt(MAX_COUNTED_GAP_MS + 1, 35.1, -120)], ROW, FRAME);
    expect(over.activeMs).toBe(0);
  });

  it('does not count a gap above the maximum, but still counts its distance', () => {
    const p = [pt(0, 35.0, -120), pt(5000, 35.1, -120), pt(5000 + 600_000, 36.0, -120), pt(5000 + 605_000, 36.1, -120)];
    const s = summarizeTrack(p, ROW, FRAME);
    expect(s.activeMs).toBe(5000 + 5000);
    expect(s.distanceNm).toBe(nm(p[0], p[1]) + nm(p[1], p[2]) + nm(p[2], p[3]));
    expect(s.distanceNm).toBeGreaterThan(nm(p[0], p[1]) + nm(p[2], p[3]) + 50);
  });

  it('skips a non-positive gap (equal or out-of-order timestamps), keeping its distance', () => {
    const p = [
      pt(0, 35.0, -120),
      pt(5000, 35.1, -120),
      pt(5000, 35.2, -120), // same instant: no time
      pt(3000, 35.3, -120), // earlier than its predecessor: no time, not a negative one
      pt(8000, 35.4, -120), // 5 s after the out-of-order one
    ];
    const s = summarizeTrack(p, ROW, FRAME);
    expect(s.activeMs).toBe(5000 + 5000);
    expect(s.distanceNm).toBe(nm(p[0], p[1]) + nm(p[1], p[2]) + nm(p[2], p[3]) + nm(p[3], p[4]));
  });

  it('skips a gap with an unparseable timestamp on either side, keeping its distance', () => {
    const p = [
      pt(0, 35.0, -120),
      pt(5000, 35.1, -120),
      pt(0, 35.2, -120, { ts: 'not a timestamp' }), // both gaps around it are NaN
      pt(15_000, 35.3, -120),
      pt(20_000, 35.4, -120),
    ];
    const s = summarizeTrack(p, ROW, FRAME);
    expect(Number.isNaN(s.activeMs)).toBe(false);
    expect(s.activeMs).toBe(5000 + 5000);
    expect(s.distanceNm).toBe(nm(p[0], p[1]) + nm(p[1], p[2]) + nm(p[2], p[3]) + nm(p[3], p[4]));
  });

  it('skips the first gap when the first timestamp is unparseable', () => {
    const p = [pt(0, 35.0, -120, { ts: '' }), pt(5000, 35.1, -120), pt(10_000, 35.2, -120)];
    expect(summarizeTrack(p, ROW, FRAME).activeMs).toBe(5000);
  });
});

describe('summarizeTrack start time', () => {
  it('is the epoch milliseconds of the row start_time', () => {
    expect(summarizeTrack([pt(0, 35, -120)], ROW, FRAME).startMs).toBe(Date.parse('2026-03-01T11:58:00.000Z'));
  });

  it('is 0 for a start_time at the epoch, not null: the instant 0 is a real start time', () => {
    expect(summarizeTrack([pt(0, 35, -120)], { ...ROW, start_time: '1970-01-01T00:00:00.000Z' }, FRAME).startMs).toBe(0);
    expect(summarizeTrack([], { ...ROW, start_time: '1970-01-01T00:00:00.000Z' }, FRAME).startMs).toBe(0);
  });

  it('is null when start_time does not parse, so the caller can pick its own fallback', () => {
    expect(summarizeTrack([pt(0, 35, -120)], { ...ROW, start_time: 'yesterday-ish' }, FRAME).startMs).toBeNull();
    expect(summarizeTrack([], { ...ROW, start_time: '' }, FRAME).startMs).toBeNull();
  });
});
