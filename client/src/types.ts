// ── Auth ──────────────────────────────────────────────────────────────────
//
// Mirrors src/types.ts byte-identically. Hand-maintained; there is no
// shared package and this run does not introduce one.

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

export interface FlightPoint {
  id: number;
  flight_id: number;
  /** ISO 8601 UTC instant. */
  ts: string;
  lat: number;
  lon: number;
  altitude_ft: number;
  airspeed_kts: number;
  ground_speed_kts: number;
  heading_deg: number;
  vertical_speed_fpm: number;
  /** 0 | 1. SQLite has no boolean. */
  on_ground: number;
}

export interface Flight {
  id: number;
  aircraft: string | null;
  start_time: string | null;
  end_time: string | null;
  duration_sec: number | null;
  distance_nm: number | null;
  max_altitude_ft: number | null;
  max_airspeed_kts: number | null;
  point_count: number | null;
  points?: FlightPoint[];
  departure_lat: number | null;
  departure_lon: number | null;
  departure_icao: string | null;
  departure_name: string | null;
  arrival_lat: number | null;
  arrival_lon: number | null;
  arrival_icao: string | null;
  arrival_name: string | null;
  notes: string | null;
  trip_id: number | null;
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
  flight_count: number;
  total_duration_sec: number | null;
  total_distance_nm: number | null;
  max_altitude_ft: number | null;
  flights: Flight[];
  /** 0 | 1. SQLite has no boolean. At most one trip has this set to 1. */
  is_active: number;
  planned_leg_count: number;
  /** Populated by GET /api/trips/:id; always [] from GET /api/trips. */
  planned_legs: PlannedLegWithChildren[];
}

// ── Settings ──────────────────────────────────────────────────────────────

/** GET and PUT /api/settings/simbrief. Absence is `null`, never a 404. */
export interface SimbriefSettings {
  simbrief_user_id: string | null;
}

/** GET and PUT /api/settings/sayintentions. Absence is null, never a 404. The key is write-only (never returned in raw form). */
export interface SayIntentionsSettings {
  sayintentions_api_key_set: boolean;
  sayintentions_api_key_masked: string | null;
}

// ── API tokens and password ──────────────────────────────────────────────

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

// ── Planned legs ──────────────────────────────────────────────────────────────
//
// Mirrors src/types.ts and src/lnmpln.ts field-for-field, including
// nullability. This file is hand-maintained and nothing checks it against the
// server automatically beyond tools/check-type-mirror.js — keep it in sync by
// hand.

/**
 * 'linked' is deliberately absent: a leg is linked when a flight row points at
 * it, so the two facts cannot drift apart. 'diverted' is set by the system
 * only; 'flown' is set at touchdown, or — reversibly — by hand on a still
 * 'planned' leg whose flight was linked manually and has already ended.
 */
export type PlannedLegStatus = 'planned' | 'flown' | 'diverted' | 'skipped';

