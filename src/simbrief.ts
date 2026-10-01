/**
 * SimBrief integration. This module is deliberately free of database, express
 * and I/O imports so its rules can be unit-tested on their own: one response
 * body in, one ParsedSimbriefPlan out, or a thrown SimbriefParseError. The
 * network half lives in src/simbriefClient.ts and nothing here knows it exists.
 */

import { haversineNm } from './geo';

/** The app_setting key the pilot ID is stored under. Owned here so the string exists once. */
export const SIMBRIEF_USER_ID_SETTING = 'simbrief_user_id';

/** Generous ceiling — the real IDs are 7 digits — that still bounds the column. */
export const MAX_SIMBRIEF_USER_ID_LENGTH = 20;

export type SimbriefUserIdResult =
  | { ok: true; userId: string | null }
  | { ok: false; code: 'INVALID_ID'; error: string };

/**
 * Validates a SimBrief pilot ID as typed by the operator.
 *
 * Accepts a string or null/undefined (both meaning "clear the setting", as does
 * a string that is empty after trimming — success then carries userId: null).
 * The input is trimmed because users paste from SimBrief's account page and
 * bring a space with them, but it is never otherwise normalised: leading zeros
 * are preserved and the value is never parsed as a number. It is an opaque
 * identifier that happens to be spelled in digits, and it is sent to SimBrief
 * as a string.
 *
 * Rejecting non-digits locally is worth the strictness: SimBrief answers a
 * username with "Error: Unknown UserID", which is a confusing round-trip for
 * what is really a wrong-field mistake.
 */
export function validateSimbriefUserId(raw: unknown): SimbriefUserIdResult {
  if (raw !== null && raw !== undefined && typeof raw !== 'string') {
    return { ok: false, code: 'INVALID_ID', error: 'SimBrief User ID must be text' };
  }

  const value = (raw ?? '').trim();
  if (value === '') return { ok: true, userId: null };

  if (!/^[0-9]+$/.test(value)) {
    return {
      ok: false,
      code: 'INVALID_ID',
      error: 'SimBrief User ID must be digits only — it is the numeric Pilot ID from your SimBrief account page, not your username',
    };
  }
  if (value.length > MAX_SIMBRIEF_USER_ID_LENGTH) {
    return { ok: false, code: 'INVALID_ID', error: 'SimBrief User ID is too long' };
  }

  return { ok: true, userId: value };
}

// ── OFP parser ────────────────────────────────────────────────────────────────
//
// SimBrief's dispatch API answers with a JSON document that PHP generated from
// XML, and that origin shows in three ways this parser has to absorb:
//
//   1. Every scalar is a string — "elevation":"128", "pos_lat":"53.169444".
//      There is not one JSON number in the 333 KB document.
//   2. An empty element becomes {} — not "" and not null. 164 of them in the
//      sample capture, including origin.faa_code and general.sid_trans.
//   3. A repeated element that appears exactly once collapses to a bare object
//      instead of a one-element array. This is why `arr()` below is mandatory
//      on navlog.fix and on alternate: reading either directly works on a plan
//      with two alternates and silently drops the only one on a plan with one.
//
// The route is navlog.fix, ordered departure to destination. The origin airport
// is NOT in it (the first entry is a SID waypoint), the destination airport IS
// — so the chain is built by prepending the origin and appending the
// destination only when it is missing.

/** Reasons the parser refuses a response outright. Thrown, never returned. */
export type SimbriefRejectCode = 'NOT_JSON' | 'NOT_AN_OFP' | 'NO_ROUTE' | 'BAD_POSITION';

/** Reasons the parser accepts a response but wants the outcome recorded. */
export type SimbriefWarningCode =
  | 'NO_ALTERNATES'
  | 'UNKNOWN_FIX_TYPE'
  | 'FIX_MISSING_POSITION'
  | 'NO_CRUISE_ALTITUDE'
  | 'ORIGIN_IN_NAVLOG'
  | 'PSEUDO_WAYPOINTS'
  | 'NO_DISPATCH_FIGURES';

