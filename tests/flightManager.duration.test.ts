// tests/flightManager.duration.test.ts — tests src/flightManager.ts, part 2 of 3.
//
// Track-derived duration: the recording interval, the counted/uncounted gap
// rule, the interruption flag (pause and slew), the tail interval, and the
// accumulators closeFlight() is handed.
//
// Every expected duration below is written as a LITERAL and computed by hand in
// the comment above it from the advances the test itself made — never read back
// from the implementation, and never from a real wait. `duration_sec` is
// closeFlight's 5th argument (src/flightManager.ts:284-296).
//
// The two worked flights below (measured against a reference FlightManager
// implementation) are reproduced verbatim as
// "worked flight (a)" and "worked flight (b)".

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SimFrame } from '../src/types';
import { dbMock, resetMocks, makeFrame, northOfNm, KSBA, KLAX, T0, useFakeClock, useRealClock } from './helpers';
import { haversineNm } from '../src/geo';

vi.mock('../src/db', async () => (await import('./helpers')).dbMock);
vi.mock('../src/airports', async () => (await import('./helpers')).airportsMock);
vi.mock('../src/acarsEvents', async () => (await import('./helpers')).acarsEventsMock);

import { FlightManager, MAX_COUNTED_GAP_MS } from '../src/flightManager';

// src/flightManager.ts:11 — not exported, so transcribed deliberately.
const RECORD_INTERVAL_MS = 5000;

const advance = (ms: number) => vi.advanceTimersByTime(ms);
const LANDED: Partial<SimFrame> = { onGround: true, groundSpeedKnots: 2, airspeedKnots: 0 };

/** The ISO stamp the faked clock reads `ms` after T0. */
const iso = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

function takeoff(fm: FlightManager, over: Partial<SimFrame> = {}): void {
  for (let i = 0; i < 3; i++) fm.onFrame(makeFrame(over));
}

function feed(fm: FlightManager, n: number, over: Partial<SimFrame> = {}): void {
  for (let i = 0; i < n; i++) {
    advance(1000);
    fm.onFrame(makeFrame(over));
  }
}

/** closeFlight's positional arguments, named (src/flightManager.ts:284-296). */
function closeArgs() {
  expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
  const c = dbMock.closeFlight.mock.calls[0];
  return {
    flightId: c[0] as number,
    endTime: c[1] as string,
    lat: c[2] as number,
    lon: c[3] as number,
    durationSec: c[4] as number,
    distanceNm: c[5] as number,
    maxAltitudeFt: c[6] as number,
    maxAirspeedKts: c[7] as number,
    pointCount: c[8] as number,
  };
}

/** The ts argument of every insertPoint call, as ms since T0. */
function pointOffsetsMs(): number[] {
  return dbMock.insertPoint.mock.calls.map((c) => Date.parse(c[1] as string) - Date.parse(T0));
}

describe('FlightManager — recording interval', () => {
  beforeEach(() => {
    resetMocks();
    useFakeClock();
  });
  afterEach(() => useRealClock());

  // ── At most one point per RECORD_INTERVAL_MS ──────────────────────────────

  it('records at most one point per RECORD_INTERVAL_MS', () => {
    const fm = new FlightManager();
    takeoff(fm); // point 1, at t=0
    expect(dbMock.insertPoint).toHaveBeenCalledTimes(1);

    advance(RECORD_INTERVAL_MS - 1); // t = 4999
    fm.onFrame(makeFrame());
    expect(dbMock.insertPoint).toHaveBeenCalledTimes(1);

    advance(1); // t = 5000 — exactly the interval, `< RECORD_INTERVAL_MS` is false (:475)
    fm.onFrame(makeFrame());
    expect(dbMock.insertPoint).toHaveBeenCalledTimes(2);
    expect(pointOffsetsMs()).toEqual([0, 5000]);
  });

  it('a burst of frames inside one window still records one point', () => {
    const fm = new FlightManager();
    takeoff(fm);
    for (let i = 0; i < 4; i++) {
      advance(1000); // t = 1000..4000
      fm.onFrame(makeFrame());
    }
    expect(dbMock.insertPoint).toHaveBeenCalledTimes(1);

    advance(1000); // t = 5000
    fm.onFrame(makeFrame());
    expect(dbMock.insertPoint).toHaveBeenCalledTimes(2);
  });
});