export interface PlannedLeg {
  id: number;
  /** null = a loose prefile, imported with no trip. */
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

/** GET /api/planned-legs element: a planned leg with its owning trip's name
 *  resolved, so a unified list needs no second request. trip_name is null
 *  exactly when trip_id is null. */
export interface PlannedLegListItem extends PlannedLegWithChildren {
  trip_name: string | null;
}

/** src/lnmpln.ts LnmplnWarning, mirrored (camelCase: computed, not persisted). */
export interface LnmplnWarning {
  code: string;
  /** One line, naming the element and the value. Surfaced per file on import. */
  message: string;
}

/**
 * Why a batch was or was not chain-sorted. src/lnmpln.ts BatchChainReason,
 * mirrored.
 */
export type BatchChainReason =
  | 'CHAINED'
  | 'SINGLE_LEG'
  | 'SNIPPET_IN_BATCH'
  | 'NO_UNIQUE_HEAD'
  | 'AMBIGUOUS_SUCCESSOR'
  | 'BROKEN_CHAIN';

/** Per-file outcome of a batch import. Partial success is the frozen policy. */
export interface PlannedLegImportResult {
  filename: string;
  status: 'imported' | 'duplicate' | 'rejected';
  /** Set for 'imported' (the new leg) and 'duplicate' (the existing leg). */
  planned_leg_id?: number;
  /** Set for 'rejected' and 'duplicate': a one-line reason, shown to the user. */
  error?: string;
  /** Set for 'imported' when the parser tolerated something worth reporting. */
  warnings?: LnmplnWarning[];
}

/** 201 when at least one file imported; 400 when none did (body still carries results). */
export interface PlannedLegImportResponse {
  /** Final seq order — route order after chain-sorting, generally NOT upload order. */
  imported: PlannedLegWithChildren[];
  /** One entry per uploaded file, in UPLOAD order, so an error maps to the file picked. */
  results: PlannedLegImportResult[];
  /**
   * Which ordering was used for `imported`, and why.
   *
   * Absent when nothing was imported: a chain verdict over zero legs says
   * nothing, so the server omits it rather than reporting a spurious one
   * (phase-1 review finding F-3). Branch on `batch?.ordering`, never assume it.
   */
  batch?: { ordering: 'chain' | 'upload'; reason: BatchChainReason };
}

/**
 * A warning surfaced by the SimBrief import. `code` is a plain string, not a
 * union: the server can add a warning code without this client failing to
 * compile, since only `message` is ever rendered.
 */
export interface SimbriefWarning {
  code: string;
  message: string;
}

/** POST /api/trips/:id/planned-legs/simbrief response's `result` field. */
export interface SimbriefImportResult {
  status: 'imported' | 'duplicate';
  planned_leg_id: number;
  label: string;
  warnings: SimbriefWarning[];
  /** Set for 'duplicate': a one-line reason, shown to the user (not an error). */
  error?: string;
}

/**
 * 201 on a new import, 200 on a duplicate (nothing failed, nothing changed).
 * `imported` holds at most one leg — one fetch is one plan — unlike the
 * .lnmpln batch route's `imported` array, which can hold several.
 */
export interface SimbriefImportResponse {
  imported: PlannedLegWithChildren[];
  result: SimbriefImportResult;
}

/** GET and PUT /api/active-trip (future phase; declared here ahead of the endpoint). */
export interface ActiveTrip {
  tripId: number | null;
  name: string | null;
}

/**
 * Mirrors src/types.ts TrafficObject byte-identically (neither file imports
 * from the other, same as StatusFrame / SimFrame). All six fields are always
 * present on this wire — onGround is only optional on the agent's ingest
 * wire, never here.
 */
export interface TrafficObject {
  id: number;
  lat: number;
  lon: number;
  altitudeFt: number;
  headingDeg: number;
  onGround: boolean;
}

export interface StatusFrame {
  lat: number;
  lon: number;
  altitudeFt: number;
  airspeedKnots: number;
  groundSpeedKnots: number;
  headingDeg: number;
  verticalSpeedFpm: number;
  onGround: boolean;
}

/**
 * Mirrors src/types.ts PlannedLegLiveStatus. Present on Status only while
 * flightState === 'FLYING' and the flight is linked to a planned leg — absent,
 * never null, the rest of the time.
 */
export interface PlannedLegLiveStatus {
  plannedLegId: number;
  /** null when the linked leg is a loose prefile (no trip). */
  tripId: number | null;
  /** null exactly when tripId is null. */
  tripName: string | null;
  destinationIdent: string;
  nextWaypointIdent: string;
  remainingDistanceNm: number;
  distanceIsApproximate: true;
}

export interface Status {
  connected: boolean;
  flightState: string;
  currentFlightId: number | null;
  aircraft: string | null;
  frame: StatusFrame | null;
  /** True for any sim pause, including MSFS Active Pause. Flight time is not counted while true. */
  paused: boolean;
  /** Raw MSFS Pause_EX1 bitmask: 1 full, 2 with-sound, 4 active, 8 sim. */
  pauseFlags: number;
  plannedLeg?: PlannedLegLiveStatus;
  /** Present iff flightState === 'GROUND'. Never null. */
  groundSession?: GroundSessionLiveStatus;
  /** Present iff non-empty, mirroring plannedLeg. */
  traffic?: TrafficObject[];
}

// ── Live event stream (GET /api/events) ─────────────────────────────────────

export type LiveTopic = 'status' | 'flight-state' | 'acars' | 'flights-changed' | 'navdata-demand';

/** Mirrors the flight-state SSE payload; same fields status carries, on their own. */
export interface FlightStateEvent {
  flightState: string;
  currentFlightId: number | null;
  plannedLegId: number | null;
}

/** A hint that new ACARS rows exist; the payload never carries the message bodies themselves. */
export interface AcarsHint {
  flightId: number | null;
  plannedLegId: number | null;
  messageId: number;
}

/** One decoded server-sent message, as delivered to a useLiveEvent handler. */
export interface LiveEvent {
  topic: LiveTopic;
  data: unknown;
}

/** Everything a registered handler is given when its debounce window fires. */
export interface LiveBatch {
  reconnected: boolean;
  events: ReadonlyArray<LiveEvent>;
}

// ── Ground sessions ─────────────────────────────────────────────────────────

export type GroundSessionSource = 'auto' | 'manual';

/** Mirrors src/types.ts GroundSessionEndReason. */
export type GroundSessionEndReason =
  | 'flight-started' | 'sim-exit' | 'crash' | 'slew'
  | 'superseded' | 'corrected' | 'manual'
  | (string & {});

/** Mirrors src/types.ts GroundSession — one ground_sessions row. */
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
  started_at: string;
  ended_at: string | null;
  ended_reason: GroundSessionEndReason | null;
  flight_id: number | null;
  created_at: string;
  updated_at: string;
}

