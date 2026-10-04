// tests/flightManager.restartclose.test.ts — the check the first running frame
// after a restart makes against a flight left open by the previous run.
//
// A frame that is the same aircraft, back within 10 min and within 5 nm plus
// the last ground speed's travel of the last stored point continues the
// flight (tests/flightManager.resume.test.ts covers that path). Any other
// frame closes the row at its last stored point, the way an expired hold
// closes a flight, and is then processed as the first frame of a fresh start.
//
// Hermetic like its siblings: './db', './airports', './acarsEvents' and
// './db/groundSessions' are replaced, so no database file is opened.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CreateGroundSession, GroundSession, SimFrame } from '../src/types';
import type { OpenFlightRow, FlightTrackPoint, LastFlightPoint } from '../src/db';
import type { CreateAcarsMessage } from '../src/types';
import {
  dbMock, acarsEventsMock, resetMocks, makeFrame, makePlannedLegWithChildren,
  northOfNm, KSBA, T0, useFakeClock, useRealClock,
} from './helpers';

vi.mock('../src/db', async () => (await import('./helpers')).dbMock);
vi.mock('../src/airports', async () => (await import('./helpers')).airportsMock);
vi.mock('../src/acarsEvents', async () => (await import('./helpers')).acarsEventsMock);
vi.mock('../src/db/groundSessions', () => ({
  insertGroundSession: vi.fn(),
  getOpenGroundSession: vi.fn(),
  closeOpenGroundSession: vi.fn(),
  fillOpenGroundSessionGaps: vi.fn(),
}));

import { FlightManager } from '../src/flightManager';
import { GROUND_DEBOUNCE_FRAMES } from '../src/groundState';
import * as groundSessionsModule from '../src/db/groundSessions';

const insertGroundSession = vi.mocked(groundSessionsModule.insertGroundSession);
const getOpenGroundSession = vi.mocked(groundSessionsModule.getOpenGroundSession);

const BOOT_CHECK = '[FlightManager] Open-flight check failed; starting fresh if a takeoff follows:';

const advance = (ms: number) => vi.advanceTimersByTime(ms);
const iso = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

/** Four points 1 nm apart due north of KSBA, 5 s apart, the newest `endMs` from T0. */
function track(endMs = -105_000): FlightTrackPoint[] {
  return [0, 1, 2, 3].map(i => {
    const p = northOfNm(KSBA, i);
    return { lat: p.lat, lon: p.lon, altitude_ft: 3000 + 500 * i, airspeed_kts: 120 + i, ts: iso(endMs - 15_000 + 5000 * i) };
  });
}

/** The newest point of track(endMs), with the columns the restart check also reads. */
function lastOf(endMs = -105_000, over: Partial<LastFlightPoint> = {}): LastFlightPoint {
  const p = track(endMs)[3];
  return {
    ...p, ground_speed_kts: 0, heading_deg: 0, vertical_speed_fpm: 0, on_ground: 0, after_interruption: undefined, ...over,
  } as LastFlightPoint;
}

function row(over: Partial<OpenFlightRow> = {}): OpenFlightRow {
  return { id: 77, aircraft: 'Cessna 172', start_time: iso(-120_000), departure_lat: KSBA.lat, departure_lon: KSBA.lon, ...over };
}

/** Scripts the open row with track(endMs) and its newest point. */
function openFlight(endMs = -105_000, rowOver: Partial<OpenFlightRow> = {}, lastOver: Partial<LastFlightPoint> = {}): void {
  dbMock.getOpenFlight.mockImplementation(() => row({ start_time: iso(endMs - 15_000), ...rowOver }));
  dbMock.getFlightTrackPoints.mockImplementation(() => track(endMs));
  dbMock.getLastFlightPoint.mockImplementation(() => lastOf(endMs, lastOver));
}

const LAST_POS = northOfNm(KSBA, 3);
const logLines = (): string[] => vi.mocked(console.log).mock.calls.map(c => String(c[0]));
const filed = (): CreateAcarsMessage[] => acarsEventsMock.fileAcarsMessageOnce.mock.calls.map(([m]) => m as CreateAcarsMessage);
const airborne = (over: Partial<SimFrame> = {}) => makeFrame({ ...LAST_POS, ...over });

