// Two values in the resume path that a restart produces and the other
// flightManager*.test.ts files never exercise with a telling input: the
// whole-second figure in the "resumed after restart" log line, and the
// fall-back for a start time that parses to epoch 0. Both differ from a near
// miss only on an input those files do not use (a gap that is not a whole
// number of seconds; a start time of exactly the epoch).
//
// These tests go through the public API only, so they keep holding wherever
// the resume arithmetic lives. Same five IO boundaries and harness as
// flightManager.gaps.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useFakeClock, useRealClock, northOfNm, KSBA } from './helpers';

vi.mock('../src/db', async () => (await import('./helpers/callOrder')).dbStub);
vi.mock('../src/db/groundSessions', async () => (await import('./helpers/callOrder')).groundSessionsStub);
vi.mock('../src/airports', async () => (await import('./helpers/callOrder')).airportsStub);
vi.mock('../src/acarsEvents', async () => (await import('./helpers/callOrder')).acarsEventsStub);
vi.mock('../src/acars', async (importOriginal) =>
  (await import('./helpers/callOrder')).wrapAcars(await importOriginal<typeof import('../src/acars')>()));

import { FlightManager } from '../src/flightManager';
import {
  behave, takeLog, captureConsole, attachListener, resetCallOrder,
  type Entry, type ConsoleEntry,
  iso, feed, cruise, openRow,
} from './helpers/callOrder';

function newFm(): FlightManager {
  const fm = new FlightManager();
  attachListener(fm);
  return fm;
}

const logLines = (log: Entry[]): string[] => log.filter(e => e.t === 'log').map(e => (e as ConsoleEntry).text);

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

const pt = (nm: number, ts: string) => {
  const p = northOfNm(KSBA, nm);
  return { lat: p.lat, lon: p.lon, altitude_ft: 3000, airspeed_kts: 120, ts };
};

describe('resume log line and start-time fallback', () => {
  it.each([
    [5400, 5],
    [5500, 6],
  ])('a stored gap of %i ms is reported as %i s counted before the interruption', (gapMs, seconds) => {
    behave.db.getOpenFlight = () => openRow();
    behave.db.getFlightTrackPoints = () => [pt(0, iso(-60_000)), pt(1, iso(-60_000 + gapMs))];
    const fm = newFm();
    feed(fm, 1, northOfNm(KSBA, 1));
    const log = takeLog();
    expect(logLines(log)).toContain(
      `[FlightManager] Flight #77 resumed after restart — 2 points, 1.0 nm, ${seconds}s counted before the interruption`,
    );
  });

  it('a resumed row whose start time is exactly the epoch keeps it, rather than falling back to now', () => {
    behave.db.getOpenFlight = () => openRow({ start_time: '1970-01-01T00:00:00.000Z' });
    // A stored point a minute back: with none, the restart check would measure
    // from the start time itself and close the flight instead.
    behave.db.getFlightTrackPoints = () => [pt(0, iso(-60_000))];
    const fm = newFm();
    feed(fm, 1, northOfNm(KSBA, 1));
    cruise(fm, 2, northOfNm(KSBA, 2));
    feed(fm, 1, { simRunning: 0 });
    const endedAtSec = Math.round(Date.now() / 1000);
    const log = takeLog();
    const ended = logLines(log).find(l => l.startsWith('[FlightManager] Flight #77 ended'));
    // Every second since the epoch is either counted or excluded, so the two
    // figures on the line add up to the clock reading; a start time replaced
    // by the resume instant would leave only the outage excluded.
    const m = /, (\d+)s \((\d+)s interrupted, excluded\)$/.exec(ended ?? '');
    expect(m).not.toBeNull();
    expect(Number(m![1]) + Number(m![2])).toBe(endedAtSec);
  });
});