/** POST /api/ground-sessions request body. */
export interface CreateGroundSessionRequest {
  icao: string;
  parking_position?: string | null;
  planned_leg_id?: number | null;
}

/** PATCH /api/ground-sessions/current request body. */
export interface UpdateGroundSessionRequest {
  parking_position: string | null;
}

/** GET /api/ground-sessions/current 200 body. `session` is null when none is open. */
export interface CurrentGroundSessionResponse {
  session: GroundSession | null;
}

/**
 * Mirrors src/types.ts GroundSessionLiveStatus. Present on Status only while
 * flightState === 'GROUND' — absent, never null, the rest of the time.
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

/** GET /api/planned-legs/:legId/acars-messages 200 body. */
export interface PlannedLegAcarsThread {
  planned_leg_id: number;
  messages: AcarsMessage[];
}

/** POST /api/planned-legs/:legId/acars-messages/wx 201 body. */
export interface PlannedLegWxRequestResponse {
  planned_leg_id: number;
  icao: string;
  available: boolean;
  request: AcarsMessage;
  reply: AcarsMessage;
  weather: WxWeatherPayload | null;
}

export interface JourneyLeg {
  id: number;
  seq: number;
  aircraft: string | null;
  departureIcao: string | null;
  arrivalIcao: string | null;
  distanceNm: number | null;
  durationSec: number | null;
  startTime: string;
  track: [number, number][];
}

export interface JourneyAirport {
  icao: string;
  name: string | null;
  lat: number;
  lon: number;
  visits: number;
}

export interface Journey {
  legCount: number;
  totalDistanceNm: number;
  totalDurationSec: number;
  /** Absent, not zero, when the trip has no planned legs. */
  plannedRouteProgressPct?: number;
  aircraftCount: number;
  aircraft: { name: string; legs: number; distanceNm: number }[];
  maxAltitudeFt: number;
  maxAirspeedKts: number;
  longestLeg: { id: number; route: string; distanceNm: number } | null;
  countries: { name: string; flag: string; airports: number }[];
  airports: JourneyAirport[];
  longestChain: { length: number; from: string; to: string } | null;
  chainBreaks: number;
  legs: JourneyLeg[];
  firstFlight: string | null;
  lastFlight: string | null;
}

// ── ACARS ─────────────────────────────────────────────────────────────────

/** 'uplink' is dispatch speaking to the aircraft; 'downlink' is the cockpit. */
export type AcarsDirection = 'uplink' | 'downlink';

/**
 * Open on purpose. The five the message-center story names, plus 'oooi', which
 * the position-report story needs; a later story may add another without a
 * schema change or a change here. Validated by shape, not by membership — see
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
  /** NULL means unread. Nothing writes it this run. */
  read_at: string | null;
}

