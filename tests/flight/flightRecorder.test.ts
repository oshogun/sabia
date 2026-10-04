// tests/flight/flightRecorder.test.ts — tests src/flight/flightRecorder.ts.
//
// The database barrel is replaced, so every insert and close the recorder
// makes is ours to inspect, and the clock is faked. The recorder's fields are
// private: each test reads them back through closeFlight's arguments (by way
// of finish()), through what the next write does, or through elapsedMs().
//
// Every expected duration is a literal worked out in the comment beside it
// from the advances the test made itself.
//
// The first block that drives a real FlightManager for the rules only the
// coordinator's sequencing can get wrong: a pause that came before the takeoff,
// the recording interval after a failed resume point, the order inside a point
// write, and the clock read the position report is given.
//
// Three blocks follow that one: two more drives of a real FlightManager (where the
// flight clock starts relative to the takeoff notify; and the rules that only show
// when a call is slow, a store fails or a pause arrives by another route: rounding,
// what a failed point still counts, the pause arms), and one that steps the faked
// clock on every read, the only way to see the order of the recorder's own reads.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SimFrame } from '../../src/types';
import type { OpenFlightRow } from '../../src/db';
import {
  dbMock, airportsMock, acarsEventsMock, resetMocks, makeFrame, makePlannedLegWithChildren,
  northOfNm, KSBA, T0, useFakeClock, useRealClock,
} from '../helpers';
import { haversineNm } from '../../src/geo';

vi.mock('../../src/db', async () => (await import('../helpers')).dbMock);
vi.mock('../../src/airports', async () => (await import('../helpers')).airportsMock);
vi.mock('../../src/acarsEvents', async () => (await import('../helpers')).acarsEventsMock);
vi.mock('../../src/db/groundSessions', () => ({
  insertGroundSession: vi.fn(),
  getOpenGroundSession: vi.fn(),
  closeOpenGroundSession: vi.fn(),
  fillOpenGroundSessionGaps: vi.fn(),
}));

import { FlightRecorder } from '../../src/flight/flightRecorder';
import type { FlightTally } from '../../src/flight/flightRecorder';
import { MAX_COUNTED_GAP_MS } from '../../src/flight/constants';
import { FlightManager } from '../../src/flightManager';
import * as groundSessionsModule from '../../src/db/groundSessions';

const advance = (ms: number) => vi.advanceTimersByTime(ms);

/** The ISO stamp the faked clock reads `ms` after T0. */
const iso = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

const logged = (): string[] => vi.mocked(console.log).mock.calls.map(c => String(c[0]));

const boom = new Error('database is locked');
const DEP = { icao: 'KSBA', name: 'Santa Barbara Muni' };
const ARR = { icao: 'KMRY', name: 'Monterey Rgnl' };

/** A recorder with a flight begun and both clocks started at the current (fake) instant. */
function started(frame: SimFrame = makeFrame()): { rec: FlightRecorder; id: number } {
  const rec = new FlightRecorder();
  const id = rec.begin(frame, DEP, iso(0));
  rec.startClock();
  return { rec, id };
}

/** Ends the flight at the current instant and names closeFlight's arguments. */
function end(rec: FlightRecorder, id: number, frame: SimFrame = makeFrame()) {
  const tally = rec.stopClock();
  rec.finish(id, frame, null, tally);
  const c = dbMock.closeFlight.mock.calls[dbMock.closeFlight.mock.calls.length - 1];
  return {
    tally,
    endTime: c[1] as string,
    durationSec: c[4] as number,
    distanceNm: c[5] as number,
    maxAltitudeFt: c[6] as number,
    maxAirspeedKts: c[7] as number,
    pointCount: c[8] as number,
  };
}

const at = (nm: number, over: Partial<SimFrame> = {}): SimFrame => {
  const p = northOfNm(KSBA, nm);
  return makeFrame({ lat: p.lat, lon: p.lon, ...over });
};

const row = (over: Partial<OpenFlightRow> = {}): OpenFlightRow => ({
  id: 77, aircraft: 'Cessna 172', start_time: iso(-300_000),
  departure_lat: KSBA.lat, departure_lon: KSBA.lon, ...over,
});

const stored = (nm: number, msFromT0: number, over: Partial<{ altitude_ft: number; airspeed_kts: number }> = {}) => {
  const p = northOfNm(KSBA, nm);
  return { lat: p.lat, lon: p.lon, altitude_ft: 3000, airspeed_kts: 120, ts: iso(msFromT0), ...over };
};

beforeEach(() => {
  resetMocks();
  vi.mocked(groundSessionsModule.closeOpenGroundSession).mockReset();
  useFakeClock();
});
afterEach(() => useRealClock());