beforeEach(() => {
  resetMocks();
  useFakeClock();
  insertGroundSession.mockReset();
  getOpenGroundSession.mockReset().mockReturnValue(null);
});
afterEach(() => useRealClock());

describe('a restart whose first frame is another aircraft', () => {
  beforeEach(() => {
    openFlight();
    dbMock.getFlightPlannedLegId.mockImplementation(() => 11);
    dbMock.getPlannedLegById.mockImplementation(() => makePlannedLegWithChildren());
  });

  it('closes the row at its last stored point with the stored track totals', () => {
    const fm = new FlightManager();
    fm.onFrame(airborne({ aircraft: 'A320' }));

    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    // End time and arrival are the last stored point's; 4 points, 3.0 nm and
    // 3 gaps of 5 s are the stored track's, with nothing added for the outage.
    expect(dbMock.closeFlight.mock.calls[0]).toEqual([
      77, iso(-105_000), LAST_POS.lat, LAST_POS.lon, 15, 3.0, 4500, 123, 4, null, null,
    ]);
    expect(dbMock.insertPoint).not.toHaveBeenCalled();
    expect(fm.appState.flightState).toBe('IDLE');
    expect(fm.appState.currentFlightId).toBeNull();
  });

  it('files ON and IN at the last stored point time with the leg refs, and records the leg arrival', () => {
    const fm = new FlightManager();
    fm.onFrame(airborne({ aircraft: 'A320' }));

    const msgs = filed();
    expect(msgs.map(m => m.label)).toEqual(['ON', 'IN']);
    for (const m of msgs) {
      expect(m.flight_id).toBe(77);
      expect(m.sent_at).toBe(iso(-105_000));
      expect(m.body).toContain('ACFT Cessna 172 DEST KMRY');
      expect(JSON.parse(m.payload_json as string).planned_leg_id).toBe(11);
    }
    expect(JSON.parse(msgs[0].payload_json as string).estimated).toBe(true);
    expect(dbMock.recordPlannedLegArrival).toHaveBeenCalledTimes(1);
    expect(dbMock.recordPlannedLegArrival.mock.calls[0][0]).toBe(11);
    expect(dbMock.recordPlannedLegArrival.mock.calls[0][1]).toBe('diverted');
    expect(dbMock.linkFlightToPlannedLeg).not.toHaveBeenCalled();
  });

  it('logs one line naming the reason before the close', () => {
    const fm = new FlightManager();
    fm.onFrame(airborne({ aircraft: 'A320' }));

    const lines = logLines();
    const at = lines.indexOf(
      '[FlightManager] Flight #77 not resumed after restart — aircraft changed (Cessna 172 -> A320); closing at the last stored point',
    );
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines.findIndex(l => l.startsWith('[FlightManager] Flight #77 ended'))).toBeGreaterThan(at);
    expect(lines.some(l => l.includes('Flight #77 resumed after restart'))).toBe(false);
  });

  it('counts an airborne first frame toward a new takeoff: two more frames start a flight', () => {
    const fm = new FlightManager();
    fm.onFrame(airborne({ aircraft: 'A320' }));
    advance(1000); fm.onFrame(airborne({ aircraft: 'A320' }));
    expect(dbMock.insertFlight).not.toHaveBeenCalled();
    advance(1000); fm.onFrame(airborne({ aircraft: 'A320' }));

    expect(dbMock.insertFlight).toHaveBeenCalledTimes(1);
    expect(dbMock.insertFlight.mock.calls[0][0]).toBe('A320');
    expect(fm.appState.flightState).toBe('FLYING');
    expect(fm.appState.currentFlightId).toBe(1);
    expect(dbMock.getOpenFlight).toHaveBeenCalledTimes(1);
    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
  });

  it('treats an on-ground first frame exactly like a fresh IDLE frame', () => {
    const parked: Partial<SimFrame> = {
      ...KSBA, aircraft: 'A320', onGround: true, groundSpeedKnots: 0, airspeedKnots: 0,
      enginesRunning: 0, engineCount: 2, parkingBrake: false,
    };
    insertGroundSession.mockImplementation((input: CreateGroundSession) => {
      const session = { id: 100, ...input, started_at: new Date().toISOString(), ended_at: null } as unknown as GroundSession;
      getOpenGroundSession.mockReturnValue(session);
      return session;
    });

    const run = (fm: FlightManager): string[] => {
      const states: string[] = [];
      for (let i = 0; i < GROUND_DEBOUNCE_FRAMES; i++) {
        if (i > 0) advance(1000);
        fm.onFrame(makeFrame(parked));
        states.push(fm.appState.flightState);
      }
      return states;
    };

    const closed = run(new FlightManager());
    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    const closedInserts = insertGroundSession.mock.calls.length;

    dbMock.getOpenFlight.mockImplementation(() => null);
    insertGroundSession.mockClear();
    getOpenGroundSession.mockReturnValue(null);
    const fresh = run(new FlightManager());

    // GROUND on the fifth frame in both: the first frame after the close
    // counted toward the parked debounce.
    expect(fresh[GROUND_DEBOUNCE_FRAMES - 1]).toBe('GROUND');
    expect(closed).toEqual(fresh);
    expect(closedInserts).toBe(1);
    expect(insertGroundSession).toHaveBeenCalledTimes(1);
  });
});

