#!/usr/bin/env ts-node
// ── Hand-close gate scenario harness ─────────────────────────────────────────
//
// A read-only CLI over src/plannedLegClose.ts. No sim, no browser, no test
// framework, no database: everything below is a synthetic HandCloseFlight /
// HandCloseLeg pair fed straight to decideHandClose(). Run:
//
//   npx ts-node src/inspect-manual-mark.ts
//
// ── Why the "expected" column is transcribed, not derived ────────────────────
//
// Every expected verdict below is transcribed BY HAND: the 24-row truth
// table, the two cases outside the grid, and the six named rows. None of it
// is computed by calling decideHandClose() or by restating its rule in a
// second function — an inspector that derives "expected" from the
// implementation proves nothing, because a bug shared by both sides would
// agree with itself. If a row here is ever found to disagree with the
// frozen table it was transcribed from, that is a question for the spec,
// not something to quietly reconcile in this file.
//
// ── Sections ──────────────────────────────────────────────────────────────────
//
// 1. GATE_TABLE       — the 24-row truth table, both directions (48 verdicts).
// 2. OUTSIDE_THE_GRID  — the two cases outside it (planned_leg_id NULL; leg missing).
// 3. NAMED_SCENARIOS  — the six required rows (a)-(f), using the live flight
//                       56 / leg 12 coordinates and the
//                       antimeridian / far-diversion pairs.
// 4. ROUNDING_BOUNDARY — one row at an x.x5 nm boundary where
//                       Math.round(x*10)/10 and Number(x.toFixed(1)) actually
//                       disagree, proving the module uses the frozen
//                       expression and not a look-alike.

import {
  decideHandClose,
  handCloseDeviationNm,
  type HandCloseDecision,
  type HandCloseFlight,
  type HandCloseLeg,
  type HandCloseRefusal,
  type HandCloseRequest,
} from './plannedLegClose';

// ── Fixture coordinates ───────────────────────────────────────────────────────
//
// Real: flight 56's stored arrival position and leg 12's stored destination
// (PAJN), read read-only out of the live flights.db. The recorded evidence
// fixes the expected deviation at 0.3 nm.
const FLIGHT_56_ARRIVAL = { lat: 58.35728796183394, lon: -134.58627965717702 };
const LEG_12_DEST = { lat: 58.354721, lon: -134.578491 };

// Synthetic: an antimeridian pair, 179°E vs 179°W — 2° of longitude, not
// 358° — and a ~120 nm far diversion off leg 12's real destination. Both
// values are the actual prototypes/haversine-parity.js output, rounded to
// one decimal place, not a hand calculation.
const ANTIMERIDIAN_ARRIVAL = { lat: 0, lon: 179 };
const ANTIMERIDIAN_DEST = { lat: 0, lon: -179 };
const FAR_DIVERSION_DEST = { lat: 56.3, lon: -134.0 };

// ── Shared verdict shape ──────────────────────────────────────────────────────

type ExpectedVerdict = { allowed: true } | { allowed: false; reason: HandCloseRefusal };
const ALLOW: ExpectedVerdict = { allowed: true };
const refuse = (reason: HandCloseRefusal): ExpectedVerdict => ({ allowed: false, reason });

function verdictMatches(actual: HandCloseDecision, expected: ExpectedVerdict): boolean {
  if (expected.allowed) return actual.allowed === true;
  return actual.allowed === false && actual.reason === expected.reason;
}

