// Call-order harness for FlightManager. One ordered log per scenario, three
// entry kinds, pushed in the order they happen:
//   { t: 'call', fn, args }             every call into a stubbed IO module, FULL args
//   { t: 'notify', ... }                every scope-listener call, tagged with
//                                       getFlightStatePayload() read at call time
//   { t: 'log' | 'warn' | 'error', text }   every console line
// Every entry is JSON round-tripped when pushed, so the in-memory log is
// exactly what the .json golden parses back to (and args are deep-copied at
// call time).
//
// Goldens live in tests/golden/flightManager and are rewritten only with
// CALLORDER_WRITE_GOLDEN=1, on production code known to be correct.

import { vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import type { FlightState, GroundSession, CreateGroundSession, SimFrame } from '../../src/types';
import type { OpenFlightRow, FlightTrackPoint } from '../../src/db';
import { haversineNm } from '../../src/geo';
import { makeFrame, makeCandidate, makePlannedLegWithChildren, northOfNm, KSBA, KMRY, T0 } from './index';

// ── Log entries ─────────────────────────────────────────────────────────────

export interface CallEntry { t: 'call'; fn: string; args: unknown[] }
export interface NotifyEntry {
  t: 'notify';
  flightState: FlightState;
  currentFlightId: number | null;
  plannedLegId: number | null | 'threw';
}
export interface ConsoleEntry { t: 'log' | 'warn' | 'error'; text: string }
export type Entry = CallEntry | NotifyEntry | ConsoleEntry;

let entries: Entry[] = [];
let quiet = 0;

function push(e: Entry): void {
  entries.push(JSON.parse(JSON.stringify(e)) as Entry);
}

/** Returns the log so far and starts a new one. */
export function takeLog(): Entry[] {
  const out = entries;
  entries = [];
  return out;
}

// ── Console serialization (stable across line-number changes) ──────────────

export function formatArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  return util.inspect(a, { depth: 4, breakLength: Infinity, compact: true, sorted: true, colors: false });
}

export function formatArgs(args: unknown[]): string {
  return args.map(formatArg).join(' ');
}

/** Installs the console capture. Call in beforeEach, after tests/setup.ts's own spies. */
export function captureConsole(): void {
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      push({ t: level, text: formatArgs(args) });
    });
  }
}

/** The console entries only, one `${level} ${text}\n` per line — the .log golden. */
export function consoleText(log: Entry[]): string {
  return log
    .filter((e): e is ConsoleEntry => e.t === 'log' || e.t === 'warn' || e.t === 'error')
    .map(e => `${e.t} ${e.text}\n`)
    .join('');
}

// ── Scope listener ─────────────────────────────────────────────────────────

interface Listenable {
  setScopeChangeListener(fn: (() => void) | null): void;
  getFlightStatePayload(): { flightState: FlightState; currentFlightId: number | null; plannedLegId: number | null };
  appState: { flightState: FlightState; currentFlightId: number | null };
}

/**
 * Attaches the logging listener. Its own getFlightStatePayload() read runs
 * with call logging suppressed (it may call getOpenGroundSession(), which is
 * the harness's read, not the code under test's), and a throw from that read
 * is recorded as plannedLegId 'threw' rather than escaping into
 * notifyScopeChange()'s catch.
 */
export function attachListener(fm: Listenable): void {
  fm.setScopeChangeListener(() => {
    let entry: NotifyEntry;
    quiet++;
    try {
      const p = fm.getFlightStatePayload();
      entry = { t: 'notify', flightState: p.flightState, currentFlightId: p.currentFlightId, plannedLegId: p.plannedLegId };
    } catch {
      entry = { t: 'notify', flightState: fm.appState.flightState, currentFlightId: fm.appState.currentFlightId, plannedLegId: 'threw' };
    } finally {
      quiet--;
    }
    push(entry);
  });
}

// ── Stubbed IO modules ───────────────────────────────────────────────────────

type Impl = (...args: any[]) => any;

function logged(fn: string, impl: () => Impl) {
  return vi.fn((...args: unknown[]) => {
    if (quiet === 0) push({ t: 'call', fn, args });
    return impl()(...args);
  });
}

export const DB_FNS = [
  'insertFlight', 'insertPoint', 'closeFlight', 'getFlightPlannedLegId',
  'getActiveTripId', 'getPlannedLegCandidatesForActiveTrip', 'getPlannedLegById',
  'linkFlightToPlannedLeg', 'recordPlannedLegArrival', 'getTripName',
  'getOpenFlight', 'getFlightTrackPoints',
] as const;
export const GROUND_FNS = [
  'insertGroundSession', 'getOpenGroundSession', 'closeOpenGroundSession', 'fillOpenGroundSessionGaps',
] as const;

type DbFn = typeof DB_FNS[number];
type GroundFn = typeof GROUND_FNS[number];