describe('a last stored point stamped after now', () => {
  it('closes with the stored track duration alone, adding no tail', () => {
    // The host clock was set back: the newest point is 30 s ahead of now.
    openFlight(+30_000);
    const fm = new FlightManager();
    fm.onFrame(airborne({ aircraft: 'A320' }));

    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    expect(dbMock.closeFlight.mock.calls[0][1]).toBe(iso(30_000));
    expect(dbMock.closeFlight.mock.calls[0][4]).toBe(15);
  });
});

describe('the 10-minute limit', () => {
  it('resumes a frame exactly 10 min after the last stored point', () => {
    openFlight(-600_000);
    const fm = new FlightManager();
    fm.onFrame(airborne());

    expect(dbMock.closeFlight).not.toHaveBeenCalled();
    expect(fm.appState.currentFlightId).toBe(77);
    expect(dbMock.insertPoint.mock.calls[0][0]).toBe(77);
  });

  it('closes a frame 1 ms later, naming the time', () => {
    openFlight(-600_001);
    const fm = new FlightManager();
    fm.onFrame(airborne());

    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    expect(dbMock.closeFlight.mock.calls[0][1]).toBe(iso(-600_001));
    expect(logLines()).toContain(
      '[FlightManager] Flight #77 not resumed after restart — 10.0 min since the last point (limit 10 min); closing at the last stored point',
    );
    expect(fm.appState.flightState).toBe('IDLE');
  });
});

describe('the distance allowance', () => {
  it('allows 5 nm plus the last ground speed over the outage, and closes beyond it', () => {
    // 105 s at 120 kt = 3.5 nm, so 8.5 nm from the last point is the limit.
    openFlight(-105_000, {}, { ground_speed_kts: 120 });
    const fm = new FlightManager();
    fm.onFrame(makeFrame({ ...northOfNm(KSBA, 3 + 8.5) }));
    expect(dbMock.closeFlight).not.toHaveBeenCalled();
    expect(fm.appState.currentFlightId).toBe(77);
  });

  it('closes a frame too far away at the last stored point, without its distance', () => {
    openFlight(-105_000, {}, { ground_speed_kts: 120 });
    const fm = new FlightManager();
    fm.onFrame(makeFrame({ ...northOfNm(KSBA, 3 + 8.6) }));

    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    const c = dbMock.closeFlight.mock.calls[0];
    expect(c[2]).toBe(LAST_POS.lat);
    expect(c[3]).toBe(LAST_POS.lon);
    expect(c[5]).toBe(3.0);
    expect(logLines()).toContain(
      '[FlightManager] Flight #77 not resumed after restart — 8.6 nm from the last point; closing at the last stored point',
    );
  });
});

