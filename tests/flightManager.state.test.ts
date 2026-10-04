// tests/flightManager.state.test.ts — tests src/flightManager.ts, part 1 of 3.
//
// The state machine and the pause flags: every transition IDLE <-> FLYING, the
// two debounce counters and their reset conditions, the three out-of-band
// endings (simRunning === 0, onCrash, onSimDisconnect), and what setPaused()
// does to appState and to point recording.
//
// Duration/accumulator arithmetic lives in tests/flightManager.duration.test.ts
// and the planned-leg seam in tests/flightManager.test.ts; the three files share
// this same mock + fake-clock harness and nothing else.
//
// Hermetic: './db' and './airports' are replaced wholesale, so no native
// binding and no database file is ever opened, and every duration in here
// comes from vi.advanceTimersByTime(), never from a real wait.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SimFrame } from '../src/types';
import { dbMock, airportsMock, resetMocks, makeFrame, T0, useFakeClock, useRealClock } from './helpers';

// The factory must resolve the harness itself at call time; it
// may not close over a top-level const, because vi.mock() is hoisted above the
// imports. The path is relative to THIS file and resolves to the same module id
// src/flightManager.ts's './db' does.
vi.mock('../src/db', async () => (await import('./helpers')).dbMock);
vi.mock('../src/airports', async () => (await import('./helpers')).airportsMock);
vi.mock('../src/acarsEvents', async () => (await import('./helpers')).acarsEventsMock);

import { FlightManager } from '../src/flightManager';

// src/flightManager.ts:16-17 — transcribed, not imported (neither constant is
// exported). A change to either must break these tests, which is the point.
const AIRBORNE_DEBOUNCE_FRAMES = 3;
const LANDED_DEBOUNCE_FRAMES = 10;

/** Move the clock first, then deliver the frame that sees it. */
const advance = (ms: number) => vi.advanceTimersByTime(ms);

/** A landed frame: onGround, and below the 5 kt ground-speed test (:213). */
const LANDED: Partial<SimFrame> = { onGround: true, groundSpeedKnots: 2, airspeedKnots: 0 };

/** The three frames that trip the airborne debounce, all at the current instant. */
function takeoff(fm: FlightManager, over: Partial<SimFrame> = {}): void {
  for (let i = 0; i < AIRBORNE_DEBOUNCE_FRAMES; i++) fm.onFrame(makeFrame(over));
}

/** `n` frames at 1 Hz, the rate the sim client sends at. */
function feed(fm: FlightManager, n: number, over: Partial<SimFrame> = {}): void {
  for (let i = 0; i < n; i++) {
    advance(1000);
    fm.onFrame(makeFrame(over));
  }
}