function fmtVerdict(v: ExpectedVerdict): string {
  return v.allowed ? 'ALLOW' : `409 ${v.reason}`;
}
function fmtActual(a: HandCloseDecision): string {
  return a.allowed ? 'ALLOW' : `409 ${a.reason}`;
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const padL = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

const failures: string[] = [];

// ═══════════════════════════════════════════════════════════════════════════
// 1. GATE_TABLE — 24 rows, both directions
// ═══════════════════════════════════════════════════════════════════════════

interface GateRow {
  row: number;
  linkSource: 'manual' | 'auto' | null;
  ended: boolean;
  legStatus: HandCloseLeg['status'];
  reachableToday: string;
  expFlown: ExpectedVerdict;
  expPlanned: ExpectedVerdict;
}

// Transcribed BY HAND from the frozen 24-row table. Column order and values
// match that table row for row.
const GATE_TABLE: GateRow[] = [
  { row: 1,  linkSource: 'manual', ended: true,  legStatus: 'planned',  reachableToday: 'yes — flight 56 -> leg 12',                  expFlown: ALLOW,                     expPlanned: refuse('LEG_NOT_FLOWN') },
  { row: 2,  linkSource: 'manual', ended: true,  legStatus: 'flown',    reachableToday: 'yes — flights 47 -> leg 4, 52 -> leg 10',     expFlown: refuse('LEG_NOT_PLANNED'), expPlanned: ALLOW },
  { row: 3,  linkSource: 'manual', ended: true,  legStatus: 'diverted', reachableToday: 'yes (no live row)',                           expFlown: refuse('LEG_NOT_PLANNED'), expPlanned: refuse('LEG_NOT_FLOWN') },
  { row: 4,  linkSource: 'manual', ended: true,  legStatus: 'skipped',  reachableToday: 'yes (no live row)',                           expFlown: refuse('LEG_NOT_PLANNED'), expPlanned: refuse('LEG_NOT_FLOWN') },
  { row: 5,  linkSource: 'manual', ended: false, legStatus: 'planned',  reachableToday: 'yes — hand-link while flying',                expFlown: refuse('FLIGHT_NOT_ENDED'), expPlanned: refuse('FLIGHT_NOT_ENDED') },
  { row: 6,  linkSource: 'manual', ended: false, legStatus: 'flown',    reachableToday: 'no',                                          expFlown: refuse('FLIGHT_NOT_ENDED'), expPlanned: refuse('FLIGHT_NOT_ENDED') },
  { row: 7,  linkSource: 'manual', ended: false, legStatus: 'diverted', reachableToday: 'no',                                          expFlown: refuse('FLIGHT_NOT_ENDED'), expPlanned: refuse('FLIGHT_NOT_ENDED') },
  { row: 8,  linkSource: 'manual', ended: false, legStatus: 'skipped',  reachableToday: 'yes — hand-link a skipped leg while flying',  expFlown: refuse('FLIGHT_NOT_ENDED'), expPlanned: refuse('FLIGHT_NOT_ENDED') },
  { row: 9,  linkSource: 'auto',   ended: true,  legStatus: 'planned',  reachableToday: 'no',                                          expFlown: refuse('LINK_NOT_MANUAL'), expPlanned: refuse('LINK_NOT_MANUAL') },
  { row: 10, linkSource: 'auto',   ended: true,  legStatus: 'flown',    reachableToday: 'yes — flights 48-51, 53',                     expFlown: refuse('LINK_NOT_MANUAL'), expPlanned: refuse('LINK_NOT_MANUAL') },
  { row: 11, linkSource: 'auto',   ended: true,  legStatus: 'diverted', reachableToday: 'yes (no live row)',                           expFlown: refuse('LINK_NOT_MANUAL'), expPlanned: refuse('LINK_NOT_MANUAL') },
  { row: 12, linkSource: 'auto',   ended: true,  legStatus: 'skipped',  reachableToday: 'no',                                          expFlown: refuse('LINK_NOT_MANUAL'), expPlanned: refuse('LINK_NOT_MANUAL') },
  { row: 13, linkSource: 'auto',   ended: false, legStatus: 'planned',  reachableToday: 'yes — every auto-matched flight in progress', expFlown: refuse('LINK_NOT_MANUAL'), expPlanned: refuse('LINK_NOT_MANUAL') },
  { row: 14, linkSource: 'auto',   ended: false, legStatus: 'flown',    reachableToday: 'no',                                          expFlown: refuse('LINK_NOT_MANUAL'), expPlanned: refuse('LINK_NOT_MANUAL') },
  { row: 15, linkSource: 'auto',   ended: false, legStatus: 'diverted', reachableToday: 'no',                                          expFlown: refuse('LINK_NOT_MANUAL'), expPlanned: refuse('LINK_NOT_MANUAL') },
  { row: 16, linkSource: 'auto',   ended: false, legStatus: 'skipped',  reachableToday: 'no',                                          expFlown: refuse('LINK_NOT_MANUAL'), expPlanned: refuse('LINK_NOT_MANUAL') },
  { row: 17, linkSource: null,     ended: true,  legStatus: 'planned',  reachableToday: 'no',                                          expFlown: refuse('LINK_NOT_MANUAL'), expPlanned: refuse('LINK_NOT_MANUAL') },
  { row: 18, linkSource: null,     ended: true,  legStatus: 'flown',    reachableToday: 'no',                                          expFlown: refuse('LINK_NOT_MANUAL'), expPlanned: refuse('LINK_NOT_MANUAL') },
  { row: 19, linkSource: null,     ended: true,  legStatus: 'diverted', reachableToday: 'no',                                          expFlown: refuse('LINK_NOT_MANUAL'), expPlanned: refuse('LINK_NOT_MANUAL') },
  { row: 20, linkSource: null,     ended: true,  legStatus: 'skipped',  reachableToday: 'no',                                          expFlown: refuse('LINK_NOT_MANUAL'), expPlanned: refuse('LINK_NOT_MANUAL') },
  { row: 21, linkSource: null,     ended: false, legStatus: 'planned',  reachableToday: 'no',                                          expFlown: refuse('LINK_NOT_MANUAL'), expPlanned: refuse('LINK_NOT_MANUAL') },
  { row: 22, linkSource: null,     ended: false, legStatus: 'flown',    reachableToday: 'no',                                          expFlown: refuse('LINK_NOT_MANUAL'), expPlanned: refuse('LINK_NOT_MANUAL') },
  { row: 23, linkSource: null,     ended: false, legStatus: 'diverted', reachableToday: 'no',                                          expFlown: refuse('LINK_NOT_MANUAL'), expPlanned: refuse('LINK_NOT_MANUAL') },
  { row: 24, linkSource: null,     ended: false, legStatus: 'skipped',  reachableToday: 'no',                                          expFlown: refuse('LINK_NOT_MANUAL'), expPlanned: refuse('LINK_NOT_MANUAL') },
];

// Fixed flight/leg ids for the 24-row table — arbitrary, but constant, so the
// frozen message text can be checked verbatim.
const TABLE_FLIGHT_ID = 900;
const TABLE_LEG_ID = 500;

function buildTableFlight(r: GateRow): HandCloseFlight {
  return {
    id: TABLE_FLIGHT_ID,
    end_time: r.ended ? '2026-09-07T17:06:00.726Z' : null,
    planned_leg_id: TABLE_LEG_ID,
    planned_leg_link_source: r.linkSource,
    // Real coordinates throughout, so the two ALLOW cells (rows 1 and 2) get
    // a genuine measured deviation rather than an arbitrary placeholder.
    arrival_lat: FLIGHT_56_ARRIVAL.lat,
    arrival_lon: FLIGHT_56_ARRIVAL.lon,
  };
}
function buildTableLeg(r: GateRow): HandCloseLeg {
  return {
    id: TABLE_LEG_ID,
    status: r.legStatus,
    destination_lat: LEG_12_DEST.lat,
    destination_lon: LEG_12_DEST.lon,
  };
}

function expectedMessage(flightId: number, legId: number, legStatus: string, v: ExpectedVerdict): string | null {
  if (v.allowed) return null;
  switch (v.reason) {
    case 'NOT_LINKED':
      return `Flight ${flightId} is not linked to a planned leg`;
    case 'LINK_NOT_MANUAL':
      return (
        `Flight ${flightId} was not linked to its planned leg by hand: only a ` +
        `hand-linked flight's leg can be closed by hand`
      );
    case 'FLIGHT_NOT_ENDED':
      return `Flight ${flightId} has not ended: its planned leg is closed at touchdown`;
    case 'LEG_NOT_PLANNED':
      return (
        `Planned leg ${legId} is '${legStatus}', not 'planned': only a planned ` +
        `leg can be marked flown by hand`
      );
    case 'LEG_NOT_FLOWN':
      return (
        `Planned leg ${legId} is '${legStatus}', not 'flown': only a flown leg ` +
        `can be returned to planned`
      );
  }
}

function runGateTable(): void {
  console.log(`── 24-row gate table, both directions (${GATE_TABLE.length * 2} verdicts)`);
  console.log('');
  console.log(
    `   ${pad('#', 4)}${pad('link', 8)}${pad('flight', 8)}${pad('leg', 10)}${pad('expected →flown', 20)}${pad('actual →flown', 20)}${pad('expected →planned', 20)}${pad('actual →planned', 20)}ok`,
  );

  for (const r of GATE_TABLE) {
    const flight = buildTableFlight(r);
    const leg = buildTableLeg(r);
    const actualFlown = decideHandClose('flown', flight, leg);
    const actualPlanned = decideHandClose('planned', flight, leg);

    const okFlown = verdictMatches(actualFlown, r.expFlown);
    const okPlanned = verdictMatches(actualPlanned, r.expPlanned);
    let okMsgFlown = true;
    let okMsgPlanned = true;
    if (!r.expFlown.allowed && !actualFlown.allowed) {
      const want = expectedMessage(TABLE_FLIGHT_ID, TABLE_LEG_ID, r.legStatus, r.expFlown)!;
      okMsgFlown = actualFlown.message === want;
    }
    if (!r.expPlanned.allowed && !actualPlanned.allowed) {
      const want = expectedMessage(TABLE_FLIGHT_ID, TABLE_LEG_ID, r.legStatus, r.expPlanned)!;
      okMsgPlanned = actualPlanned.message === want;
    }

    const ok = okFlown && okPlanned && okMsgFlown && okMsgPlanned;
    console.log(
      `   ${pad(String(r.row), 4)}${pad(String(r.linkSource), 8)}${pad(r.ended ? 'ended' : 'in air', 8)}${pad(r.legStatus, 10)}` +
        `${pad(fmtVerdict(r.expFlown), 20)}${pad(fmtActual(actualFlown), 20)}` +
        `${pad(fmtVerdict(r.expPlanned), 20)}${pad(fmtActual(actualPlanned), 20)}${ok ? '✓' : '✗'}`,
    );
    console.log(`        reachable today? ${r.reachableToday}`);

    if (!ok) {
      const parts: string[] = [];
      if (!okFlown) parts.push(`→flown expected ${fmtVerdict(r.expFlown)}, got ${fmtActual(actualFlown)}`);
      if (!okPlanned) parts.push(`→planned expected ${fmtVerdict(r.expPlanned)}, got ${fmtActual(actualPlanned)}`);
      if (!okMsgFlown) parts.push(`→flown message mismatch: "${(actualFlown as any).message}"`);
      if (!okMsgPlanned) parts.push(`→planned message mismatch: "${(actualPlanned as any).message}"`);
      failures.push(`   ✗ row ${r.row} (${r.linkSource}/${r.ended ? 'ended' : 'in air'}/${r.legStatus})\n        ${parts.join('\n        ')}`);
    }
  }
  console.log('');

  // The two ALLOW cells (exactly two out of forty-eight) get their
  // deviation checked too — row 1 →flown (measured), row 2 →planned (cleared).
  const row1 = GATE_TABLE.find((r) => r.row === 1)!;
  const row1Decision = decideHandClose('flown', buildTableFlight(row1), buildTableLeg(row1));
  if (row1Decision.allowed && row1Decision.deviationNm !== 0.3) {
    failures.push(`   ✗ row 1 →flown deviationNm expected 0.3, got ${row1Decision.deviationNm}`);
  }
  const row2 = GATE_TABLE.find((r) => r.row === 2)!;
  const row2Decision = decideHandClose('planned', buildTableFlight(row2), buildTableLeg(row2));
  if (row2Decision.allowed && row2Decision.deviationNm !== null) {
    failures.push(`   ✗ row 2 →planned deviationNm expected null, got ${row2Decision.deviationNm}`);
  }
  console.log(`── row 1 →flown deviationNm: ${row1Decision.allowed ? row1Decision.deviationNm : 'n/a'} (expected 0.3)`);
  console.log(`── row 2 →planned deviationNm: ${row2Decision.allowed ? row2Decision.deviationNm : 'n/a'} (expected null)`);
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. OUTSIDE_THE_GRID — the two cases outside the grid
// ═══════════════════════════════════════════════════════════════════════════

function runOutsideTheGrid(): void {
  console.log('── the two cases outside the 24-row grid');
  console.log('');

  // Case 1: flights.planned_leg_id IS NULL. Design's own example body is
  // `{"error":"Flight 56 is not linked to a planned leg"}` — flight id 56 is
  // used here so the message can be checked against that exact string.
  const unlinkedFlight: HandCloseFlight = {
    id: 56,
    end_time: '2026-09-07T17:06:00.726Z',
    planned_leg_id: null,
    planned_leg_link_source: null,
    arrival_lat: FLIGHT_56_ARRIVAL.lat,
    arrival_lon: FLIGHT_56_ARRIVAL.lon,
  };
  for (const requested of ['flown', 'planned'] as HandCloseRequest[]) {
    const actual = decideHandClose(requested, unlinkedFlight, null);
    const want = 'Flight 56 is not linked to a planned leg';
    const ok = !actual.allowed && actual.reason === 'NOT_LINKED' && actual.message === want;
    console.log(`   case 1 (planned_leg_id NULL), request '${requested}': expected 409 NOT_LINKED "${want}"`);
    console.log(`           actual: ${fmtActual(actual)}${!actual.allowed ? ` "${actual.message}"` : ''}  ${ok ? '✓' : '✗'}`);
    if (!ok) failures.push(`   ✗ outside-the-grid case 1, request '${requested}': got ${JSON.stringify(actual)}`);
  }

  // Case 2: planned_leg_id IS set but getPlannedLegById() returned undefined
  // (the leg row vanished — unreachable in practice, ON DELETE SET NULL, but
  // the handler must answer rather than dereference undefined). At the HTTP
  // layer the endpoint intercepts this shape BEFORE ever calling
  // decideHandClose() and answers 404 'Planned leg not found' — this module
  // never produces a 404, it has no such reason code. Called anyway
  // (leg=null, planned_leg_id set) it falls into the same branch as "not
  // linked at all", which is the honest, no-crash fallback this row
  // demonstrates.
  const linkedButLegMissingFlight: HandCloseFlight = {
    ...unlinkedFlight,
    planned_leg_id: 12,
    planned_leg_link_source: 'manual',
  };
  const actual2 = decideHandClose('flown', linkedButLegMissingFlight, null);
  const want2 = 'Flight 56 is not linked to a planned leg';
  const ok2 = !actual2.allowed && actual2.reason === 'NOT_LINKED' && actual2.message === want2;
  console.log(
    `   case 2 (planned_leg_id=12 set, leg row missing), request 'flown': module-level fallback ` +
      `expected 409 NOT_LINKED "${want2}" (the HTTP layer answers 404 'Planned leg not found' before ` +
      `reaching this function at all)`,
  );
  console.log(`           actual: ${fmtActual(actual2)}${!actual2.allowed ? ` "${actual2.message}"` : ''}  ${ok2 ? '✓' : '✗'}`);
  if (!ok2) failures.push(`   ✗ outside-the-grid case 2: got ${JSON.stringify(actual2)}`);
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. NAMED_SCENARIOS — the six required rows
// ═══════════════════════════════════════════════════════════════════════════

interface NamedScenario {
  label: string;
  requested: HandCloseRequest;
  flight: HandCloseFlight;
  leg: HandCloseLeg | null;
  expected: ExpectedVerdict;
  expectedDeviation?: number | null; // checked only when expected.allowed
  expectedStatus?: HandCloseRequest; // sanity: allowed.status is always the request, never 'diverted'
  note: string;
}

const MANUAL_ENDED_LEG_PLANNED_FLIGHT: HandCloseFlight = {
  id: 56,
  end_time: '2026-09-07T17:06:00.726Z',
  planned_leg_id: 12,
  planned_leg_link_source: 'manual',
  arrival_lat: FLIGHT_56_ARRIVAL.lat,
  arrival_lon: FLIGHT_56_ARRIVAL.lon,
};
const LEG_12_PLANNED: HandCloseLeg = {
  id: 12,
  status: 'planned',
  destination_lat: LEG_12_DEST.lat,
  destination_lon: LEG_12_DEST.lon,
};

const NAMED_SCENARIOS: NamedScenario[] = [
  {
    label: '(a) live stuck case: flight 56 -> leg 12, manual, ended, leg planned',
    requested: 'flown',
    flight: MANUAL_ENDED_LEG_PLANNED_FLIGHT,
    leg: LEG_12_PLANNED,
    expected: ALLOW,
    expectedDeviation: 0.3,
    expectedStatus: 'flown',
    note: 'recomputed deviation for this exact pair is 0.3 nm',
  },
  {
    label: '(b) same flight, auto link instead of manual',
    requested: 'flown',
    flight: { ...MANUAL_ENDED_LEG_PLANNED_FLIGHT, planned_leg_link_source: 'auto' },
    leg: LEG_12_PLANNED,
    expected: refuse('LINK_NOT_MANUAL'),
    note: 'only a hand-linked flight can be closed by hand',
  },
  {
    label: "(c) same flight, manual, but end_time NULL (still in the air)",
    requested: 'flown',
    flight: { ...MANUAL_ENDED_LEG_PLANNED_FLIGHT, end_time: null },
    leg: LEG_12_PLANNED,
    expected: refuse('FLIGHT_NOT_ENDED'),
    note: 'the planned leg is closed at touchdown, not before',
  },
  {
    label: '(d) manual, ended, leg planned, but arrival position NULL',
    requested: 'flown',
    flight: { ...MANUAL_ENDED_LEG_PLANNED_FLIGHT, arrival_lat: null, arrival_lon: null },
    leg: LEG_12_PLANNED,
    expected: ALLOW,
    expectedDeviation: null,
    expectedStatus: 'flown',
    note: 'the NULL policy: store arrival_deviation_nm = NULL, still set the requested status',
  },
  {
    label: '(e) antimeridian: arrival 179°E vs destination 179°W',
    requested: 'flown',
    flight: { ...MANUAL_ENDED_LEG_PLANNED_FLIGHT, arrival_lat: ANTIMERIDIAN_ARRIVAL.lat, arrival_lon: ANTIMERIDIAN_ARRIVAL.lon },
    leg: { ...LEG_12_PLANNED, destination_lat: ANTIMERIDIAN_DEST.lat, destination_lon: ANTIMERIDIAN_DEST.lon },
    expected: ALLOW,
    expectedDeviation: 120.1,
    expectedStatus: 'flown',
    note: '~2° of longitude (~120 nm), not 358° — proof the deviation is haversine, not a degree delta',
  },
  {
    label: '(f) far diversion: ~124.8 nm off plan',
    requested: 'flown',
    flight: { ...MANUAL_ENDED_LEG_PLANNED_FLIGHT, arrival_lat: LEG_12_DEST.lat, arrival_lon: LEG_12_DEST.lon },
    leg: { ...LEG_12_PLANNED, destination_lat: FAR_DIVERSION_DEST.lat, destination_lon: FAR_DIVERSION_DEST.lon },
    expected: ALLOW,
    expectedDeviation: 124.8,
    expectedStatus: 'flown',
    note: "status is 'flown', NEVER 'diverted' — the frozen decision — however large the deviation",
  },
];

function runNamedScenarios(): void {
  console.log('── six required named rows');
  console.log('');
  for (const s of NAMED_SCENARIOS) {
    const actual = decideHandClose(s.requested, s.flight, s.leg);
    let ok = verdictMatches(actual, s.expected);
    const notes: string[] = [];

    if (s.expected.allowed && actual.allowed) {
      if (s.expectedDeviation !== undefined && actual.deviationNm !== s.expectedDeviation) {
        ok = false;
        notes.push(`deviationNm expected ${s.expectedDeviation}, got ${actual.deviationNm}`);
      }
      if (s.expectedStatus !== undefined && actual.status !== s.expectedStatus) {
        ok = false;
        notes.push(`status expected '${s.expectedStatus}', got '${actual.status}'`);
      }
    }

    console.log(`   ${s.label}`);
    console.log(`        ${s.note}`);
    console.log(
      `        expected: ${fmtVerdict(s.expected)}${s.expectedDeviation !== undefined ? `, deviationNm ${s.expectedDeviation}` : ''}${s.expectedStatus !== undefined ? `, status '${s.expectedStatus}'` : ''}`,
    );
    console.log(
      `        actual:   ${fmtActual(actual)}${actual.allowed ? `, deviationNm ${actual.deviationNm}, status '${actual.status}'` : ` "${(actual as any).message}"`}  ${ok ? '✓' : '✗'}`,
    );
    if (!ok) {
      failures.push(`   ✗ ${s.label}\n        ${notes.length ? notes.join('\n        ') : `expected ${fmtVerdict(s.expected)}, got ${fmtActual(actual)}`}`);
    }
  }
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. ROUNDING_BOUNDARY — an x.x5 nm boundary where the two roundings diverge
// ═══════════════════════════════════════════════════════════════════════════
//
// The rounding is frozen as `Math.round(deviationNm * 10) / 10`,
// character-identical to PlannedLegLink.recordArrival(), and explicitly rules out
// `toFixed(1)` / `Number(x.toFixed(1))` / a `round(x, 1)` helper as look-alikes
// that can disagree. This row is constructed (by binary search over a due-north
// offset, so the two points share a meridian and the geometry is exact) so
// that its raw haversine distance sits at a genuine floating-point x.x5
// boundary where the two roundings actually differ — not a hypothetical.

function runRoundingBoundary(): void {
  console.log('── rounding boundary — Math.round(x*10)/10 vs Number(x.toFixed(1))');
  console.log('');

  // Arrival at the origin; destination 0.0024983152722295506° north of it —
  // found by binary search so that haversineNm(...) lands on the double
  // nearest 0.15 nm, i.e. 0.14999999999999999445..., a value multiplying by
  // 10 pushes to the far side of the boundary from where toFixed(1) sees it.
  const flight: HandCloseFlight = {
    id: 901,
    end_time: '2026-09-07T17:06:00.726Z',
    planned_leg_id: 501,
    planned_leg_link_source: 'manual',
    arrival_lat: 0,
    arrival_lon: 0,
  };
  const leg: HandCloseLeg = {
    id: 501,
    status: 'planned',
    destination_lat: 0.0024983152722295506,
    destination_lon: 0,
  };

  const decision = decideHandClose('flown', flight, leg);
  const direct = handCloseDeviationNm(flight, leg);

  // The two candidate roundings of the SAME raw double, computed here only to
  // show the divergence this row is built to exercise — the module itself
  // must use the first one, never the second.
  const rawViaModule = direct; // already rounded by the frozen expression
  const raw = 0.14999999999999999445; // the double both roundings start from
  const roundExpr = Math.round(raw * 10) / 10; // the frozen expression
  const toFixedExpr = Number(raw.toFixed(1)); // the look-alike the design rules out

  console.log(`   raw distance (double)        : ${raw}`);
  console.log(`   Math.round(raw*10)/10        : ${roundExpr}  <- the frozen expression, src/flightManager.ts:463`);
  console.log(`   Number(raw.toFixed(1))       : ${toFixedExpr}  <- NOT used; shown to prove the two disagree here`);
  console.log(`   handCloseDeviationNm() actual : ${rawViaModule}`);
  console.log(`   decideHandClose() deviationNm: ${decision.allowed ? decision.deviationNm : 'n/a (refused)'}`);

  const disagree = roundExpr !== toFixedExpr;
  const ok = decision.allowed && rawViaModule === roundExpr && decision.deviationNm === roundExpr;
  console.log(
    `   the two roundings ${disagree ? 'DO disagree at this boundary' : 'agree here'} (${roundExpr} vs ${toFixedExpr}); ` +
      `module used the frozen expression: ${ok ? '✓' : '✗'}`,
  );
  console.log('');
  if (!ok) {
    failures.push(
      `   ✗ rounding boundary: expected handCloseDeviationNm()===${roundExpr} (Math.round(x*10)/10), got ${rawViaModule}`,
    );
  }
  if (!disagree) {
    // Not fatal to the module's correctness, but it would mean this specific
    // boundary no longer proves anything — flag it loudly rather than let a
    // future edit silently defang the row.
    failures.push('   ✗ rounding boundary: the two roundings no longer disagree at this input — row needs a new boundary');
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

function main(): void {
  runGateTable();
  runOutsideTheGrid();
  runNamedScenarios();
  runRoundingBoundary();

  if (failures.length === 0) {
    console.log(`${GATE_TABLE.length} gate rows (${GATE_TABLE.length * 2} verdicts) + 2 outside-the-grid cases + ${NAMED_SCENARIOS.length} named rows + 1 rounding-boundary row, 0 failures`);
    return;
  }
  for (const f of failures) console.error(f);
  console.error('');
  console.error(`${failures.length} failure(s)`);
  process.exitCode = 1;
}

main();