describe('FlightManager — duration from counted gaps', () => {
  beforeEach(() => {
    resetMocks();
    useFakeClock();
  });
  afterEach(() => useRealClock());

  // ── Worked flight (a) ──────────────────────────────────────────────────────

  it('worked flight (a): a clean 20 s flight reports duration_sec = 20', () => {
    const fm = new FlightManager();
    takeoff(fm); // point at t=0
    feed(fm, 10); // t = 1..10 s, airborne -> points at t=5, t=10
    feed(fm, 10, LANDED); // t = 11..20 s -> points at t=15, t=20; lands on the 10th

    // 5 points at 0/5/10/15/20 s; four counted 5 s gaps; tail = 0 because the
    // landing frame is itself a point.  5+5+5+5 + 0 = 20 s.
    expect(pointOffsetsMs()).toEqual([0, 5000, 10000, 15000, 20000]);
    expect(dbMock.closeFlight).toHaveBeenCalledWith(
      1, iso(20000), 34.426201, -119.841507, 20, 0, 1500, 110, 5, null, null,
    );
  });

  // ── A multi-point flight with a non-zero tail ─────────────────────────────

  it('duration_sec is the counted gaps plus the tail: 5+5+5 + 3 = 18', () => {
    const fm = new FlightManager();
    takeoff(fm); // point 1 at t=0
    advance(5000); fm.onFrame(makeFrame()); // point 2 at t=5000   gap 5000 counted
    advance(5000); fm.onFrame(makeFrame()); // point 3 at t=10000  gap 5000 counted
    advance(5000); fm.onFrame(makeFrame()); // point 4 at t=15000  gap 5000 counted
    advance(3000); fm.onFrame(makeFrame()); // t=18000, below the interval -> no point
    fm.onCrash();                   // tail = 18000-15000 = 3000, counted

    expect(pointOffsetsMs()).toEqual([0, 5000, 10000, 15000]);
    expect(closeArgs().durationSec).toBe(18);
    expect(closeArgs().pointCount).toBe(4);
  });

  it('duration_sec is rounded to the nearest second, not truncated', () => {
    const fm = new FlightManager();
    takeoff(fm);                            // point 1 at t=0
    advance(5500); fm.onFrame(makeFrame()); // point 2 at t=5500, gap 5500 counted
    fm.onCrash();                   // tail 0

    // Math.round(5500/1000) = 6, not 5 (src/flightManager.ts:278).
    expect(closeArgs().durationSec).toBe(6);
  });

  // ── The MAX_COUNTED_GAP_MS boundary, both sides ───────────────────────────

  it('a gap of exactly MAX_COUNTED_GAP_MS is counted', () => {
    expect(MAX_COUNTED_GAP_MS).toBe(60_000);

    const fm = new FlightManager();
    takeoff(fm);                     // point 1 at t=0
    advance(60_000);
    fm.onFrame(makeFrame());         // point 2 at t=60000; gap 60000 <= 60000 -> counted
    fm.onCrash();            // tail = 0

    expect(dbMock.insertPoint).toHaveBeenCalledTimes(2);
    expect(closeArgs().durationSec).toBe(60);
  });

  it('a gap of MAX_COUNTED_GAP_MS + 1 is not counted', () => {
    const fm = new FlightManager();
    takeoff(fm);                     // point 1 at t=0
    advance(60_001);
    fm.onFrame(makeFrame());         // point 2 at t=60001; gap 60001 > 60000 -> dropped
    fm.onCrash();            // tail = 0

    // The point is still recorded — only the time between them is disowned.
    expect(dbMock.insertPoint).toHaveBeenCalledTimes(2);
    expect(closeArgs().durationSec).toBe(0);
  });

  // ── The tail interval, all four branches ──────────────────────────────────

  it('the tail is counted when the flight was not interrupted and it fits the budget', () => {
    const fm = new FlightManager();
    takeoff(fm);                            // point 1 at t=0
    advance(5000); fm.onFrame(makeFrame()); // point 2 at t=5000, gap counted
    advance(4000);                          // 4 s with no frame at all
    fm.onCrash();                   // tail 4000 -> counted.  5 + 4 = 9
    expect(closeArgs().durationSec).toBe(9);
  });

  it('a tail of exactly MAX_COUNTED_GAP_MS is counted; one millisecond more is not', () => {
    const fm = new FlightManager();
    takeoff(fm);
    advance(5000); fm.onFrame(makeFrame()); // point 2 at t=5000, gap counted
    advance(60_000);
    fm.onCrash();                   // tail 60000 <= 60000.  5 + 60 = 65
    expect(closeArgs().durationSec).toBe(65);

    resetMocks();
    const fm2 = new FlightManager();
    takeoff(fm2);
    advance(5000); fm2.onFrame(makeFrame());
    advance(60_001);
    fm2.onCrash();                  // tail 60001 > 60000 -> dropped.  5 + 0 = 5
    expect(closeArgs().durationSec).toBe(5);
  });

  it('an interrupted tail is excluded even though it fits the budget', () => {
    const fm = new FlightManager();
    takeoff(fm);
    advance(5000); fm.onFrame(makeFrame()); // point 2 at t=5000, gap counted
    fm.setPaused(true, 1);                  // marks interrupted (:177)
    advance(4000);                          // the same 4 s tail as the test above
    fm.onCrash();
    // 5 + 0 = 5, not the 9 the un-interrupted tail produced.
    expect(closeArgs().durationSec).toBe(5);
  });

  // ── Wall clock far exceeds counted time ───────────────────────────────────

  it('a flight with one over-long gap reports only the counted time', () => {
    const fm = new FlightManager();
    takeoff(fm);                             // point 1 at t=0
    advance(5000);   fm.onFrame(makeFrame()); // point 2 at t=5000    gap 5000 counted
    advance(120_000); fm.onFrame(makeFrame()); // point 3 at t=125000 gap 120000 dropped
    advance(5000);   fm.onFrame(makeFrame()); // point 4 at t=130000  gap 5000 counted
    fm.onCrash();                     // tail 0

    const c = closeArgs();
    // Wall clock start->end is 130 s; counted is 5 + 5 = 10.
    expect(c.endTime).toBe('2026-09-09T12:02:10.000Z');
    expect(Date.parse(c.endTime) - Date.parse(T0)).toBe(130_000);
    expect(c.durationSec).toBe(10);
    expect(c.pointCount).toBe(4);
  });
});

