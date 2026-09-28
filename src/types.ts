export interface SimFrame {
  lat: number;
  lon: number;
  altitudeFt: number;
  airspeedKnots: number;
  groundSpeedKnots: number;
  headingDeg: number;
  verticalSpeedFpm: number;
  onGround: boolean;
  simRunning: number;
  aircraft: string;
  /** Absent when the agent predates this field or the sim rejected the SimVar. */
  parkingBrake?: boolean;
  /** NUMBER OF ENGINES, clamped to 0..4. Absent under the same conditions as parkingBrake. */
  engineCount?: number;
  /** How many of engines 1..engineCount are burning. Absent under the same conditions as parkingBrake. */
  enginesRunning?: number;
}

export type FlightState = 'IDLE' | 'GROUND' | 'FLYING' | 'ENDED';

export interface AppState {
  flightState: FlightState;
  currentFlightId: number | null;
  connected: boolean;
  lastFrame: SimFrame | null;
  /** True while the sim is paused in any form, including Active Pause. */
  paused: boolean;
  /** Raw MSFS Pause_EX1 bitmask, so the UI can name the kind of pause. */
  pauseFlags: number;
}

export interface Flight {
  id: number;
  aircraft: string | null;
  departure_lat: number | null;
  departure_lon: number | null;
  arrival_lat: number | null;
  arrival_lon: number | null;
  start_time: string;
  end_time: string | null;
  duration_sec: number | null;
  distance_nm: number | null;
  max_altitude_ft: number | null;
  max_airspeed_kts: number | null;
  point_count: number | null;
  notes: string | null;
  trip_id: number | null;
  departure_icao: string | null;
  departure_name: string | null;
  arrival_icao: string | null;
  arrival_name: string | null;
  flight_plan_name: string | null;
  /** The planned leg this flight is attached to, or null. */
  planned_leg_id: number | null;
  planned_leg_link_source: 'auto' | 'manual' | null;
  /** The trip_id held immediately before an auto/manual link; restored on unlink. */
  planned_leg_prev_trip_id: number | null;
}

export interface Trip {
  id: number;
  name: string;
  notes: string | null;
  created_at: string;
  /** 0 | 1. SQLite has no boolean. At most one trip has this set to 1. */
  is_active: number;
}

export interface TripWithFlights extends Trip {
  flights: FlightWithPoints[];
  flight_count: number;
  total_distance_nm: number | null;
  total_duration_sec: number | null;
  max_altitude_ft: number | null;
  planned_leg_count: number;
  /** Populated by GET /api/trips/:id; always [] from GET /api/trips. */
  planned_legs: PlannedLegWithChildren[];
}

export interface TripEditPayload {
  name?: string;
  notes?: string | null;
}

export interface FlightEditPayload {
  aircraft?: string | null;
  notes?: string | null;
}

export interface CombinePayload {
  id1: number;
  id2: number;
}

export interface FlightPoint {
  id: number;
  flight_id: number;
  ts: string;
  lat: number;
  lon: number;
  altitude_ft: number;
  airspeed_kts: number;
  ground_speed_kts: number;
  heading_deg: number;
  vertical_speed_fpm: number;
  on_ground: number;
}

export interface FlightWithPoints extends Flight {
  points: FlightPoint[];
}

// ── Planned legs ──────────────────────────────────────────────────────────────
//
// A planned leg is a route imported from a Little Navmap .lnmpln file and
// attached to a trip, before it is flown. Not to be confused with the existing
// PDF "flight plan" attachment (flights.flight_plan_name).
// Row types persisted by src/db.ts; the parser's own output shape lives in
// src/lnmpln.ts and is never imported here.

/**
 * 'linked' is deliberately absent: a leg is linked when a flight row points at
 * it, so the two facts cannot drift apart. 'diverted' is set by the system
 * only; 'flown' is set at touchdown, or — reversibly — by hand on a still
 * 'planned' leg whose flight was linked manually and has already ended.
 */
export type PlannedLegStatus = 'planned' | 'flown' | 'diverted' | 'skipped';

export interface PlannedLeg {
  id: number;
  /** NULL means "loose": a prefile that belongs to no trip. */
  trip_id: number | null;
  /** 1-based within the trip; gappy after a delete. Read with ORDER BY seq, id. */
  seq: number;
  status: PlannedLegStatus;