describe('a flight with no stored points', () => {
  it('is measured from its departure at its start time, and closed there with zero totals', () => {
    dbMock.getOpenFlight.mockImplementation(() => row({ start_time: iso(-11 * 60_000) }));
    // getFlightTrackPoints and getLastFlightPoint keep their defaults: no points.
    const fm = new FlightManager();
    fm.onFrame(makeFrame({ ...KSBA }));

    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    expect(dbMock.closeFlight.mock.calls[0]).toEqual([
      77, iso(-11 * 60_000), KSBA.lat, KSBA.lon, 0, 0, 0, 0, 0, null, null,
    ]);
    expect(logLines()).toContain(
      '[FlightManager] Flight #77 not resumed after restart — 11.0 min since the last point (limit 10 min); closing at the last stored point',
    );
  });

  it('and no departure coordinates is adopted without a check', () => {
    dbMock.getOpenFlight.mockImplementation(() =>
      row({ start_time: iso(-60 * 60_000), departure_lat: null, departure_lon: null, aircraft: 'A320' }));
    const fm = new FlightManager();
    fm.onFrame(makeFrame({ ...northOfNm(KSBA, 100) }));

    expect(dbMock.closeFlight).not.toHaveBeenCalled();
    expect(fm.appState.currentFlightId).toBe(77);
  });
});

describe('a row with no aircraft', () => {
  it('skips the aircraft comparison and resumes a nearby frame', () => {
    openFlight(-105_000, { aircraft: null });
    const fm = new FlightManager();
    fm.onFrame(airborne({ aircraft: 'A320' }));

    expect(dbMock.closeFlight).not.toHaveBeenCalled();
    expect(fm.appState.currentFlightId).toBe(77);
  });

  it('still closes a frame too far away', () => {
    openFlight(-105_000, { aircraft: null });
    const fm = new FlightManager();
    fm.onFrame(makeFrame({ ...northOfNm(KSBA, 3 + 5.1), aircraft: 'A320' }));

    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    expect(logLines()).toContain(
      '[FlightManager] Flight #77 not resumed after restart — 5.1 nm from the last point; closing at the last stored point',
    );
  });
});

describe('failures', () => {
  it('a close that throws leaves the row open, the manager IDLE, and the frame counted toward a takeoff', () => {
    openFlight();
    dbMock.getFlightPlannedLegId.mockImplementation(() => 11);
    dbMock.getPlannedLegById.mockImplementation(() => makePlannedLegWithChildren());
    const boom = new Error('close write failed');
    dbMock.closeFlight.mockImplementation(() => { throw boom; });

    const fm = new FlightManager();
    fm.onFrame(airborne({ aircraft: 'A320' }));

    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls).toEqual([[BOOT_CHECK, boom]]);
    expect(fm.appState.flightState).toBe('IDLE');
    expect(fm.appState.currentFlightId).toBeNull();
    expect(fm.getPlannedLegStatus(KSBA.lat, KSBA.lon)).toBeNull();
    expect(acarsEventsMock.fileAcarsMessageOnce).not.toHaveBeenCalled();

    advance(1000); fm.onFrame(airborne({ aircraft: 'A320' }));
    advance(1000); fm.onFrame(airborne({ aircraft: 'A320' }));
    expect(dbMock.insertFlight).toHaveBeenCalledTimes(1);
    expect(fm.appState.currentFlightId).toBe(1);
    expect(dbMock.insertPoint.mock.calls.every(c => c[0] === 1)).toBe(true);
    expect(dbMock.getOpenFlight).toHaveBeenCalledTimes(1);
  });

  it('a last-point read that throws is warned once and the server carries on fresh', () => {
    openFlight();
    const boom = new Error('point read failed');
    dbMock.getLastFlightPoint.mockImplementation(() => { throw boom; });

    const fm = new FlightManager();
    fm.onFrame(airborne());
    advance(1000); fm.onFrame(airborne());
    advance(1000); fm.onFrame(airborne());

    expect(vi.mocked(console.warn).mock.calls).toEqual([[BOOT_CHECK, boom]]);
    expect(dbMock.closeFlight).not.toHaveBeenCalled();
    expect(dbMock.insertFlight).toHaveBeenCalledTimes(1);
    expect(dbMock.getLastFlightPoint).toHaveBeenCalledTimes(1);
  });
});
