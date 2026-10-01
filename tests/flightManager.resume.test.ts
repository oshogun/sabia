// tests/flightManager.resume.test.ts — adopting an already-open flights row
// at boot, instead of starting a new one.
//
// Covers the once-per-process open-flight check at the top of
// checkAirborneDebounce() and the private resumeFlight() it calls: adopting
// instead of duplicating, the on-ground self-heal for a flight that landed
// while the server was down, duration/distance reconstruction from the
// seeded track across the outage, and the zero-flight_points edge case.
//
// Every expected duration and distance below is a LITERAL computed by hand in
// the comment above it, from the advances the test itself made — never read
// back from the implementation and never from a real wait. Same convention as
// tests/flightManager.duration.test.ts.
//
// Hermetic like its siblings: './db', './airports' and './acarsEvents' are
// all replaced wholesale via tests/helpers, so no native binding and no
// database file is ever opened. getOpenFlight() is mocked here too, so its
// multiple-open-rows anomaly (adopt the newest, warn about the rest) is not
// testable through this harness — that is verified separately against real
// SQL, against a real SQLite file.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SimFrame } from '../src/types';
import type { OpenFlightRow, FlightTrackPoint } from '../src/db';
import {
  dbMock, acarsEventsMock, resetMocks, makeFrame, makePlannedLegWithChildren,
  northOfNm, KSBA, T0, useFakeClock, useRealClock,
} from './helpers';

vi.mock('../src/db', async () => (await import('./helpers')).dbMock);
vi.mock('../src/airports', async () => (await import('./helpers')).airportsMock);
vi.mock('../src/acarsEvents', async () => (await import('./helpers')).acarsEventsMock);

import { FlightManager, MAX_COUNTED_GAP_MS } from '../src/flightManager';
import { haversineNm } from '../src/geo';

const advance = (ms: number) => vi.advanceTimersByTime(ms);
const LANDED: Partial<SimFrame> = { onGround: true, groundSpeedKnots: 2, airspeedKnots: 0 };

/** The ISO stamp the faked clock reads `ms` after T0 (negative for before). */
const iso = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

function takeoff(fm: FlightManager, over: Partial<SimFrame> = {}): void {
  for (let i = 0; i < 3; i++) fm.onFrame(makeFrame(over));
}

/** Feeds n frames 1 s apart, the same shape tests/flightManager.duration.test.ts uses. */
function feed(fm: FlightManager, n: number, over: Partial<SimFrame> = {}): void {
  for (let i = 0; i < n; i++) {
    advance(1000);
    fm.onFrame(makeFrame(over));
  }
}

// One consumer each — declared locally per tests/helpers/index.ts's own rule
// that a fixture with exactly one consumer lives with that consumer.

function makeOpenFlightRow(over: Partial<OpenFlightRow> = {}): OpenFlightRow {
  return {
    id: 77,
    aircraft: 'A320',
    start_time: T0,
    departure_lat: KSBA.lat,
    departure_lon: KSBA.lon,
    ...over,
  };
}

function makeTrackPoint(over: Partial<FlightTrackPoint> = {}): FlightTrackPoint {
  return {
    lat: KSBA.lat,
    lon: KSBA.lon,
    altitude_ft: 5000,
    airspeed_kts: 120,
    ts: T0,
    ...over,
  };
}

/** Four points 5 s apart, T0-45s..T0-30s — three counted gaps, 15 000 ms. */
function fourPointTrack(): FlightTrackPoint[] {
  return [
    makeTrackPoint({ ts: iso(-45000) }),
    makeTrackPoint({ ts: iso(-40000) }),
    makeTrackPoint({ ts: iso(-35000) }),
    makeTrackPoint({ ts: iso(-30000) }),
  ];
}

/** What a later process reads back: every point stored so far, with its interruption mark. */
const snapshotTrack = (): FlightTrackPoint[] => dbMock.insertPoint.mock.calls.map(c => ({
  ts: c[1] as string, lat: c[2] as number, lon: c[3] as number,
  altitude_ft: c[4] as number, airspeed_kts: c[5] as number,
  after_interruption: c[10] ? 1 : 0,
}));