describe('FlightRecorder.begin', () => {
  it('returns the id insertFlight issued, handing it the takeoff fix, the start time and the departure airport', () => {
    const rec = new FlightRecorder();
    const frame = makeFrame({ aircraft: 'Piper PA-28', lat: 10, lon: 20 });
    const id = rec.begin(frame, DEP, iso(0));
    expect(id).toBe(1);
    expect(dbMock.insertFlight).toHaveBeenCalledTimes(1);
    expect(dbMock.insertFlight).toHaveBeenCalledWith('Piper PA-28', 10, 20, iso(0), 'KSBA', 'Santa Barbara Muni');
  });

  it('passes null airport columns when there is no departure airport', () => {
    new FlightRecorder().begin(makeFrame(), null, iso(0));
    expect(dbMock.insertFlight).toHaveBeenCalledWith('Cessna 172', KSBA.lat, KSBA.lon, iso(0), null, null);
  });

  it('does not read the clock', () => {
    const now = vi.spyOn(Date, 'now');
    new FlightRecorder().begin(makeFrame(), DEP, iso(0));
    expect(now).not.toHaveBeenCalled();
  });

  it('resets every accumulator of the previous flight to the new takeoff frame', () => {
    const { rec, id } = started(makeFrame({ altitudeFt: 1500, airspeedKnots: 110 }));
    advance(5000);
    rec.writePoint(id, makeFrame());
    advance(5000);
    rec.writePoint(id, at(10, { altitudeFt: 9000, airspeedKnots: 250 }));

    const second = rec.begin(makeFrame({ altitudeFt: 2000, airspeedKnots: 95 }), DEP, iso(10_000));
    rec.startClock();
    const out = end(rec, second);
    // Nothing of the first flight (10 nm, 9000 ft, 250 kt, 2 points, 5 s counted) survives.
    expect(out.pointCount).toBe(0);
    expect(out.distanceNm).toBe(0);
    expect(out.maxAltitudeFt).toBe(2000);
    expect(out.maxAirspeedKts).toBe(95);
    expect(out.durationSec).toBe(0);
  });

  it('leaves the previous accumulators alone when insertFlight throws, and the throw propagates', () => {
    const { rec, id } = started();
    advance(5000);
    rec.writePoint(id, makeFrame());
    advance(5000);
    rec.writePoint(id, at(10, { altitudeFt: 9000 }));

    dbMock.insertFlight.mockImplementationOnce(() => { throw boom; });
    expect(() => rec.begin(makeFrame({ altitudeFt: 100 }), DEP, iso(10_000))).toThrow(boom);

    const out = end(rec, id);
    expect(out.pointCount).toBe(2);
    expect(out.maxAltitudeFt).toBe(9000);
    expect(out.distanceNm).toBe(10);
  });

  it('clears an interruption marked while no flight existed, so the first tail still counts', () => {
    const rec = new FlightRecorder();
    rec.markInterrupted();
    rec.begin(makeFrame(), DEP, iso(0));
    rec.startClock();
    advance(3000);
    // The tail is 3 s and nothing interrupted this flight: 3.
    expect(end(rec, 1).durationSec).toBe(3);
  });
});

describe('FlightRecorder.startClock and elapsedMs', () => {
  it('reads the clock twice, and measures the flight clock from there', () => {
    const { rec } = started();
    advance(90_000);
    expect(rec.elapsedMs(Date.now())).toBe(90_000);

    const rec2 = new FlightRecorder();
    rec2.begin(makeFrame(), DEP, iso(0));
    const now = vi.spyOn(Date, 'now');
    rec2.startClock();
    expect(now).toHaveBeenCalledTimes(2);
  });

  it('starts the recording interval: no point before it has run, one when it has', () => {
    const { rec, id } = started();
    advance(4999);
    expect(rec.maybeRecord(id, makeFrame())).toBeNull();
    advance(1);
    expect(rec.maybeRecord(id, makeFrame())).not.toBeNull();
  });
});

describe('FlightRecorder.maybeRecord', () => {
  it('writes at most one point per 5000 ms, counted from the last point', () => {
    const { rec, id } = started();
    advance(5000);
    expect(rec.maybeRecord(id, makeFrame())).toEqual({ flightId: id, nowMs: Date.parse(iso(5000)), ts: iso(5000) });

    advance(4999);
    expect(rec.maybeRecord(id, makeFrame())).toBeNull();
    expect(dbMock.insertPoint).toHaveBeenCalledTimes(1);

    advance(1);
    const second = rec.maybeRecord(id, makeFrame());
    expect(second).toEqual({ flightId: id, nowMs: Date.parse(iso(10_000)), ts: iso(10_000) });
    expect(dbMock.insertPoint).toHaveBeenCalledTimes(2);
  });

  it('returns null with no current flight even when a point is due, and does not move the interval', () => {
    const { rec, id } = started();
    advance(5000);
    expect(rec.maybeRecord(null, makeFrame())).toBeNull();
    expect(dbMock.insertPoint).not.toHaveBeenCalled();
    // The point is still due.
    expect(rec.maybeRecord(id, makeFrame())).not.toBeNull();
  });

  it('reads the clock once for a throttled frame and twice for a written one', () => {
    const { rec, id } = started();
    advance(1000);
    const now = vi.spyOn(Date, 'now');
    rec.maybeRecord(id, makeFrame());
    expect(now).toHaveBeenCalledTimes(1);
    advance(4000);
    rec.maybeRecord(id, makeFrame());
    expect(now).toHaveBeenCalledTimes(3);
  });
});