/** GET /api/flights/:id/acars-messages 200 body. */
export interface AcarsThread {
  flight_id: number;
  /** The leg whose pre-flight messages are included, or null. */
  planned_leg_id: number | null;
  /** Oldest first: sent_at ASC, id ASC. The client reverses for display. */
  messages: AcarsMessage[];
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
  /** Always 'downlink' for every entry in this run's set. */
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

/** The generated load sheet's figures — illustrative planning numbers, not a loading calculation. */
export interface LoadsheetFigures {
  /** 'kgs' | 'lbs' as SimBrief spelled it, or null. Every weight is in this unit. */
  units: string | null;
  block_fuel: number | null;
  taxi_fuel: number | null;
  takeoff_fuel: number | null;
  trip_fuel: number | null;
  payload: number | null;
  payload_source: 'simbrief' | 'derived' | 'unavailable';
  zero_fuel_weight: number | null;
  zfw_source: 'simbrief' | 'derived' | 'unavailable';
  max_zero_fuel_weight: number | null;
  dry_operating_weight: number | null;
  takeoff_weight: number | null;
  landing_weight: number | null;
  pax_count: number | null;
  cargo: number | null;
  /** Always true. Never present these as authoritative loading data. */
  estimated: boolean;
}

/**
 * POST /api/planned-legs/:legId/acars-messages/loadsheet 200/201 body. The
 * request takes no body at all.
 *
 * `created` is false when the leg already had a load sheet: the two messages
 * are then the stored ones, already in the thread, so they are merged into
 * local state by id rather than appended.
 */
export interface LoadsheetRequestResponse {
  planned_leg_id: number;
  created: boolean;
  /** direction 'downlink', label 'REQUEST LOADSHEET'. */
  request: AcarsMessage;
  /** direction 'uplink', label 'LOADSHEET'. correlation_id === request.id. */
  reply: AcarsMessage;
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

/**
 * POST /api/planned-legs/:legId/acars-messages/clearance 200/201 body. The
 * request takes no body at all.
 *
 * `created` is false when the leg already had a clearance: the two messages
 * are then the stored ones, already in the thread, so they are merged into
 * local state by id rather than appended.
 */
export interface ClearanceRequestResponse {
  planned_leg_id: number;
  created: boolean;
  /** direction 'downlink', label 'REQUEST CLEARANCE'. */
  request: AcarsMessage;
  /** direction 'uplink', label 'PDC'. correlation_id === request.id. */
  reply: AcarsMessage;
  clearance: ClearanceDetails;
}

export interface WxWeatherPayload {
  icao: string;
  metar: string;
  taf: string | null;
  fetched_at: string;
}

export type WxUnavailableReason =
  | 'NO_DATA'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'BAD_STATUS'
  | 'BAD_BODY';

/** POST /api/flights/:id/acars-messages/wx 201 body. */
export interface WxRequestResponse {
  flight_id: number;
  icao: string;
  available: boolean;
  request: AcarsMessage;
  reply: AcarsMessage;
  weather: WxWeatherPayload | null;
}

// ── SayIntentions ─────────────────────────────────────────────────────────

/**
 * One msfslogger flight bound to whatever SayIntentions session the stored
 * key held at the moment the operator pressed LINK.
 */
export interface SayIntentionsLink {
  flight_id: number;
  /** SayIntentions' own flight/session id, as a string, captured at link time. */
  upstream_flight_id: string | null;
  /** Highest comm_history[].id imported so far. null before the first import. */
  since_id: number | null;
  /** Highest comm_history[].id that already existed at link time. */
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
  /** false when no key is stored. The UI hides its whole SayIntentions block on this alone. */
  api_key_set: boolean;
}

/** POST /api/flights/:id/sayintentions/link — 201 on a new link, 200 on a re-link. */
export interface SayIntentionsLinkResponse {
  flight_id: number;
  created: boolean;
  link: SayIntentionsLink;
  /** comm_history entries the first import would file, counted at link time. 0 with ?from=now. */
  pending_messages: number;
}

/** POST /api/flights/:id/sayintentions/import — 201 when imported > 0, else 200. */
export interface SayIntentionsImportResponse {
  flight_id: number;
  /** Rows written by this call. 0 is a success, not an error. */
  imported: number;
  /** Entries whose dedup_key was already on file. */
  already_seen: number;
  /** Entries that produced no row at all (no usable text in either direction). */
  skipped: number;
  /** The cursor after this import — the link's new since_id. */
  since_id: number | null;
  /** Exactly the rows written, oldest first. [] when imported === 0. */
  messages: AcarsMessage[];
}

/** POST /api/planned-legs/:legId/sayintentions/clearance 201 body. */
export interface SayIntentionsPushResponse {
  planned_leg_id: number;
  /** The exact text handed to sayAs. Never longer than 128 characters. */
  sent_text: string;
  /** The PDC message sent to SayIntentions, newly stored in acars_messages. */
  message: AcarsMessage;
}

// -- Navdata --
// Mirrors src/navdata/queryTypes.ts (camelCase query shapes). Hand-maintained;
// longitudes are in [-180,180] and are never unwrapped by the server.

export type NavdataSidecarState = 'nav.off' | 'nav.unavailable' | 'nav.bulk' | 'nav.ready' | 'nav.error';
export type NavdataDetailState = 'index' | 'pending' | 'detail' | 'absent' | 'failed';
export type NavdataTransitionRole = 'common' | 'runway' | 'enroute' | 'approach' | 'final' | 'missed';

/** Which replica the map reads: the simulator's (MCDU) or an imported Little Navmap database. */
export type NavdataSource = 'mcdu' | 'lnm';
export type LnmDataSource = 'NAVIGRAPH' | 'MSFS' | 'MSFS24';

/** What a replica is: a label to show, its AIRAC cycle and validity when it has them. */
export interface NavdataDataset {
  source: NavdataSource;
  /** Human text; display only, never parsed. */
  label: string;
  provider: LnmDataSource | null;
  /** 'YYNN', e.g. '1801'; null when the dataset has none. */
  airacCycle: string | null;
  /** 'YYYY-MM-DD', UTC calendar date, inclusive. */
  validFrom: string | null;
  /** 'YYYY-MM-DD', UTC calendar date, inclusive. */
  validThrough: string | null;
  /** Decided by the server. null = not knowable (no validThrough). */
  expired: boolean | null;
  /** Zone-less local time text, shown verbatim if at all. */
  compiledAt: string | null;
  navigraphUpdate: boolean | null;
  /** Epoch ms. */
  importedAt: number | null;
}

/** GET/PUT /api/settings/navdata-source. */
export interface NavdataSourceResponse {
  selected: NavdataSource;
  effective: NavdataSource;
  /** Set iff selected is 'lnm' and the simulator replica answers instead. */
  fallback: null | 'lnm-unavailable';
  mcdu: { present: boolean; dataset: NavdataDataset | null };
  lnm: { present: boolean; dataset: NavdataDataset | null };
  importDir: string;
}

export interface NavdataStatusResponse {
  present: boolean;
  schemaVersion: number | null;
  snapshotId: string | null;
  rev: number | null;
  simId: string | null;
  simAppName: string | null;
  simAppVersion: string | null;
  snapshotAppliedAt: number | null;
  lastRowsAt: number | null;
  counts: {
    airports: number; airportsWithDetail: number; navaids: number; waypoints: number;
    airwayLegs: number; runways: number; procedures: number; coverageCells: number; absent: number;
  } | null;
  sidecar: { state: NavdataSidecarState; reason: string | null } | null;
  /** The source that answered: the selected one, unless it is unavailable. */
  source: NavdataSource;
  /** The stored choice from Settings. */
  selectedSource: NavdataSource;
  /** Set iff selectedSource is 'lnm' and the simulator replica answered instead. */
  sourceFallback: null | 'lnm-unavailable';
  /** What the answering replica is. null iff present is false. */
  dataset: NavdataDataset | null;
}

export type LnmStage =
  | 'validating' | 'indexing' | 'airports' | 'navaids' | 'waypoints' | 'airways'
  | 'procedures' | 'finalising' | 'coverage' | 'verifying' | 'swapping';
export type LnmImportState = 'receiving' | 'running' | 'succeeded' | 'failed' | 'cancelled';
/** The union lives in src/navdata/lnm/types.ts; the client only displays the message. */
export type LnmImportErrorCode = string;

export interface LnmImportCounts {
  airports: number; runways: number; frequencies: number; navaids: number; waypoints: number;
  airwayLegs: number; procedures: number; transitions: number; legs: number; coverageCells: number;
}

/** The current or last Little Navmap import since the server started (GET /api/navdata/lnm-import). */
export interface LnmImportJob {
  /** Opaque. */
  id: string;
  origin: 'upload' | 'path';
  /** Basename only. */
  sourceFileName: string;
  sourceBytes: number;
  /** 'receiving' = the upload body is still arriving (upload only). */
  state: LnmImportState;
  /** null while receiving. */
  stage: LnmStage | null;
  /** 0..1; 0 while receiving. */
  fraction: number;
  /** Epoch ms the request was accepted. */
  startedAt: number;
  finishedAt: number | null;
  /** Set iff state is 'failed'. */
  error: { code: LnmImportErrorCode; message: string } | null;
  /** Set iff state is 'succeeded'. */
  result: { dataset: NavdataDataset; counts: LnmImportCounts; warnings: number } | null;
}

export interface LnmImportJobResponse { job: LnmImportJob | null }

/** GET /api/navdata/lnm-import/files: the import folder's .sqlite files and the limits an upload is checked against. */
export interface LnmImportFilesResponse {
  /** Absolute, as the server sees it. */
  dir: string;
  files: { name: string; sizeBytes: number; modifiedAt: number }[];
  maxUploadBytes: number;
  /** null when the free space cannot be read. */
  availableBytes: number | null;
  /** An upload of n bytes needs n + reserveBytes free. */
  reserveBytes: number;
}

/** Surface class of the airport's LONGEST runway. Never inferred when unknown. */
export type AirportSurface = 'paved' | 'water' | 'soft';

/** An airport's size class, in reveal order: a lower tier is revealed at a
 *  lower zoom. 'unknown' means the airport has no fetched detail and no
 *  OurAirports row carries its ident — it is NOT a claim that the airport is
 *  small. 'other' is a positively classified heliport, seaplane base,
 *  balloonport or closed field. */
export type AirportTier = 'large' | 'medium' | 'small' | 'unknown' | 'other';

/** Why the airport list is shorter than the bbox's contents. Separate from
 *  `truncated`, which reports the `limit` cut on whatever passed the filter. */
export interface AirportThinning {
  /** 'none' = no tier filter ran and every airport in the bbox was eligible.
   *  'tier' = only airports up to `through` were returned. */
  mode: 'none' | 'tier';
  /** The last tier included. null iff mode === 'none'. Never 'other': when the
   *  last tier is admitted nothing is filtered, so mode is 'none'. */
  through: AirportTier | null;
  /** Airports inside the bbox the tier filter excluded. 0 iff mode === 'none'. */
  hidden: number;
  /** Unfiltered per-tier counts for this bbox, every key present including
   *  zeros. null when no histogram ran: the airports kind was not requested,
   *  or was zoom-gated, or the zoom already admits every tier. */
  byTier: Record<AirportTier, number> | null;
  /** Lowest zoom at which the tier after `through` is admitted. null iff
   *  mode === 'none'. */
  nextZoom: number | null;
}

export interface FeatureAirport {
  ident: string; lat: number; lon: number; name: string | null;
  hasDetail: boolean; runways: number | null; procedures: number | null;
  /** Length in metres of the airport's longest runway, unrounded, exactly as
   *  nav_runway.length_m stores it. null = not known; never 0 and never a
   *  stand-in for "small". */
  longestRunwayM: number | null;
  /** Surface class of that same longest runway. null = not known. */
  surface: AirportSurface | null;
  /** true = the airport has a TOWER frequency (nav_airport_frequency.freq_type = 6).
   *  false = detail is present, frequencies are present, none of them is a tower.
   *  null  = not known. false and null are DIFFERENT and must render differently. */
  towered: boolean | null;
  /** True heading of the airport's longest runway, taken from that same runway
   *  row. null = not known — either detail hasn't been fetched, or that row's
   *  heading_deg column is itself null (independent of length/surface). */
  longestRunwayHeadingDeg: number | null;
  /** This airport's size class. null = neither source could be consulted: no
   *  fetched runway and no classification data loaded. Distinct from
   *  'unknown', which is a measured fact about OurAirports' coverage; neither
   *  may be read as "small". */
  tier: AirportTier | null;
}
export interface FeatureNavaid {
  kind: 'V' | 'N'; ident: string; region: string; lat: number; lon: number;
  frequencyHz: number | null; name: string | null; navType: number | null; isDme: boolean | null;
  /** The station has a navigation (VOR) function. null = not known (index-only row, and every NDB). */
  isNav: boolean | null;
  /** The station has a TACAN function. null = not known (index-only row, and every NDB). */
  isTacan: boolean | null;
  /** Magnetic variation, degrees WEST-positive, [0, 360), as stored. null = not known. */
  magvar: number | null;
}
export interface FeatureWaypoint {
  key: string; ident: string; region: string; lat: number; lon: number; terminal: boolean | null;
}
export interface FeatureAirwayLeg {
  airway: string; from: [number, number]; to: [number, number];
  fromIdent: string; toIdent: string; dateline: boolean;
}
export interface FeatureRunway {
  airport: string; lat: number; lon: number;
  headingDeg: number | null; lengthM: number | null; widthM: number | null; designation: string;
  secondaryDesignation: string;
}
export interface FeatureCoverageKind {
  harvestedCells: number; fraction: number;
  oldestHarvestAt: number | null; newestHarvestAt: number | null;
}
export interface FeatureCoverage {
  totalCells: number;
  byKind: Record<'V' | 'N' | 'W', FeatureCoverageKind>;
  airportsComplete: boolean;
}
export interface FeaturesResponse {
  bbox: [number, number, number, number];
  zoom: number; gated: string[]; truncated: boolean; limit: number;
  airports: FeatureAirport[]; navaids: FeatureNavaid[]; waypoints: FeatureWaypoint[];
  airways: FeatureAirwayLeg[]; runways: FeatureRunway[];
  coverage: FeatureCoverage;
  /** Always present, never null. */
  airportThinning: AirportThinning;
}

export interface AirportProcedureSummary {
  key: string; kind: 'SID' | 'STAR' | 'APPROACH'; name: string; runway: string | null;
  transitions: { key: string; role: NavdataTransitionRole; name: string; legs: number }[];
}
export interface AirportDetailResponse {
  ident: string; detailState: NavdataDetailState; detailFetchedAt: number | null;
  lat: number | null; lon: number | null; altM: number | null;
  name: string | null; magvar: number | null;
  runways: FeatureRunway[];
  frequencies: { type: number | null; frequencyHz: number | null; name: string | null }[];
  procedures: AirportProcedureSummary[];
  longestRunwayM: number | null;
  surface: AirportSurface | null;
  towered: boolean | null;
  longestRunwayHeadingDeg: number | null;
}

export interface GeometryPoint {
  lat: number; lon: number; ident: string | null; legType: number | null;
  flyOver: boolean | null;
  altitude1M: number | null; altitude2M: number | null; speedLimitKt: number | null;
}
export interface GeometryArc {
  fromIndex: number; toIndex: number; centerLat: number; centerLon: number; turn: 'L' | 'R' | null;
}
export interface GeometryChain {
  /** proc_key for a real procedure; the plan's opaque sid_name/approach_name
   *  for a synthetic chain; 'planned' for enroute; null when empty. */
  source: string | null;
  /** true only for a custom SID/approach computed from the runway
   *  (see the synthetic procedure builder). false on every other chain, empty
   *  chains included. */
  synthetic: boolean;
  points: GeometryPoint[];
  arcs: GeometryArc[];
}

/** isAirport comes from
 *  planned_legs.departure_is_airport / destination_is_airport; when false the
 *  UI must not offer "fetch detail". This server never emits null — the
 *  planned columns are NOT NULL — but the type admits it. */
export interface RouteGeometryEndpoint {
  ident: string; lat: number; lon: number; isAirport: boolean;
}

export type UnresolvedKind = 'sid' | 'star' | 'approach' | 'airway' | 'waypoint';
export type UnresolvedReason =
  | 'ident not in cache'
  | 'position disagrees with cache'
  | 'no path found'
  | 'procedure not in cache'
  | 'airport detail not fetched'
  /** A custom SID/approach whose runway row is missing or unusable .
   *  A custom procedure is NEVER 'procedure not in cache'. */
  | 'custom procedure, no runway'
  /** A custom procedure whose runway resolved but whose distance is missing or not a positive number. */
  | 'custom procedure, invalid distance'
  | 'unparseable runway'
  | 'approach runway not specified';

export interface RouteGeometryResponse {
  legId: number;
  origin: RouteGeometryEndpoint | null; destination: RouteGeometryEndpoint | null;
  sid: GeometryChain; enroute: GeometryChain; star: GeometryChain; approach: GeometryChain;
  skippedLegs: number;
  skippedByChain: Record<'sid' | 'enroute' | 'star' | 'approach', number>;
  unresolved: { kind: UnresolvedKind; name: string; reason: UnresolvedReason }[];
}

export interface NavdataRequestBody { kind: 'A' | 'W'; ident: string; region?: string | null; force?: boolean }
export interface NavdataRequestResponse { ok: true; state: 'queued' | 'already-present' | 'known-absent'; ident: string }