describe('FlightManager — adopting an open flight at boot', () => {
  beforeEach(() => {
    resetMocks();
    useFakeClock();
  });
  afterEach(() => useRealClock());

  it('adopts the open flight on the very first frame instead of inserting a second row', () => {
    dbMock.getOpenFlight.mockImplementation(() => makeOpenFlightRow({ start_time: iso(-45000) }));
    dbMock.getFlightTrackPoints.mockImplementation(() => fourPointTrack());

    const fm = new FlightManager();
    fm.onFrame(makeFrame());

    expect(dbMock.insertFlight).not.toHaveBeenCalled();
    expect(fm.appState.flightState).toBe('FLYING');
    expect(fm.appState.currentFlightId).toBe(77);
    expect(dbMock.insertPoint).toHaveBeenCalledTimes(1);
    expect(dbMock.insertPoint.mock.calls[0][0]).toBe(77);
  });

  it('runs the open-flight lookup exactly once per instance', () => {
    dbMock.getOpenFlight.mockImplementation(() => makeOpenFlightRow({ start_time: iso(-45000) }));
    dbMock.getFlightTrackPoints.mockImplementation(() => fourPointTrack());

    const fm = new FlightManager();
    fm.onFrame(makeFrame()); // the resume frame
    feed(fm, 20); // twenty more airborne frames, 1 s apart

    expect(dbMock.getOpenFlight).toHaveBeenCalledTimes(1);
  });

  it('does not file OUT or OFF, close a ground session, or re-link a planned leg', () => {
    dbMock.getOpenFlight.mockImplementation(() => makeOpenFlightRow({ start_time: iso(-45000) }));
    dbMock.getFlightTrackPoints.mockImplementation(() => fourPointTrack());

    const fm = new FlightManager();
    fm.onFrame(makeFrame());

    expect(acarsEventsMock.fileAcarsMessageOnce).not.toHaveBeenCalled();
    expect(dbMock.linkFlightToPlannedLeg).not.toHaveBeenCalled();
    expect(dbMock.getFlightPlannedLegId).toHaveBeenCalledWith(77);
  });

  it('restores a planned-leg link read-only', () => {
    dbMock.getOpenFlight.mockImplementation(() => makeOpenFlightRow({ start_time: iso(-45000) }));
    dbMock.getFlightTrackPoints.mockImplementation(() => fourPointTrack());
    dbMock.getFlightPlannedLegId.mockImplementation(() => 11);
    dbMock.getPlannedLegById.mockImplementation(() => makePlannedLegWithChildren());

    const fm = new FlightManager();
    fm.onFrame(makeFrame());

    const status = fm.getPlannedLegStatus(KSBA.lat, KSBA.lon);
    expect(status).not.toBeNull();
    expect(status?.destinationIdent).toBe('KMRY');
    expect(dbMock.linkFlightToPlannedLeg).not.toHaveBeenCalled();
  });

  it('behaves exactly as today when no flight is open', () => {
    // dbMock.getOpenFlight defaults to () => null via resetMocks().
    const fm = new FlightManager();
    takeoff(fm); // three airborne frames -> AIRBORNE_DEBOUNCE_FRAMES

    expect(dbMock.insertFlight).toHaveBeenCalledTimes(1);
    expect(dbMock.getOpenFlight).toHaveBeenCalledTimes(1);
  });
});

describe('FlightManager — a flight that landed while the server was down', () => {
  beforeEach(() => {
    resetMocks();
    useFakeClock();
  });
  afterEach(() => useRealClock());

  it('adopts an open flight from an on-ground, slow first frame', () => {
    dbMock.getOpenFlight.mockImplementation(() => makeOpenFlightRow({ start_time: iso(-45000) }));
    dbMock.getFlightTrackPoints.mockImplementation(() => fourPointTrack());

    const fm = new FlightManager();
    fm.onFrame(makeFrame(LANDED));

    expect(fm.appState.flightState).toBe('FLYING');
  });

  it('never enters GROUND and closes the flight through the ordinary landed debounce', () => {
    dbMock.getOpenFlight.mockImplementation(() => makeOpenFlightRow({ start_time: iso(-45000) }));
    dbMock.getFlightTrackPoints.mockImplementation(() => fourPointTrack());
    const warnSpy = vi.spyOn(console, 'warn');

    const fm = new FlightManager();
    fm.onFrame(makeFrame(LANDED)); // resume, adopted on the spot
    expect(fm.getGroundSessionStatus()).toBeNull();
    expect(fm.appState.flightState).not.toBe('GROUND');

    // LANDED_DEBOUNCE_FRAMES (10) more on-ground/slow frames, 1 s apart.
    for (let i = 0; i < 10; i++) {
      advance(1000);
      fm.onFrame(makeFrame(LANDED));
      expect(fm.getGroundSessionStatus()).toBeNull();
      expect(fm.appState.flightState).not.toBe('GROUND');
    }

    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    expect(dbMock.closeFlight.mock.calls[0][0]).toBe(77);

    // The positive proof enterGround() never ran: src/db/groundSessions is not
    // mocked in this harness, so a real call would reach getDb() with no
    // database open and log exactly this warning from its own catch.
    const groundEntryFailed = warnSpy.mock.calls.some(
      (args) => typeof args[0] === 'string' && args[0].includes('Ground session entry failed')
    );
    expect(groundEntryFailed).toBe(false);
  });
});

