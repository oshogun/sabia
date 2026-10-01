// tests/flight/groundExits.test.ts — the two GROUND exits that must end the frame.
//
// A slew and a jump away from the anchor each close the session and return to
// IDLE, and that frame goes no further. After a slew the ground tracker is not
// consulted again (it would start an off-blocks instant on the freshly reset
// tracker); after a jump the airborne debounce does not count the frame. Both
// are only visible through what a later takeoff files and when it starts, so
// each test drives a real FlightManager through the public methods with the IO
// boundaries stubbed, the same way the characterization net does.
//
// The last block pins the frame dispatcher's own rules the same way: which
// frame is stored, which handler a frame reaches, and what counts as a slew,
// a parked frame or a landed one.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { northOfNm, KSBA, useFakeClock, useRealClock } from '../helpers';

vi.mock('../../src/db', async () => (await import('../helpers/callOrder')).dbStub);
vi.mock('../../src/db/groundSessions', async () => (await import('../helpers/callOrder')).groundSessionsStub);
vi.mock('../../src/airports', async () => (await import('../helpers/callOrder')).airportsStub);
vi.mock('../../src/acarsEvents', async () => (await import('../helpers/callOrder')).acarsEventsStub);
vi.mock('../../src/acars', async (importOriginal) =>
  (await import('../helpers/callOrder')).wrapAcars(await importOriginal<typeof import('../../src/acars')>()));

import { FlightManager } from '../../src/flightManager';
import {
  takeLog, captureConsole, resetCallOrder, TAXI, feed, takeoff, cruise, park, callsTo,
} from '../helpers/callOrder';
import { behave, boom, thrown, land, PARKED } from '../helpers/callOrder';

const savedInterval = process.env.POSITION_REPORT_INTERVAL_MIN;

beforeEach(() => {
  resetCallOrder();
  useFakeClock();
  captureConsole();
  delete process.env.POSITION_REPORT_INTERVAL_MIN;
});
afterEach(() => {
  useRealClock();
  if (savedInterval === undefined) delete process.env.POSITION_REPORT_INTERVAL_MIN;
  else process.env.POSITION_REPORT_INTERVAL_MIN = savedInterval;
});

const far = northOfNm(KSBA, 20);

describe('a GROUND exit ends its frame', () => {
  it('a slew frame at taxi speed closes the session without starting the off-blocks memo', () => {
    const fm = new FlightManager();
    park(fm);
    expect(fm.appState.flightState).toBe('GROUND');
    feed(fm, 1, { ...TAXI, simRunning: 3 });
    expect(fm.appState.flightState).toBe('IDLE');
    takeoff(fm); cruise(fm, 1);

    const out = callsTo(takeLog(), 'acars.buildOooiMessage')[0].args[0];
    expect(out).toMatchObject({ event: 'OUT', estimated: true });
  });

  it('an airborne frame that jumps away from the anchor does not count towards the takeoff debounce', () => {
    const fm = new FlightManager();
    park(fm);
    feed(fm, 1, far);
    expect(fm.appState.flightState).toBe('IDLE');

    feed(fm, 2, far);
    expect(fm.appState.flightState).toBe('IDLE');
    expect(callsTo(takeLog(), 'db.insertFlight')).toHaveLength(0);

    feed(fm, 1, far);
    expect(fm.appState.flightState).toBe('FLYING');
    expect(callsTo(takeLog(), 'db.insertFlight')).toHaveLength(1);
  });
});

describe('the frame dispatcher', () => {
  it('stores each frame before handling it, so a frame whose handling throws is still the last one seen', () => {
    const fm = new FlightManager();
    takeoff(fm); cruise(fm, 1);
    behave.db.insertPoint = boom('point failed');
    const f = northOfNm(KSBA, 40);

    expect(thrown(() => cruise(fm, 1, f))).toBe('point failed');
    expect(fm.appState.lastFrame?.lat).toBe(f.lat);
  });

  it('a takeoff frame from GROUND is handled once, so a pause around it leaves the duration alone', () => {
    const closedDuration = (paused: boolean): number => {
      resetCallOrder();
      const fm = new FlightManager();
      park(fm);
      expect(fm.appState.flightState).toBe('GROUND');
      if (paused) fm.setPaused(true, 4);
      takeoff(fm);
      expect(fm.appState.flightState).toBe('FLYING');
      if (paused) fm.setPaused(false);
      cruise(fm, 2); land(fm);
      return callsTo(takeLog(), 'db.closeFlight')[0].args[4] as number;
    };

    expect(closedDuration(false)).toBe(20);
    expect(closedDuration(true)).toBe(20);
  });

  it('only simRunning 3 is a slew: any other running code records points and keeps a ground session', () => {
    const fm = new FlightManager();
    takeoff(fm); cruise(fm, 2, { simRunning: 2 });
    expect(callsTo(takeLog(), 'db.insertPoint')).toHaveLength(3);

    const parked = new FlightManager();
    park(parked);
    feed(parked, 1, { ...PARKED, simRunning: 2 });
    expect(parked.appState.flightState).toBe('GROUND');
    expect(callsTo(takeLog(), 'groundSessions.closeOpenGroundSession')).toHaveLength(0);
  });

  it('a slew frame breaks the parked streak', () => {
    const fm = new FlightManager();
    park(fm, 4);
    feed(fm, 1, { ...PARKED, simRunning: 3 });
    park(fm, 1);
    expect(fm.appState.flightState).toBe('IDLE');

    park(fm, 4);
    expect(fm.appState.flightState).toBe('GROUND');
  });

  it('a frame that is both a slew and away from the anchor closes the session as slew', () => {
    const fm = new FlightManager();
    park(fm);
    feed(fm, 1, { ...PARKED, ...far, simRunning: 3 });

    expect(fm.appState.flightState).toBe('IDLE');
    expect(callsTo(takeLog(), 'groundSessions.closeOpenGroundSession').map(c => c.args[0])).toEqual(['slew']);
  });

  it('slow airborne frames do not count towards the landed debounce', () => {
    const fm = new FlightManager();
    takeoff(fm);
    feed(fm, 12, { groundSpeedKnots: 2 });
    expect(fm.appState.flightState).toBe('FLYING');
    expect(callsTo(takeLog(), 'db.closeFlight')).toHaveLength(0);
  });
});