describe('FlightRecorder.writePoint', () => {
  it('stores the point and returns the stamp it was stored under, from a single clock read', () => {
    const { rec, id } = started();
    advance(1234);
    const now = vi.spyOn(Date, 'now');
    const frame = makeFrame({
      lat: 1.5, lon: 2.5, altitudeFt: 3000, airspeedKnots: 120, groundSpeedKnots: 115,
      headingDeg: 90, verticalSpeedFpm: -300, onGround: true,
    });
    const point = rec.writePoint(id, frame);

    expect(now).toHaveBeenCalledTimes(1);
    expect(point).toEqual({ flightId: id, nowMs: Date.parse(iso(1234)), ts: iso(1234) });
    expect(dbMock.insertPoint).toHaveBeenCalledWith(id, iso(1234), 1.5, 2.5, 3000, 120, 115, 90, -300, true, false);
  });

  it('returns null, stores nothing and reads no clock when there is no current flight', () => {
    const { rec } = started();
    advance(5000);
    const now = vi.spyOn(Date, 'now');
    expect(rec.writePoint(null, at(10))).toBeNull();
    expect(now).not.toHaveBeenCalled();
    expect(dbMock.insertPoint).not.toHaveBeenCalled();
    expect(end(rec, 1).pointCount).toBe(0);
  });

  it('counts neither a gap nor a distance for the first point of a flight', () => {
    const { rec, id } = started();
    advance(30_000); // inside the budget, so only "first point" keeps it out of the duration
    rec.writePoint(id, at(50));
    const out = end(rec, id, at(50));
    expect(out.pointCount).toBe(1);
    expect(out.distanceNm).toBe(0);
    expect(out.durationSec).toBe(0);
  });

  it.each([
    [5000, 5],
    [MAX_COUNTED_GAP_MS, 60],
    [MAX_COUNTED_GAP_MS + 1, 0],
  ])('a gap of %i ms between points adds %i s of flight time', (gapMs, seconds) => {
    const { rec, id } = started();
    rec.writePoint(id, makeFrame());
    advance(gapMs);
    rec.writePoint(id, makeFrame());
    // No tail: the flight ends on the second point.
    expect(end(rec, id).durationSec).toBe(seconds);
  });

  it('counts the distance of a gap whether or not the gap itself counts', () => {
    const { rec, id } = started();
    rec.writePoint(id, at(0));
    advance(5000);
    rec.writePoint(id, at(4));                 // a counted gap: 4 nm
    advance(MAX_COUNTED_GAP_MS + 1);
    rec.writePoint(id, at(10));                // an over-long gap: still 6 nm
    const out = end(rec, id, at(10));
    // 4 + 6 nm; only the first 5 s is flight time.
    expect(out.distanceNm).toBe(10);
    expect(out.durationSec).toBe(5);
  });

  it('keeps the highest altitude and airspeed of the points it stores', () => {
    const { rec, id } = started(makeFrame({ altitudeFt: 1500, airspeedKnots: 110 }));
    advance(5000);
    rec.writePoint(id, makeFrame({ altitudeFt: 3000, airspeedKnots: 90 }));
    advance(5000);
    rec.writePoint(id, makeFrame({ altitudeFt: 2000, airspeedKnots: 130 }));
    const out = end(rec, id);
    expect(out.maxAltitudeFt).toBe(3000);
    expect(out.maxAirspeedKts).toBe(130);
  });

  it('an interruption excludes the gap that spans it but not its distance, and the next point clears it', () => {
    const { rec, id } = started();
    rec.writePoint(id, at(0));
    rec.markInterrupted();
    advance(10_000);
    rec.writePoint(id, at(5));                 // the 10 s gap is not counted, its 5 nm is
    advance(5000);
    rec.writePoint(id, at(10));                // the flag was cleared: 5 s counted
    const out = end(rec, id, at(10));
    expect(out.durationSec).toBe(5);
    expect(out.distanceNm).toBe(10);
    expect(out.pointCount).toBe(3);
  });

  describe('when the point cannot be stored', () => {
    it('propagates the throw, and a frame that was never stored raises neither the distance nor the maxima', () => {
      const { rec, id } = started(makeFrame({ altitudeFt: 1500, airspeedKnots: 110 }));
      advance(5000);
      rec.writePoint(id, at(0));
      advance(5000);
      dbMock.insertPoint.mockImplementationOnce(() => { throw boom; });
      expect(() => rec.writePoint(id, at(10, { altitudeFt: 9000, airspeedKnots: 250 }))).toThrow(boom);

      const out = end(rec, id, at(10));
      expect(out.maxAltitudeFt).toBe(1500);
      expect(out.maxAirspeedKts).toBe(110);
      expect(out.distanceNm).toBe(0);
      expect(out.pointCount).toBe(1);
    });

    it('leaves the last point, the count and the interruption mark as they were', () => {
      const { rec, id } = started();
      advance(5000);
      rec.writePoint(id, at(0));
      rec.markInterrupted();
      advance(10_000);
      dbMock.insertPoint.mockImplementationOnce(() => { throw boom; });
      expect(() => rec.writePoint(id, at(10))).toThrow(boom);
      advance(5000);
      rec.writePoint(id, at(10));

      // The failed attempt added nothing, and the next point measures from the last point that
      // was stored, so the 10 nm is counted once. The mark survived the failure: the 15 s since
      // the stored point is not counted.
      const out = end(rec, id, at(10));
      expect(out.pointCount).toBe(2);
      expect(out.distanceNm).toBe(10);
      expect(out.durationSec).toBe(0);
    });
  });
});

describe('FlightRecorder.stopClock', () => {
  it('reads the end instant, the tail and the wall-clock span: one date construction and two reads', () => {
    const { rec } = started();
    advance(2000);
    const now = vi.spyOn(Date, 'now');
    const tally = rec.stopClock();
    expect(now).toHaveBeenCalledTimes(2);
    expect(tally.endTime).toBe(iso(2000));
  });

  it.each([
    ['a tail well inside the budget', 4000, 4],
    ['a tail of exactly the budget', MAX_COUNTED_GAP_MS, 60],
    ['a tail one millisecond over the budget', MAX_COUNTED_GAP_MS + 1, 0],
  ])('%s, when nothing interrupted the flight', (_name, tailMs, seconds) => {
    const { rec, id } = started();
    rec.writePoint(id, makeFrame());
    advance(tailMs);
    expect(rec.stopClock().durationSec).toBe(seconds);
  });

  it('drops the tail of an interrupted flight even though it fits the budget', () => {
    const { rec, id } = started();
    rec.writePoint(id, makeFrame());
    advance(5000);
    rec.writePoint(id, makeFrame());           // 5 s counted
    rec.markInterrupted();
    advance(4000);
    // 5 + 0, not the 9 the same tail gives without the interruption.
    expect(rec.stopClock().durationSec).toBe(5);
  });

  it('rounds the counted time to the nearest second', () => {
    const { rec, id } = started();
    rec.writePoint(id, makeFrame());
    advance(5500);
    rec.writePoint(id, makeFrame());
    // 5.5 s is 6, not 5.
    expect(rec.stopClock().durationSec).toBe(6);
  });

  it('reports the wall-clock time that was not counted as excluded seconds', () => {
    const { rec, id } = started();
    rec.writePoint(id, makeFrame());
    advance(120_000);
    rec.writePoint(id, makeFrame());           // over-long gap, dropped
    advance(5000);
    rec.writePoint(id, makeFrame());           // 5 s counted
    const tally = rec.stopClock();
    // 125 s of wall clock, 5 s counted.
    expect(tally.durationSec).toBe(5);
    expect(tally.excludedSec).toBe(120);
  });

  it('never reports negative excluded seconds', () => {
    const rec = new FlightRecorder();
    dbMock.getFlightTrackPoints.mockReturnValue([stored(0, -20_000), stored(1, -10_000)]);
    // The row starts now, but the stored track already counts 10 s: counted time exceeds the wall clock.
    rec.adopt(row({ start_time: iso(0) }), makeFrame());
    const tally = rec.stopClock();
    expect(tally.durationSec).toBe(10);
    expect(tally.excludedSec).toBe(0);
  });
});