/** Scenario-configurable behaviour behind every stub. Reset by resetCallOrder(). */
export const behave = {
  db: {} as Record<DbFn, Impl>,
  groundSessions: {} as Record<GroundFn, Impl>,
  airports: {} as { findNearestAirport: Impl },
  acarsEvents: {} as { fileAcarsMessageOnce: Impl },
  acars: {} as { buildOooiMessage: Impl | null; buildPositionReportMessage: Impl | null },
};

export const dbStub = Object.fromEntries(DB_FNS.map(n => [n, logged(`db.${n}`, () => behave.db[n])]));
export const groundSessionsStub = Object.fromEntries(GROUND_FNS.map(n => [n, logged(`groundSessions.${n}`, () => behave.groundSessions[n])]));
export const airportsStub = {
  findNearestAirport: logged('airports.findNearestAirport', () => behave.airports.findNearestAirport),
  initAirports: vi.fn(() => Promise.resolve()),
};
export const acarsEventsStub = {
  fileAcarsMessageOnce: logged('acarsEvents.fileAcarsMessageOnce', () => behave.acarsEvents.fileAcarsMessageOnce),
};

/** For vi.mock('../src/acars', importOriginal): real module, two builders logged with their full input. */
export function wrapAcars<T extends { buildOooiMessage: Impl; buildPositionReportMessage: Impl }>(real: T): T {
  return {
    ...real,
    buildOooiMessage: logged('acars.buildOooiMessage', () => behave.acars.buildOooiMessage ?? real.buildOooiMessage),
    buildPositionReportMessage: logged('acars.buildPositionReportMessage', () => behave.acars.buildPositionReportMessage ?? real.buildPositionReportMessage),
  };
}

// ── The fake ground_sessions table (one open row at most) ───────────────────

export const ground = { open: null as GroundSession | null, nextId: 100 };

export function makeSessionRow(over: Partial<GroundSession> = {}): GroundSession {
  const now = '2026-09-09T11:00:00.000Z';
  return {
    id: ground.nextId++, source: 'auto', airport_icao: null, airport_name: null, lat: null, lon: null,
    parking_position: null, parking_position_source: null, planned_leg_id: null, planned_leg_link_source: null,
    aircraft: null, started_at: now, ended_at: null, ended_reason: null, flight_id: null,
    created_at: now, updated_at: now, ...over,
  };
}

// ── The fake airport table ───────────────────────────────────────────────────

export const AIRPORTS = [
  { icao: 'KSBA', name: 'Santa Barbara Muni', lat: 34.426201, lon: -119.841507 },
  { icao: 'KMRY', name: 'Monterey Rgnl', lat: 36.586952, lon: -121.843079 },
];

function nearestAirport(lat: number, lon: number): { icao: string; name: string } | null {
  let best: typeof AIRPORTS[number] | null = null;
  let bestNm = Infinity;
  for (const ap of AIRPORTS) {
    const d = haversineNm(lat, lon, ap.lat, ap.lon);
    if (d < bestNm) { bestNm = d; best = ap; }
  }
  return best && bestNm <= 10 ? { icao: best.icao, name: best.name } : null;
}

let flightIdCounter = 1;

/** Re-installs every default behaviour, empties the log and the fake tables. Call in beforeEach. */
export function resetCallOrder(): void {
  entries = [];
  quiet = 0;
  flightIdCounter = 1;
  ground.open = null;
  ground.nextId = 100;
  behave.db = {
    insertFlight: () => flightIdCounter++,
    insertPoint: () => undefined,
    closeFlight: () => undefined,
    getFlightPlannedLegId: () => null,
    getActiveTripId: () => null,
    getPlannedLegCandidatesForActiveTrip: () => [],
    getPlannedLegById: () => null,
    linkFlightToPlannedLeg: () => undefined,
    recordPlannedLegArrival: () => undefined,
    getTripName: () => 'Test Trip',
    getOpenFlight: () => null,
    getFlightTrackPoints: () => [],
  };
  behave.groundSessions = {
    getOpenGroundSession: () => ground.open,
    insertGroundSession: (input: CreateGroundSession) => {
      const row = makeSessionRow({ ...input });
      ground.open = row;
      return row;
    },
    closeOpenGroundSession: (reason: string, flightId: number | null = null) => {
      const was = ground.open;
      ground.open = null;
      return was ? { ...was, ended_at: new Date().toISOString(), ended_reason: reason, flight_id: flightId } : null;
    },
    fillOpenGroundSessionGaps: (patch: Partial<CreateGroundSession>) => {
      if (!ground.open) return null;
      const cur = ground.open as unknown as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...cur };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === null || cur[k] !== null) continue;
        merged[k] = v;
      }
      ground.open = merged as unknown as GroundSession;
      return ground.open;
    },
  };
  behave.airports = { findNearestAirport: nearestAirport };
  behave.acarsEvents = { fileAcarsMessageOnce: () => true };
  behave.acars = { buildOooiMessage: null, buildPositionReportMessage: null };
}

// ── Goldens ──────────────────────────────────────────────────────────────────

