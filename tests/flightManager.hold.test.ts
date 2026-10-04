// tests/flightManager.hold.test.ts — tests src/flightManager.ts: a FLYING flight
// is held open for up to 180 s when the simulator's data stops, instead of being
// closed at once.
//
// The shared timeline, in ms after T0: takeoff at 0 (point 1), a frame at 5_000
// (point 2), a frame at 8_000 (not a point; the last frame before the silence),
// onSimDisconnect() at 20_000. The hold expires 180 s after the last frame was
// received, so at 188_000, not 200_000 (180 s after the disconnect call).
// Every expected value is a literal worked out from those advances.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import type { SimFrame } from '../src/types';
import {
  dbMock, airportsMock, acarsEventsMock, resetMocks, makeFrame, makeCandidate, makePlannedLegWithChildren,
  northOfNm, KSBA, KMRY, T0, useFakeClock, useRealClock,
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

const iso = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
const clockAt = () => Date.now() - Date.parse(T0);
/** Moves the faked clock to `ms` after T0. */
const goTo = (ms: number) => vi.advanceTimersByTime(ms - clockAt());

const KMRY_FRAME: Partial<SimFrame> = { lat: KMRY.lat, lon: KMRY.lon };
const LANDED: Partial<SimFrame> = { onGround: true, groundSpeedKnots: 2, airspeedKnots: 0 };

let logSpy: MockInstance<typeof console.log>;
let warnSpy: MockInstance<typeof console.warn>;

function newFm(): FlightManager {
  return new FlightManager();
}

function takeoff(fm: FlightManager, over: Partial<SimFrame> = {}): void {
  for (let i = 0; i < 3; i++) fm.onFrame(makeFrame(over));
}

/** Delivers a frame at `ms` after T0 and returns it. */
function frameAt(fm: FlightManager, ms: number, over: Partial<SimFrame> = {}): SimFrame {
  goTo(ms);
  const frame = makeFrame(over);
  fm.onFrame(frame);
  return frame;
}

/** Takeoff at 0, a point at 5_000, the last frame at 8_000 (at KMRY), then the disconnect at 20_000. */
function sharedTimeline(fm: FlightManager): SimFrame {
  takeoff(fm);
  frameAt(fm, 5_000);
  const last = frameAt(fm, 8_000, KMRY_FRAME);
  goTo(20_000);
  fm.onSimDisconnect();
  return last;
}

/** closeFlight's positional arguments, named. */
function closeArgs(call = 0) {
  const c = dbMock.closeFlight.mock.calls[call];
  return {
    flightId: c[0] as number,
    endTime: c[1] as string,
    lat: c[2] as number,
    lon: c[3] as number,
    durationSec: c[4] as number,
    distanceNm: c[5] as number,
    pointCount: c[8] as number,
    icao: c[9] as string | null,
  };
}

/** sent_at of every ACARS message with this label, in filing order. */
function sentAt(label: string): string[] {
  return acarsEventsMock.fileAcarsMessageOnce.mock.calls
    .filter(([msg]) => (msg as { label: string }).label === label)
    .map(([msg]) => (msg as { sent_at: string }).sent_at);
}

/** Filing contexts such as 'Flight #1 OUT', in filing order. */
function contexts(): string[] {
  return acarsEventsMock.fileAcarsMessageOnce.mock.calls.map(([, context]) => context as string);
}

const loggedLines = (): string[] => logSpy.mock.calls.map(c => String(c[0]));

/** A leg the takeoff at KSBA links to, the way tests/flightManager.test.ts arranges one. */
function arrangeLinkedLeg(): void {
  dbMock.getActiveTripId.mockReturnValue(7);
  dbMock.getPlannedLegCandidatesForActiveTrip.mockReturnValue([
    makeCandidate({ tripId: 7, departureLat: KSBA.lat, departureLon: KSBA.lon }),
  ]);
  dbMock.getPlannedLegById.mockReturnValue(makePlannedLegWithChildren({ trip_id: 7 }));
}

beforeEach(() => {
  resetMocks();
  useFakeClock();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  airportsMock.findNearestAirport.mockImplementation((lat: number) =>
    Math.abs(lat - KMRY.lat) < 0.5 ? { icao: 'KMRY', name: 'Monterey Rgnl' } : { icao: 'KSBA', name: 'Santa Barbara Muni' });
  getOpenGroundSession.mockReset().mockReturnValue(null);
  closeOpenGroundSession.mockReset();
  insertGroundSession.mockReset().mockImplementation(() => {
    const row = { id: 1, source: 'auto', ended_at: null } as unknown as ReturnType<typeof groundSessionsModule.insertGroundSession>;
    getOpenGroundSession.mockReturnValue(row);
    return row;
  });
});
afterEach(() => {
  useRealClock();
  vi.restoreAllMocks();
});

describe('FlightManager — hold through a sim silence', () => {
  it('(a) a disconnect while FLYING keeps the flight open and changes nothing visible', () => {
    const fm = newFm();
    const scope = vi.fn();
    fm.setScopeChangeListener(scope);
    const last = sharedTimeline(fm);
    const notifiesBefore = scope.mock.calls.length;

    expect(fm.getFlightStatePayload().flightState).toBe('FLYING');
    expect(fm.appState.flightState).toBe('FLYING');
    expect(fm.getFlightStatePayload().currentFlightId).toBe(1);
    expect(fm.appState.currentFlightId).toBe(1);
    expect(dbMock.closeFlight).not.toHaveBeenCalled();
    expect(sentAt('ON')).toEqual([]);
    expect(sentAt('IN')).toEqual([]);
    expect(fm.appState.lastFrame).toBe(last);
    expect(fm.isHoldingFlight()).toBe(true);
    expect(loggedLines()).toContain('[FlightManager] Flight #1 sim silent — holding up to 180s from the last frame');
    expect(scope.mock.calls.length).toBe(notifiesBefore);
  });

  it('(b) closes 180 s after the last frame, from the last frame, with no interruption suffix', () => {
    const fm = newFm();
    const scope = vi.fn();
    sharedTimeline(fm);
    fm.setScopeChangeListener(scope);

    goTo(187_999);
    expect(dbMock.closeFlight).not.toHaveBeenCalled();
    goTo(188_000);

    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    const c = closeArgs();
    expect(c.endTime).toBe(iso(8_000));
    expect(c.lat).toBe(KMRY.lat);
    expect(c.lon).toBe(KMRY.lon);
    expect(c.icao).toBe('KMRY');
    expect(c.durationSec).toBe(8);
    expect(c.pointCount).toBe(2);
    expect(loggedLines()).toContain('[FlightManager] Flight #1 ended — 2 points, 0.0 nm, 8s');
    expect(loggedLines().some(l => l.includes('interrupted, excluded'))).toBe(false);
    expect(loggedLines()).toContain(
      '[FlightManager] Flight #1 hold expired after 180s without data — closing at the last frame');
    expect(sentAt('ON')).toEqual([iso(8_000)]);
    expect(sentAt('IN')).toEqual([iso(8_000)]);
    expect(fm.appState.flightState).toBe('IDLE');
    expect(fm.isHoldingFlight()).toBe(false);
    expect(scope).toHaveBeenCalled();
  });

  describe('a pause event while the flight is held', () => {
    it('(b2) keeps the tail flown before the silence in the duration', () => {
      const fm = newFm();
      sharedTimeline(fm);
      goTo(30_000);
      fm.setPaused(true, 1);
      goTo(188_000);

      expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
      expect(closeArgs().endTime).toBe(iso(8_000));
      expect(closeArgs().durationSec).toBe(8);
      expect(loggedLines()).toContain('[FlightManager] Flight #1 ended — 2 points, 0.0 nm, 8s');
      expect(loggedLines().some(l => l.includes('interrupted, excluded'))).toBe(false);
    });

    it('(b3) a crash or a not-running frame after the pause still counts the tail', () => {
      const fm = newFm();
      sharedTimeline(fm);
      goTo(30_000);
      fm.setPaused(true, 1);
      goTo(40_000);
      fm.onCrash();
      expect(closeArgs().durationSec).toBe(8);

      resetMocks();
      const fm2 = newFm();
      goTo(100_000);
      takeoff(fm2);
      frameAt(fm2, 105_000);
      frameAt(fm2, 108_000, KMRY_FRAME);
      goTo(120_000);
      fm2.onSimDisconnect();
      goTo(130_000);
      fm2.setPaused(true, 1);
      frameAt(fm2, 140_000, { simRunning: 0 });
      expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
      expect(closeArgs().endTime).toBe(iso(108_000));
      expect(closeArgs().durationSec).toBe(8);
    });

    it('(b4) a continuation after the pause is still an interrupted point and excludes the silence', () => {
      const fm = newFm();
      takeoff(fm);
      frameAt(fm, 5_000);
      goTo(15_000);
      fm.onSimDisconnect();
      goTo(16_000);
      fm.setPaused(true, 1);
      goTo(24_000);
      fm.setPaused(false);

      const insertsBefore = dbMock.insertPoint.mock.calls.length;
      frameAt(fm, 25_000, northOfNm(KSBA, 1));

      expect(dbMock.insertFlight).toHaveBeenCalledTimes(1);
      expect(dbMock.insertPoint.mock.calls.length).toBe(insertsBefore + 1);
      expect(dbMock.insertPoint.mock.calls[insertsBefore][10]).toBe(true);

      // The point at 5_000 counts 5 s; the point at 25_000 follows a silence, so its
      // 20 s gap is excluded, and there is no tail after it: 5 s in total.
      fm.onCrash();
      expect(closeArgs().durationSec).toBe(5);
      expect(closeArgs().distanceNm).toBe(1);
    });
  });

  it('(c) a repeated disconnect keeps the deadline and a late one does not close twice', () => {
    const fm = newFm();
    sharedTimeline(fm);

    goTo(100_000);
    fm.onSimDisconnect();
    goTo(187_999);
    expect(dbMock.closeFlight).not.toHaveBeenCalled();
    goTo(188_000);
    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);

    fm.onSimDisconnect();
    goTo(400_000);
    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
  });

  it('(d) a same-aircraft frame continues the flight: same row, interrupted point, no second OUT/OFF', () => {
    arrangeLinkedLeg();
    const fm = newFm();
    takeoff(fm);
    const legId = fm.getFlightStatePayload().plannedLegId;
    expect(legId).not.toBeNull();
    frameAt(fm, 5_000);
    goTo(15_000);
    fm.onSimDisconnect();
    expect(fm.getFlightStatePayload().plannedLegId).toBe(legId);

    const insertsBefore = dbMock.insertPoint.mock.calls.length;
    frameAt(fm, 25_000, northOfNm(KSBA, 1));

    expect(dbMock.insertFlight).toHaveBeenCalledTimes(1);
    expect(fm.getFlightStatePayload().currentFlightId).toBe(1);
    expect(fm.getFlightStatePayload().plannedLegId).toBe(legId);
    expect(dbMock.linkFlightToPlannedLeg).toHaveBeenCalledTimes(1);
    expect(dbMock.insertPoint.mock.calls.length).toBe(insertsBefore + 1);
    const inserted = dbMock.insertPoint.mock.calls[insertsBefore];
    expect(inserted[10]).toBe(true);
    expect(contexts().filter(c => c === 'Flight #1 OUT')).toHaveLength(1);
    expect(contexts().filter(c => c === 'Flight #1 OFF')).toHaveLength(1);
    expect(fm.isHoldingFlight()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(loggedLines()).toContain(
      '[FlightManager] Flight #1 continued after 20s of silence — 1.0 nm from the last frame');

    fm.onCrash();
    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    expect(closeArgs().durationSec).toBe(5);
    expect(closeArgs().distanceNm).toBe(1);
    goTo(300_000);
    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
  });

  it('(e) another aircraft closes the old flight at its last frame, then starts a new flight', () => {
    const fm = newFm();
    takeoff(fm);
    frameAt(fm, 5_000, KMRY_FRAME);
    goTo(10_000);
    fm.onSimDisconnect();
    const pointsBefore = dbMock.insertPoint.mock.calls.length;

    frameAt(fm, 65_000, { aircraft: 'Piper PA-28' });

    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    const c = closeArgs();
    expect(c.flightId).toBe(1);
    expect(c.endTime).toBe(iso(5_000));
    expect(c.lat).toBe(KMRY.lat);
    expect(sentAt('ON')).toEqual([iso(5_000)]);
    expect(sentAt('IN')).toEqual([iso(5_000)]);
    expect(dbMock.insertPoint.mock.calls.length).toBe(pointsBefore);
    expect(fm.isHoldingFlight()).toBe(false);

    frameAt(fm, 66_000, { aircraft: 'Piper PA-28' });
    frameAt(fm, 67_000, { aircraft: 'Piper PA-28' });
    expect(dbMock.insertFlight).toHaveBeenCalledTimes(2);
    expect(dbMock.insertFlight.mock.calls[1][0]).toBe('Piper PA-28');
    expect(contexts()).toContain('Flight #2 OUT');
    expect(contexts()).toContain('Flight #2 OFF');
    expect(fm.appState.currentFlightId).toBe(2);
  });

  describe('(f) paused and not paused', () => {
    function silentAt6nm(paused: boolean, nm: number): FlightManager {
      const fm = newFm();
      takeoff(fm, { groundSpeedKnots: 120 });
      frameAt(fm, 5_000, { groundSpeedKnots: 120 });
      goTo(17_000);
      if (paused) fm.setPaused(true, 1);
      fm.onSimDisconnect();
      frameAt(fm, 65_000, { groundSpeedKnots: 120, ...northOfNm(KSBA, nm) });
      return fm;
    }

    it('paused: the 6 nm return is a different flight', () => {
      const fm = silentAt6nm(true, 6);
      expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
      expect(closeArgs().endTime).toBe(iso(5_000));
      expect(fm.appState.flightState).toBe('IDLE');
      expect(dbMock.insertFlight).toHaveBeenCalledTimes(1);
    });

    it.each([6, 6.9])('not paused: the %s nm return continues the flight', (nm) => {
      const fm = silentAt6nm(false, nm);
      expect(dbMock.closeFlight).not.toHaveBeenCalled();
      expect(fm.appState.flightState).toBe('FLYING');
      expect(fm.isHoldingFlight()).toBe(false);
    });
  });

  it('(g) a not-running frame closes the held flight at once, at the last frame', () => {
    const fm = newFm();
    sharedTimeline(fm);

    frameAt(fm, 25_000, { simRunning: 0, lat: 10, lon: 10 });

    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    const c = closeArgs();
    expect(c.endTime).toBe(iso(8_000));
    expect(c.lat).toBe(KMRY.lat);
    expect(c.lon).toBe(KMRY.lon);
    expect(c.durationSec).toBe(8);
    expect(sentAt('ON')).toEqual([iso(8_000)]);
    expect(sentAt('IN')).toEqual([iso(8_000)]);
    expect(fm.appState.flightState).toBe('IDLE');
    expect(fm.appState.lastFrame?.simRunning).toBe(0);
    expect(fm.isHoldingFlight()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('(h) a crash during the hold closes at once at the last frame; outside a hold it uses now', () => {
    const fm = newFm();
    sharedTimeline(fm);
    goTo(25_000);
    fm.onCrash();

    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    const c = closeArgs();
    expect(c.endTime).toBe(iso(8_000));
    expect(c.lat).toBe(KMRY.lat);
    expect(c.durationSec).toBe(8);
    expect(sentAt('ON')).toEqual([iso(8_000)]);
    expect(sentAt('IN')).toEqual([iso(8_000)]);
    expect(fm.isHoldingFlight()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    dbMock.closeFlight.mockClear();
    const fm2 = newFm();
    goTo(100_000);
    takeoff(fm2);
    frameAt(fm2, 105_000);
    frameAt(fm2, 108_000);
    goTo(120_000);
    fm2.onCrash();
    expect(closeArgs().endTime).toBe(iso(120_000));
    expect(closeArgs().durationSec).toBe(20);
  });

  it('(i) a slew frame near the last position continues the flight and writes no point', () => {
    const fm = newFm();
    takeoff(fm);
    frameAt(fm, 5_000);
    goTo(10_000);
    fm.onSimDisconnect();
    const pointsBefore = dbMock.insertPoint.mock.calls.length;

    frameAt(fm, 30_000, { simRunning: 3 });

    expect(fm.isHoldingFlight()).toBe(false);
    expect(fm.appState.flightState).toBe('FLYING');
    expect(dbMock.closeFlight).not.toHaveBeenCalled();
    expect(dbMock.insertPoint.mock.calls.length).toBe(pointsBefore);
  });

  it('(j) landing frames after the continuation feed the normal landed debounce', () => {
    const fm = newFm();
    takeoff(fm);
    frameAt(fm, 5_000);
    goTo(10_000);
    fm.onSimDisconnect();

    frameAt(fm, 20_000, LANDED);
    for (let i = 1; i <= 8; i++) frameAt(fm, 20_000 + i * 1000, LANDED);
    expect(fm.appState.flightState).toBe('FLYING');
    expect(dbMock.closeFlight).not.toHaveBeenCalled();
    expect(sentAt('ON')).toEqual([iso(20_000)]);

    frameAt(fm, 29_000, LANDED);
    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    expect(closeArgs().endTime).toBe(iso(29_000));
    expect(fm.appState.flightState).toBe('IDLE');
  });

  it('(k) GROUND closes its auto session with no timer; IDLE does nothing', () => {
    const idle = newFm();
    idle.onSimDisconnect();
    expect(idle.isHoldingFlight()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    const fm = newFm();
    for (let i = 0; i < GROUND_DEBOUNCE_FRAMES; i++) {
      vi.advanceTimersByTime(1000);
      fm.onFrame(makeFrame({ onGround: true, groundSpeedKnots: 0, airspeedKnots: 0, enginesRunning: 0, engineCount: 2, parkingBrake: false }));
    }
    expect(fm.appState.flightState).toBe('GROUND');
    fm.onSimDisconnect();
    expect(fm.appState.flightState).toBe('IDLE');
    expect(closeOpenGroundSession).toHaveBeenCalledWith('sim-exit');
    expect(fm.isHoldingFlight()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('(l) isHoldingFlight() is true exactly between the hold start and its exit', () => {
    const fm = newFm();
    takeoff(fm);
    frameAt(fm, 5_000);
    expect(fm.isHoldingFlight()).toBe(false);
    fm.onSimDisconnect();
    expect(fm.isHoldingFlight()).toBe(true);
    goTo(184_999);
    expect(fm.isHoldingFlight()).toBe(true);
    goTo(185_000);
    expect(fm.isHoldingFlight()).toBe(false);

    const second = newFm();
    goTo(200_000);
    takeoff(second);
    frameAt(second, 205_000);
    second.onSimDisconnect();
    expect(second.isHoldingFlight()).toBe(true);
    frameAt(second, 210_000);
    expect(second.isHoldingFlight()).toBe(false);
  });

  it('(m) a disconnect reported long after the last frame closes at once, at that frame', () => {
    const fm = newFm();
    takeoff(fm);
    frameAt(fm, 8_000);
    goTo(200_000);
    fm.onSimDisconnect();
    expect(fm.isHoldingFlight()).toBe(true);

    vi.advanceTimersByTime(0);

    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    expect(closeArgs().endTime).toBe(iso(8_000));
  });

  it('(n) a second hold after a continuation counts 180 s from the continuation frame', () => {
    const fm = newFm();
    takeoff(fm);
    frameAt(fm, 5_000);
    goTo(6_000);
    fm.onSimDisconnect();
    const back = frameAt(fm, 25_000, northOfNm(KSBA, 1));
    goTo(35_000);
    fm.onSimDisconnect();

    goTo(185_000);
    expect(dbMock.closeFlight).not.toHaveBeenCalled();
    goTo(204_999);
    expect(dbMock.closeFlight).not.toHaveBeenCalled();
    goTo(205_000);

    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    const c = closeArgs();
    expect(c.lat).toBe(back.lat);
    expect(c.lon).toBe(back.lon);
    expect(c.endTime).toBe(iso(25_000));
  });

  it('(o) a close that throws at expiry is logged and does not escape the timer', () => {
    const fm = newFm();
    takeoff(fm);
    frameAt(fm, 5_000);
    fm.onSimDisconnect();
    dbMock.closeFlight.mockImplementation(() => { throw new Error('database is locked'); });

    expect(() => vi.advanceTimersByTime(180_000)).not.toThrow();

    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('close after the hold failed'))).toBe(true);
    expect(fm.isHoldingFlight()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('(p) a continuation does not resume the flight after a touchdown that was already filed', () => {
    const fm = newFm();
    takeoff(fm);
    frameAt(fm, 5_000, { onGround: true, groundSpeedKnots: 40 });
    frameAt(fm, 6_000);
    goTo(10_000);
    fm.onSimDisconnect();

    frameAt(fm, 20_000, { onGround: true, groundSpeedKnots: 40 });

    expect(fm.isHoldingFlight()).toBe(false);
    expect(fm.appState.flightState).toBe('FLYING');
    expect(sentAt('ON')).toEqual([iso(5_000)]);
  });

  it('(q) a continuation restarts the landed streak at the continuation frame', () => {
    const fm = newFm();
    takeoff(fm);
    for (let t = 1_000; t <= 5_000; t += 1_000) frameAt(fm, t, LANDED);
    expect(fm.appState.flightState).toBe('FLYING');
    goTo(6_000);
    fm.onSimDisconnect();

    for (let t = 16_000; t <= 30_000 && fm.appState.flightState === 'FLYING'; t += 1_000) frameAt(fm, t, LANDED);

    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    expect(closeArgs().endTime).toBe(iso(25_000));
  });

  describe('(r) the same-flight decision uses the pause state from the start of the hold', () => {
    const frameBack = (fm: FlightManager) =>
      frameAt(fm, 65_000, { groundSpeedKnots: 120, ...northOfNm(KSBA, 6) });

    it('paused at the hold start, unpaused during it: 6 nm is a different flight', () => {
      const fm = newFm();
      takeoff(fm, { groundSpeedKnots: 120 });
      frameAt(fm, 5_000, { groundSpeedKnots: 120 });
      goTo(17_000);
      fm.setPaused(true, 1);
      fm.onSimDisconnect();
      goTo(40_000);
      fm.setPaused(false);

      frameBack(fm);

      expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
      expect(closeArgs().endTime).toBe(iso(5_000));
    });

    it('not paused at the hold start, paused during it: 6 nm is the same flight', () => {
      const fm = newFm();
      takeoff(fm, { groundSpeedKnots: 120 });
      frameAt(fm, 5_000, { groundSpeedKnots: 120 });
      goTo(17_000);
      fm.onSimDisconnect();
      goTo(40_000);
      fm.setPaused(true, 1);

      frameBack(fm);

      expect(dbMock.closeFlight).not.toHaveBeenCalled();
      expect(fm.appState.flightState).toBe('FLYING');
    });
  });
});