  /** First waypoint of the plan. Not necessarily an airport (plan snippets exist). */
  departure_ident: string;
  departure_name: string | null;
  departure_lat: number;
  departure_lon: number;
  /** 0 | 1. When 0, departure_ident is not an airport code. */
  departure_is_airport: number;
  /** <Departure> in the file: commonly absent (NULL). */
  departure_start: string | null;
  departure_start_type: string | null;
  departure_pos_lat: number | null;
  departure_pos_lon: number | null;

  /** Last waypoint of the plan, same airport caveat as the departure. */
  destination_ident: string;
  destination_name: string | null;
  destination_lat: number;
  destination_lon: number;
  destination_is_airport: number;

  /** 0 | 1 */
  is_snippet: number;
  cruise_alt_ft: number | null;
  flightplan_type: string | null;
  aircraft_type: string | null;

  sid_name: string | null;
  /** The only source of a departure runway. */
  sid_runway: string | null;
  sid_transition: string | null;
  /** 'CUSTOMDEPART' for the manual's custom-departure form; NULL otherwise. */
  sid_type: string | null;
  sid_custom_distance_nm: number | null;

  star_name: string | null;
  star_runway: string | null;
  star_transition: string | null;

  /** Opaque label, not a fix reference when approach_type is 'CUSTOM'. */
  approach_name: string | null;
  approach_runway: string | null;
  approach_transition: string | null;
  approach_type: string | null;
  approach_arinc: string | null;
  approach_suffix: string | null;
  approach_transition_type: string | null;
  approach_custom_distance_nm: number | null;
  approach_custom_altitude_ft: number | null;
  approach_custom_offset_deg: number | null;

  waypoint_count: number;
  alternate_count: number;
  /** Great-circle sum over the en-route waypoint chain. Always render with an
   *  "approx." qualifier — procedure legs are never in the file. */
  approx_distance_nm: number;
  /** Written at landing on both the 'flown' and the 'diverted' path. */
  arrival_deviation_nm: number | null;

  remarks: string | null;
  /** CreationDate normalised to a full ISO instant. */
  plan_created_at: string | null;
  source_filename: string;
  source_sha256: string;
  source_program: string | null;
  imported_at: string;
}

export interface PlannedWaypoint {
  id: number;
  planned_leg_id: number;
  /** 1-based document order across every <Waypoints> block. Never keyed by ident. */
  seq: number;
  ident: string;
  name: string | null;
  region: string | null;
  airway: string | null;
  track: string | null;
  type: string;
  comment: string | null;
  lat: number;
  lon: number;
  /**
   * Little Navmap's COMPUTED profile altitude, not a planned constraint. Never
   * render it as a planned or crossing altitude — cruise_alt_ft is the leg's
   * planned altitude.
   */
  alt_ft: number | null;
}

export interface PlannedAlternate {
  id: number;
  planned_leg_id: number;
  seq: number;
  ident: string;
  name: string | null;
  type: string | null;
  /** Nullable: Alternate/Pos is optional in the format. */
  lat: number | null;
  lon: number | null;
  alt_ft: number | null;
}

/**
 * What every planned-leg endpoint returns. linked_flight_id is derived by a
 * subquery, not stored.
 */
export interface PlannedLegWithChildren extends PlannedLeg {
  linked_flight_id: number | null;
  waypoints: PlannedWaypoint[];
  alternates: PlannedAlternate[];
}

/**
 * GET /api/planned-legs element: a planned leg with its owning trip's name
 * resolved server-side, so a unified list of loose and trip-linked legs needs
 * no second request to name the trips. trip_name is null exactly when
 * trip_id is null — the foreign key guarantees a non-null trip_id always
 * names an existing trip.
 */
export interface PlannedLegListItem extends PlannedLegWithChildren {
  trip_name: string | null;
}

/**
 * GET /api/status's `plannedLeg` key. Computed, camelCase.
 * Present only while flightState === 'FLYING' and the current flight is
 * linked to a planned leg; the endpoint omits the key entirely otherwise, so
 * this never appears as a null field.
 */
export interface PlannedLegLiveStatus {
  plannedLegId: number;
  tripId: number | null;
  tripName: string | null;
  destinationIdent: string;
  nextWaypointIdent: string;
  /** Great-circle, via nextWaypointIdent, to the leg's destination. */
  remainingDistanceNm: number;
  distanceIsApproximate: true;
}

