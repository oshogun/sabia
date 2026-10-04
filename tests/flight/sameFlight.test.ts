// tests/flight/sameFlight.test.ts — tests src/flight/sameFlight.ts.
//
// Positions are built with northOfNm(KSBA, nm) so the distance between the two
// frames is the figure in the title. The rule is `distance <= allowance`, so
// the boundary cases sit at exactly the allowance and at 0.1 nm either side.

import { describe, it, expect } from 'vitest';
import { makeFrame, northOfNm, KSBA } from '../helpers';
import { isSameFlight } from '../../src/flight/sameFlight';

const last = (over = {}) => makeFrame({ ...KSBA, groundSpeedKnots: 0, ...over });
const next = (nm: number, over = {}) => makeFrame({ ...northOfNm(KSBA, nm), ...over });

describe('isSameFlight', () => {
  it('rejects a different aircraft string at distance 0', () => {
    expect(isSameFlight({
      last: last(), lastWasPaused: true, next: next(0, { aircraft: 'Cessna 182' }), elapsedMs: 1000,
    })).toBe(false);
  });

  it('accepts the same aircraft at distance 0', () => {
    expect(isSameFlight({ last: last(), lastWasPaused: true, next: next(0), elapsedMs: 1000 })).toBe(true);
  });

  it('paused: accepts exactly 5.0 nm and rejects 5.1 nm', () => {
    expect(isSameFlight({ last: last(), lastWasPaused: true, next: next(5), elapsedMs: 1000 })).toBe(true);
    expect(isSameFlight({ last: last(), lastWasPaused: true, next: next(5.1), elapsedMs: 1000 })).toBe(false);
  });

  it('not paused: 120 kt for 60 s grows the allowance to 7.0 nm', () => {
    const base = { last: last({ groundSpeedKnots: 120 }), lastWasPaused: false, elapsedMs: 60_000 };
    expect(isSameFlight({ ...base, next: next(6.9) })).toBe(true);
    expect(isSameFlight({ ...base, next: next(7) })).toBe(true);
    expect(isSameFlight({ ...base, next: next(7.1) })).toBe(false);
  });

  it('paused: ignores the ground speed', () => {
    const base = { last: last({ groundSpeedKnots: 120 }), lastWasPaused: true, elapsedMs: 60_000 };
    expect(isSameFlight({ ...base, next: next(5) })).toBe(true);
    expect(isSameFlight({ ...base, next: next(5.1) })).toBe(false);
    expect(isSameFlight({ ...base, next: next(6.9) })).toBe(false);
  });

  it('rejects a return after 180_001 ms even at distance 0, and accepts exactly 180_000 ms', () => {
    expect(isSameFlight({ last: last(), lastWasPaused: false, next: next(0), elapsedMs: 180_001 })).toBe(false);
    expect(isSameFlight({ last: last(), lastWasPaused: false, next: next(0), elapsedMs: 180_000 })).toBe(true);
  });

  it('takes its own time limit when given one, inclusive like the default', () => {
    const base = { last: last(), lastWasPaused: false, next: next(0), maxElapsedMs: 600_000 };
    expect(isSameFlight({ ...base, elapsedMs: 600_000 })).toBe(true);
    expect(isSameFlight({ ...base, elapsedMs: 600_001 })).toBe(false);
    expect(isSameFlight({ ...base, elapsedMs: 180_001 })).toBe(true);
  });

  it('a given time limit leaves the aircraft and distance checks as they are', () => {
    const base = { last: last({ groundSpeedKnots: 60 }), lastWasPaused: false, elapsedMs: 600_000, maxElapsedMs: 600_000 };
    // 5 nm + 60 kt for 10 min = 15 nm.
    expect(isSameFlight({ ...base, next: next(15) })).toBe(true);
    expect(isSameFlight({ ...base, next: next(15.1) })).toBe(false);
    expect(isSameFlight({ ...base, next: next(0, { aircraft: 'Cessna 182' }) })).toBe(false);
  });

  it('treats a NaN ground speed as 0', () => {
    const base = { last: last({ groundSpeedKnots: NaN }), lastWasPaused: false, elapsedMs: 60_000 };
    expect(isSameFlight({ ...base, next: next(5) })).toBe(true);
    expect(isSameFlight({ ...base, next: next(5.1) })).toBe(false);
  });

  it('treats a negative ground speed as 0', () => {
    const base = { last: last({ groundSpeedKnots: -50 }), lastWasPaused: false, elapsedMs: 60_000 };
    expect(isSameFlight({ ...base, next: next(5.1) })).toBe(false);
  });
});