describe('FlightRecorder.finish', () => {
  function twoPoints() {
    const { rec, id } = started(makeFrame({ altitudeFt: 1500, airspeedKnots: 110 }));
    rec.writePoint(id, at(0));
    advance(5000);
    rec.writePoint(id, at(12.34, { altitudeFt: 3000.4, airspeedKnots: 129.5 }));
    return { rec, id };
  }

  it('closes the row with the accumulators rounded, the tally and the arrival airport', () => {
    const { rec, id } = twoPoints();
    const tally: FlightTally = { endTime: iso(9000), durationSec: 5, excludedSec: 0 };
    rec.finish(id, makeFrame({ lat: 36.5, lon: -121.8 }), ARR, tally);
    // 12.34 nm -> 12.3; 3000.4 ft -> 3000; 129.5 kt -> 130.
    expect(dbMock.closeFlight).toHaveBeenCalledWith(id, iso(9000), 36.5, -121.8, 5, 12.3, 3000, 130, 2, 'KMRY', 'Monterey Rgnl');
  });

  it('passes null airport columns when there is no arrival airport', () => {
    const { rec, id } = twoPoints();
    rec.finish(id, makeFrame(), null, { endTime: iso(9000), durationSec: 5, excludedSec: 0 });
    const c = dbMock.closeFlight.mock.calls[0];
    expect(c[9]).toBeNull();
    expect(c[10]).toBeNull();
  });

  it('logs the ended line after the close, with no suffix when nothing was excluded', () => {
    const { rec, id } = twoPoints();
    rec.finish(id, makeFrame(), ARR, { endTime: iso(9000), durationSec: 5, excludedSec: 0 });
    expect(logged()).toEqual(['[FlightManager] Flight #1 ended — 2 points, 12.3 nm, 5s']);
    const closeOrder = dbMock.closeFlight.mock.invocationCallOrder[0];
    const logOrder = vi.mocked(console.log).mock.invocationCallOrder[0];
    expect(closeOrder).toBeLessThan(logOrder);
  });

  it('adds the interrupted suffix only when seconds were excluded', () => {
    const { rec, id } = twoPoints();
    rec.finish(id, makeFrame(), ARR, { endTime: iso(9000), durationSec: 5, excludedSec: 51 });
    expect(logged()).toEqual(['[FlightManager] Flight #1 ended — 2 points, 12.3 nm, 5s (51s interrupted, excluded)']);
  });

  it('lets a closeFlight throw through and logs nothing', () => {
    const { rec, id } = twoPoints();
    dbMock.closeFlight.mockImplementationOnce(() => { throw boom; });
    expect(() => rec.finish(id, makeFrame(), ARR, { endTime: iso(9000), durationSec: 5, excludedSec: 0 })).toThrow(boom);
    expect(logged()).toEqual([]);
  });
});