// ── Auto-match candidate ──────────────────────────────────────────────────────
//
// The payload getPlannedLegCandidatesForActiveTrip() (src/db.ts) hands to
// src/legMatcher.ts's matchPlannedLeg(). CamelCase because it is a
// computed payload flattened for the matcher, not a row.
// Mirrors contracts/planned-legs.d.ts.

/** One candidate leg, flattened by the caller from the DB row. No I/O in here. */
export interface LegMatchCandidate {
  plannedLegId: number;
  tripId: number;
  seq: number;
  /** Null when departureIsAirport is false. */
  departureIdent: string | null;
  departureIsAirport: boolean;
  departureLat: number;
  departureLon: number;
  status: PlannedLegStatus;
  linkedFlightId: number | null;
  /** Carried for the log and a possible future tie-break; not used in v1. */
  aircraftType: string | null;
}

// ── AI traffic ─────────────────────────────────────────────────────────────────
//
// One JSON object per AI aircraft, carried on both wires: agent -> server
// (inside a batch, POST /api/ingest/traffic) and server -> client (inside
// GET /api/status's `traffic` key). Mirrored byte-identically in
// client/src/types.ts; neither file imports from the other, matching how
// SimFrame / StatusFrame are already mirrored in this project.
export interface TrafficObject {
  id: number;
  lat: number;
  lon: number;
  altitudeFt: number;
  headingDeg: number;
  onGround: boolean;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
//
// Wire shapes for the operator login. Mirrored byte-identically in
// client/src/types.ts; neither file imports from the other, matching how
// SimFrame / StatusFrame and TrafficObject are already mirrored in this
// project.

/** What a logged-in session holds. Persisted inside auth_session.data. */
export interface SessionUser {
  username: string;
}

/** POST /api/auth/login request body. */
export interface LoginRequest {
  username: string;
  password: string;
}

/** POST /api/auth/login 200 body. */
export interface LoginResponse {
  user: SessionUser;
}

/** GET /api/auth/session 200 body. Always 200, never 401. */
export type SessionResponse =
  | { authenticated: true; user: SessionUser }
  | { authenticated: false; user: null };

// ── ACARS ─────────────────────────────────────────────────────────────────────
//
// The datalink message thread: one table (acars_messages), read per flight and
// written by the canned-message route and, later, by server-side writers such
// as a PDC issuer or an OOOI emitter. The wire shapes below are mirrored
// by hand in client/src/types.ts, like SimFrame and TrafficObject before them.

/** 'uplink' is dispatch speaking to the aircraft; 'downlink' is the cockpit. */
export type AcarsDirection = 'uplink' | 'downlink';

/**
 * Open on purpose. The five the message centre names, plus 'oooi', which
 * position reports need; a later feature may add another without a schema
 * change or a change here. Validated by shape, not by membership — see
 * isValidAcarsCategory in src/acars.ts.
 */
export type AcarsCategory =
  | 'pdc' | 'wx' | 'freetext' | 'position-report' | 'dispatch' | 'oooi'
  | (string & {});

/** One row of acars_messages, as every read returns it and as the API sends it. */
export interface AcarsMessage {
  id: number;
  flight_id: number | null;
  planned_leg_id: number | null;
  direction: AcarsDirection;
  category: AcarsCategory;
  label: string | null;
  body: string;
  /** Raw JSON text exactly as stored; never parsed by the transport. */
  payload_json: string | null;
  correlation_id: number | null;
  dedup_key: string | null;
  /** ISO 8601 UTC instant. */
  sent_at: string;
  /** NULL means unread. Nothing writes it yet. */
  read_at: string | null;
}

/**
 * Argument to insertAcarsMessage. snake_case, one key per column, so a row can
 * be checked against the table without a mapping table in between.
 */
export interface CreateAcarsMessage {
  flight_id?: number | null;
  planned_leg_id?: number | null;
  direction: AcarsDirection;
  category: AcarsCategory;
  label?: string | null;
  body: string;
  payload_json?: string | null;
  correlation_id?: number | null;
  dedup_key?: string | null;
  /** Defaults to new Date().toISOString() when omitted. */
  sent_at?: string;
}

/** GET /api/flights/:id/acars-messages 200 body. */
export interface AcarsThread {
  flight_id: number;
  /** The leg whose pre-flight messages are included, or null. */
  planned_leg_id: number | null;
  /** Oldest first: sent_at ASC, id ASC. The client reverses for display. */
  messages: AcarsMessage[];
}

/** The four OOOI events, in the order a normal flight fires them. */
export type OooiEvent = 'OUT' | 'OFF' | 'ON' | 'IN';

/**
 * The machine-readable twin of an OOOI message's body, stored as that
 * message's payload_json. `planned_leg_id` is recorded for reference only —
 * the row itself is always flight-scoped (never leg-scoped), so nothing
 * reads this back to decide where the message belongs.
 */
export interface OooiPayload {
  v: 1;
  event: OooiEvent;
  /** ISO 8601 UTC instant; the same value as the message's sent_at. */
  at: string;
  airport_icao: string | null;
  stand: string | null;
  estimated: boolean;
  planned_leg_id: number | null;
}

/**
 * The machine-readable twin of a position report's body, stored as that
 * message's payload_json. `ete_sec` and `eta` are null together when no ETA
 * could be estimated.
 */
export interface PositionReportPayload {
  v: 1;
  at: string;
  window: number;
  lat: number;
  lon: number;
  altitude_ft: number;
  groundspeed_kts: number;
  heading_deg: number;
  next_waypoint: string;
  destination: string;
  remaining_nm: number;
  ete_sec: number | null;
  eta: string | null;
  planned_leg_id: number;
}

/** One entry of the fixed outgoing set. */
export interface CannedAcarsMessage {
  /** Stable, lower-kebab. The only thing a client has to send. */
  id: string;
  /** What the button says. */
  label: string;
  /** What is stored in acars_messages.body, verbatim. */
  body: string;
  category: AcarsCategory;
  /** Always 'downlink': a client may not speak for dispatch. */
  direction: AcarsDirection;
}

/** GET /api/acars/canned-messages 200 body. */
export interface CannedAcarsMessageList {
  messages: CannedAcarsMessage[];
}

/** POST /api/flights/:id/acars-messages request body. */
export interface SendCannedAcarsMessageRequest {
  /** One of CannedAcarsMessage.id. Required unless `body` is given. */
  canned_id?: string;
  /** The canned text itself, for a client that has no ids. Must match an entry. */
  body?: string;
  /** If present, must be 'downlink'. */
  direction?: AcarsDirection;
  /** If present, must equal the canned entry's category. */
  category?: AcarsCategory;
}

/**
 * The machine-readable twin of the dispatch-release body, stored in that
 * message's payload_json and read back — possibly days later — by the
 * load-sheet route. Deliberately self-contained: it is the only record of the
 * OFP's fuel and weight figures, and nothing may re-fetch or re-derive them.
 */
export interface DispatchPayload {
  /** Schema version of this blob. A reader that does not know it treats the payload as absent. */
  v: 1;
  /** Which upstream produced the figures. 'simbrief' is the only value today. */
  source: 'simbrief';
  ofp: {
    request_id: string | null;
    sequence_id: string | null;
    /** Epoch seconds, as a string, exactly as SimBrief sent it. */
    time_generated: string | null;
  };
  flight_number: string | null;
  aircraft_type: string | null;
  aircraft_reg: string | null;
  origin: string | null;
  destination: string | null;
  /** ICAO idents in plan order. [] when the plan was filed with none. */
  alternates: string[];
  /** The filed route string, untruncated. Truncation is a display rule. */
  route: string | null;
  cruise_alt_ft: number | null;
  /** 'kgs' | 'lbs' as SimBrief spelled it. Every weight below is in this unit. */
  units: string | null;
  ete_sec: number | null;
  block_time_sec: number | null;
  fuel: {
    ramp: number | null;
    takeoff: number | null;
    landing: number | null;
    taxi: number | null;
    enroute_burn: number | null;
    contingency: number | null;
    reserve: number | null;
    alternate_burn: number | null;
  };
  weights: {
    oew: number | null;
    payload: number | null;
    est_zfw: number | null;
    max_zfw: number | null;
    est_tow: number | null;
    est_ldw: number | null;
    pax_count: number | null;
    cargo: number | null;
  };
}

/**
 * The generated load sheet's figures. Stored as the reply message's
 * payload_json and returned alongside it, so the row and the response can
 * never disagree. Illustrative planning numbers, never a loading calculation.
 */
export interface LoadsheetFigures {
  /** 'kgs' | 'lbs' as SimBrief spelled it, or null. Every weight is in this unit. */
  units: string | null;
  block_fuel: number | null;
  taxi_fuel: number | null;
  takeoff_fuel: number | null;
  trip_fuel: number | null;
  payload: number | null;
  /** 'derived' means est_zfw - oew; 'unavailable' means the figure is null. */
  payload_source: 'simbrief' | 'derived' | 'unavailable';
  zero_fuel_weight: number | null;
  /** 'derived' means oew + payload. */
  zfw_source: 'simbrief' | 'derived' | 'unavailable';
  max_zero_fuel_weight: number | null;
  dry_operating_weight: number | null;
  takeoff_weight: number | null;
  landing_weight: number | null;
  pax_count: number | null;
  cargo: number | null;
  /** Always true: SimBrief planning figures, not a loading calculation. */
  estimated: boolean;
}

/**
 * POST /api/planned-legs/:legId/acars-messages/loadsheet — 201 when the pair
 * was written, 200 when it already existed. The request takes no body.
 */
export interface LoadsheetRequestResponse {
  planned_leg_id: number;
  /** false when this leg already had a load sheet and these are the stored rows. */
  created: boolean;
  /** direction 'downlink', label 'REQUEST LOADSHEET'. */
  request: AcarsMessage;
  /** direction 'uplink', label 'LOADSHEET'. correlation_id === request.id. */
  reply: AcarsMessage;
  /** The figures, already parsed, so no client has to scrape the body text. */
  sheet: LoadsheetFigures;
}

/** The machine-readable twin of a PDC's body, stored as the uplink message's payload_json and returned inline so no client parses the body text. */
export interface ClearanceDetails {
  v: 1;
  departure_icao: string | null;
  destination_icao: string | null;
  route: string | null;
  initial_altitude_ft: number;
  squawk: string;
}

/** POST /api/planned-legs/:legId/acars-messages/clearance — 201 when the pair was written, 200 when it already existed. The request takes no body. */
export interface ClearanceRequestResponse {
  planned_leg_id: number;
  /** false when this leg already had a clearance and these are the stored rows. */
  created: boolean;
  /** direction 'downlink', label 'REQUEST CLEARANCE'. */
  request: AcarsMessage;
  /** direction 'uplink', label 'PDC'. correlation_id === request.id. */
  reply: AcarsMessage;
  /** The clearance fields, already parsed, so no client has to scrape the body text. */
  clearance: ClearanceDetails;
}

/** POST /api/flights/:id/acars-messages/wx request body. */
export interface RequestWxRequest {
  /** Any string; validated server-side (see isValidIcaoShape in src/acars.ts). */
  icao: string;
}

/**
 * The machine-readable twin of a successful WX reply's payload_json, and
 * weatherClient.ts's own return type — the raw METAR/TAF response maps
 * directly onto this shape, so no second struct exists for the same data.
 */
export interface WxWeatherPayload {
  /** Normalised (trimmed, uppercased) — never the caller's raw casing. */
  icao: string;
  /** Raw METAR text, e.g. "METAR KJFK 142251Z 02013KT 10SM FEW060 22/08 A3014". */
  metar: string;
  /** Raw TAF text, or null — a station with no TAF on file is not an error. */
  taf: string | null;
  /** ISO 8601 UTC instant: when this fetch (or cache fill) happened. */
  fetched_at: string;
}

/** Why a WX reply is the rejection rather than the metar/taf reply. */
export type WxUnavailableReason =
  | 'NO_DATA'       // well-formed ICAO, upstream has no current METAR for it
  | 'NETWORK'       // could not reach the upstream at all
  | 'TIMEOUT'       // upstream did not respond in time
  | 'RATE_LIMITED'  // upstream answered 429
  | 'BAD_STATUS'    // upstream answered an unexpected non-2xx/204 status
  | 'BAD_BODY';     // upstream answered 200 with a body this client could not read

/** The machine-readable twin of a WX rejection reply's payload_json. */
export interface WxUnavailablePayload {
  icao: string;
  reason: WxUnavailableReason;
}

/** POST /api/flights/:id/acars-messages/wx 201 body. */
export interface WxRequestResponse {
  flight_id: number;
  /** Normalised (trimmed, uppercased) ICAO actually looked up. */
  icao: string;
  /** true when `reply` carries METAR/TAF text; false when it is the rejection. */
  available: boolean;
  /** direction 'downlink', label `WX REQUEST <ICAO>`. */
  request: AcarsMessage;
  /** direction 'uplink'; label 'METAR <ICAO>' when available, 'WX UNAVAILABLE' otherwise. */
  reply: AcarsMessage;
  /** The parsed convenience payload, present iff available === true. Mirrors reply.payload_json. */
  weather: WxWeatherPayload | null;
}

/** Every ACARS rejection body: { error, code }. */
export interface AcarsErrorBody {
  error: string;
  code:
    | 'INVALID_ID' | 'FLIGHT_NOT_FOUND' | 'INVALID_BODY'
    | 'UNKNOWN_CANNED_MESSAGE' | 'NOT_A_CANNED_MESSAGE'
    | 'DIRECTION_NOT_PERMITTED' | 'CATEGORY_NOT_PERMITTED'
    | 'PLANNED_LEG_NOT_FOUND' | 'NO_DISPATCH_DATA'
    | 'INVALID_ICAO';
}

// ── Ground sessions ───────────────────────────────────────────────────────────
//
// A pre-flight / on-ground session: the aircraft parked somewhere with an
// airport and (sometimes) a stand, before a flights row exists. Mirrored by
// hand into client/src/types.ts, like the ACARS shapes above — neither file
// imports from the other.

/** Who put a value there. Same vocabulary as flights.planned_leg_link_source. */
export type GroundSessionSource = 'auto' | 'manual';

/**
 * How an open session ended. Open on purpose, like AcarsCategory: these are
 * what today's rules produce, and a later rule may add another without a
 * migration.
 */
export type GroundSessionEndReason =
  | 'flight-started' | 'sim-exit' | 'crash' | 'slew'
  | 'superseded' | 'corrected' | 'manual'
  | (string & {});

/** One row of ground_sessions, as every read returns it and as the API sends it. */
export interface GroundSession {
  id: number;
  source: GroundSessionSource;
  airport_icao: string | null;
  airport_name: string | null;
  lat: number | null;
  lon: number | null;
  parking_position: string | null;
  parking_position_source: GroundSessionSource | null;
  planned_leg_id: number | null;
  planned_leg_link_source: GroundSessionSource | null;
  aircraft: string | null;
  /** ISO 8601 UTC instant. */
  started_at: string;
  /** NULL means the session is open. At most one row is open at a time. */
  ended_at: string | null;
  ended_reason: GroundSessionEndReason | null;
  flight_id: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Argument to insertGroundSession (src/db/groundSessions.ts). snake_case, one
 * key per column, so a row can be checked against the table without a mapping
 * table in between. Every key but `source` and `started_at` defaults to NULL.
 */
export interface CreateGroundSession {
  source: GroundSessionSource;
  airport_icao?: string | null;
  airport_name?: string | null;
  lat?: number | null;
  lon?: number | null;
  parking_position?: string | null;
  parking_position_source?: GroundSessionSource | null;
  planned_leg_id?: number | null;
  planned_leg_link_source?: GroundSessionSource | null;
  aircraft?: string | null;
  /** Defaults to new Date().toISOString() when omitted. */
  started_at?: string;
}

/** POST /api/ground-sessions request body. */
export interface CreateGroundSessionRequest {
  /** Required. Validated with isValidIcaoShape() from src/acars.ts after normaliseIcao(). */
  icao: string;
  /** Free text, trimmed; '' is stored as NULL. Max 120 chars. */
  parking_position?: string | null;
  /** Must exist when given: 404 PLANNED_LEG_NOT_FOUND otherwise. */
  planned_leg_id?: number | null;
}

/** GET /api/ground-sessions/current 200 body. Always 200, never 404. */
export interface CurrentGroundSessionResponse {
  /** null when no session is open. */
  session: GroundSession | null;
}

/** Every ground-session rejection body: { error, code }. */
export interface GroundSessionErrorBody {
  error: string;
  code:
    | 'INVALID_BODY' | 'INVALID_ICAO' | 'PLANNED_LEG_NOT_FOUND'
    | 'NO_OPEN_GROUND_SESSION';
}

/**
 * GET /api/status's `groundSession` key. Computed, camelCase. Present only
 * while flightState === 'GROUND'; the endpoint omits the key entirely
 * otherwise, so this never appears as a null field. tripId/tripName/
 * departureIdent/destinationIdent come from the linked planned leg and are
 * null when the session has none.
 */
export interface GroundSessionLiveStatus {
  groundSessionId: number;
  source: GroundSessionSource;
  airportIcao: string | null;
  airportName: string | null;
  parkingPosition: string | null;
  parkingPositionSource: GroundSessionSource | null;
  plannedLegId: number | null;
  plannedLegLinkSource: GroundSessionSource | null;
  tripId: number | null;
  tripName: string | null;
  departureIdent: string | null;
  destinationIdent: string | null;
  startedAt: string;
}

// ── Leg-scoped ACARS ─────────────────────────────────────────────────────────

/**
 * GET /api/planned-legs/:legId/acars-messages 200 body. The leg-scoped twin of
 * AcarsThread, which is keyed on a flight. Separate interface rather than a
 * widened AcarsThread: AcarsThread.flight_id is a `number` today and every
 * existing consumer relies on it.
 */
export interface PlannedLegAcarsThread {
  planned_leg_id: number;
  /** Oldest first: sent_at ASC, id ASC. The client reverses for display. */
  messages: AcarsMessage[];
}

/**
 * POST /api/planned-legs/:legId/acars-messages/wx 201 body. Field-for-field
 * WxRequestResponse with planned_leg_id where flight_id was.
 */
export interface PlannedLegWxRequestResponse {
  planned_leg_id: number;
  icao: string;
  available: boolean;
  request: AcarsMessage;
  reply: AcarsMessage;
  weather: WxWeatherPayload | null;
}

// ── SayIntentions ─────────────────────────────────────────────────────────────

/**
 * GET and PUT /api/settings/sayintentions.
 *
 * The key itself is NEVER in this shape. Unlike the SimBrief pilot ID — a
 * public identifier — a SayIntentions pilot key is a credential, so it goes
 * into the server and does not come back out. The UI needs exactly two
 * facts: whether one is stored, and enough of it to recognise which one.
 */
export interface SayIntentionsSettings {
  /** The only field any UI gates on. */
  sayintentions_api_key_set: boolean;
  /** 'abcd…wxyz' — first 4 + U+2026 + last 4, or '••••' for a key under 12
   *  characters, or null when nothing is stored. Never the whole key. */
  sayintentions_api_key_masked: string | null;
}

/**
 * One msfslogger flight bound to whatever SayIntentions session the stored key
 * held at the moment the operator pressed LINK. One row per flight; the
 * database enforces it (sayintentions_links.flight_id is the primary key).
 */
export interface SayIntentionsLink {
  flight_id: number;
  /** SayIntentions' own flight/session id, as a string, captured at link time.
   *  null when the response carried none — the session-changed guard is then
   *  skipped for this link. */
  upstream_flight_id: string | null;
  /** Highest comm_history[].id imported so far, sent as since_id on the next
   *  import. null before the first import, meaning "from the start of
   *  whatever the API returns". */
  since_id: number | null;
  /** Highest comm_history[].id that already existed at link time; 0 when the
   *  session had no comms yet. */
  baseline_comm_id: number;
  /** ISO 8601 UTC. */
  linked_at: string;
  /** ISO 8601 UTC; null until the first import. */
  last_import_at: string | null;
  /** Rows this link has written into acars_messages, cumulative. */
  imported_count: number;
}

/** GET /api/flights/:id/sayintentions/link — always 200 for an existing flight. */
export interface SayIntentionsLinkStatus {
  flight_id: number;
  linked: boolean;
  link: SayIntentionsLink | null;
  /** false when no key is stored. The UI hides its whole SayIntentions block
   *  on this alone, without a second settings request. */
  api_key_set: boolean;
}

/** POST /api/flights/:id/sayintentions/link — 201 on a new link, 200 on a re-link. */
export interface SayIntentionsLinkResponse {
  flight_id: number;
  created: boolean;
  link: SayIntentionsLink;
  /** comm_history entries the first import would file, counted at link time.
   *  0 with `?from=now`. */
  pending_messages: number;
}

/** POST /api/flights/:id/sayintentions/import — 201 when imported > 0, else 200. */
export interface SayIntentionsImportResponse {
  flight_id: number;
  /** Rows written by this call. 0 is a success, not an error. */
  imported: number;
  /** Rows whose dedup_key was already on file. */
  already_seen: number;
  /** Entries that produced no row at all (no usable text in either direction,
   *  or the entry itself was not usable). */
  skipped: number;
  /** The cursor after this import — the link's new since_id. */
  since_id: number | null;
  /** Exactly the rows written, oldest first. [] when imported === 0. */
  messages: AcarsMessage[];
}

/**
 * acars_messages.payload_json for an imported comms row: the upstream entry,
 * verbatim and unparsed by anything downstream, so nothing is lost if the
 * comm_history[] mapping ever needs to change.
 */
export interface SayIntentionsCommPayload {
  v: 1;
  source: 'sayintentions';
  /** comm_history[].id — also the dedup key's discriminator. */
  comm_id: number;
  /** 'in' (station → aircraft) or 'out' (aircraft → station). */
  leg: 'in' | 'out';
  /** The upstream entry exactly as received, minus nothing. */
  entry: Record<string, unknown>;
}

/** POST /api/planned-legs/:legId/sayintentions/clearance — 201 on success. No request body. */
export interface SayIntentionsPushResponse {
  planned_leg_id: number;
  /** The exact text handed to sayAs. Never longer than 128 characters. */
  sent_text: string;
  /** The acars_messages row that records the send. */
  message: AcarsMessage;
}

/** acars_messages.payload_json for the row recording a push. */
export interface SayIntentionsPushPayload {
  v: 1;
  source: 'sayintentions';
  channel: 'ACARS_IN';
  message_type: 'cpdlc';
  /** What was sent as sayAs's `from` — the departure ICAO, or 'DISPATCH'. */
  from: string;
  sent_text: string;
  /** ISO 8601 UTC. */
  sent_at: string;
  /** Upstream's confirmation body as text, truncated to 500 characters. Kept
   *  because SayIntentions does not document this shape and the first real
   *  response is the evidence that settles it. */
  upstream_excerpt: string;
}

// ── API tokens and password ──────────────────────────────────────────────────

/** How ingest is authenticated right now. 'closed': no credential exists and no
 *  opt-out — every ingest request is 401. */
export type IngestAuthMode = 'ui_tokens' | 'env_token' | 'unauthenticated' | 'closed';

/** One active ingest token. Never carries the secret or its digest. */
export interface IngestTokenSummary {
  id: number;
  /** 8 lowercase hex chars, random, unrelated to the secret. */
  public_id: string;
  label: string;
  /** ISO-8601 UTC. */
  created_at: string;
  /** ISO-8601 UTC, minute resolution; null = never used. */
  last_used_at: string | null;
}

/** GET /api/settings/ingest-tokens, and the body of a revoke. */
export interface IngestTokenListResponse {
  tokens: IngestTokenSummary[];
  mode: IngestAuthMode;
  /** INGEST_TOKEN is set on the server (whether or not it is being used). */
  env_token_set: boolean;
  /** ALLOW_UNAUTHENTICATED_INGEST is set and INGEST_TOKEN is not. */
  unauthenticated_opt_out_set: boolean;
}

/** POST /api/settings/ingest-tokens. `secret` appears here and never again. */
export interface IngestTokenCreateResponse extends IngestTokenListResponse {
  created: IngestTokenSummary;
  secret: string;
}

export type McpAuthMode = 'ui_tokens' | 'env_token' | 'disabled';

export interface McpTokenSummary {
  id: number;
  public_id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

export interface McpTokenListResponse {
  tokens: McpTokenSummary[];
  mode: McpAuthMode;
  /** MCP_TOKEN is set on the server (whether or not it is being used). */
  env_token_set: boolean;
}

export interface McpTokenCreateResponse extends McpTokenListResponse {
  created: McpTokenSummary;
  secret: string;
}

/** POST /api/settings/password body. */
export interface ChangePasswordRequest {
  current_password: string;
  new_password: string;
}

/** POST /api/settings/password success. */
export interface ChangePasswordResponse {
  ok: true;
  /** Sessions other than the caller's that were logged out. */
  other_sessions_revoked: number;
}