describe('FlightManager — interruption excludes the gap that spans it', () => {
  beforeEach(() => {
    resetMocks();
    useFakeClock();
  });
  afterEach(() => useRealClock());

  // The three tests below are the same 30-second flight three ways. The only
  // difference is what happens between t=6 s and t=15 s, and it moves
  // duration_sec from 30 to 15 — i.e. the 15 s gap that spans the interruption
  // is dropped by `!this.interrupted` (:493), NOT by MAX_COUNTED_GAP_MS, which
  // 15000 is nowhere near. Deleting that clause turns both 15s below into 30.

  /** t=0 takeoff, point at t=5, then `during` for t=6..15, then a point at
   *  t=20 and a landing over t=21..30. */
  function thirtySecondFlight(fm: FlightManager, during: (fm: FlightManager) => void): void {
    takeoff(fm);                              // point 1 at t=0
    advance(5000); fm.onFrame(makeFrame());   // point 2 at t=5000, gap 5000 counted
    during(fm);                               // t = 6000..15000
    advance(5000); fm.onFrame(makeFrame());   // point 3 at t=20000
    feed(fm, 10, LANDED);                     // t = 21000..30000, lands on the 10th
  }

  it('control: with no interruption at all the same flight is 30 s', () => {
    const fm = new FlightManager();
    thirtySecondFlight(fm, (f) => feed(f, 10)); // ten ordinary airborne frames

    // Points at 0/5/10/15/20/25/30 — six counted 5 s gaps, tail 0.
    expect(pointOffsetsMs()).toEqual([0, 5000, 10000, 15000, 20000, 25000, 30000]);
    expect(closeArgs().durationSec).toBe(30);
  });

  // ── A 10 s pause, well under MAX_COUNTED_GAP_MS ───────────────────────────

  it('a 10 s pause is excluded from duration_sec even though it is far under the 60 s gap budget', () => {
    const fm = new FlightManager();
    thirtySecondFlight(fm, (f) => {
      f.setPaused(true, 4);
      feed(f, 10);        // t = 6000..15000, every frame suppressed (:206)
      f.setPaused(false);
    });

    // Points at 0/5/20/25/30 — nothing between 5 s and 20 s.
    expect(pointOffsetsMs()).toEqual([0, 5000, 20000, 25000, 30000]);
    // 5 (0->5) + 0 (5->20, interrupted) + 5 (20->25) + 5 (25->30) + tail 0 = 15.
    expect(closeArgs().durationSec).toBe(15);
    // …against a 30 s wall clock, and against the 30 s the control reports.
    expect(Date.parse(closeArgs().endTime) - Date.parse(T0)).toBe(30_000);
    expect(15_000).toBeLessThan(MAX_COUNTED_GAP_MS); // the dropped gap was never over budget
  });

  // ── Slew does exactly what a pause does ───────────────────────────────────

  it('slew (simRunning === 3) while FLYING records nothing and interrupts the following gap', () => {
    const fm = new FlightManager();
    thirtySecondFlight(fm, (f) => feed(f, 10, { simRunning: 3 })); // t = 6000..15000

    expect(pointOffsetsMs()).toEqual([0, 5000, 20000, 25000, 30000]);
    expect(closeArgs().durationSec).toBe(15);
    expect(fm.appState.flightState).toBe('IDLE');
  });

  // ── Worked flight (b) ──────────────────────────────────────────────────────

  it('worked flight (b): a 35 s pause leaves duration_sec = 15 on a 50 s flight', () => {
    const fm = new FlightManager();
    takeoff(fm);                            // point 1 at t=0
    advance(5000); fm.onFrame(makeFrame()); // point 2 at t=5000
    fm.setPaused(true, 4);
    expect(fm.appState.pauseFlags).toBe(4);
    feed(fm, 30);                           // t = 6..35 s, all suppressed
    expect(dbMock.insertPoint).toHaveBeenCalledTimes(2);
    fm.setPaused(false);
    advance(5000); fm.onFrame(makeFrame()); // point 3 at t=40000; 35 s gap dropped
    feed(fm, 10, LANDED);                   // t = 41..50 s; points at 45 and 50

    expect(pointOffsetsMs()).toEqual([0, 5000, 40_000, 45_000, 50_000]);
    // 5 + 5 + 5 = 15; the 35 000 ms gap is under MAX_COUNTED_GAP_MS and is
    // dropped only because the pause set `interrupted`.
    expect(dbMock.closeFlight).toHaveBeenCalledWith(
      1, iso(50_000), 34.426201, -119.841507, 15, 0, 1500, 110, 5, null, null,
    );
  });
});

