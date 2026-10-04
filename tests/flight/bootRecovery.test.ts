// tests/flight/bootRecovery.test.ts — tests src/flight/bootRecovery.ts.
//
// The database barrel is replaced, so the open-flight lookup and the last
// stored point are ours to script. One try/catch covers the lookup, the
// restart check and the caller's resume or close together; what the
// callbacks do with the row belongs to the coordinator and is pinned by its
// own tests. The last block drives a real FlightManager (with the rest of its
// boundaries replaced) for the one rule the function cannot hold itself: the
// once-per-process flag is set before the lookup is made.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LastFlightPoint } from '../../src/db';
import { dbMock, resetMocks, makeFrame, northOfNm, KSBA, T0, useFakeClock, useRealClock } from '../helpers';

vi.mock('../../src/db', async () => (await import('../helpers')).dbMock);
vi.mock('../../src/airports', async () => (await import('../helpers')).airportsMock);
vi.mock('../../src/acarsEvents', async () => (await import('../helpers')).acarsEventsMock);
vi.mock('../../src/db/groundSessions', () => ({
  insertGroundSession: vi.fn(),
  getOpenGroundSession: vi.fn(),
  closeOpenGroundSession: vi.fn(),
  fillOpenGroundSessionGaps: vi.fn(),
}));

import { FlightManager } from '../../src/flightManager';
import { tryResumeOpenFlight, storedLastPoint, restartMismatch } from '../../src/flight/bootRecovery';
import type { OpenFlightRow, StoredLastPoint } from '../../src/flight/bootRecovery';

const WARN = '[FlightManager] Open-flight check failed; starting fresh if a takeoff follows:';

const ROW: OpenFlightRow = {
  id: 77,
  aircraft: 'Cessna 172',
  start_time: '2026-09-09T11:00:00.000Z',
  departure_lat: 34.426201,
  departure_lon: -119.841507,
};

const T0_MS = Date.parse(T0);
const iso = (ms: number) => new Date(T0_MS + ms).toISOString();

/** A stored point at KSBA a minute before T0: the frames below at KSBA continue it. */
function lastPoint(over: Partial<LastFlightPoint> = {}): LastFlightPoint {
  return {
    ts: iso(-60_000), lat: KSBA.lat, lon: KSBA.lon, altitude_ft: 4500, airspeed_kts: 115,
    ground_speed_kts: 0, heading_deg: 90, vertical_speed_fpm: -200, on_ground: 0, ...over,
  };
}

/** The first running frame after the restart: the row's aircraft, at KSBA. */
const NEXT = makeFrame({ ...KSBA });

const warned = (): unknown[][] => vi.mocked(console.warn).mock.calls;

beforeEach(() => {
  resetMocks();
  useFakeClock();
  dbMock.getLastFlightPoint.mockReturnValue(lastPoint());
});
afterEach(() => useRealClock());

describe('tryResumeOpenFlight', () => {
  it('hands the open row to the callback, once, and returns true', () => {
    dbMock.getOpenFlight.mockReturnValue(ROW);
    const resume = vi.fn();

    expect(tryResumeOpenFlight(NEXT, resume, vi.fn())).toBe(true);
    expect(dbMock.getOpenFlight).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]).toHaveLength(1);
    expect(resume.mock.calls[0][0]).toBe(ROW);
    expect(warned()).toEqual([]);
  });

  it('returns false and never calls the callback when there is no open row', () => {
    dbMock.getOpenFlight.mockReturnValue(null);
    const resume = vi.fn();

    expect(tryResumeOpenFlight(NEXT, resume, vi.fn())).toBe(false);
    expect(dbMock.getOpenFlight).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    expect(warned()).toEqual([]);
  });

  it('swallows a failing lookup: one warning with the lookup error, false, and no callback', () => {
    const boom = new Error('database is locked');
    dbMock.getOpenFlight.mockImplementation(() => { throw boom; });
    const resume = vi.fn();

    expect(tryResumeOpenFlight(NEXT, resume, vi.fn())).toBe(false);
    expect(resume).not.toHaveBeenCalled();
    expect(warned()).toHaveLength(1);
    expect(warned()[0]).toHaveLength(2);
    expect(warned()[0][0]).toBe(WARN);
    expect(warned()[0][1]).toBe(boom);
  });

  it('swallows a failing resume with the same warning: the boundary spans the callback', () => {
    const boom = new Error('track read failed');
    dbMock.getOpenFlight.mockReturnValue(ROW);
    const resume = vi.fn(() => { throw boom; });

    expect(tryResumeOpenFlight(NEXT, resume, vi.fn())).toBe(false);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith(ROW);
    expect(warned()).toHaveLength(1);
    expect(warned()[0]).toHaveLength(2);
    expect(warned()[0][0]).toBe(WARN);
    expect(warned()[0][1]).toBe(boom);
  });

  it('treats a thrown non-Error the same way', () => {
    dbMock.getOpenFlight.mockReturnValue(ROW);

    expect(tryResumeOpenFlight(NEXT, () => { throw 'plain string'; }, vi.fn())).toBe(false);
    expect(warned()).toEqual([[WARN, 'plain string']]);
  });

  it('keeps no state between calls: every call queries again', () => {
    dbMock.getOpenFlight.mockReturnValue(null);
    tryResumeOpenFlight(NEXT, vi.fn(), vi.fn());
    dbMock.getOpenFlight.mockReturnValue(ROW);
    const resume = vi.fn();

    expect(tryResumeOpenFlight(NEXT, resume, vi.fn())).toBe(true);
    expect(dbMock.getOpenFlight).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('logs nothing of its own on success', () => {
    dbMock.getOpenFlight.mockReturnValue(ROW);
    tryResumeOpenFlight(NEXT, vi.fn(), vi.fn());

    expect(vi.mocked(console.log).mock.calls).toEqual([]);
  });
});

