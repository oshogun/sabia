#!/usr/bin/env ts-node
// ── Ground-state scenario harness ────────────────────────────────────────────
//
// A read-only CLI over src/groundState.ts, in the same shape as
// src/inspect-legmatch.ts: a scenario table, expected against actual, exits
// non-zero if any row disagrees. There is no test framework driving this
// directly — it exercises the pure decision functions frame-by-frame, the way
// the coordinator's per-state frame handlers feed them one frame at a time.
//
//   npx ts-node src/inspect-groundstate.ts
//
// Each scenario is a sequence of frames fed one at a time through
// nextParkedStreak()/hasParkedDebounce(), the same two calls
// GroundTracker.observeIdle() (src/flight/groundTracker.ts) makes for the
// coordinator's IDLE frame handler. The table
// records the 1-based frame index at which entry occurs, or null if the whole
// sequence never trips it — so "enters on the 5th frame, not the 4th" is
// simply a sequence of 4 or 5 qualifying frames with a different expectation.

import {
  isParkedFrame, nextParkedStreak, hasParkedDebounce,
  GROUND_DEBOUNCE_FRAMES, GROUND_SPEED_MAX_KTS,
} from './groundState';
import type { SimFrame } from './types';

// ── Frame builders ────────────────────────────────────────────────────────────

function baseFrame(over: Partial<SimFrame> = {}): SimFrame {
  return {
    lat: 34.426201,
    lon: -119.841507,
    altitudeFt: 0,
    airspeedKnots: 0,
    groundSpeedKnots: 0,
    headingDeg: 270,
    verticalSpeedFpm: 0,
    onGround: true,
    simRunning: 1,
    aircraft: 'Cessna 172',
    ...over,
  };
}

/** Engines confirmed off, parking brake released — cold and dark. */
const coldAndDark = (over: Partial<SimFrame> = {}): SimFrame =>
  baseFrame({ engineCount: 2, enginesRunning: 0, parkingBrake: false, ...over });

/** Engines running, brake set — ready to push and start, or just arrived. */
const readyForTaxi = (over: Partial<SimFrame> = {}): SimFrame =>
  baseFrame({ engineCount: 2, enginesRunning: 2, parkingBrake: true, ...over });

const repeat = (frame: SimFrame, n: number): SimFrame[] => new Array(n).fill(frame);

// ── The scenario table ────────────────────────────────────────────────────────

interface Scenario {
  name: string;
  note?: string;
  frames: SimFrame[];
  /** 1-based frame index entry is expected at, or null if it should never fire. */
  expectEntryAt: number | null;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'cold and dark at a gate — enters on the 5th frame, not the 4th',
    frames: repeat(coldAndDark(), 6),
    expectEntryAt: GROUND_DEBOUNCE_FRAMES,
  },
  {
    name: 'ready-for-taxi spawn (engines running, brake set) — enters',
    frames: repeat(readyForTaxi(), 6),
    expectEntryAt: GROUND_DEBOUNCE_FRAMES,
  },
  {
    name: 'engines running, brake released, stationary at the hold — never enters',
    note: 'neither qualifying clause holds: engines are not off and the brake is not set',
    frames: repeat(baseFrame({ engineCount: 2, enginesRunning: 2, parkingBrake: false }), 20),
    expectEntryAt: null,
  },
  {
    name: 'taxiing with the brake released — never enters',
    frames: repeat(baseFrame({ engineCount: 2, enginesRunning: 2, parkingBrake: false, groundSpeedKnots: 8 }), 20),
    expectEntryAt: null,
  },
  {
    name: 'engines off but rolling at 3 kts (pushback/tow) — never enters',
    frames: repeat(baseFrame({ engineCount: 2, enginesRunning: 0, groundSpeedKnots: 3 }), 20),
    expectEntryAt: null,
  },
  {
    name: `exactly ${GROUND_SPEED_MAX_KTS.toFixed(1)} kt ground speed — never enters (strict <)`,
    frames: repeat(coldAndDark({ groundSpeedKnots: GROUND_SPEED_MAX_KTS }), 20),
    expectEntryAt: null,
  },
  {
    name: '0.9 kt — enters',
    frames: repeat(coldAndDark({ groundSpeedKnots: 0.9 }), 6),
    expectEntryAt: GROUND_DEBOUNCE_FRAMES,
  },
  {
    name: 'a one-frame jolt fully resets the streak, not just delays it by one',
    note: '4 qualifying frames, one jolt, then a fresh run of 5 — proves the counter resets to 0, never decrements',
    frames: [
      ...repeat(coldAndDark(), 4),
      coldAndDark({ groundSpeedKnots: 2 }), // the jolt: fails the speed test
      ...repeat(coldAndDark(), 5),
    ],
    expectEntryAt: 10,
  },
  {
    name: 'slew at the gate — never enters',
    frames: repeat(coldAndDark({ simRunning: 3 }), 20),
    expectEntryAt: null,
  },
  {
    name: 'simRunning === 0 — never enters',
    frames: repeat(coldAndDark({ simRunning: 0 }), 20),
    expectEntryAt: null,
  },
  {
    name: "an old agent's frames (no new fields at all) — never enters, never throws",
    frames: repeat(baseFrame(), 20), // parkingBrake/engineCount/enginesRunning all absent
    expectEntryAt: null,
  },
  {
    name: 'old agent, then updated mid-session — enters 5 frames after the first complete frame',
    frames: [...repeat(baseFrame(), 5), ...repeat(coldAndDark(), 5)],
    expectEntryAt: 10,
  },
  {
    name: 'cold-and-dark shutdown after a flight (taxi in, brake, cut engines)',
    note: 'rollout at speed, then parked — the arrival-airport case this feature exists for',
    frames: [
      ...repeat(baseFrame({ engineCount: 2, enginesRunning: 2, groundSpeedKnots: 25 }), 3),
      ...repeat(coldAndDark(), 5),
    ],
    expectEntryAt: 8,
  },
  {
    name: 'engine failure in the air — never enters (onGround is false)',
    frames: repeat(baseFrame({ onGround: false, airspeedKnots: 140, groundSpeedKnots: 140, engineCount: 2, enginesRunning: 0 }), 20),
    expectEntryAt: null,
  },
];

