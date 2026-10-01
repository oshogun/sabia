/**
 * ACARS message rules. This module is deliberately free of database, express
 * and I/O imports — it reads no clock, no environment and no file — so every
 * rule below can be unit-tested on its own: values in, values out. The
 * persistence half lives in src/db/acarsMessages.ts and the transport half in
 * src/routes/acars.ts; neither vocabulary is duplicated there.
 */

import type {
  AcarsDirection, CannedAcarsMessage, ClearanceDetails, CreateAcarsMessage, DispatchPayload, LoadsheetFigures,
  OooiEvent, OooiPayload, PositionReportPayload,
} from './types';
import type { ParsedSimbriefPlan } from './simbrief';

/** The two directions the codebase knows. The column itself has no CHECK. */
export const ACARS_DIRECTIONS = ['uplink', 'downlink'] as const;

/**
 * The categories this codebase knows how to label and colour today. NOT a
 * closed set: the column accepts any well-shaped category, so a new kind of
 * message needs no migration and no change to the validator — only to this
 * list, and only if it wants a badge of its own.
 */
export const KNOWN_ACARS_CATEGORIES = [
  'pdc', 'wx', 'freetext', 'position-report', 'dispatch', 'oooi',
] as const;

/** The single direction a client is permitted to write. */
export const CLIENT_DIRECTION = 'downlink';

/**
 * Generous ceiling that still bounds the column: a METAR+TAF pair and a full
 * PDC are each well under it.
 */
export const MAX_ACARS_BODY_LENGTH = 4096;

/**
 * The fixed outgoing set, in render order. A client may send these and nothing
 * else: free text is not accepted, and everything stored comes from the entry
 * rather than from the request.
 *
 * All three are 'freetext', including WX REQUEST — the category records what a
 * message *is*, and this one is a typed-out phrase that triggers no lookup and
 * carries no ICAO, so filing it as 'wx' would put an entry in the weather
 * category that no reply will ever correlate to.
 */
export const CANNED_MESSAGES: readonly CannedAcarsMessage[] = [
  { id: 'wx-request',       label: 'WX REQUEST',       body: 'WX REQUEST',       category: 'freetext', direction: 'downlink' },
  { id: 'gate-request',     label: 'GATE REQUEST',     body: 'GATE REQUEST',     category: 'freetext', direction: 'downlink' },
  { id: 'request-pushback', label: 'REQUEST PUSHBACK', body: 'REQUEST PUSHBACK', category: 'freetext', direction: 'downlink' },
];

export type AcarsBodyResult =
  | { ok: true; body: string }
  | { ok: false; code: 'INVALID_BODY' | 'BODY_TOO_LONG'; error: string };

export function isAcarsDirection(v: unknown): v is AcarsDirection {
  return typeof v === 'string' && (ACARS_DIRECTIONS as readonly string[]).includes(v);
}

/**
 * Shape, not membership: lower-kebab, starting with a letter, at most 32
 * characters. That is what actually protects the column — the enumeration is
 * open (see KNOWN_ACARS_CATEGORIES) — and it is also what makes a category safe
 * to interpolate into a CSS class name.
 */
export function isValidAcarsCategory(v: unknown): boolean {
  return typeof v === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(v);
}

/** Membership, for display decisions. A different question from validity. */
export function isKnownAcarsCategory(v: string): boolean {
  return (KNOWN_ACARS_CATEGORIES as readonly string[]).includes(v);
}

/** Exact, case-sensitive match on id: an id is a wire value, not user typing. */
export function findCannedMessage(id: unknown): CannedAcarsMessage | null {
  if (typeof id !== 'string' || id === '') return null;
  return CANNED_MESSAGES.find(m => m.id === id) ?? null;
}

/**
 * Trims, collapses every run of whitespace (newlines and tabs included) to one
 * space, and uppercases. Applied only to a client-submitted body before it is
 * matched against the canned set — never to a stored body, which keeps its
 * newlines and its case exactly.
 */
