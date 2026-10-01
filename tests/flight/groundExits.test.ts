// tests/flight/groundExits.test.ts — the two GROUND exits that must end the frame.
//
// A slew and a jump away from the anchor each close the session and return to
// IDLE, and that frame goes no further. After a slew the ground tracker is not
// consulted again (it would start an off-blocks instant on the freshly reset
// tracker); after a jump the airborne debounce does not count the frame. Both
// are only visible through what a later takeoff files and when it starts, so
// each test drives a real FlightManager through the public methods with the IO
// boundaries stubbed, the same way the characterization net does.

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