describe('FlightManager — state machine', () => {
  beforeEach(() => {
    resetMocks(); // must be first; restoreMocks does not touch vi.fn()s.
    useFakeClock();
  });
  afterEach(() => useRealClock());

  // ── The airborne debounce is exactly 3, and it is a streak ────────────────

  it('needs exactly AIRBORNE_DEBOUNCE_FRAMES consecutive qualifying frames to start a flight', () => {
    const fm = new FlightManager();

    fm.onFrame(makeFrame());
    fm.onFrame(makeFrame());
    expect(dbMock.insertFlight).not.toHaveBeenCalled();

    fm.onFrame(makeFrame());
    expect(dbMock.insertFlight).toHaveBeenCalledTimes(1);
    expect(dbMock.insertFlight).toHaveBeenCalledWith('Cessna 172', 34.426201, -119.841507, T0, null, null);
  });

  it('a non-qualifying frame resets the airborne streak', () => {
    const fm = new FlightManager();

    fm.onFrame(makeFrame());
    fm.onFrame(makeFrame());
    fm.onFrame(makeFrame({ onGround: true })); // resets to 0 (:201)
    fm.onFrame(makeFrame());
    fm.onFrame(makeFrame());
    expect(dbMock.insertFlight).not.toHaveBeenCalled();

    fm.onFrame(makeFrame()); // third of the new streak
    expect(dbMock.insertFlight).toHaveBeenCalledTimes(1);
  });

  // ── The three guards on the qualifying frame (:195) ────────────────────────

  it('never starts a flight in slew, on the ground, or at or below 30 kt', () => {
    const cases: { name: string; over: Partial<SimFrame> }[] = [
      { name: 'slew', over: { simRunning: 3 } },
      { name: 'on the ground', over: { onGround: true } },
      { name: 'airspeed exactly 30', over: { airspeedKnots: 30 } },
    ];

    for (const c of cases) {
      resetMocks();
      const fm = new FlightManager();
      for (let i = 0; i < 20; i++) fm.onFrame(makeFrame(c.over));
      expect(dbMock.insertFlight, c.name).not.toHaveBeenCalled();
      expect(fm.appState.flightState, c.name).toBe('IDLE');
    }
  });

  it('starts at 31 kt — the guard is strictly greater than 30', () => {
    const fm = new FlightManager();
    for (let i = 0; i < 10; i++) fm.onFrame(makeFrame({ airspeedKnots: 30 }));
    expect(dbMock.insertFlight).not.toHaveBeenCalled();

    takeoff(fm, { airspeedKnots: 31 });
    expect(dbMock.insertFlight).toHaveBeenCalledTimes(1);
    expect(fm.appState.flightState).toBe('FLYING');
  });

  // ── The landed debounce is exactly 10, and it is a streak ─────────────────

  it('needs exactly LANDED_DEBOUNCE_FRAMES consecutive landed frames to end a flight', () => {
    const fm = new FlightManager();
    takeoff(fm);

    feed(fm, LANDED_DEBOUNCE_FRAMES - 1, LANDED);
    expect(dbMock.closeFlight).not.toHaveBeenCalled();
    expect(fm.appState.flightState).toBe('FLYING');

    feed(fm, 1, LANDED);
    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    expect(fm.appState.flightState).toBe('IDLE');
  });

  it('a landed frame at exactly 5 kt ground speed resets the landed streak', () => {
    const fm = new FlightManager();
    takeoff(fm);

    feed(fm, 9, LANDED);
    feed(fm, 1, { onGround: true, groundSpeedKnots: 5, airspeedKnots: 0 }); // `< 5` is false (:213)
    feed(fm, 9, LANDED);
    expect(dbMock.closeFlight).not.toHaveBeenCalled();

    feed(fm, 1, LANDED);
    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
  });

  // ── simRunning === 0 (:186) ────────────────────────────────────────────────

  it('simRunning === 0 ends a FLYING flight immediately, once', () => {
    const fm = new FlightManager();
    takeoff(fm);
    advance(1000);

    fm.onFrame(makeFrame({ simRunning: 0 }));
    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    expect(fm.appState.flightState).toBe('IDLE');

    advance(1000);
    fm.onFrame(makeFrame({ simRunning: 0 }));
    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
  });

  it('simRunning === 0 while IDLE is a silent no-op', () => {
    const fm = new FlightManager();
    expect(() => fm.onFrame(makeFrame({ simRunning: 0 }))).not.toThrow();
    expect(dbMock.closeFlight).not.toHaveBeenCalled();
    expect(dbMock.insertFlight).not.toHaveBeenCalled();
    expect(fm.appState.flightState).toBe('IDLE');
    // The frame is still published even though it decided nothing.
    expect(fm.appState.lastFrame?.simRunning).toBe(0);
  });

  // ── onCrash / onSimDisconnect ───────────────────────────────────────────────

  it('onCrash() ends a FLYING flight at the last frame\'s coordinates', () => {
    const fm = new FlightManager();
    takeoff(fm);

    // A frame 1 s later, somewhere else, that is NOT recorded as a point
    // (1000 < RECORD_INTERVAL_MS) — so only appState.lastFrame carries it.
    advance(1000);
    fm.onFrame(makeFrame({ lat: 36.586952, lon: -121.843079 }));

    fm.onCrash();
    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    const [, , lat, lon] = dbMock.closeFlight.mock.calls[0];
    expect(lat).toBe(36.586952);
    expect(lon).toBe(-121.843079);
    expect(fm.appState.flightState).toBe('IDLE');
  });

  it('onSimDisconnect() holds a FLYING flight and closes it at the last frame 180 s after that frame', () => {
    const fm = new FlightManager();
    takeoff(fm);

    advance(1000);
    fm.onFrame(makeFrame({ lat: 36.586952, lon: -121.843079 }));

    fm.onSimDisconnect();
    advance(179_999);
    expect(dbMock.closeFlight).not.toHaveBeenCalled();
    expect(fm.appState.flightState).toBe('FLYING');

    advance(1);
    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    const [, , lat, lon] = dbMock.closeFlight.mock.calls[0];
    expect(lat).toBe(36.586952);
    expect(lon).toBe(-121.843079);
    expect(fm.appState.flightState).toBe('IDLE');
  });

  for (const ending of ['onCrash', 'onSimDisconnect'] as const) {
    it(`${ending}() is a no-op when no frame has ever arrived`, () => {
      const fm = new FlightManager();
      expect(() => fm[ending]()).not.toThrow();
      expect(dbMock.closeFlight).not.toHaveBeenCalled();
    });

    it(`${ending}() is a no-op when IDLE after a completed flight`, () => {
      const fm = new FlightManager();
      takeoff(fm);
      feed(fm, LANDED_DEBOUNCE_FRAMES, LANDED);
      expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);

      // appState.lastFrame is non-null here, so only the state test can stop it.
      expect(fm.appState.lastFrame).not.toBeNull();
      expect(() => fm[ending]()).not.toThrow();
      expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    });
  }

  // ── appState around the two transitions ─────────────────────────────────────

  it('appState follows startFlight and endFlight', () => {
    const fm = new FlightManager();
    expect(fm.appState.flightState).toBe('IDLE');
    expect(fm.appState.currentFlightId).toBeNull();

    takeoff(fm);
    const issuedId = dbMock.insertFlight.mock.results[0].value;
    expect(issuedId).toBe(1);
    expect(fm.appState.flightState).toBe('FLYING');
    expect(fm.appState.currentFlightId).toBe(issuedId);

    feed(fm, LANDED_DEBOUNCE_FRAMES, LANDED);
    expect(fm.appState.flightState).toBe('IDLE');
    expect(fm.appState.currentFlightId).toBeNull();
    expect(dbMock.closeFlight.mock.calls[0][0]).toBe(issuedId);
  });

  it('a second flight gets the next issued id', () => {
    const fm = new FlightManager();
    takeoff(fm);
    feed(fm, LANDED_DEBOUNCE_FRAMES, LANDED);
    advance(1000);
    takeoff(fm);
    expect(fm.appState.currentFlightId).toBe(2);
    expect(dbMock.insertFlight).toHaveBeenCalledTimes(2);
  });

  // ── findNearestAirport is called exactly three times per flight: once in
  // startFlight, once for the OOOI touchdown event, once in endFlight, never
  // on the frame path more than that. A regression that moved it into
  // recordPoint would show here.

  it('resolves the nearest airport exactly three times per flight', () => {
    airportsMock.findNearestAirport.mockReturnValue({ icao: 'KSBA', name: 'Santa Barbara Muni' });
    const fm = new FlightManager();
    takeoff(fm);
    feed(fm, LANDED_DEBOUNCE_FRAMES, LANDED);

    expect(airportsMock.findNearestAirport).toHaveBeenCalledTimes(3);
    expect(dbMock.insertFlight).toHaveBeenCalledWith('Cessna 172', 34.426201, -119.841507, T0, 'KSBA', 'Santa Barbara Muni');
    const close = dbMock.closeFlight.mock.calls[0];
    expect(close[9]).toBe('KSBA');
    expect(close[10]).toBe('Santa Barbara Muni');
  });
});