describe('FlightManager — duration across a restart', () => {
  beforeEach(() => {
    resetMocks();
    useFakeClock();
  });
  afterEach(() => useRealClock());

  it('worked resume: 15 s flown before the crash + 30 s of downtime + 20 s after = 35 s', () => {
    // The dropped gap is well under the 60 s budget — it is `interrupted`,
    // not MAX_COUNTED_GAP_MS, that excludes it.
    expect(30_000).toBeLessThan(MAX_COUNTED_GAP_MS);

    dbMock.getOpenFlight.mockImplementation(() => makeOpenFlightRow({ start_time: iso(-45000) }));
    dbMock.getFlightTrackPoints.mockImplementation(() => fourPointTrack());

    const fm = new FlightManager();
    fm.onFrame(makeFrame()); // resume + resume point; the 30 s outage gap is dropped

    advance(5000); fm.onFrame(makeFrame()); // point at +5 s, gap counted
    advance(5000); fm.onFrame(makeFrame()); // point at +10 s, gap counted

    // Ten on-ground/slow frames 1 s apart: points at +15 s and +20 s (every
    // 5th, per RECORD_INTERVAL_MS), landing on the 10th.
    for (let i = 0; i < 10; i++) {
      advance(1000);
      fm.onFrame(makeFrame(LANDED));
    }

    // 15 000 (reconstructed) + 0 (resume gap, dropped by interrupted) +
    // 5000*4 (the four counted post-resume gaps) = 35 000 ms -> 35 s.
    // 4 seeded points + 5 written (resume, +5s, +10s, +15s, +20s) = 9.
    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    const c = dbMock.closeFlight.mock.calls[0];
    expect(c[0]).toBe(77);
    expect(c[4]).toBe(35); // durationSec
    expect(c[8]).toBe(9); // pointCount
  });

  describe('interruptions stored with the track', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { logSpy = vi.spyOn(console, 'log').mockImplementation(() => {}); });
    afterEach(() => logSpy.mockRestore());

    const resumeLine = (): string[] =>
      logSpy.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes('resumed after restart'));

    it('a pause before a restart is not counted again after the resume', () => {
      // Process 1: 20 s cruise, 20 s paused, 20 s cruise. Points at +0 +5 +10
      // +15 +20, then +41 +46 +51 +56 (the +41 point is the first after the pause).
      const fm1 = new FlightManager();
      takeoff(fm1);
      feed(fm1, 20);
      fm1.setPaused(true, 1);
      feed(fm1, 20);
      fm1.setPaused(false);
      feed(fm1, 20);

      const track = snapshotTrack();
      expect(track.map(p => p.after_interruption)).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 0]);
      dbMock.getOpenFlight.mockImplementation(() => makeOpenFlightRow({ id: 1, start_time: iso(0) }));
      dbMock.getFlightTrackPoints.mockImplementation(() => track);

      advance(10_000); // outage
      const fm2 = new FlightManager();
      fm2.onFrame(makeFrame()); // resume at +70
      feed(fm2, 10, LANDED);    // points at +75 +80, lands on the 10th frame

      // Live had 20 + 15 = 35 s. Replay: 35 s; after the resume: +5 +5 = 10 s.
      expect(resumeLine()).toHaveLength(1);
      expect(resumeLine()[0]).toContain('9 points, 0.0 nm, 35s counted before the interruption');
      const c = dbMock.closeFlight.mock.calls[0];
      expect(c[4]).toBe(45); // 80 s wall - 21 s (pause gap) - 14 s (outage gap)
      expect(c[8]).toBe(12);
    });

    it('does not count the first outage again when the server restarts a second time', () => {
      const fm1 = new FlightManager();
      takeoff(fm1);
      feed(fm1, 20); // points +0 +5 +10 +15 +20: 20 s counted
      const track1 = snapshotTrack();
      advance(30_000); // first outage

      dbMock.getOpenFlight.mockImplementation(() => makeOpenFlightRow({ id: 1, start_time: iso(0) }));
      dbMock.getFlightTrackPoints.mockImplementation(() => track1);
      const fm2 = new FlightManager();
      fm2.onFrame(makeFrame()); // resume at +50, flagged
      feed(fm2, 10);            // points +55 +60
      const track2 = snapshotTrack();
      advance(20_000); // second outage

      dbMock.getFlightTrackPoints.mockImplementation(() => track2);
      logSpy.mockClear();
      const fm3 = new FlightManager();
      fm3.onFrame(makeFrame()); // resume at +80
      feed(fm3, 10, LANDED);    // points +85 +90

      // 20 s + 10 s are counted before the second resume; the 30 s gap ending
      // at the flagged +50 point is not.
      expect(resumeLine()[0]).toContain('8 points, 0.0 nm, 30s counted before the interruption');
      const c = dbMock.closeFlight.mock.calls[0];
      expect(c[4]).toBe(40); // 30 s replayed + 10 s flown after the second resume
      expect(c[8]).toBe(11);
    });

    it('still counts unflagged gaps of 60 s or less and excludes gaps above 60 s after a resume', () => {
      // Hand-built track: +0 .. +10 ordinary (10 s), a flagged point at +40
      // (skipped), +45 ordinary (5 s), a 90 s gap to +135 (excluded), +140 (5 s).
      const track: FlightTrackPoint[] = [
        makeTrackPoint({ ts: iso(-140000), after_interruption: 0 }),
        makeTrackPoint({ ts: iso(-135000), after_interruption: 0 }),
        makeTrackPoint({ ts: iso(-130000), after_interruption: 0 }),
        makeTrackPoint({ ts: iso(-100000), after_interruption: 1 }),
        makeTrackPoint({ ts: iso(-95000), after_interruption: 0 }),
        makeTrackPoint({ ts: iso(-5000), after_interruption: 0 }),
        makeTrackPoint({ ts: iso(0), after_interruption: 0 }),
      ];
      dbMock.getOpenFlight.mockImplementation(() => makeOpenFlightRow({ start_time: iso(-140000) }));
      dbMock.getFlightTrackPoints.mockImplementation(() => track);

      const fm = new FlightManager();
      fm.onFrame(makeFrame());

      expect(resumeLine()[0]).toContain('7 points, 0.0 nm, 20s counted before the interruption');
    });

    it('resumes pre-upgrade data (every flag 0) with the same numbers as before', () => {
      dbMock.getOpenFlight.mockImplementation(() => makeOpenFlightRow({ start_time: iso(-45000) }));
      dbMock.getFlightTrackPoints.mockImplementation(() =>
        fourPointTrack().map(p => ({ ...p, after_interruption: 0 })));

      const fm = new FlightManager();
      fm.onFrame(makeFrame());
      advance(5000); fm.onFrame(makeFrame());
      advance(5000); fm.onFrame(makeFrame());
      for (let i = 0; i < 10; i++) {
        advance(1000);
        fm.onFrame(makeFrame(LANDED));
      }

      expect(resumeLine()[0]).toContain('4 points, 0.0 nm, 15s counted before the interruption');
      const c = dbMock.closeFlight.mock.calls[0];
      expect(c[4]).toBe(35);
      expect(c[8]).toBe(9);
    });
  });

  it('adds the distance flown during the outage exactly once', () => {
    const p10 = northOfNm(KSBA, 10);
    const p20 = northOfNm(KSBA, 20);
    const p30 = northOfNm(KSBA, 30);
    const resumePos = northOfNm(KSBA, 50);

    dbMock.getOpenFlight.mockImplementation(() => makeOpenFlightRow({ start_time: iso(-45000) }));
    dbMock.getFlightTrackPoints.mockImplementation(() => [
      makeTrackPoint({ ts: iso(-45000), lat: KSBA.lat, lon: KSBA.lon }),
      makeTrackPoint({ ts: iso(-40000), lat: p10.lat, lon: p10.lon }),
      makeTrackPoint({ ts: iso(-35000), lat: p20.lat, lon: p20.lon }),
      makeTrackPoint({ ts: iso(-30000), lat: p30.lat, lon: p30.lon }),
    ]);

    const fm = new FlightManager();
    fm.onFrame(makeFrame({ lat: resumePos.lat, lon: resumePos.lon })); // resume 50 nm north
    for (let i = 0; i < 10; i++) {
      advance(1000);
      fm.onFrame(makeFrame({ lat: resumePos.lat, lon: resumePos.lon, ...LANDED }));
    }

    // Reconstructed 0->10->20->30 nm plus the outage leg 30->50 nm: all four
    // legs lie on the same meridian northOfNm() defines, so they sum exactly
    // to the direct 0->50 nm distance — the outage leg counted once, not
    // dropped and not doubled.
    const legs =
      haversineNm(KSBA.lat, KSBA.lon, p10.lat, p10.lon) +
      haversineNm(p10.lat, p10.lon, p20.lat, p20.lon) +
      haversineNm(p20.lat, p20.lon, p30.lat, p30.lon) +
      haversineNm(p30.lat, p30.lon, resumePos.lat, resumePos.lon);
    expect(Math.round(legs * 10) / 10).toBe(50.0);

    const c = dbMock.closeFlight.mock.calls[0];
    expect(c[5]).toBe(50.0); // distanceNm
  });

  it('uses the row start_time, not now, as the flight start', () => {
    const logSpy = vi.spyOn(console, 'log');

    dbMock.getOpenFlight.mockImplementation(() => makeOpenFlightRow({ start_time: iso(-45000) }));
    dbMock.getFlightTrackPoints.mockImplementation(() => fourPointTrack());

    const fm = new FlightManager();
    fm.onFrame(makeFrame());
    advance(5000); fm.onFrame(makeFrame());
    advance(5000); fm.onFrame(makeFrame());
    for (let i = 0; i < 10; i++) {
      advance(1000);
      fm.onFrame(makeFrame(LANDED));
    }

    // Wall clock from the row's real start_time (T0-45s) to endTime (T0+20s)
    // is 65 s; durationSec is 35 s (see the worked-resume test above), so the
    // excluded figure endFlight() logs must read exactly 30 s.
    expect(dbMock.closeFlight.mock.calls[0][4]).toBe(35);
    const endedLine = logSpy.mock.calls.map((args) => String(args[0])).find((line) => line.includes('ended'));
    expect(endedLine).toContain('(30s interrupted, excluded)');
  });
});

