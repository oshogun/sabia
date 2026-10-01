// tests/flight/bootRecovery.test.ts — tests src/flight/bootRecovery.ts.
//
// The database barrel is replaced, so the open-flight lookup is ours to script.
// One try/catch covers the lookup and the caller's resume together; what the
// callback does with the row belongs to the coordinator and is pinned by its
// own tests. The last block drives a real FlightManager (with the rest of its
// boundaries replaced) for the one rule the function cannot hold itself: the
// once-per-process flag is set before the lookup is made.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock, resetMocks, makeFrame } from '../helpers';

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
import { tryResumeOpenFlight } from '../../src/flight/bootRecovery';
import type { OpenFlightRow } from '../../src/flight/bootRecovery';

const WARN = '[FlightManager] Open-flight check failed; starting fresh if a takeoff follows:';

const ROW: OpenFlightRow = {
  id: 77,
  aircraft: 'Cessna 172',
  start_time: '2026-09-09T11:00:00.000Z',
  departure_lat: 34.426201,
  departure_lon: -119.841507,
};

const warned = (): unknown[][] => vi.mocked(console.warn).mock.calls;

beforeEach(() => {
  resetMocks();
});

describe('tryResumeOpenFlight', () => {
  it('hands the open row to the callback, once, and returns true', () => {
    dbMock.getOpenFlight.mockReturnValue(ROW);
    const resume = vi.fn();

    expect(tryResumeOpenFlight(resume)).toBe(true);
    expect(dbMock.getOpenFlight).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]).toHaveLength(1);
    expect(resume.mock.calls[0][0]).toBe(ROW);
    expect(warned()).toEqual([]);
  });

  it('returns false and never calls the callback when there is no open row', () => {
    dbMock.getOpenFlight.mockReturnValue(null);
    const resume = vi.fn();

    expect(tryResumeOpenFlight(resume)).toBe(false);
    expect(dbMock.getOpenFlight).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    expect(warned()).toEqual([]);
  });

  it('swallows a failing lookup: one warning with the lookup error, false, and no callback', () => {
    const boom = new Error('database is locked');
    dbMock.getOpenFlight.mockImplementation(() => { throw boom; });
    const resume = vi.fn();

    expect(tryResumeOpenFlight(resume)).toBe(false);
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

    expect(tryResumeOpenFlight(resume)).toBe(false);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith(ROW);
    expect(warned()).toHaveLength(1);
    expect(warned()[0]).toHaveLength(2);
    expect(warned()[0][0]).toBe(WARN);
    expect(warned()[0][1]).toBe(boom);
  });

  it('treats a thrown non-Error the same way', () => {
    dbMock.getOpenFlight.mockReturnValue(ROW);

    expect(tryResumeOpenFlight(() => { throw 'plain string'; })).toBe(false);
    expect(warned()).toEqual([[WARN, 'plain string']]);
  });

  it('keeps no state between calls: every call queries again', () => {
    dbMock.getOpenFlight.mockReturnValue(null);
    tryResumeOpenFlight(vi.fn());
    dbMock.getOpenFlight.mockReturnValue(ROW);
    const resume = vi.fn();

    expect(tryResumeOpenFlight(resume)).toBe(true);
    expect(dbMock.getOpenFlight).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('logs nothing of its own on success', () => {
    dbMock.getOpenFlight.mockReturnValue(ROW);
    tryResumeOpenFlight(vi.fn());

    expect(vi.mocked(console.log).mock.calls).toEqual([]);
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