// ── Simulation ────────────────────────────────────────────────────────────────

/** Feeds frames one at a time through the same two calls GroundTracker.observeIdle() makes. */
function simulateEntry(frames: SimFrame[]): number | null {
  let streak = 0;
  for (let i = 0; i < frames.length; i++) {
    streak = nextParkedStreak(streak, frames[i]);
    if (hasParkedDebounce(streak)) return i + 1;
  }
  return null;
}

// ── The airborne-debounce parity check ────────────────────────────────────────
//
// src/groundState.ts owns no airborne logic — that stays in
// src/flightManager.ts, unchanged. What this proves is narrower and just as
// important: a frame carrying the new optional ground fields is decided
// identically to one without them, on the *existing* IDLE -> FLYING rule.
// Transcribed here, not imported: the airborne predicate is inline in the
// coordinator and AIRBORNE_DEBOUNCE_FRAMES is private to src/flightManager.ts,
// so neither is exported.

const AIRBORNE_DEBOUNCE_FRAMES = 3;

function isAirborneQualifying(frame: SimFrame): boolean {
  return frame.simRunning !== 3 && !frame.onGround && frame.airspeedKnots > 30;
}

function simulateAirborneEntry(frames: SimFrame[]): number | null {
  let streak = 0;
  for (let i = 0; i < frames.length; i++) {
    streak = isAirborneQualifying(frames[i]) ? streak + 1 : 0;
    if (streak >= AIRBORNE_DEBOUNCE_FRAMES) return i + 1;
  }
  return null;
}

function checkAirborneParity(): { ok: boolean; withoutFields: number | null; withFields: number | null } {
  const takeoffFrame = (over: Partial<SimFrame> = {}): SimFrame =>
    baseFrame({ onGround: false, airspeedKnots: 60, groundSpeedKnots: 58, ...over });

  const withoutFields = simulateAirborneEntry(repeat(takeoffFrame(), 5));
  const withFields = simulateAirborneEntry(
    repeat(takeoffFrame({ engineCount: 2, enginesRunning: 2, parkingBrake: false }), 5),
  );
  return { ok: withoutFields === AIRBORNE_DEBOUNCE_FRAMES && withoutFields === withFields, withoutFields, withFields };
}

// ── Runner ────────────────────────────────────────────────────────────────────

const fmt = (n: number | null) => (n === null ? 'never' : `frame ${n}`);
const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

function main(): void {
  const failures: string[] = [];

  console.log(`── ground-state scenarios — ${SCENARIOS.length} rows`);
  console.log(`   GROUND_DEBOUNCE_FRAMES=${GROUND_DEBOUNCE_FRAMES}  GROUND_SPEED_MAX_KTS=${GROUND_SPEED_MAX_KTS}`);
  console.log('');
  console.log(`   ${pad('#', 3)}${pad('scenario', 70)}${pad('expected', 12)}${pad('actual', 12)}  ok`);

  SCENARIOS.forEach((s, i) => {
    const actual = simulateEntry(s.frames);
    const ok = actual === s.expectEntryAt;
    console.log(
      `   ${pad(String(i + 1), 3)}${pad(s.name, 70)}${pad(fmt(s.expectEntryAt), 12)}${pad(fmt(actual), 12)}  ${ok ? '✓' : '✗'}`,
    );
    if (s.note) console.log(`        ${s.note}`);
    if (!ok) {
      failures.push(`   ✗ ${i + 1}. ${s.name}\n        expected entry ${fmt(s.expectEntryAt)}, got ${fmt(actual)}`);
    }
  });

  console.log('');

  // isParkedFrame must never throw on a frame missing the new fields — the
  // "old agent" and "mid-session update" rows above already prove this in
  // practice, but call it directly too so a future refactor that adds a
  // field read without an undefined check is caught here, not in production.
  let threw = false;
  try {
    isParkedFrame(baseFrame());
  } catch {
    threw = true;
  }
  console.log(`── isParkedFrame() on a fields-absent frame  ${threw ? 'THREW ✗' : 'no throw ✓'}`);
  if (threw) failures.push('   ✗ isParkedFrame() threw on a frame with no ground fields at all');

  const parity = checkAirborneParity();
  console.log(
    `── IDLE -> FLYING airborne debounce unaffected  without-fields=${fmt(parity.withoutFields)}  ` +
    `with-fields=${fmt(parity.withFields)}  ${parity.ok ? '✓' : '✗'}`,
  );
  if (!parity.ok) failures.push('   ✗ airborne debounce parity: presence of the new ground fields changed the outcome');

  console.log('');

  if (failures.length === 0) {
    console.log(`${SCENARIOS.length} scenarios, 0 failures`);
    return;
  }
  for (const f of failures) console.error(f);
  console.error('');
  console.error(`${SCENARIOS.length} scenarios, ${failures.length} failure(s)`);
  process.exitCode = 1;
}

main();
