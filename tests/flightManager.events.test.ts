// tests/flightManager.events.test.ts — the scope-change seam added on top of
// the state machine covered by tests/flightManager.state.test.ts and
// tests/flightManager.ground.test.ts: setScopeChangeListener()/
// notifyScopeChange() at every listed call site, and getFlightStatePayload()'s
// resolution of the effective planned leg.
//
// Hermetic like its siblings: './db', './airports', './acarsEvents' and
// './db/groundSessions' are all replaced wholesale, so no native binding and
// no database file is ever opened. A FlightManager with no listener attached
// is exactly what tests/flightManager.*.test.ts already exercise — this file
// only adds coverage for the attached-listener and getFlightStatePayload()
// seams, and never edits an existing case in a sibling file.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CreateGroundSession, GroundSession, SimFrame } from '../src/types';
import type { OpenFlightRow } from '../src/db';
import {
  dbMock, airportsMock, resetMocks, makeFrame, makeCandidate, makePlannedLegWithChildren,
  KSBA, T0, useFakeClock, useRealClock,
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
const closeOpenGroundSession = vi.mocked(groundSessionsModule.closeOpenGroundSession);
const fillOpenGroundSessionGaps = vi.mocked(groundSessionsModule.fillOpenGroundSessionGaps);

const advance = (ms: number) => vi.advanceTimersByTime(ms);
const TRIP = 7;
const LANDED: Partial<SimFrame> = { onGround: true, groundSpeedKnots: 2, airspeedKnots: 0 };

function takeoff(fm: FlightManager, over: Partial<SimFrame> = {}): void {
  for (let i = 0; i < 3; i++) fm.onFrame(makeFrame(over));
}

function land(fm: FlightManager, over: Partial<SimFrame> = {}): void {
  for (let i = 0; i < 10; i++) {
    advance(1000);
    fm.onFrame(makeFrame({ ...LANDED, ...over }));
  }
}

const PARKED: Partial<SimFrame> = {
  onGround: true, groundSpeedKnots: 0, enginesRunning: 0, engineCount: 2, parkingBrake: false,
};

function park(fm: FlightManager, n: number, over: Partial<SimFrame> = {}): void {
  for (let i = 0; i < n; i++) {
    advance(1000);
    fm.onFrame(makeFrame({ ...PARKED, ...over }));
  }
}

/**
 * Arrange a leg the matcher will accept: an active trip, one eligible
 * candidate whose departure is exactly `from`, and the leg row the link path
 * reads back. Transcribed from tests/flightManager.test.ts's own helper —
 * that file's copy is not exported, and this seam needs the same setup.
 */
function arrangeMatch(from: { lat: number; lon: number }): void {
  dbMock.getActiveTripId.mockReturnValue(TRIP);
  dbMock.getPlannedLegCandidatesForActiveTrip.mockReturnValue([
    makeCandidate({ tripId: TRIP, departureLat: from.lat, departureLon: from.lon }),
  ]);
  dbMock.getPlannedLegById.mockReturnValue(makePlannedLegWithChildren({ trip_id: TRIP }));
}

let nextSessionId = 1;

function makeSessionRow(over: Partial<GroundSession> = {}): GroundSession {
  return {
    id: nextSessionId++,
    source: 'auto',
    airport_icao: null,
    airport_name: null,
    lat: null,
    lon: null,
    parking_position: null,
    parking_position_source: null,
    planned_leg_id: null,
    planned_leg_link_source: null,
    aircraft: null,
    started_at: T0,
    ended_at: null,
    ended_reason: null,
    flight_id: null,
    created_at: T0,
    updated_at: T0,
    ...over,
  };
}

function makeOpenFlightRow(over: Partial<OpenFlightRow> = {}): OpenFlightRow {
  return {
    id: 77,
    aircraft: 'Cessna 172',
    start_time: T0,
    departure_lat: KSBA.lat,
    departure_lon: KSBA.lon,
    ...over,
  };
}

describe('FlightManager — scope-change listener', () => {
  beforeEach(() => {
    resetMocks();
    useFakeClock();
    nextSessionId = 1;
    getOpenGroundSession.mockReset().mockReturnValue(null);
    insertGroundSession.mockReset().mockImplementation((input: Partial<CreateGroundSession>) => makeSessionRow(input));
    closeOpenGroundSession.mockReset().mockReturnValue(null);
    fillOpenGroundSessionGaps.mockReset().mockReturnValue(null);
  });
  afterEach(() => useRealClock());

  it('is never called with no listener attached — every existing transition still runs to completion', () => {
    const fm = new FlightManager();
    expect(() => {
      park(fm, GROUND_DEBOUNCE_FRAMES);
      takeoff(fm);
      land(fm);
    }).not.toThrow();
  });

  it('fires once at enterGround (IDLE -> GROUND)', () => {
    const fm = new FlightManager();
    const listener = vi.fn();
    fm.setScopeChangeListener(listener);

    park(fm, GROUND_DEBOUNCE_FRAMES);

    expect(fm.appState.flightState).toBe('GROUND');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fires once at startFlight (-> FLYING), with a fresh currentFlightId already visible', () => {
    const fm = new FlightManager();
    const listener = vi.fn(() => {
      expect(fm.appState.flightState).toBe('FLYING');
      expect(fm.appState.currentFlightId).not.toBeNull();
    });
    fm.setScopeChangeListener(listener);

    takeoff(fm);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fires once at endFlight (FLYING -> IDLE)', () => {
    const fm = new FlightManager();
    takeoff(fm);
    const listener = vi.fn();
    fm.setScopeChangeListener(listener); // attached after takeoff, to isolate the landing call

    land(fm);

    expect(fm.appState.flightState).toBe('IDLE');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fires once at resetGroundTracking via a slew exit from GROUND', () => {
    const fm = new FlightManager();
    park(fm, GROUND_DEBOUNCE_FRAMES);
    const listener = vi.fn();
    fm.setScopeChangeListener(listener); // attached after entering GROUND

    advance(1000);
    fm.onFrame(makeFrame({ ...PARKED, simRunning: 3 }));

    expect(fm.appState.flightState).toBe('IDLE');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fires at resumeFlight, once via its own internal refreshPlannedLegForFlight() call and once more at its own end', () => {
    dbMock.getOpenFlight.mockReturnValue(makeOpenFlightRow());
    const fm = new FlightManager();
    const listener = vi.fn();
    fm.setScopeChangeListener(listener);

    fm.onFrame(makeFrame());

    expect(fm.appState.flightState).toBe('FLYING');
    // Two call sites in the table fire on this one path: resumeFlight() calls
    // refreshPlannedLegForFlight(row.id) internally (its own notify, since the
    // resumed flight is already this.currentFlightId by then) and then
    // notifies again at its own end — both are correct per their own rule,
    // and a consumer treats either as a no-op repeat of the same level value.
    expect(listener).toHaveBeenCalledTimes(2);
  });

  describe('refreshGroundSession()', () => {
    it('fires once when the open row is rebuilt into the cache', () => {
      const fm = new FlightManager();
      const listener = vi.fn();
      fm.setScopeChangeListener(listener);
      getOpenGroundSession.mockReturnValue(makeSessionRow({ planned_leg_id: 5 }));

      fm.refreshGroundSession();

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('fires once when no row is open and the machine was already IDLE', () => {
      const fm = new FlightManager();
      const listener = vi.fn();
      fm.setScopeChangeListener(listener);

      fm.refreshGroundSession();

      expect(fm.appState.flightState).toBe('IDLE');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('fires exactly once, not twice, when no row is open and it drops GROUND -> IDLE via resetGroundTracking', () => {
      const fm = new FlightManager();
      park(fm, GROUND_DEBOUNCE_FRAMES);
      const listener = vi.fn();
      fm.setScopeChangeListener(listener);
      getOpenGroundSession.mockReturnValue(null);

      fm.refreshGroundSession();

      expect(fm.appState.flightState).toBe('IDLE');
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('refreshPlannedLegForFlight()', () => {
    it('fires once on the early return for a flight id that is not the current one', () => {
      const fm = new FlightManager();
      const listener = vi.fn();
      fm.setScopeChangeListener(listener);

      fm.refreshPlannedLegForFlight(999);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('fires once when clearing the cache (manual unlink)', () => {
      arrangeMatch(KSBA);
      const fm = new FlightManager();
      takeoff(fm);
      const listener = vi.fn();
      fm.setScopeChangeListener(listener);
      dbMock.getFlightPlannedLegId.mockReturnValue(null);

      fm.refreshPlannedLegForFlight(1);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('fires once when rebuilding the cache (manual link)', () => {
      const fm = new FlightManager();
      takeoff(fm); // no active trip -> unlinked
      const listener = vi.fn();
      fm.setScopeChangeListener(listener);
      dbMock.getFlightPlannedLegId.mockReturnValue(11);
      dbMock.getPlannedLegById.mockReturnValue(makePlannedLegWithChildren());

      fm.refreshPlannedLegForFlight(1);

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  it('catches a throwing listener, logs it, and never breaks the frame path', () => {
    const fm = new FlightManager();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fm.setScopeChangeListener(() => { throw new Error('boom'); });

    expect(() => takeoff(fm)).not.toThrow();
    expect(fm.appState.flightState).toBe('FLYING');
    expect(warn).toHaveBeenCalledWith('[FlightManager] scope listener failed:', expect.any(Error));
    warn.mockRestore();
  });

  it('setScopeChangeListener(null) detaches: no call, no throw, on a later transition', () => {
    const fm = new FlightManager();
    const listener = vi.fn();
    fm.setScopeChangeListener(listener);
    fm.setScopeChangeListener(null);

    expect(() => takeoff(fm)).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('FlightManager — getFlightStatePayload()', () => {
  beforeEach(() => {
    resetMocks();
    useFakeClock();
    nextSessionId = 1;
    getOpenGroundSession.mockReset().mockReturnValue(null);
    insertGroundSession.mockReset().mockImplementation((input: Partial<CreateGroundSession>) => makeSessionRow(input));
    closeOpenGroundSession.mockReset().mockReturnValue(null);
    fillOpenGroundSessionGaps.mockReset().mockReturnValue(null);
  });
  afterEach(() => useRealClock());

  it('reports IDLE, no flight, no leg — nothing going on', () => {
    const fm = new FlightManager();
    expect(fm.getFlightStatePayload()).toEqual({ flightState: 'IDLE', currentFlightId: null, plannedLegId: null });
  });

  it('reports the effective leg for a flight linked at takeoff', () => {
    arrangeMatch(KSBA);
    const fm = new FlightManager();
    takeoff(fm);
    const issuedId = dbMock.insertFlight.mock.results[0].value;

    expect(fm.getFlightStatePayload()).toEqual({ flightState: 'FLYING', currentFlightId: issuedId, plannedLegId: 11 });
  });

  it('reports plannedLegId null for a flight with no link', () => {
    const fm = new FlightManager();
    takeoff(fm); // no active trip -> unlinked
    const issuedId = dbMock.insertFlight.mock.results[0].value;

    expect(fm.getFlightStatePayload()).toEqual({ flightState: 'FLYING', currentFlightId: issuedId, plannedLegId: null });
  });

  it('reports the open ground session\'s leg while IDLE with a manual session open', () => {
    getOpenGroundSession.mockReturnValue(makeSessionRow({ planned_leg_id: 42 }));
    const fm = new FlightManager(); // agent never connected, so still IDLE

    expect(fm.getFlightStatePayload()).toEqual({ flightState: 'IDLE', currentFlightId: null, plannedLegId: 42 });
  });

  it('never reads the ground session while a flight is in progress, even if one happens to be open', () => {
    arrangeMatch(KSBA);
    const fm = new FlightManager();
    takeoff(fm);
    const issuedId = dbMock.insertFlight.mock.results[0].value;
    getOpenGroundSession.mockReturnValue(makeSessionRow({ planned_leg_id: 999 })); // must not leak in

    expect(fm.getFlightStatePayload()).toEqual({ flightState: 'FLYING', currentFlightId: issuedId, plannedLegId: 11 });
  });
});