describe('tryResumeOpenFlight — the restart check', () => {
  it('hands a failing row to close with its last stored point and the reason, and returns false', () => {
    dbMock.getOpenFlight.mockReturnValue(ROW);
    const resume = vi.fn();
    const close = vi.fn();
    const next = makeFrame({ ...KSBA, aircraft: 'A320' });

    expect(tryResumeOpenFlight(next, resume, close)).toBe(false);
    expect(resume).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    const [row, last, reason] = close.mock.calls[0] as [OpenFlightRow, StoredLastPoint, string];
    expect(row).toBe(ROW);
    expect(last.atMs).toBe(T0_MS - 60_000);
    expect(last.frame).toMatchObject({ lat: KSBA.lat, lon: KSBA.lon, aircraft: 'Cessna 172' });
    expect(reason).toBe('aircraft changed (Cessna 172 -> A320)');
    expect(dbMock.getLastFlightPoint).toHaveBeenCalledWith(77);
    expect(warned()).toEqual([]);
  });

  it('swallows a failing close with the same warning', () => {
    const boom = new Error('close failed');
    dbMock.getOpenFlight.mockReturnValue(ROW);
    const close = vi.fn(() => { throw boom; });

    expect(tryResumeOpenFlight(makeFrame({ ...KSBA, aircraft: 'A320' }), vi.fn(), close)).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(warned()).toEqual([[WARN, boom]]);
  });

  it('swallows a failing last-point read with the same warning, and calls neither callback', () => {
    const boom = new Error('point read failed');
    dbMock.getOpenFlight.mockReturnValue(ROW);
    dbMock.getLastFlightPoint.mockImplementation(() => { throw boom; });
    const resume = vi.fn();
    const close = vi.fn();

    expect(tryResumeOpenFlight(NEXT, resume, close)).toBe(false);
    expect(resume).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(warned()).toEqual([[WARN, boom]]);
  });

  it('resumes as before a row with no points and no departure coordinates, whatever the frame', () => {
    dbMock.getOpenFlight.mockReturnValue({ ...ROW, departure_lat: null, departure_lon: null });
    dbMock.getLastFlightPoint.mockReturnValue(null);
    const resume = vi.fn();
    const close = vi.fn();

    expect(tryResumeOpenFlight(makeFrame({ ...northOfNm(KSBA, 200), aircraft: 'A320' }), resume, close)).toBe(true);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it('measures a row with no points from its departure at its start time', () => {
    dbMock.getOpenFlight.mockReturnValue(ROW); // started an hour before T0
    dbMock.getLastFlightPoint.mockReturnValue(null);
    const close = vi.fn();

    expect(tryResumeOpenFlight(NEXT, vi.fn(), close)).toBe(false);
    expect(close.mock.calls[0][1]).toEqual({
      atMs: Date.parse(ROW.start_time),
      frame: {
        lat: KSBA.lat, lon: KSBA.lon, altitudeFt: 0, airspeedKnots: 0, groundSpeedKnots: 0,
        headingDeg: 0, verticalSpeedFpm: 0, onGround: true, simRunning: 1, aircraft: 'Cessna 172',
      },
    });
    expect(close.mock.calls[0][2]).toBe('60.0 min since the last point (limit 10 min)');
  });
});

describe('storedLastPoint', () => {
  it('rebuilds a frame from every stored column and the row aircraft', () => {
    expect(storedLastPoint(ROW, lastPoint({ on_ground: 1 }))).toEqual({
      atMs: T0_MS - 60_000,
      frame: {
        lat: KSBA.lat, lon: KSBA.lon, altitudeFt: 4500, airspeedKnots: 115, groundSpeedKnots: 0,
        headingDeg: 90, verticalSpeedFpm: -200, onGround: true, simRunning: 1, aircraft: 'Cessna 172',
      },
    });
    expect(storedLastPoint(ROW, lastPoint({ on_ground: 0 }))?.frame.onGround).toBe(false);
  });

  it('carries an empty aircraft string for a row with no aircraft', () => {
    expect(storedLastPoint({ ...ROW, aircraft: null }, lastPoint())?.frame.aircraft).toBe('');
  });

  it('is null for a point whose time does not parse, and for no points with a start time that does not parse', () => {
    expect(storedLastPoint(ROW, lastPoint({ ts: 'not a date' }))).toBeNull();
    expect(storedLastPoint({ ...ROW, start_time: 'not a date' }, null)).toBeNull();
  });

  it('is null for no points and either departure coordinate missing', () => {
    expect(storedLastPoint({ ...ROW, departure_lat: null }, null)).toBeNull();
    expect(storedLastPoint({ ...ROW, departure_lon: null }, null)).toBeNull();
  });
});

describe('restartMismatch', () => {
  const at = (over: Partial<LastFlightPoint> = {}): StoredLastPoint => storedLastPoint(ROW, lastPoint(over)) as StoredLastPoint;
  const now = T0_MS;

  it('is null for the same aircraft, in time and in range', () => {
    expect(restartMismatch(ROW, at(), NEXT, now)).toBeNull();
  });

  it('names a changed aircraft first, even when time and distance also fail', () => {
    const next = makeFrame({ ...northOfNm(KSBA, 50), aircraft: 'A320' });
    expect(restartMismatch(ROW, at({ ts: iso(-3_600_000) }), next, now)).toBe('aircraft changed (Cessna 172 -> A320)');
  });

  it('skips the aircraft comparison for a row with no aircraft; time and distance still apply', () => {
    const row = { ...ROW, aircraft: null };
    const last = storedLastPoint(row, lastPoint()) as StoredLastPoint;
    expect(restartMismatch(row, last, makeFrame({ ...KSBA, aircraft: 'A320' }), now)).toBeNull();
    expect(restartMismatch(row, last, makeFrame({ ...northOfNm(KSBA, 5.1), aircraft: 'A320' }), now))
      .toBe('5.1 nm from the last point');
    const old = storedLastPoint(row, lastPoint({ ts: iso(-600_001) })) as StoredLastPoint;
    expect(restartMismatch(row, old, makeFrame({ ...KSBA, aircraft: 'A320' }), now))
      .toBe('10.0 min since the last point (limit 10 min)');
  });

  it('allows exactly 10 min since the last point and rejects 1 ms more', () => {
    expect(restartMismatch(ROW, at({ ts: iso(-600_000) }), NEXT, now)).toBeNull();
    expect(restartMismatch(ROW, at({ ts: iso(-600_001) }), NEXT, now)).toBe('10.0 min since the last point (limit 10 min)');
  });

  it('allows 5 nm plus the last ground speed over the outage, as if the sim was not paused', () => {
    // 120 kt for 5 min = 10 nm, so the allowance is 15 nm.
    const last = at({ ts: iso(-300_000), ground_speed_kts: 120 });
    expect(restartMismatch(ROW, last, makeFrame({ ...northOfNm(KSBA, 15) }), now)).toBeNull();
    expect(restartMismatch(ROW, last, makeFrame({ ...northOfNm(KSBA, 15.1) }), now)).toBe('15.1 nm from the last point');
    // Stopped: the base 5 nm only.
    expect(restartMismatch(ROW, at(), makeFrame({ ...northOfNm(KSBA, 5) }), now)).toBeNull();
    expect(restartMismatch(ROW, at(), makeFrame({ ...northOfNm(KSBA, 5.1) }), now)).toBe('5.1 nm from the last point');
  });

  it('counts a last point stamped after now as no time at all', () => {
    const last = at({ ts: iso(+3_600_000), ground_speed_kts: 600 });
    expect(restartMismatch(ROW, last, NEXT, now)).toBeNull();
    expect(restartMismatch(ROW, last, makeFrame({ ...northOfNm(KSBA, 5.1) }), now)).toBe('5.1 nm from the last point');
  });
});

describe('the once-per-process flag, through the coordinator', () => {
  it('is set before the lookup: a frame arriving while the lookup is still running does not start a second one', () => {
    const fm = new FlightManager();
    const parked = makeFrame({ onGround: true, groundSpeedKnots: 0, airspeedKnots: 0 });
    dbMock.getOpenFlight.mockImplementationOnce(() => {
      fm.onFrame(parked);
      return null;
    });

    fm.onFrame(parked);
    expect(dbMock.getOpenFlight).toHaveBeenCalledTimes(1);
  });
});