describe('FlightManager — accumulators handed to closeFlight', () => {
  beforeEach(() => {
    resetMocks();
    useFakeClock();
  });
  afterEach(() => useRealClock());

  // ── Distance and max accumulators only count recorded points ─────────────

  it('distance is rounded to 0.1 nm and sums recorded points only; maxima ignore unrecorded frames', () => {
    // Two legs due north of KSBA. Never an arc-minute: northOfNm uses this
    // codebase's own R = 3440.065.
    const p2 = northOfNm(KSBA, 12.34);
    const p3 = northOfNm(p2, 5.28);
    const legs = haversineNm(KSBA.lat, KSBA.lon, p2.lat, p2.lon) + haversineNm(p2.lat, p2.lon, p3.lat, p3.lon);

    const fm = new FlightManager();
    takeoff(fm); // point 1 at KSBA, t=0 — startFlight seeds maxima at 1500 ft / 110 kt

    // t=1000: far away, far higher, far faster — but inside the recording
    // window, so it is not a point and must contribute nothing.
    advance(1000);
    fm.onFrame(makeFrame({ lat: KLAX.lat, lon: KLAX.lon, altitudeFt: 9999, airspeedKnots: 999 }));

    advance(4000); // t=5000
    fm.onFrame(makeFrame({ lat: p2.lat, lon: p2.lon, altitudeFt: 3000, airspeedKnots: 130 })); // point 2

    advance(1000); // t=6000 — unrecorded again
    fm.onFrame(makeFrame({ lat: KLAX.lat, lon: KLAX.lon, altitudeFt: 8888, airspeedKnots: 888 }));

    advance(4000); // t=10000
    fm.onFrame(makeFrame({ lat: p3.lat, lon: p3.lon, altitudeFt: 2000, airspeedKnots: 90 })); // point 3

    fm.onCrash();

    const c = closeArgs();
    expect(dbMock.insertPoint).toHaveBeenCalledTimes(3);
    expect(c.pointCount).toBe(3);
    expect(c.pointCount).toBe(dbMock.insertPoint.mock.calls.length);

    // 12.34 + 5.28 = 17.62 nm, rounded to one decimal by Math.round(d*10)/10.
    expect(c.distanceNm).toBe(17.6);
    expect(c.distanceNm).toBe(Math.round(legs * 10) / 10);
    expect(legs).toBeGreaterThan(17.6); // the raw sum is not what was stored
    expect(legs).toBeCloseTo(17.62, 6);

    // The 9999 ft / 999 kt and 8888 ft / 888 kt frames were never points.
    expect(c.maxAltitudeFt).toBe(3000);
    expect(c.maxAirspeedKts).toBe(130);

    // …and the flight ended where the last frame was.
    expect(c.lat).toBe(p3.lat);
    expect(c.lon).toBe(p3.lon);
    expect(c.durationSec).toBe(10);
  });

  it('distance stays 0 and the maxima stay at the takeoff frame when nothing changes', () => {
    const fm = new FlightManager();
    takeoff(fm);
    feed(fm, 10, LANDED);
    const c = closeArgs();
    expect(c.distanceNm).toBe(0);
    expect(c.maxAltitudeFt).toBe(1500);
    expect(c.maxAirspeedKts).toBe(110);
  });
});