describe('FlightManager — pause flags and suppression', () => {
  beforeEach(() => {
    resetMocks();
    useFakeClock();
  });
  afterEach(() => useRealClock());

  // ── setPaused() and appState ─────────────────────────────────────────────────

  it('setPaused(true, flags) publishes the flags; setPaused(false) always clears them', () => {
    const fm = new FlightManager();
    expect(fm.appState.paused).toBe(false);
    expect(fm.appState.pauseFlags).toBe(0);

    fm.setPaused(true, 4);
    expect(fm.appState.paused).toBe(true);
    expect(fm.appState.pauseFlags).toBe(4);

    fm.setPaused(false, 4); // flags argument ignored on the un-pause (:180)
    expect(fm.appState.paused).toBe(false);
    expect(fm.appState.pauseFlags).toBe(0);

    fm.setPaused(true); // default flags = 1
    expect(fm.appState.pauseFlags).toBe(1);

    fm.setPaused(false);
    expect(fm.appState.pauseFlags).toBe(0);
  });

  // ── frames delivered while paused record nothing ────────────────────────────

  it('records no points while paused, across several RECORD_INTERVAL_MS windows', () => {
    const fm = new FlightManager();
    takeoff(fm);
    expect(dbMock.insertPoint).toHaveBeenCalledTimes(1); // the takeoff point

    fm.setPaused(true, 1);
    feed(fm, 30, {}); // 30 s = six 5-second windows, every frame otherwise qualifying
    expect(dbMock.insertPoint).toHaveBeenCalledTimes(1);
    expect(fm.appState.flightState).toBe('FLYING');

    // …and recording resumes on the next interval once un-paused.
    fm.setPaused(false);
    advance(5000);
    fm.onFrame(makeFrame());
    expect(dbMock.insertPoint).toHaveBeenCalledTimes(2);
  });

  it('a paused landing never ends the flight', () => {
    const fm = new FlightManager();
    takeoff(fm);
    fm.setPaused(true, 1);
    feed(fm, 30, LANDED); // three times the landed debounce, all suppressed (:206)
    expect(dbMock.closeFlight).not.toHaveBeenCalled();
    expect(fm.appState.flightState).toBe('FLYING');
  });
});