export interface SimbriefWarning {
  code: SimbriefWarningCode;
  /** One line, naming the field and the value. Surfaced on import. */
  message: string;
}

/** Thrown by parseSimbriefPlan. The REST layer maps this to 502 and anything else to 500. */
export class SimbriefParseError extends Error {
  readonly code: SimbriefRejectCode;

  constructor(code: SimbriefRejectCode, message: string) {
    super(message);
    this.name = 'SimbriefParseError';
    this.code = code;
  }
}

/**
 * First / last point of the plan. `isAirport` is always true here: SimBrief
 * cannot file a plan that does not start and end at an airport.
 */
export interface SimbriefEndpoint {
  ident: string;
  name: string | null;
  lat: number;
  lon: number;
  isAirport: boolean;
}

export interface SimbriefWaypoint {
  /** 1-based over the final chain, origin first. */
  seq: number;
  ident: string;
  name: string | null;
  region: string | null;
  /** SimBrief's via_airway, verbatim — including the literal "DCT". */
  airway: string | null;
  /** Always null. The column is the .lnmpln NAT-track field, a different concept. */
  track: string | null;
  /** Only 'AIRPORT' is behaviourally significant; anything else is display-only. */
  type: string;
  comment: string | null;
  lat: number;
  lon: number;
  /**
   * SimBrief's COMPUTED profile altitude for the fix, not a planned constraint.
   * Never render it as a crossing restriction; cruiseAltFt is the leg's
   * planned altitude.
   */
  altFt: number | null;
}

export interface SimbriefAlternate {
  seq: number;
  ident: string;
  name: string | null;
  type: string | null;
  /** Nullable, matching the column: an alternate may arrive without a position. */
  lat: number | null;
  lon: number | null;
  altFt: number | null;
}

/**
 * The dispatch/load-planning figures, in whatever unit `units` names. SimBrief
 * plans in one unit system per OFP and this carries its numbers forward
 * unconverted — nothing downstream multiplies a weight by anything.
 *
 * Every member is nullable: an OFP with no `fuel` node is still a usable route,
 * and nothing here may refuse a plan.
 */
export interface SimbriefDispatchFigures {
  /** params.units, verbatim: 'kgs' or 'lbs'. null when absent. */
  units: string | null;
  /** aircraft.reg, e.g. 'N201SB'. */
  aircraftReg: string | null;

  /** fuel.plan_ramp — block/ramp fuel, the load sheet's headline figure. */
  planRamp: number | null;
  /** fuel.plan_takeoff */
  planTakeoff: number | null;
  /** fuel.plan_landing */
  planLanding: number | null;
  /** fuel.taxi */
  taxi: number | null;
  /** fuel.enroute_burn — trip fuel. */
  enrouteBurn: number | null;
  /** fuel.contingency */
  contingency: number | null;
  /** fuel.reserve */
  reserve: number | null;
  /** fuel.alternate_burn */
  alternateBurn: number | null;

  /** times.est_time_enroute, SECONDS. */
  estTimeEnrouteSec: number | null;
  /** times.est_block, SECONDS, gate to gate. */
  estBlockSec: number | null;

  /** weights.oew — dry operating weight. */
  oew: number | null;
  /** weights.payload */
  payload: number | null;
  /** weights.est_zfw */
  estZfw: number | null;
  /** weights.max_zfw */
  maxZfw: number | null;
  /** weights.est_tow */
  estTow: number | null;
  /** weights.est_ldw */
  estLdw: number | null;
  /** weights.pax_count — a head count, not a weight. */
  paxCount: number | null;
  /** weights.cargo */
  cargo: number | null;
}

/**
 * The parser's complete output. Structurally compatible with
 * CreatePlannedLegPlan (src/db.ts) and not imported by it — the same seam
 * src/lnmpln.ts's ParsedFlightPlan already uses. src/server.ts is the only
 * module that sees both.
 */
