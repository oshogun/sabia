// tests/flight/flightRecorder.stopClockAt.test.ts — FlightRecorder.stopClock(atMs).
//
// With atMs the flight ends at that instant (the receive time of the last frame
// before a silence) instead of now. Points are at t=0 and t=5_000 and the clock
// is then advanced to t=200_000, so a result that followed the clock would show.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetMocks, makeFrame, T0, useFakeClock, useRealClock } from '../helpers';

vi.mock('../../src/db', async () => (await import('../helpers')).dbMock);

import { FlightRecorder } from '../../src/flight/flightRecorder';

const advance = (ms: number) => vi.advanceTimersByTime(ms);
const iso = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

function twoPoints(): FlightRecorder {
  const rec = new FlightRecorder();
  const id = rec.begin(makeFrame(), null, iso(0));
  rec.startClock();
  rec.writePoint(id, makeFrame());
  advance(5000);
  rec.writePoint(id, makeFrame());
  return rec;
}

describe('FlightRecorder.stopClock(atMs)', () => {
  beforeEach(() => {
    resetMocks();
    useFakeClock();
  });
  afterEach(() => useRealClock());

  it('ends at atMs and counts the tail up to it, not up to now', () => {
    const rec = twoPoints();
    advance(195_000);
    const tally = rec.stopClock(Date.parse(iso(8000)));
    expect(tally).toEqual({ endTime: iso(8000), durationSec: 8, excludedSec: 0 });
  });

  it('drops the tail when the flight was interrupted', () => {
    const rec = twoPoints();
    rec.markInterrupted();
    advance(195_000);
    expect(rec.stopClock(Date.parse(iso(8000))).durationSec).toBe(5);
  });

  it('drops a tail longer than the counted-gap budget', () => {
    const rec = twoPoints();
    advance(195_000);
    const tally = rec.stopClock(Date.parse(iso(70_000)));
    expect(tally.durationSec).toBe(5);
    expect(tally.endTime).toBe(iso(70_000));
    expect(tally.excludedSec).toBe(65);
  });

  it('does not read the clock', () => {
    const rec = twoPoints();
    advance(195_000);
    const now = vi.spyOn(Date, 'now');
    rec.stopClock(Date.parse(iso(8000)));
    expect(now).not.toHaveBeenCalled();
  });
});