const GOLDEN_DIR = path.resolve(__dirname, '../golden/flightManager');

/**
 * Reads <id>.json and <id>.log. With CALLORDER_WRITE_GOLDEN=1 it first
 * (re)writes them from `log` — only ever run on unmodified production code.
 */
export function golden(id: string, log: Entry[]): { log: Entry[]; consoleText: string } {
  const jsonFile = path.join(GOLDEN_DIR, `${id}.json`);
  const logFile = path.join(GOLDEN_DIR, `${id}.log`);
  if (process.env.CALLORDER_WRITE_GOLDEN === '1') {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(jsonFile, JSON.stringify(log, null, 2) + '\n');
    fs.writeFileSync(logFile, consoleText(log));
  }
  return {
    log: JSON.parse(fs.readFileSync(jsonFile, 'utf8')) as Entry[],
    consoleText: fs.readFileSync(logFile, 'utf8'),
  };
}

// ── Frames and drivers ───────────────────────────────────────────────────────
// Every driver advances the fake clock itself, so the caller must have
// installed it (useFakeClock) first.

export const PARKED: Partial<SimFrame> = { onGround: true, groundSpeedKnots: 0, airspeedKnots: 0, enginesRunning: 0, engineCount: 2, parkingBrake: false };
export const TAXI: Partial<SimFrame> = { onGround: true, groundSpeedKnots: 5, airspeedKnots: 0 };
export const LANDED: Partial<SimFrame> = { onGround: true, groundSpeedKnots: 2, airspeedKnots: 0, lat: KMRY.lat, lon: KMRY.lon };
export const ROLL: Partial<SimFrame> = { onGround: true, groundSpeedKnots: 2, airspeedKnots: 0 };

interface FrameSink { onFrame(frame: SimFrame): void }

export const iso = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString();

/** n frames, each `stepMs` after the previous one. */
export function feed(fm: FrameSink, n: number, over: Partial<SimFrame> = {}, stepMs = 1000): void {
  for (let i = 0; i < n; i++) { vi.advanceTimersByTime(stepMs); fm.onFrame(makeFrame(over)); }
}
/** The airborne debounce: three qualifying frames at one instant. */
export function takeoff(fm: FrameSink, over: Partial<SimFrame> = {}): void {
  for (let i = 0; i < 3; i++) fm.onFrame(makeFrame(over));
}
export const cruise = (fm: FrameSink, n = 3, over: Partial<SimFrame> = {}): void => feed(fm, n, over, 5000);
export const park = (fm: FrameSink, n = 5, over: Partial<SimFrame> = {}): void => feed(fm, n, { ...PARKED, ...over });
export const land = (fm: FrameSink): void => feed(fm, 10, LANDED);

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Trip 1 with candidate leg 11 at KSBA; getPlannedLegById(11) is the KSBA→KMRY leg. */
export function arrangeLeg(legOver: Record<string, unknown> = {}): void {
  behave.db.getActiveTripId = () => 1;
  behave.db.getPlannedLegCandidatesForActiveTrip = () => [makeCandidate({ tripId: 1 })];
  behave.db.getPlannedLegById = (id: number) => (id === 11 ? makePlannedLegWithChildren({ departure_start: 'GATE 3', ...legOver }) : null);
}

export const openRow = (over: Partial<OpenFlightRow> = {}): OpenFlightRow => ({
  id: 77, aircraft: 'A320', start_time: iso(-60_000), departure_lat: KSBA.lat, departure_lon: KSBA.lon, ...over,
});

/** Four points one nm apart due north of KSBA, 3000-4500 ft, 120-123 kt, 45 s to 30 s before T0. */
export const TRACK: FlightTrackPoint[] = [0, 1, 2, 3].map(i => {
  const p = northOfNm(KSBA, i);
  return { lat: p.lat, lon: p.lon, altitude_ft: 3000 + 500 * i, airspeed_kts: 120 + i, ts: iso(-45_000 + 5000 * i) };
});

export const boom = (msg = 'boom') => (): never => { throw new Error(msg); };

/** The message `fn` throws, or null if it returns. */
export function thrown(fn: () => void): string | null {
  try { fn(); } catch (e) { return (e as Error).message; }
  return null;
}

// ── Reading a log ────────────────────────────────────────────────────────────

export const notifies = (log: Entry[]): number => log.filter(e => e.t === 'notify').length;
export const warns = (log: Entry[]): string[] => log.filter(e => e.t === 'warn').map(e => (e as ConsoleEntry).text);
export const callsTo = (log: Entry[], fn: string): CallEntry[] => log.filter((e): e is CallEntry => e.t === 'call' && e.fn === fn);

export function endState(fm: Pick<Listenable, 'appState'>, log: Entry[]): { flightState: FlightState; currentFlightId: number | null; notifies: number } {
  return { flightState: fm.appState.flightState, currentFlightId: fm.appState.currentFlightId, notifies: notifies(log) };
}