export function normaliseCannedBody(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** The entry whose body normalises to the same text, or null. */
export function findCannedMessageByBody(body: unknown): CannedAcarsMessage | null {
  if (typeof body !== 'string') return null;
  const normalised = normaliseCannedBody(body);
  if (normalised === '') return null;
  return CANNED_MESSAGES.find(m => normaliseCannedBody(m.body) === normalised) ?? null;
}

/**
 * The guard for any writer of a message body, including the server-side ones.
 * The length is measured before trimming, so padding cannot smuggle a body past
 * the ceiling; the stored value is the trimmed string, with its interior
 * newlines intact.
 */
export function validateAcarsBody(raw: unknown): AcarsBodyResult {
  if (typeof raw !== 'string') {
    return { ok: false, code: 'INVALID_BODY', error: 'Message body must be text' };
  }
  if (raw.length > MAX_ACARS_BODY_LENGTH) {
    return { ok: false, code: 'BODY_TOO_LONG', error: `Message body is too long (max ${MAX_ACARS_BODY_LENGTH} characters)` };
  }
  const body = raw.trim();
  if (body === '') {
    return { ok: false, code: 'INVALID_BODY', error: 'Message body must not be empty' };
  }
  return { ok: true, body };
}

/** 'wx-request, gate-request, request-pushback' — the tail of the error text. */
export function cannedMessageIdList(): string {
  return CANNED_MESSAGES.map(m => m.id).join(', ');
}

// ── Dispatch release + load sheet ───────────────────────────────────────────
//
// Server-generated messages: a SimBrief import files a dispatch release, and a
// pilot action files a load-sheet request/reply pair, both keyed to a planned
// leg rather than a flight (a planned leg exists before pushback, when there is
// no flights row yet). Every function below is pure — no clock, no database —
// so the emitter (src/routes/plannedLegs.ts, src/routes/acars.ts) and the
// reader cannot disagree about a dedup key or a body's wording.

export const DISPATCH_RELEASE_LABEL = 'DISPATCH RELEASE';
export const LOADSHEET_REQUEST_LABEL = 'REQUEST LOADSHEET';
export const LOADSHEET_LABEL = 'LOADSHEET';
/** The one definition of the rejection phrase a missing dispatch record answers with. */
export const NO_DISPATCH_DATA_MESSAGE = 'NO DISPATCH DATA ON FILE';
/** Ceiling on the filed route inside a message body, so no body can exceed MAX_ACARS_BODY_LENGTH. */
export const MAX_ROUTE_BODY_CHARS = 900;

/** Keyed on the planned leg, not the OFP: a re-imported OFP is a new leg and gets its own release. */
export function dispatchDedupKey(legId: number): string {
  return `dispatch:leg:${legId}`;
}
export function loadsheetRequestDedupKey(legId: number): string {
  return `loadsheet-req:leg:${legId}`;
}
export function loadsheetReplyDedupKey(legId: number): string {
  return `loadsheet:leg:${legId}`;
}

// ── Shared formatters ────────────────────────────────────────────────────────
// Used by both the dispatch-release body and the load-sheet bodies, so the two
// messages cannot disagree about how a number looks.

/** null, non-finite or negative -> '----'. Otherwise HHMM, seconds discarded (never rounded up). */
export function hhmm(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return '----';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`;
}

/** null -> 'UNKNOWN'. >= 18000 ft -> flight level, e.g. 'FL280'. Otherwise '8000FT'. */
export function levelText(ft: number | null): string {
  if (ft === null) return 'UNKNOWN';
  const r = Math.round(ft);
  return r >= 18000 ? `FL${String(Math.round(r / 100)).padStart(3, '0')}` : `${r}FT`;
}

/** null -> '----'. Otherwise the rounded value, no thousands separator, no unit suffix. */
export function qty(v: number | null): string {
  return v === null ? '----' : String(Math.round(v));
}

/** 'kgs'/'kg' -> 'KG'; 'lbs'/'lb' -> 'LB'; anything else including null -> 'UNITS UNKNOWN'. */
export function unitText(units: string | null): string {
  const u = (units ?? '').toLowerCase();
  return u === 'kgs' || u === 'kg' ? 'KG' : u === 'lbs' || u === 'lb' ? 'LB' : 'UNITS UNKNOWN';
}

/** null -> 'NIL'. At or under the cap, verbatim. Otherwise truncated with a trailing '...'. */
export function clampRoute(route: string | null): string {
  if (route === null) return 'NIL';
  return route.length <= MAX_ROUTE_BODY_CHARS ? route : `${route.slice(0, MAX_ROUTE_BODY_CHARS - 3)}...`;
}

/** label.padEnd(14) + value.padStart(6) — the fixed-field grid the load sheet's body is built from. */
export function field(label: string, value: string): string {
  return `${label.padEnd(14, ' ')}${value.padStart(6, ' ')}`;
}

/** Field copy, no arithmetic, no unit conversion — the parser's numbers, unmodified. */
export function buildDispatchPayload(plan: ParsedSimbriefPlan): DispatchPayload {
  const d = plan.dispatch;
  return {
    v: 1,
    source: 'simbrief',
    ofp: {
      request_id: plan.ofp.requestId,
      sequence_id: plan.ofp.sequenceId,
      time_generated: plan.ofp.timeGenerated,
    },
    flight_number: plan.ofp.flightNumber,
    aircraft_type: plan.aircraftType,
    aircraft_reg: d.aircraftReg,
    origin: plan.departure.ident,
    destination: plan.destination.ident,
    alternates: plan.alternates.map((a) => a.ident),
    route: plan.ofp.routeString,
    cruise_alt_ft: plan.cruiseAltFt,
    units: d.units,
    ete_sec: d.estTimeEnrouteSec,
    block_time_sec: d.estBlockSec,
    fuel: {
      ramp: d.planRamp,
      takeoff: d.planTakeoff,
      landing: d.planLanding,
      taxi: d.taxi,
      enroute_burn: d.enrouteBurn,
      contingency: d.contingency,
      reserve: d.reserve,
      alternate_burn: d.alternateBurn,
    },
    weights: {
      oew: d.oew,
      payload: d.payload,
      est_zfw: d.estZfw,
      max_zfw: d.maxZfw,
      est_tow: d.estTow,
      est_ldw: d.estLdw,
      pax_count: d.paxCount,
      cargo: d.cargo,
    },
  };
}

/**
 * Total: never throws. `null` is "no usable dispatch data on file" — an absent
 * or unparseable blob, or one written by a schema version this build does not
 * know. A string is written by us, in one place; a scalar that arrives as a
 * string here means the stored data is not what we wrote, so it is dropped
 * rather than coerced.
 */
export function parseDispatchPayload(raw: string | null): DispatchPayload | null {
  if (raw === null || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  if (p['v'] !== 1 || p['source'] !== 'simbrief') return null;

  const numOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const ofp = rec(p['ofp']);
  const fuel = rec(p['fuel']);
  const weights = rec(p['weights']);
  const alternatesRaw = p['alternates'];

  return {
    v: 1,
    source: 'simbrief',
    ofp: {
      request_id: strOrNull(ofp['request_id']),
      sequence_id: strOrNull(ofp['sequence_id']),
      time_generated: strOrNull(ofp['time_generated']),
    },
    flight_number: strOrNull(p['flight_number']),
    aircraft_type: strOrNull(p['aircraft_type']),
    aircraft_reg: strOrNull(p['aircraft_reg']),
    origin: strOrNull(p['origin']),
    destination: strOrNull(p['destination']),
    alternates: Array.isArray(alternatesRaw) ? alternatesRaw.filter((s): s is string => typeof s === 'string') : [],
    route: strOrNull(p['route']),
    cruise_alt_ft: numOrNull(p['cruise_alt_ft']),
    units: strOrNull(p['units']),
    ete_sec: numOrNull(p['ete_sec']),
    block_time_sec: numOrNull(p['block_time_sec']),
    fuel: {
      ramp: numOrNull(fuel['ramp']),
      takeoff: numOrNull(fuel['takeoff']),
      landing: numOrNull(fuel['landing']),
      taxi: numOrNull(fuel['taxi']),
      enroute_burn: numOrNull(fuel['enroute_burn']),
      contingency: numOrNull(fuel['contingency']),
      reserve: numOrNull(fuel['reserve']),
      alternate_burn: numOrNull(fuel['alternate_burn']),
    },
    weights: {
      oew: numOrNull(weights['oew']),
      payload: numOrNull(weights['payload']),
      est_zfw: numOrNull(weights['est_zfw']),
      max_zfw: numOrNull(weights['max_zfw']),
      est_tow: numOrNull(weights['est_tow']),
      est_ldw: numOrNull(weights['est_ldw']),
      pax_count: numOrNull(weights['pax_count']),
      cargo: numOrNull(weights['cargo']),
    },
  };
}

/** The dispatch-release body: route, cruise altitude, planned fuel, alternates, ETE. */
export function buildDispatchReleaseBody(p: DispatchPayload, issuedAt: string): string {
  const lines = [
    'DISPATCH RELEASE',
    `FLT ${p.flight_number ?? 'UNKNOWN'}`,
    `${p.origin ?? '????'} ${p.destination ?? '????'} ALTN ${p.alternates.length ? p.alternates.join(' ') : 'NONE'}`,
    `ACFT ${p.aircraft_type ?? 'UNKNOWN'} ${p.aircraft_reg ?? 'NOREG'}`,
    `CRZ ${levelText(p.cruise_alt_ft)}`,
    `ETE ${hhmm(p.ete_sec)}`,
    `FUEL ${unitText(p.units)} BLOCK ${qty(p.fuel.ramp)} TRIP ${qty(p.fuel.enroute_burn)} RESV ${qty(p.fuel.reserve)} ALTN ${qty(p.fuel.alternate_burn)} CONT ${qty(p.fuel.contingency)} TAXI ${qty(p.fuel.taxi)}`,
    `RTE ${clampRoute(p.route)}`,
    `OFP ${p.ofp.request_id ?? 'UNKNOWN'} ISSUED ${issuedAt}`,
    'SIMULATED DISPATCH RELEASE - NOT FOR REAL WORLD USE',
  ];
  return lines.join('\n');
}

/**
 * Derives block fuel, payload and zero-fuel weight from the dispatch payload.
 * Payload is resolved before ZFW, and ZFW's fallback consumes the
 * already-resolved payload, so the two fallbacks can never both fire on the
 * same plan.
 */
export function buildLoadsheetFigures(p: DispatchPayload): LoadsheetFigures {
  const f = p.fuel;
  const w = p.weights;

  const blockFuel = f.ramp !== null ? f.ramp
    : f.takeoff !== null && f.taxi !== null ? f.takeoff + f.taxi
      : null;

  const payload = w.payload !== null ? w.payload
    : w.est_zfw !== null && w.oew !== null ? w.est_zfw - w.oew
      : null;
  const payloadSource: LoadsheetFigures['payload_source'] =
    w.payload !== null ? 'simbrief' : payload !== null ? 'derived' : 'unavailable';

  const zfw = w.est_zfw !== null ? w.est_zfw
    : w.oew !== null && payload !== null ? w.oew + payload
      : null;
  const zfwSource: LoadsheetFigures['zfw_source'] =
    w.est_zfw !== null ? 'simbrief' : zfw !== null ? 'derived' : 'unavailable';

  return {
    units: p.units,
    block_fuel: blockFuel,
    taxi_fuel: f.taxi,
    takeoff_fuel: f.takeoff,
    trip_fuel: f.enroute_burn,
    payload,
    payload_source: payloadSource,
    zero_fuel_weight: zfw,
    zfw_source: zfwSource,
    max_zero_fuel_weight: w.max_zfw,
    dry_operating_weight: w.oew,
    takeoff_weight: w.est_tow,
    landing_weight: w.est_ldw,
    pax_count: w.pax_count,
    cargo: w.cargo,
    estimated: true,
  };
}

/** The pilot's load-sheet request: two lines, no figures — the figures arrive in the reply. */
export function buildLoadsheetRequestBody(p: DispatchPayload): string {
  const fltClause = p.flight_number ? ` FLT ${p.flight_number}` : '';
  return `REQUEST LOADSHEET\n${p.origin ?? '????'} ${p.destination ?? '????'}${fltClause}`;
}

/** The generated load-sheet reply: fixed-field figures, in `field()`'s aligned grid. */
export function buildLoadsheetReplyBody(p: DispatchPayload, sheet: LoadsheetFigures, issuedAt: string): string {
  const zfwLine = sheet.max_zero_fuel_weight === null
    ? field('ZERO FUEL WT', qty(sheet.zero_fuel_weight))
    : `${field('ZERO FUEL WT', qty(sheet.zero_fuel_weight))} MAX ${qty(sheet.max_zero_fuel_weight)}`;

  const lines = [
    'LOADSHEET',
    `FLT ${p.flight_number ?? 'UNKNOWN'} ${p.origin ?? '????'} ${p.destination ?? '????'}`,
    `ACFT ${p.aircraft_type ?? 'UNKNOWN'} ${p.aircraft_reg ?? 'NOREG'}`,
    `UNITS ${unitText(sheet.units)}`,
    field('BLOCK FUEL', qty(sheet.block_fuel)),
    field('TAXI FUEL', qty(sheet.taxi_fuel)),
    field('TAKEOFF FUEL', qty(sheet.takeoff_fuel)),
    field('TRIP FUEL', qty(sheet.trip_fuel)),
    field('PAX', qty(sheet.pax_count)),
    field('CARGO', qty(sheet.cargo)),
    field('PAYLOAD', qty(sheet.payload)),
    field('DRY OPER WT', qty(sheet.dry_operating_weight)),
    zfwLine,
    field('TAKEOFF WT', qty(sheet.takeoff_weight)),
    field('LANDING WT', qty(sheet.landing_weight)),
    `ISSUED ${issuedAt}`,
    'ESTIMATED FIGURES - SIMULATION ONLY - NOT FOR ACTUAL LOADING',
  ];
  return lines.join('\n');
}

// ── PDC (Pre-Departure Clearance) ────────────────────────────────────────────
//
// A simulated clearance, generated from the same on-file dispatch release the
// load sheet reads — a leg with no filed route has nothing to clear it
// against. Keyed to the planned leg, same as the loadsheet request/reply
// pair, and idempotent for the same reason: the same dispatch payload always
// yields the same clearance, so a second request returns the first one
// rather than filing a duplicate.

export const NO_FLIGHT_PLAN_MESSAGE = 'NO FLIGHT PLAN ON FILE';
export const CLEARANCE_REQUEST_LABEL = 'REQUEST CLEARANCE';
export const CLEARANCE_LABEL = 'PDC';
export const DEFAULT_INITIAL_ALTITUDE_FT = 5000;

export function clearanceRequestDedupKey(legId: number): string {
  return `clearance-req:leg:${legId}`;
}
export function clearanceDedupKey(legId: number): string {
  return `clearance:leg:${legId}`;
}

/** min(5000, cruiseAltFt) when cruiseAltFt is known and lower; else 5000. No initial-climb-altitude data exists anywhere on a planned leg (SID has no altitude column), so this is a fixed simulated default, not derived from real procedure data. */
export function deriveInitialAltitudeFt(cruiseAltFt: number | null): number {
  if (cruiseAltFt === null) return DEFAULT_INITIAL_ALTITUDE_FT;
  return Math.min(DEFAULT_INITIAL_ALTITUDE_FT, cruiseAltFt);
}

/** Deterministic 4-digit octal (digits 0-7) squawk from the leg id — same leg always gets the same code (AC2). Excludes the reserved codes 0000/7500/7600/7700. */
export function squawkForLeg(legId: number): string {
  const RESERVED = new Set(['0000', '7500', '7600', '7700']);
  let n = (Math.abs(Math.trunc(legId)) * 2654435761) % 4096;
  let code = n.toString(8).padStart(4, '0');
  while (RESERVED.has(code)) {
    n = (n + 1) % 4096;
    code = n.toString(8).padStart(4, '0');
  }
  return code;
}

/** Field values only, no formatting — the message body and the JSON payload derive from this one struct so they cannot disagree. */
export function buildClearanceDetails(p: DispatchPayload, legId: number): ClearanceDetails {
  return {
    v: 1,
    departure_icao: p.origin,
    destination_icao: p.destination,
    route: clampRoute(p.route),
    initial_altitude_ft: deriveInitialAltitudeFt(p.cruise_alt_ft),
    squawk: squawkForLeg(legId),
  };
}

/** The clearance body: departure/destination, cleared route, initial altitude, squawk, and an unambiguous simulation disclaimer (never to be read as a real-world IFR clearance). */
export function buildClearanceBody(details: ClearanceDetails): string {
  const lines = [
    'PDC',
    `${details.departure_icao ?? '????'} TO ${details.destination_icao ?? '????'}`,
    `CLEARED VIA ${details.route ?? 'NIL'}`,
    `CLIMB AND MAINTAIN ${levelText(details.initial_altitude_ft)}`,
    `SQUAWK ${details.squawk}`,
    'SIMULATED CLEARANCE - NOT FOR REAL WORLD USE',
  ];
  return lines.join('\n');
}

/**
 * Total: never throws. Reads a stored clearance's payload_json back into a
 * ClearanceDetails, the same shape parseDispatchPayload uses for the dispatch
 * release: `v !== 1` or an unparseable/non-object blob is `null`, and every
 * other field falls back rather than failing the whole parse — a squawk that
 * arrives as something other than a string reads as '0000' rather than
 * discarding an otherwise-usable clearance.
 */
export function parseClearancePayload(raw: string | null): ClearanceDetails | null {
  if (raw === null || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  if (p['v'] !== 1) return null;

  const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

  return {
    v: 1,
    departure_icao: strOrNull(p['departure_icao']),
    destination_icao: strOrNull(p['destination_icao']),
    route: strOrNull(p['route']),
    initial_altitude_ft: typeof p['initial_altitude_ft'] === 'number' ? p['initial_altitude_ft'] : DEFAULT_INITIAL_ALTITUDE_FT,
    squawk: typeof p['squawk'] === 'string' ? p['squawk'] : '0000',
  };
}

// ── Condensed ACARS_IN message ───────────────────────────────────────────────
//
// A one-line, <=128-character rendering of a clearance for SayIntentions'
// sayAs(channel=ACARS_IN), which carries no disclaimer and clips the route
// rather than the fixed fields around it — the departure and arrival transitions
// are what a readback is actually about, so they are the two things that
// survive a clip. Deliberately separate from buildClearanceBody: that body is
// already stored, already read by the UI, and six lines long by design.

/** SayIntentions' documented cap for channel=ACARS_IN. */
export const MAX_ACARS_IN_CHARS = 128;

/** Strips anything outside printable ASCII, uppercases, collapses whitespace
 *  runs to one space, trims. Empty result (including the untouched literal
 *  'NIL' clampRoute() emits, handled by the caller) -> null. */
function normaliseRoute(route: string | null): string | null {
  if (route === null) return null;
  const cleaned = route
    .replace(/[^\x20-\x7E]/g, ' ')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned === '' ? null : cleaned;
}

/**
 * Fits a route's tokens into `budget` characters. The whole route wins if it
 * fits; otherwise the first token and the last token are kept — the departure
 * and arrival transitions — with as many middle tokens as fit before them,
 * joined by ' .. '. Falls back to a hard character clip when even the first
 * and last token cannot both fit, and to 'NIL' when there is no room at all.
 */
function clipRouteToBudget(tokens: string[], budget: number): string {
  const whole = tokens.join(' ');
  if (whole.length <= budget) return whole;

  const last = tokens[tokens.length - 1];
  const suffix = ` .. ${last}`;
  if (tokens.length > 1 && suffix.length + tokens[0].length <= budget) {
    let out = tokens[0];
    for (let i = 1; i < tokens.length - 1; i++) {
      const next = `${out} ${tokens[i]}`;
      if (next.length + suffix.length > budget) break;
      out = next;
    }
    return out + suffix;
  }

  if (budget >= 3) return `${whole.slice(0, budget - 2).trimEnd()}..`;
  return 'NIL';
}

/**
 * 'PDC <dep> <dst> CLRD <route> CLB <level> SQ <squawk>' — never longer than
 * MAX_ACARS_IN_CHARS, for any ClearanceDetails: the route is clipped to
 * whatever budget is left after the fixed head and tail, and a final slice
 * makes the cap hold even if every earlier step somehow did not.
 */
export function buildCondensedClearanceMessage(details: ClearanceDetails): string {
  const dep = (details.departure_icao ?? '').trim().toUpperCase() || '????';
  const dst = (details.destination_icao ?? '').trim().toUpperCase() || '????';
  const head = `PDC ${dep} ${dst} CLRD `;
  const tail = ` CLB ${levelText(details.initial_altitude_ft)} SQ ${details.squawk}`;
  const budget = MAX_ACARS_IN_CHARS - head.length - tail.length;

  const route = normaliseRoute(details.route);
  let routeText: string;
  if (route === null || route === 'NIL') {
    routeText = 'NIL';
  } else if (budget < 5) {
    routeText = 'NIL';
  } else {
    routeText = clipRouteToBudget(route.split(' '), budget);
  }

  const message = `${head}${routeText}${tail}`;
  return message.length <= MAX_ACARS_IN_CHARS ? message : message.slice(0, MAX_ACARS_IN_CHARS);
}

// ── Weather request ──────────────────────────────────────────────────────────
//
// A crew-initiated request/reply pair, filed fresh on every call (no dedup
// key, unlike the dispatch/loadsheet messages above): a WX request answers a
// question about "right now," so repeating it is meaningful, not a duplicate.

export const WX_UNAVAILABLE_LABEL = 'WX UNAVAILABLE';

/** Trim, then uppercase. The one normalisation applied before validation,
 *  caching (weatherClient's cache key), and storage (the request/reply body
 *  and label both interpolate this normalised form, never the raw input). */
export function normaliseIcao(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Shape check for a four-character alphanumeric ICAO. Applied to an
 *  ALREADY-normalised string — call normaliseIcao() first. */
export function isValidIcaoShape(v: string): boolean {
  return /^[A-Z0-9]{4}$/.test(v);
}

/** 'WX REQUEST EGLL' — both the request row's label and its body, verbatim. */
export function wxRequestLabelAndBody(icao: string): string {
  return `WX REQUEST ${icao}`;
}

/** 'METAR EGLL' — the reply row's label when weather was found, regardless of
 *  whether a TAF was also found. */
export function wxReplyLabel(icao: string): string {
  return `METAR ${icao}`;
}

/** metar, or metar + '\n' + taf when a TAF was found. Never adds a TAF header
 *  line: the raw METAR and TAF text are each already self-identifying
 *  ("METAR KJFK...", "TAF KJFK..."). */
export function buildWxReplyBody(metar: string, taf: string | null): string {
  return taf !== null ? `${metar}\n${taf}` : metar;
}

/** 'WX DATA UNAVAILABLE FOR ZZZZ' — the one definition of this literal string. */
export function buildWxUnavailableBody(icao: string): string {
  return `WX DATA UNAVAILABLE FOR ${icao}`;
}

// ── OOOI events ───────────────────────────────────────────────────────────────
//
// OUT/OFF/ON/IN: server-generated, one per flight, keyed to a flight rather
// than a planned leg — a flight row always exists by the time any of these
// is filed, even though OUT is timestamped to an earlier instant (the
// off-blocks memo). Every function here is pure; the emitter (OooiReporter in
// src/flight/oooiReporter.ts, via src/acarsEvents.ts) owns the filing, with its
// clock reads and database writes.

export const POSITION_REPORT_LABEL = 'POS REPORT';
export const MIN_ETA_GROUND_SPEED_KTS = 30;
export const DEFAULT_POSITION_REPORT_INTERVAL_MIN = 10;
export const MIN_POSITION_REPORT_INTERVAL_MIN = 0.5;

export interface OooiEventInput {
  flightId: number;
  event: OooiEvent;
  /** ISO 8601 UTC; becomes sent_at and the HHMMZ in the body. */
  at: string;
  /** Station ICAO, or null when no airport resolved within range. */
  airportIcao: string | null;
  /** Stand/gate from the ground session; null everywhere else. */
  stand: string | null;
  /** frame.aircraft, or null. */
  aircraft: string | null;
  /** The linked leg's destinationIdent, from the planned-leg link's cache, or null when unlinked. */
  destinationIdent: string | null;
  /** Recorded in payload_json only; the row stays flight-scoped. */
  plannedLegId: number | null;
  /** True when `at` is not the instant the event name describes. */
  estimated: boolean;
}

/** 'oooi:flight:12:OUT'. */
export function oooiDedupKey(flightId: number, event: OooiEvent): string {
  return `oooi:flight:${flightId}:${event}`;
}

/** The frozen wording of the third body line. Total: defined for all four. */
export function oooiEstimatedReason(event: OooiEvent): string {
  switch (event) {
    case 'OUT': return 'NO GROUND SESSION, TIME TAKEN AT TAKEOFF';
    case 'ON': return 'NO TOUCHDOWN DETECTED, TIME TAKEN AT FLIGHT END';
    case 'OFF':
    case 'IN':
      return 'TIME APPROXIMATE';
  }
}

/** '<HHMM>Z' UTC from an ISO instant; '----Z' for an unparseable string. */
export function hhmmz(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '----Z';
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
}

/** The two- or three-line OOOI body. */
export function buildOooiBody(input: OooiEventInput): string {
  const lines = [
    `${input.event} ${input.airportIcao ?? '----'} ${hhmmz(input.at)}`,
    `ACFT ${input.aircraft ?? 'UNKNOWN'}` +
      (input.stand !== null ? ` STAND ${input.stand}` : '') +
      (input.destinationIdent !== null ? ` DEST ${input.destinationIdent}` : ''),
  ];
  if (input.estimated) {
    lines.push(`${input.event} TIME ESTIMATED - ${oooiEstimatedReason(input.event)}`);
  }
  return lines.join('\n');
}

/** The payload_json twin. */
export function buildOooiPayload(input: OooiEventInput): OooiPayload {
  return {
    v: 1,
    event: input.event,
    at: input.at,
    airport_icao: input.airportIcao,
    stand: input.stand,
    estimated: input.estimated,
    planned_leg_id: input.plannedLegId,
  };
}

/** The whole row, ready for insertAcarsMessageOnce(). */
export function buildOooiMessage(input: OooiEventInput): CreateAcarsMessage & { dedup_key: string } {
  return {
    flight_id: input.flightId,
    direction: 'downlink',
    category: 'oooi',
    label: input.event,
    body: buildOooiBody(input),
    payload_json: JSON.stringify(buildOooiPayload(input)),
    dedup_key: oooiDedupKey(input.flightId, input.event),
    sent_at: input.at,
  };
}

// ── Position reports ─────────────────────────────────────────────────────────
//
// Periodic enroute reports, filed only for a flight linked to a planned leg,
// at most once per configured interval window (OooiReporter in
// src/flight/oooiReporter.ts owns the window arithmetic, working from the
// elapsed time the flight recorder hands it; everything here is pure).

export interface PositionReportInput {
  flightId: number;
  /** The interval window this report belongs to; >= 1. */
  windowIndex: number;
  /** ISO 8601 UTC — the recorded point's own ts. Becomes sent_at. */
  at: string;
  lat: number;
  lon: number;
  altitudeFt: number;
  groundSpeedKnots: number;
  headingDeg: number;
  /** From getPlannedLegStatus(). */
  nextWaypointIdent: string;
  destinationIdent: string;
  remainingDistanceNm: number;
  plannedLegId: number;
}

/** 'position-report:flight:12:3'. */
export function positionReportDedupKey(flightId: number, windowIndex: number): string {
  return `position-report:flight:${flightId}:${windowIndex}`;
}

/** 'N3425.6 W11950.5'. */
export function formatLatLon(lat: number, lon: number): string {
  const part = (v: number, digits: number, pos: string, neg: string): string => {
    const hemi = v >= 0 ? pos : neg;
    const abs = Math.abs(v);
    let deg = Math.floor(abs);
    let min = Math.round((abs - deg) * 600) / 10;
    if (min >= 60) { deg += 1; min = 0; }
    return `${hemi}${String(deg).padStart(digits, '0')}${min.toFixed(1).padStart(4, '0')}`;
  };
  return `${part(lat, 2, 'N', 'S')} ${part(lon, 3, 'E', 'W')}`;
}

/** Seconds to destination, or null at/below MIN_ETA_GROUND_SPEED_KTS. */
export function estimateEnrouteSec(remainingNm: number, gsKts: number): number | null {
  if (!Number.isFinite(remainingNm) || remainingNm < 0) return null;
  if (!Number.isFinite(gsKts) || gsKts < MIN_ETA_GROUND_SPEED_KTS) return null;
  return Math.round((remainingNm / gsKts) * 3600);
}

/** The five-line body. */
export function buildPositionReportBody(input: PositionReportInput): string {
  const eteSec = estimateEnrouteSec(input.remainingDistanceNm, input.groundSpeedKnots);
  const etaIso = eteSec !== null ? new Date(Date.parse(input.at) + eteSec * 1000).toISOString() : null;
  const gs = Math.round(input.groundSpeedKnots);
  const hdg = String(Math.round(input.headingDeg)).padStart(3, '0');
  const lines = [
    'POSITION REPORT',
    `${formatLatLon(input.lat, input.lon)} ${hhmmz(input.at)}`,
    `${levelText(input.altitudeFt)} GS ${gs} HDG ${hdg}`,
    `NEXT ${input.nextWaypointIdent} DEST ${input.destinationIdent} ${input.remainingDistanceNm.toFixed(1)} NM`,
    `ETE ${hhmm(eteSec)} ETA ${etaIso !== null ? hhmmz(etaIso) : '----Z'}`,
  ];
  return lines.join('\n');
}

/** The payload_json twin. */
export function buildPositionReportPayload(input: PositionReportInput): PositionReportPayload {
  const eteSec = estimateEnrouteSec(input.remainingDistanceNm, input.groundSpeedKnots);
  const eta = eteSec !== null ? new Date(Date.parse(input.at) + eteSec * 1000).toISOString() : null;
  return {
    v: 1,
    at: input.at,
    window: input.windowIndex,
    lat: input.lat,
    lon: input.lon,
    altitude_ft: input.altitudeFt,
    groundspeed_kts: input.groundSpeedKnots,
    heading_deg: input.headingDeg,
    next_waypoint: input.nextWaypointIdent,
    destination: input.destinationIdent,
    remaining_nm: input.remainingDistanceNm,
    ete_sec: eteSec,
    eta,
    planned_leg_id: input.plannedLegId,
  };
}

/** The whole row, ready for insertAcarsMessageOnce(). */
export function buildPositionReportMessage(input: PositionReportInput): CreateAcarsMessage & { dedup_key: string } {
  return {
    flight_id: input.flightId,
    direction: 'downlink',
    category: 'position-report',
    label: POSITION_REPORT_LABEL,
    body: buildPositionReportBody(input),
    payload_json: JSON.stringify(buildPositionReportPayload(input)),
    dedup_key: positionReportDedupKey(input.flightId, input.windowIndex),
    sent_at: input.at,
  };
}

/**
 * Minutes -> ms. Order matters: `Number('')` is `0`, which would otherwise
 * read as "disabled" rather than "unset" — so the empty/blank case is
 * resolved before the numeric ones. `0` itself means disabled; a negative
 * value is treated as a typo and falls back to the default rather than
 * being read as an opt-out.
 */
export function parsePositionReportIntervalMs(raw: string | undefined): number {
  const DEFAULT_MS = DEFAULT_POSITION_REPORT_INTERVAL_MIN * 60_000;
  const s = String(raw ?? '').trim();
  if (s === '') return DEFAULT_MS;
  const n = Number(s);
  if (!Number.isFinite(n)) return DEFAULT_MS;
  if (n === 0) return 0;
  if (n < 0) return DEFAULT_MS;
  if (n < MIN_POSITION_REPORT_INTERVAL_MIN) return 30_000;
  return Math.round(n * 60_000);
}