export interface ParsedSimbriefPlan {
  departure: SimbriefEndpoint;
  destination: SimbriefEndpoint;
  /** Always false: SimBrief cannot express a plan snippet. */
  isSnippet: false;
  cruiseAltFt: number | null;
  /** "IFR" | "VFR", derived from atc.flight_rules. */
  flightplanType: string | null;
  aircraftType: string | null;
  remarks: string | null;
  /** params.time_generated as a full ISO instant. */
  createdAt: string | null;
  /** Always "SimBrief". */
  sourceProgram: string;

  /** All null: SimBrief has no gate or parking concept. */
  departureStart: { pos: null; start: null; startType: null };
  procedures: {
    sidName: string | null;
    sidRunway: string | null;
    sidTransition: string | null;
    sidType: null;
    sidCustomDistanceNm: null;
    starName: string | null;
    starRunway: string | null;
    starTransition: string | null;
    approachName: null;
    approachRunway: null;
    approachTransition: null;
    approachType: null;
    approachArinc: null;
    approachSuffix: null;
    approachTransitionType: null;
    approachCustomDistanceNm: null;
    approachCustomAltitudeFt: null;
    approachCustomOffsetDeg: null;
  };

  waypoints: SimbriefWaypoint[];
  alternates: SimbriefAlternate[];
  /**
   * Great-circle sum over the stored waypoint chain, in nautical miles.
   * Computed here rather than taken from SimBrief's own route_distance so the
   * number and the rows it is derived from always agree — the two are within
   * 0.2% anyway, because unlike .lnmpln the SID and STAR waypoints really are
   * in the route.
   */
  approxDistanceNm: number;

  /** OFP provenance. Not part of CreatePlannedLegPlan; read by the import route. */
  ofp: {
    /** params.request_id — unique per OFP generation. */
    requestId: string | null;
    sequenceId: string | null;
    /** params.time_generated, the raw epoch-seconds string. */
    timeGenerated: string | null;
    /** general.flight_number, e.g. "SHG037". */
    flightNumber: string | null;
    /** general.route, the filed route string. */
    routeString: string | null;
    /** The pilot id the plan belongs to, from params.user_id. */
    userId: string | null;
  };

  /**
   * Fuel, time and weight planning figures. Not part of CreatePlannedLegPlan;
   * read by the import route when it files the dispatch release. Every member
   * is nullable: an OFP with no `fuel` node is still a usable route.
   */
  dispatch: SimbriefDispatchFigures;

  warnings: SimbriefWarning[];
}

// ── Coercion helpers ──────────────────────────────────────────────────────────
//
// Required, not a style choice: together they absorb the three quirks
// described above the OFP parser.