describe('FlightManager — resuming a flight with no recorded points', () => {
  beforeEach(() => {
    resetMocks();
    useFakeClock();
  });
  afterEach(() => useRealClock());

  it('closes without throwing when the open flight has no points', () => {
    dbMock.getOpenFlight.mockImplementation(() => makeOpenFlightRow({ start_time: iso(-10000) }));
    dbMock.getFlightTrackPoints.mockImplementation(() => []);

    const fm = new FlightManager();
    expect(() => {
      fm.onFrame(makeFrame());
      for (let i = 0; i < 10; i++) {
        advance(1000);
        fm.onFrame(makeFrame(LANDED));
      }
    }).not.toThrow();

    expect(dbMock.closeFlight).toHaveBeenCalledTimes(1);
    const c = dbMock.closeFlight.mock.calls[0];
    expect(c[0]).toBe(77);
    expect(Number.isFinite(c[5] as number)).toBe(true); // distanceNm, not NaN
    expect(c[8]).toBe(dbMock.insertPoint.mock.calls.length); // pointCount
  });

  it('measures the first post-resume leg from the flight departure, not from 0,0', () => {
    dbMock.getOpenFlight.mockImplementation(() => makeOpenFlightRow({ start_time: iso(-10000) }));
    dbMock.getFlightTrackPoints.mockImplementation(() => []);

    const p10 = northOfNm(KSBA, 10);

    const fm = new FlightManager();
    fm.onFrame(makeFrame()); // resume at KSBA (makeFrame()'s default position)
    advance(5000);
    fm.onFrame(makeFrame({ lat: p10.lat, lon: p10.lon })); // the first post-resume leg: 10 nm
    for (let i = 0; i < 10; i++) {
      advance(1000);
      fm.onFrame(makeFrame({ lat: p10.lat, lon: p10.lon, ...LANDED }));
    }

    const c = dbMock.closeFlight.mock.calls[0];
    expect(c[5]).toBe(10.0); // distanceNm — the fallback used KSBA, not Null Island
  });

  it('falls back to the frame position when the row has no departure coordinates', () => {
    dbMock.getOpenFlight.mockImplementation(() =>
      makeOpenFlightRow({ start_time: iso(-10000), departure_lat: null, departure_lon: null })
    );
    dbMock.getFlightTrackPoints.mockImplementation(() => []);

    const fm = new FlightManager();
    fm.onFrame(makeFrame()); // resume; falls back to the frame's own position
    for (let i = 0; i < 10; i++) {
      advance(1000);
      fm.onFrame(makeFrame(LANDED)); // stationary
    }

    const c = dbMock.closeFlight.mock.calls[0];
    expect(c[5]).toBe(0); // distanceNm — stationary, not NaN and not thousands of nm
    expect(Number.isNaN(c[5] as number)).toBe(false);
  });
});