describe('FlightRecorder.adopt', () => {
  const track = [
    stored(0, -120_000, { altitude_ft: 2000, airspeed_kts: 100 }),
    stored(4, -115_000, { altitude_ft: 4200, airspeed_kts: 90 }),
    stored(9, -110_000, { altitude_ft: 3500, airspeed_kts: 130 }),
  ];
  const trackNm = haversineNm(track[0].lat, track[0].lon, track[1].lat, track[1].lon)
    + haversineNm(track[1].lat, track[1].lon, track[2].lat, track[2].lon);

  it('reads the row\'s own track and seeds the accumulators from it', () => {
    dbMock.getFlightTrackPoints.mockReturnValue(track);
    const rec = new FlightRecorder();
    const seed = rec.adopt(row(), makeFrame({ altitudeFt: 10, airspeedKnots: 10 }));

    expect(dbMock.getFlightTrackPoints).toHaveBeenCalledWith(77);
    // Three stored points, two 5 s gaps, the distance between consecutive points.
    expect(seed).toEqual({ pointCount: 3, distanceNm: trackNm, activeMs: 10_000 });
    expect(trackNm).toBeCloseTo(9, 6);

    // The maxima and the last point come from the track, not from the frame.
    advance(3000);
    rec.writePoint(77, at(11, { altitudeFt: 10, airspeedKnots: 10 }));
    const out = end(rec, 77, at(11));
    expect(out.pointCount).toBe(4);
    expect(out.maxAltitudeFt).toBe(4200);
    expect(out.maxAirspeedKts).toBe(130);
    // 9 nm stored, 2 nm from the last stored point to the new one.
    expect(out.distanceNm).toBe(11);
  });

  it('seeds from the frame when the track is empty', () => {
    dbMock.getFlightTrackPoints.mockReturnValue([]);
    const rec = new FlightRecorder();
    const seed = rec.adopt(row(), makeFrame({ altitudeFt: 4000, airspeedKnots: 140 }));
    expect(seed).toEqual({ pointCount: 0, distanceNm: 0, activeMs: 0 });
    const out = end(rec, 77);
    expect(out.maxAltitudeFt).toBe(4000);
    expect(out.maxAirspeedKts).toBe(140);
  });

  it('measures the first gap after an adoption from the adoption, not from the last stored point', () => {
    dbMock.getFlightTrackPoints.mockReturnValue(track);
    const rec = new FlightRecorder();
    rec.adopt(row(), makeFrame());
    advance(3000);
    rec.writePoint(77, makeFrame());
    // 10 s from the track plus 3 s since the adoption. A gap from the last stored point would be 113 s and dropped.
    expect(end(rec, 77).durationSec).toBe(13);
  });

  it('restarts the recording interval at the adoption', () => {
    dbMock.getFlightTrackPoints.mockReturnValue(track);
    const rec = new FlightRecorder();
    rec.adopt(row(), makeFrame());
    advance(4999);
    expect(rec.maybeRecord(77, makeFrame())).toBeNull();
    advance(1);
    expect(rec.maybeRecord(77, makeFrame())).not.toBeNull();
  });

  it('leaves the interruption mark alone, in either direction', () => {
    dbMock.getFlightTrackPoints.mockReturnValue(track);

    const clean = new FlightRecorder();
    clean.adopt(row(), makeFrame());
    advance(4000);
    // 10 s from the track plus a 4 s tail: adopting does not interrupt the flight.
    expect(clean.stopClock().durationSec).toBe(14);

    const marked = new FlightRecorder();
    marked.markInterrupted();
    marked.adopt(row(), makeFrame());
    advance(4000);
    // The mark set before the adoption survives it: no tail.
    expect(marked.stopClock().durationSec).toBe(10);
  });

  it('takes the flight start from the row, so elapsed time runs from the row\'s start', () => {
    dbMock.getFlightTrackPoints.mockReturnValue(track);
    const rec = new FlightRecorder();
    rec.adopt(row({ start_time: iso(-300_000) }), makeFrame());
    expect(rec.elapsedMs(Date.parse(iso(0)))).toBe(300_000);
  });

  it('falls back to the clock for a start time that does not parse, with one more clock read', () => {
    dbMock.getFlightTrackPoints.mockReturnValue(track);
    const now = vi.spyOn(Date, 'now');
    const rec = new FlightRecorder();
    rec.adopt(row({ start_time: 'not a date' }), makeFrame());
    expect(now).toHaveBeenCalledTimes(2);
    expect(rec.elapsedMs(Date.parse(iso(90_000)))).toBe(90_000);
  });

  it('reads the clock once for a start time that parses', () => {
    dbMock.getFlightTrackPoints.mockReturnValue(track);
    const now = vi.spyOn(Date, 'now');
    new FlightRecorder().adopt(row(), makeFrame());
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('keeps a start time of exactly the epoch rather than falling back to the clock', () => {
    dbMock.getFlightTrackPoints.mockReturnValue(track);
    const rec = new FlightRecorder();
    rec.adopt(row({ start_time: '1970-01-01T00:00:00.000Z' }), makeFrame());
    expect(rec.elapsedMs(123_456)).toBe(123_456);
  });

  it('lets a failed track read through before anything is seeded', () => {
    const { rec, id } = started(makeFrame({ altitudeFt: 1500 }));
    advance(5000);
    rec.writePoint(id, makeFrame());
    advance(5000);
    rec.writePoint(id, at(10, { altitudeFt: 9000 }));

    dbMock.getFlightTrackPoints.mockImplementationOnce(() => { throw boom; });
    expect(() => rec.adopt(row(), makeFrame())).toThrow(boom);

    const out = end(rec, id);
    expect(out.pointCount).toBe(2);
    expect(out.maxAltitudeFt).toBe(9000);
    expect(out.distanceNm).toBe(10);
  });
});

// A real FlightManager over the same mocks. Only the rules whose truth depends on how the
// coordinator calls the recorder are here; the recorder's own contract is above.
describe('FlightRecorder through the coordinator', () => {
  const savedInterval = process.env.POSITION_REPORT_INTERVAL_MIN;
  afterEach(() => {
    if (savedInterval === undefined) delete process.env.POSITION_REPORT_INTERVAL_MIN;
    else process.env.POSITION_REPORT_INTERVAL_MIN = savedInterval;
  });

  const takeoff = (fm: FlightManager, over: Partial<SimFrame> = {}): void => {
    for (let i = 0; i < 3; i++) fm.onFrame(makeFrame(over));
  };

  const closeArgs = () => {
    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    const c = dbMock.closeFlight.mock.calls[0];
    return {
      durationSec: c[4] as number, distanceNm: c[5] as number, maxAltitudeFt: c[6] as number,
      maxAirspeedKts: c[7] as number, pointCount: c[8] as number,
    };
  };

  describe('every way of interrupting a flight reaches the recorder', () => {
    it('a pause, even with no frame arriving while it lasts', () => {
      const fm = new FlightManager();
      takeoff(fm);                             // point 1 at t=0
      advance(5000);
      fm.onFrame(makeFrame());                 // point 2 at t=5000, 5 s counted
      fm.setPaused(true, 1);
      advance(4000);
      fm.onCrash();
      // 5 s counted; the 4 s tail is excluded by the pause.
      expect(closeArgs().durationSec).toBe(5);
    });

    it('a slew frame while flying', () => {
      const fm = new FlightManager();
      takeoff(fm);
      advance(5000);
      fm.onFrame(makeFrame());                 // point 2 at t=5000
      advance(1000);
      fm.onFrame(makeFrame({ simRunning: 3 }));
      advance(3000);
      fm.onCrash();                    // the slew frame interrupted the last 4 s
      expect(closeArgs().durationSec).toBe(5);
    });

    it('a resume, whose own point is the one that clears it', () => {
      dbMock.getOpenFlight.mockReturnValue(row({ start_time: iso(-120_000) }));
      dbMock.getFlightTrackPoints.mockReturnValue([stored(0, -120_000), stored(1, -115_000)]);
      dbMock.insertPoint.mockImplementationOnce(() => { throw boom; });
      const fm = new FlightManager();
      fm.onFrame(makeFrame());                 // adopts the flight; its point fails, so the mark stays
      advance(5000);
      fm.onFrame(makeFrame());                 // the next point: its 5 s gap follows the outage
      fm.onCrash();
      // The stored track counted 5 s; the gap after the failed point is not counted.
      expect(closeArgs().durationSec).toBe(5);
      expect(closeArgs().pointCount).toBe(3);
    });
  });

  it('a pause and resume before the takeoff do not leak into the flight: its tail still counts', () => {
    const fm = new FlightManager();
    fm.setPaused(true, 1);                     // marks an interruption while no flight exists
    fm.setPaused(false);
    dbMock.insertPoint.mockImplementationOnce(() => { throw boom; });
    fm.onFrame(makeFrame());
    fm.onFrame(makeFrame());
    expect(() => fm.onFrame(makeFrame())).toThrow(boom);   // the third frame starts the flight; its first point fails
    advance(3000);
    fm.onCrash();

    // No point was ever stored, so the only flight time is the 3 s tail, which counts because
    // starting the flight cleared the stale interruption.
    expect(closeArgs().pointCount).toBe(0);
    expect(closeArgs().durationSec).toBe(3);
  });

  it('a failed resume point does not stop the recording interval: the next point is still throttled', () => {
    dbMock.getOpenFlight.mockReturnValue(row({ start_time: iso(-60_000) }));
    dbMock.getFlightTrackPoints.mockReturnValue([stored(0, -60_000), stored(1, -55_000)]);
    dbMock.insertPoint.mockImplementationOnce(() => { throw boom; });
    const fm = new FlightManager();
    fm.onFrame(makeFrame());                   // adopts the flight; its point fails and the boot check swallows it
    expect(fm.appState.flightState).toBe('FLYING');
    expect(dbMock.insertPoint).toHaveBeenCalledTimes(1);

    advance(1000);
    fm.onFrame(makeFrame());
    // The interval is counted from the adoption. From the last stored point (55 s ago) or from
    // nothing it would already be due.
    expect(dbMock.insertPoint).toHaveBeenCalledTimes(1);

    advance(4000);
    fm.onFrame(makeFrame());
    expect(dbMock.insertPoint).toHaveBeenCalledTimes(2);
  });

  it('starts the flight clock after the ground close and the leg link, not at the insert', () => {
    // Both the ground-session close and the leg lookup take time on the faked clock.
    vi.mocked(groundSessionsModule.closeOpenGroundSession).mockImplementation(() => { advance(5000); return null; });
    dbMock.getActiveTripId.mockImplementation(() => { advance(10_000); return null; });
    const fm = new FlightManager();
    takeoff(fm);                               // the flight clock starts 15 s after the row was inserted
    advance(5000);
    fm.onFrame(makeFrame());
    fm.onCrash();
    // 5 s of wall clock since the clock started, 5 s counted: nothing excluded, no suffix.
    expect(logged()).toContain('[FlightManager] Flight #1 ended — 2 points, 0.0 nm, 5s');
  });

  it('fixes the end instant and the duration before the arrival lookup', () => {
    const fm = new FlightManager();
    takeoff(fm);
    advance(3000);
    airportsMock.findNearestAirport.mockImplementation(() => { advance(20_000); return null; });
    fm.onCrash();
    // The tail is the 3 s before the lookup; the 20 s the lookup took are not part of the flight.
    expect(dbMock.closeFlight.mock.calls[0][1]).toBe(iso(3000));
    expect(closeArgs().durationSec).toBe(3);
  });

  it('adds the distance and raises the maxima only once the point is stored, so a failed store counts neither', () => {
    const fm = new FlightManager();
    takeoff(fm);                               // point 1, at the takeoff fix
    advance(5000);
    dbMock.insertPoint.mockImplementationOnce(() => { throw boom; });
    expect(() => fm.onFrame(at(10, { altitudeFt: 9000, airspeedKnots: 250 }))).toThrow(boom);
    fm.onCrash();

    const c = closeArgs();
    expect(c.pointCount).toBe(1);
    expect(c.maxAltitudeFt).toBe(1500);
    expect(c.maxAirspeedKts).toBe(110);
    expect(c.distanceNm).toBe(0);
  });

  describe('the position report of a written point', () => {
    const report = () => {
      dbMock.getOpenFlight.mockReturnValue(row({ start_time: iso(-50_000) }));
      dbMock.getFlightTrackPoints.mockReturnValue([stored(0, -70_000), stored(1, -65_000)]);
      dbMock.getFlightPlannedLegId.mockReturnValue(11);
      dbMock.getPlannedLegById.mockReturnValue(makePlannedLegWithChildren({ id: 11 }));
      process.env.POSITION_REPORT_INTERVAL_MIN = '1';
      // Storing the point takes 30 s of the faked clock, so a clock read after the write would
      // see a different instant than the one the point was stamped with.
      dbMock.insertPoint.mockImplementation(() => { advance(30_000); });
    };

    it('is placed in the window of the point\'s own stamp, not of a later clock read', () => {
      report();
      new FlightManager().onFrame(at(0));
      // At the stamp the flight is 50 s old: window 0, nothing to file. A read after the write
      // would say 80 s and open window 1.
      expect(dbMock.insertPoint).toHaveBeenCalledTimes(1);
      expect(acarsEventsMock.fileAcarsMessageOnce).not.toHaveBeenCalled();
    });

    it('is stamped with the point\'s own timestamp', () => {
      report();
      dbMock.getOpenFlight.mockReturnValue(row({ start_time: iso(-70_000) }));
      new FlightManager().onFrame(at(0));
      // 70 s old at the stamp: window 1, filed with the stamp the point was stored under.
      expect(acarsEventsMock.fileAcarsMessageOnce).toHaveBeenCalledTimes(1);
      const msg = acarsEventsMock.fileAcarsMessageOnce.mock.calls[0][0];
      expect(msg.category).toBe('position-report');
      expect(msg.dedup_key).toBe('position-report:flight:77:1');
      expect(msg.sent_at).toBe(iso(0));
      expect(dbMock.insertPoint.mock.calls[0][1]).toBe(iso(0));
    });
  });
});

describe('FlightRecorder through the coordinator: the takeoff notify', () => {
  it('starts the flight clock before the takeoff notify, so time the listener takes is excluded wall clock', () => {
    const fm = new FlightManager();
    let first = true;
    // The first notify is the takeoff's; it takes 7 s of the faked clock.
    fm.setScopeChangeListener(() => { if (first) { first = false; advance(7000); } });
    for (let i = 0; i < 3; i++) fm.onFrame(makeFrame());   // takeoff; its first point is stored at 7 s
    advance(5000);
    fm.onFrame(makeFrame());                                 // point 2 at 12 s: 5 s counted
    fm.onCrash();
    // The flight clock started before the notify: 12 s of wall clock, 5 s counted, 7 s excluded.
    // Started after it, the clock would show 5 s and no suffix.
    expect(logged()).toContain('[FlightManager] Flight #1 ended — 2 points, 0.0 nm, 5s (7s interrupted, excluded)');
  });
});

// More drives of a real FlightManager, for the rules that only show when a call is slow, when
// a store fails, or when a frame reaches the recorder by a route the recorder's own tests do not take.
describe('FlightRecorder through the coordinator: rounding, failed stores, pauses and slow calls', () => {
  const takeoff = (fm: FlightManager, over: Partial<SimFrame> = {}): void => {
    for (let i = 0; i < 3; i++) fm.onFrame(makeFrame(over));
  };

  const closeArgs = () => {
    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    const c = dbMock.closeFlight.mock.calls[0];
    return {
      endTime: c[1] as string, durationSec: c[4] as number, distanceNm: c[5] as number, maxAltitudeFt: c[6] as number,
      maxAirspeedKts: c[7] as number, pointCount: c[8] as number,
    };
  };

  /** The instant the ACARS message filed under `label` was stamped with. */
  const filedAt = (label: string): string | undefined => {
    const call = acarsEventsMock.fileAcarsMessageOnce.mock.calls.find(c => c[1] === label);
    return (call?.[0] as { sent_at?: string } | undefined)?.sent_at;
  };

  describe('rounding', () => {
    it('rounds the counted time to the nearest second: 5.2 s is 5, not 6', () => {
      const fm = new FlightManager();
      takeoff(fm);
      advance(5200);
      fm.onFrame(makeFrame());                 // point 2 at 5.2 s: the whole gap counts; no tail
      fm.onCrash();
      expect(closeArgs().durationSec).toBe(5);
    });

    it.each([
      [65_400, 65],
      [65_500, 66],
    ])('rounds the wall-clock time that was not counted to the nearest second: %i ms is %i s', (gapMs, seconds) => {
      const fm = new FlightManager();
      takeoff(fm);
      advance(gapMs);                          // longer than a counted gap, so none of it is flight time
      fm.onFrame(makeFrame());
      fm.onCrash();
      expect(closeArgs().durationSec).toBe(0);
      expect(logged()).toContain(`[FlightManager] Flight #1 ended — 2 points, 0.0 nm, 0s (${seconds}s interrupted, excluded)`);
    });

    it('rounds the highest altitude and airspeed to the nearest whole number', () => {
      const fm = new FlightManager();
      takeoff(fm, { altitudeFt: 3000.6, airspeedKnots: 129.4 });
      fm.onCrash();
      // 3000.6 ft is 3001 (a floor would say 3000); 129.4 kt is 129 (a ceiling would say 130).
      expect(closeArgs().maxAltitudeFt).toBe(3001);
      expect(closeArgs().maxAirspeedKts).toBe(129);
    });
  });

  describe('a point that fails to store', () => {
    const failingFrame = (fm: FlightManager): void => {
      dbMock.insertPoint.mockImplementationOnce(() => { throw boom; });
      expect(() => fm.onFrame(makeFrame())).toThrow(boom);
    };

    // A point's gap, distance and maxima are folded in only once it is stored, and the recording
    // clock moves with them. A failed attempt leaves everything as it was, and the next point
    // measures from the last point that was stored, so each segment is counted once.
    it('does not count the gap of the failed attempt, and the next point measures from the last stored one', () => {
      const fm = new FlightManager();
      takeoff(fm);                             // point 1 at 0 s
      advance(5000);
      failingFrame(fm);                        // store fails: nothing counted
      advance(5000);
      fm.onFrame(makeFrame());                 // 10 s since the last stored point, counted once
      fm.onCrash();
      // The 10 s from the stored point to the next; no tail.
      expect(closeArgs().durationSec).toBe(10);
      expect(closeArgs().pointCount).toBe(2);
    });

    it('measures the tail of a flight that ends right after a failed point from the last stored one', () => {
      const fm = new FlightManager();
      takeoff(fm);
      advance(5000);
      failingFrame(fm);                        // store fails: nothing counted
      fm.onCrash();
      // Only the 5 s tail since the last stored point.
      expect(closeArgs().durationSec).toBe(5);
      expect(closeArgs().pointCount).toBe(1);
    });

    it('counts a stored segment once, however many attempts failed before it', () => {
      const fm = new FlightManager();
      takeoff(fm);                             // point 1 at KSBA, 0 s
      advance(5000);
      dbMock.insertPoint.mockImplementation(() => { throw boom; });
      for (let s = 5; s <= 9; s++) {
        expect(() => fm.onFrame(at(s / 10))).toThrow(boom);
        advance(1000);
      }
      dbMock.insertPoint.mockImplementation(() => undefined);
      fm.onFrame(at(1.0));                     // point 2 at 10 s
      fm.onCrash();
      expect(closeArgs().pointCount).toBe(2);
      expect(closeArgs().durationSec).toBe(10);
      expect(closeArgs().distanceNm).toBe(1);
      const startMs = Date.parse(dbMock.insertFlight.mock.calls[0][3] as string);
      expect(closeArgs().durationSec).toBeLessThanOrEqual((Date.parse(closeArgs().endTime) - startMs) / 1000);
    });

    it('tries the point again on the next frame: the failed store did not move the recording interval', () => {
      const fm = new FlightManager();
      takeoff(fm);
      advance(5000);
      failingFrame(fm);
      advance(1000);
      fm.onFrame(makeFrame());                 // 6 s since the last stored point: due
      // The takeoff point, the failed attempt and the retry.
      expect(dbMock.insertPoint).toHaveBeenCalledTimes(3);
    });
  });

  describe('the pause arm of the flying gate', () => {
    it('a paused frame interrupts a flight that was resumed while the sim was paused', () => {
      dbMock.getOpenFlight.mockReturnValue(row({ start_time: iso(-120_000) }));
      dbMock.getFlightTrackPoints.mockReturnValue([stored(0, -120_000), stored(1, -115_000)]);
      const fm = new FlightManager();
      fm.setPaused(true, 1);
      fm.onFrame(makeFrame());                 // adopts the flight and stores its point: a pause does not stop that
      advance(5000);
      fm.onFrame(makeFrame());                 // flying and paused: skipped, and the interruption marked again
      advance(3000);
      fm.onCrash();
      // 5 s from the stored track. The 8 s since the resume point are excluded, tail included.
      expect(closeArgs().durationSec).toBe(5);
    });

    it('a paused frame interrupts a flight that was started while the sim was paused', () => {
      const fm = new FlightManager();
      fm.setPaused(true, 1);
      takeoff(fm);                             // a pause does not stop the takeoff or its first point
      advance(5000);
      fm.onFrame(makeFrame());                 // flying and paused: skipped, and marked
      advance(3000);
      fm.onCrash();
      // Only the first point exists, so nothing was counted, and the 8 s since it are excluded.
      expect(closeArgs().durationSec).toBe(0);
    });

    it('unpausing does not interrupt the flight: only the start of a pause is marked', () => {
      const fm = new FlightManager();
      takeoff(fm);
      advance(5000);
      fm.setPaused(false);                     // no pause to end
      fm.onFrame(makeFrame());                 // point 2 at 5 s: counted
      fm.onCrash();
      expect(closeArgs().durationSec).toBe(5);
    });
  });

  describe('slow calls between the clock reads', () => {
    it('starts the flight clock before OUT and OFF are filed, so the time filing takes is excluded wall clock', () => {
      let filing = true;
      acarsEventsMock.fileAcarsMessageOnce.mockImplementation(() => { if (filing) advance(2000); return true; });
      const fm = new FlightManager();
      takeoff(fm);                             // OUT and OFF take 2 s each: the first point is stored at 4 s
      filing = false;
      advance(5000);
      fm.onFrame(makeFrame());                 // point 2 at 9 s: 5 s counted
      fm.onCrash();
      // The clock started at 0 s: 9 s of wall clock, 5 s counted, 4 s excluded.
      // Started after the filing, it would show 5 s and no suffix.
      expect(logged()).toContain('[FlightManager] Flight #1 ended — 2 points, 0.0 nm, 5s (4s interrupted, excluded)');
    });

    it('starts the flight clock before the takeoff notify, however long every notify takes', () => {
      const fm = new FlightManager();
      fm.setScopeChangeListener(() => advance(5000));
      takeoff(fm);                             // the takeoff notify takes 5 s: the first point is stored at 5 s
      advance(5000);
      fm.onFrame(makeFrame());                 // point 2 at 10 s: 5 s counted
      fm.onCrash();
      // The clock started at 0 s: 10 s of wall clock, 5 s counted, 5 s excluded.
      expect(logged()).toContain('[FlightManager] Flight #1 ended — 2 points, 0.0 nm, 5s (5s interrupted, excluded)');
    });

    it('stores the flight under the takeoff instant the OFF event carries, not one read after the departure lookup', () => {
      airportsMock.findNearestAirport.mockImplementation(() => { advance(20_000); return null; });
      const fm = new FlightManager();
      takeoff(fm);                             // the departure lookup takes 20 s
      expect(dbMock.insertFlight.mock.calls[0][3]).toBe(iso(0));
      expect(filedAt('Flight #1 OFF')).toBe(iso(0));
    });

    it('files ON and IN, and closes the flight, at the one end instant fixed before the arrival lookup', () => {
      const fm = new FlightManager();
      takeoff(fm);
      advance(3000);
      airportsMock.findNearestAirport.mockImplementation(() => { advance(20_000); return null; });
      acarsEventsMock.fileAcarsMessageOnce.mockClear();
      fm.onCrash();                    // the arrival lookup takes 20 s
      expect(closeArgs().endTime).toBe(iso(3000));
      expect(filedAt('Flight #1 ON')).toBe(iso(3000));
      expect(filedAt('Flight #1 IN')).toBe(iso(3000));
    });
  });
});

/**
 * Makes every Date.now() hand out the faked instant and then move the faked clock on by stepMs,
 * so two reads in a row see two different instants. `new Date()` with no argument sees the moved
 * clock. Only install it around the one call under test, and restore it with mockRestore().
 */
function stepEveryRead(stepMs: number) {
  let t = Date.now();
  return vi.spyOn(Date, 'now').mockImplementation(() => {
    const read = t;
    t += stepMs;
    vi.setSystemTime(t);
    return read;
  });
}

describe('FlightRecorder clock reads, one at a time', () => {
  it('startClock reads the recording-interval clock first and the flight clock second', () => {
    const rec = new FlightRecorder();
    rec.begin(makeFrame(), DEP, iso(0));
    const reads = stepEveryRead(1000);
    rec.startClock();                          // recording clock at 0 s, flight clock at 1 s
    reads.mockRestore();                       // the faked clock now stands at 2 s
    // The flight clock is 1 s behind the faked clock's first reading: 51 s is 50 s into the flight.
    expect(rec.elapsedMs(Date.parse(iso(51_000)))).toBe(50_000);
    advance(2999);                             // 4999 ms since the recording clock
    expect(rec.maybeRecord(1, makeFrame())).toBeNull();
    advance(1);                                // 5000 ms: due
    expect(rec.maybeRecord(1, makeFrame())).not.toBeNull();
  });

  it('adopt reads the fallback flight start before it restarts the recording interval', () => {
    dbMock.getFlightTrackPoints.mockReturnValue([stored(0, -120_000), stored(1, -115_000)]);
    const rec = new FlightRecorder();
    const reads = stepEveryRead(1000);
    rec.adopt(row({ start_time: 'not a date' }), makeFrame());   // fallback read at 0 s, recording clock at 1 s
    reads.mockRestore();                       // the faked clock now stands at 2 s
    expect(rec.elapsedMs(Date.parse(iso(10_000)))).toBe(10_000);
    advance(3000);                             // 5 s: 4 s since the recording clock
    expect(rec.maybeRecord(77, makeFrame())).toBeNull();
    advance(1000);                             // 6 s: 5 s since the recording clock
    expect(rec.maybeRecord(77, makeFrame())).not.toBeNull();
  });

  it('writePoint takes the gap, the stamp and the returned instant from a single read', () => {
    const { rec, id } = started();
    rec.writePoint(id, makeFrame());
    advance(5000);
    const reads = stepEveryRead(1000);
    const point = rec.writePoint(id, makeFrame());
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockRestore();
    // A second read, for any of the three, would be 1 s later.
    expect(point).toEqual({ flightId: id, nowMs: Date.parse(iso(5000)), ts: iso(5000) });
    expect(dbMock.insertPoint.mock.calls[1][1]).toBe(iso(5000));
  });

  it('stopClock takes the end instant before the tail and the wall-clock span', () => {
    const { rec, id } = started();
    rec.writePoint(id, makeFrame());           // a point at 0 s
    advance(2000);
    const reads = stepEveryRead(1000);
    const tally = rec.stopClock();             // end instant at 2 s, tail read at 2 s, span read at 3 s
    reads.mockRestore();
    expect(tally.endTime).toBe(iso(2000));
    // 2 s counted; 3 s of wall clock since the flight clock started, 1 s of it not counted.
    expect(tally.durationSec).toBe(2);
    expect(tally.excludedSec).toBe(1);
  });
});