/** "", {} and undefined all mean absent. Trims. Never returns "". */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** Every SimBrief scalar is a string. Non-finite means absent. */
function num(v: unknown): number | null {
  const s = str(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Absorbs the single-element collapse: {} is none, a bare object is one. */
function arr(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.filter(isRecord);
  if (isRecord(v) && Object.keys(v).length > 0) return [v];
  return [];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function rec(v: unknown): Record<string, unknown> | null {
  return isRecord(v) ? v : null;
}

/** SimBrief's per-fix type onto the planned_waypoints.type vocabulary. */
const FIX_TYPES: Record<string, string> = {
  apt: 'AIRPORT',
  wpt: 'WAYPOINT',
  vor: 'VOR',
  ndb: 'NDB',
  // A computed lat/long — top of climb, top of descent. USER is exactly what
  // .lnmpln calls one of these; WAYPOINT would claim a navaid exists there.
  ltlg: 'USER',
};

/** One entry of the chain before it is numbered and validated. */
interface RawFix {
  ident: string | null;
  name: string | null;
  region: string | null;
  airway: string | null;
  type: string;
  comment: string | null;
  lat: number | null;
  lon: number | null;
  altFt: number | null;
  /** True for a computed lat/long point, so the warning can name them. */
  pseudo: boolean;
  /** For the reject message when there is no ident to name. */
  where: string;
}

/**
 * Parses one SimBrief OFP.
 *
 * Accepts the already-decoded body, or the raw text of one (the CLI inspector
 * hands it a file). Pure: no network, no database, no filesystem, no clock
 * beyond the timestamp inside the payload.
 *
 * @throws {SimbriefParseError} on a body that cannot become a plan at all.
 */
export function parseSimbriefPlan(body: unknown): ParsedSimbriefPlan {
  function reject(code: SimbriefRejectCode, message: string): never {
    throw new SimbriefParseError(code, message);
  }

  const warnings: SimbriefWarning[] = [];
  const warn = (code: SimbriefWarningCode, message: string): void => {
    warnings.push({ code, message });
  };

  let root: Record<string, unknown>;
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    // Buffer carries no I/O with it — this is the same "bytes in, value out"
    // seam parseLnmpln has, so the inspector needs no decoding of its own.
    try {
      const decoded: unknown = JSON.parse(body.toString());
      if (!isRecord(decoded)) reject('NOT_JSON', 'body parsed to a value that is not a JSON object');
      root = decoded;
    } catch (err) {
      if (err instanceof SimbriefParseError) throw err;
      reject('NOT_JSON', `body is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
  } else if (isRecord(body)) {
    root = body;
  } else {
    reject('NOT_JSON', `body is ${body === null ? 'null' : typeof body}, not a JSON object`);
  }

  const params = rec(root['params']);
  const general = rec(root['general']);
  const originNode = rec(root['origin']);
  const destinationNode = rec(root['destination']);

  // An error body carries only the envelope — no params, no origin, no navlog.
  if (originNode === null || destinationNode === null) {
    reject('NOT_AN_OFP', 'response carries no origin/destination — it is not a flight plan');
  }

  // ── Endpoints ───────────────────────────────────────────────────────────────

  /** An out-of-range coordinate is a wrong payload, not an incomplete one: refused. */
  function inRange(n: number, what: string, axis: 'lat' | 'lon'): number {
    const limit = axis === 'lat' ? 90 : 180;
    const field = axis === 'lat' ? 'pos_lat' : 'pos_long';
    if (n < -limit || n > limit) reject('BAD_POSITION', `${what} has ${field}=${n}, outside ±${limit}`);
    return n;
  }

  function coordinate(value: unknown, what: string, axis: 'lat' | 'lon'): number {
    const n = num(value);
    if (n === null) reject('BAD_POSITION', `${what} has a non-numeric ${axis === 'lat' ? 'pos_lat' : 'pos_long'}`);
    return inRange(n, what, axis);
  }

  function endpoint(node: Record<string, unknown>, what: string): SimbriefEndpoint {
    const ident = str(node['icao_code']);
    if (ident === null) reject('NOT_AN_OFP', `${what} has no icao_code`);
    return {
      ident,
      name: str(node['name']),
      lat: coordinate(node['pos_lat'], `${what} ${ident}`, 'lat'),
      lon: coordinate(node['pos_long'], `${what} ${ident}`, 'lon'),
      isAirport: true,
    };
  }

  const departure = endpoint(originNode, 'origin');
  const destination = endpoint(destinationNode, 'destination');

  // ── The chain ───────────────────────────────────────────────────────────────

  const fixes = arr(rec(root['navlog'])?.['fix']);
  if (fixes.length === 0) reject('NO_ROUTE', 'response has no navlog fixes');

  const airportFix = (node: Record<string, unknown>, ident: string, what: string): RawFix => ({
    ident,
    name: str(node['name']),
    region: null,
    airway: null,
    type: 'AIRPORT',
    comment: null,
    lat: num(node['pos_lat']),
    lon: num(node['pos_long']),
    altFt: num(node['elevation']),
    pseudo: false,
    where: what,
  });

  const raw: RawFix[] = [];

  // The origin is normally absent from the navlog, whose first entry is a SID
  // waypoint — but the destination is present, so the origin plausibly can be
  // too. Prepend it only when it is not already there.
  if (str(fixes[0]['ident']) === departure.ident) {
    warn('ORIGIN_IN_NAVLOG', `origin ${departure.ident} is already the first navlog fix; not prepended`);
  } else {
    raw.push(airportFix(originNode, departure.ident, 'origin'));
  }

  fixes.forEach((fix, i) => {
    const rawType = str(fix['type']);
    const ident = str(fix['ident']);
    let type: string;
    if (rawType === null) {
      type = 'UNKNOWN';
    } else if (FIX_TYPES[rawType.toLowerCase()] !== undefined) {
      type = FIX_TYPES[rawType.toLowerCase()];
    } else {
      type = rawType.toUpperCase();
      warn('UNKNOWN_FIX_TYPE', `fix ${ident ?? `#${i + 1}`} has type "${rawType}", stored as ${type}`);
    }
    raw.push({
      ident,
      name: str(fix['name']),
      region: str(fix['icao_region']),
      airway: str(fix['via_airway']),
      type,
      comment: str(fix['stage']),
      lat: num(fix['pos_lat']),
      lon: num(fix['pos_long']),
      altFt: num(fix['altitude_feet']),
      pseudo: rawType !== null && rawType.toLowerCase() === 'ltlg',
      where: `navlog fix #${i + 1}`,
    });
  });

  if (str(fixes[fixes.length - 1]['ident']) !== destination.ident) {
    raw.push(airportFix(destinationNode, destination.ident, 'destination'));
  }

  // A fix with no ident or no position cannot be stored — planned_waypoints
  // requires all three — so it is dropped rather than failing the whole
  // import. An out-of-range coordinate is a different thing: the payload is
  // wrong, not incomplete, and the whole plan is refused.
  const waypoints: SimbriefWaypoint[] = [];
  const pseudoIdents: string[] = [];
  for (const fix of raw) {
    if (fix.ident === null) {
      warn('FIX_MISSING_POSITION', `${fix.where} has no ident; dropped`);
      continue;
    }
    if (fix.lat === null || fix.lon === null) {
      warn('FIX_MISSING_POSITION', `fix ${fix.ident} has no position; dropped`);
      continue;
    }
    const lat = inRange(fix.lat, `fix ${fix.ident}`, 'lat');
    const lon = inRange(fix.lon, `fix ${fix.ident}`, 'lon');
    if (fix.pseudo) pseudoIdents.push(fix.ident);
    waypoints.push({
      seq: waypoints.length + 1,
      ident: fix.ident,
      name: fix.name,
      region: fix.region,
      airway: fix.airway,
      track: null,
      type: fix.type,
      comment: fix.comment,
      lat,
      lon,
      altFt: fix.altFt,
    });
  }

  if (waypoints.length < 2) {
    reject('NO_ROUTE', `plan has ${waypoints.length} usable waypoint(s); a route needs at least two`);
  }
  if (pseudoIdents.length > 0) {
    warn(
      'PSEUDO_WAYPOINTS',
      `${pseudoIdents.join(', ')} are computed lat/long points, not navaids; kept as USER waypoints`,
    );
  }

  // ── Alternates ──────────────────────────────────────────────────────────────

  const alternates: SimbriefAlternate[] = [];
  arr(root['alternate']).forEach((alt, i) => {
    const ident = str(alt['icao_code']);
    if (ident === null) return;
    alternates.push({
      seq: i + 1,
      ident,
      name: str(alt['name']),
      type: 'AIRPORT',
      lat: num(alt['pos_lat']),
      lon: num(alt['pos_long']),
      altFt: num(alt['cruise_altitude']),
    });
  });
  if (alternates.length === 0) warn('NO_ALTERNATES', 'plan was filed with no alternate airport');

  // ── Plan-level fields ───────────────────────────────────────────────────────

  const cruiseAltFt = num(general?.['initial_altitude']);
  if (cruiseAltFt === null) warn('NO_CRUISE_ALTITUDE', 'general.initial_altitude is absent; cruise altitude unknown');

  const rules = str(rec(root['atc'])?.['flight_rules']);
  const flightplanType =
    rules === null ? null : rules.toUpperCase() === 'I' ? 'IFR' : rules.toUpperCase() === 'V' ? 'VFR' : rules.toUpperCase();

  const flightNumber = str(general?.['flight_number']);
  const routeString = str(general?.['route']);
  const remarkParts = [flightNumber, routeString].filter((p): p is string => p !== null);
  const remarks = remarkParts.length === 0 ? null : `SimBrief OFP ${remarkParts.join(' · ')}`;

  const timeGenerated = str(params?.['time_generated']);
  const generatedSeconds = num(timeGenerated);
  const createdAt = generatedSeconds === null ? null : new Date(generatedSeconds * 1000).toISOString();

  // ── Dispatch figures ────────────────────────────────────────────────────────
  // Cannot reject a plan: a missing fuel/times/weights node just yields a node
  // of all-null members, and the route the OFP describes is unaffected.

  const fuelNode = rec(root['fuel']);
  const timesNode = rec(root['times']);
  const weightsNode = rec(root['weights']);
  const aircraftNode = rec(root['aircraft']);
  const units = str(params?.['units']);

  const dispatch: SimbriefDispatchFigures = {
    units,
    aircraftReg: str(aircraftNode?.['reg']),
    planRamp: num(fuelNode?.['plan_ramp']),
    planTakeoff: num(fuelNode?.['plan_takeoff']),
    planLanding: num(fuelNode?.['plan_landing']),
    taxi: num(fuelNode?.['taxi']),
    enrouteBurn: num(fuelNode?.['enroute_burn']),
    contingency: num(fuelNode?.['contingency']),
    reserve: num(fuelNode?.['reserve']),
    alternateBurn: num(fuelNode?.['alternate_burn']),
    estTimeEnrouteSec: num(timesNode?.['est_time_enroute']),
    estBlockSec: num(timesNode?.['est_block']),
    oew: num(weightsNode?.['oew']),
    payload: num(weightsNode?.['payload']),
    estZfw: num(weightsNode?.['est_zfw']),
    maxZfw: num(weightsNode?.['max_zfw']),
    estTow: num(weightsNode?.['est_tow']),
    estLdw: num(weightsNode?.['est_ldw']),
    paxCount: num(weightsNode?.['pax_count']),
    cargo: num(weightsNode?.['cargo']),
  };
  if (dispatch.planRamp === null && dispatch.estZfw === null) {
    warn('NO_DISPATCH_FIGURES', 'SimBrief returned no fuel or weight figures; the dispatch release will carry no load data');
  }

  let approxDistanceNm = 0;
  for (let i = 1; i < waypoints.length; i++) {
    approxDistanceNm += haversineNm(waypoints[i - 1].lat, waypoints[i - 1].lon, waypoints[i].lat, waypoints[i].lon);
  }

  return {
    departure,
    destination,
    isSnippet: false,
    cruiseAltFt,
    flightplanType,
    aircraftType: str(rec(root['aircraft'])?.['icao_code']),
    remarks,
    createdAt,
    sourceProgram: 'SimBrief',
    departureStart: { pos: null, start: null, startType: null },
    procedures: {
      sidName: str(general?.['sid_ident']),
      sidRunway: str(originNode['plan_rwy']),
      sidTransition: str(general?.['sid_trans']),
      sidType: null,
      sidCustomDistanceNm: null,
      starName: str(general?.['star_ident']),
      starRunway: str(destinationNode['plan_rwy']),
      starTransition: str(general?.['star_trans']),
      // The OFP carries no approach procedure at all, and plan_rwy is already
      // spent on the STAR runway. All nine approach fields stay null.
      approachName: null,
      approachRunway: null,
      approachTransition: null,
      approachType: null,
      approachArinc: null,
      approachSuffix: null,
      approachTransitionType: null,
      approachCustomDistanceNm: null,
      approachCustomAltitudeFt: null,
      approachCustomOffsetDeg: null,
    },
    waypoints,
    alternates,
    approxDistanceNm,
    ofp: {
      requestId: str(params?.['request_id']),
      sequenceId: str(params?.['sequence_id']),
      timeGenerated,
      flightNumber,
      routeString,
      userId: str(params?.['user_id']),
    },
    dispatch,
    warnings,
  };
}
