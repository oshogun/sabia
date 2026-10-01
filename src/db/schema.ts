// ── Schema ────────────────────────────────────────────────────────────────────
//
// Every statement initDb() runs against a fresh or an existing database.
// Idempotent from end to end — the CREATE ... IF NOT EXISTS block, the
// column migrations for databases that predate a column, and the two partial
// UNIQUE indexes — so running it again over real rows changes nothing.

import Database from 'better-sqlite3';

/**
 * One-time rebuild for a database created before trip_id could be NULL.
 * SQLite has no ALTER TABLE ... ALTER COLUMN, so the only way to drop a NOT
 * NULL constraint is to rebuild the table. Gated on the column's own notnull
 * flag rather than a version marker, so a fresh database (already nullable)
 * and an already-migrated one both return immediately, and running this
 * function again is always a no-op.
 *
 * Column lists here are frozen at the 50 columns planned_legs had before this
 * change: this block only ever runs against a database that predates it, and
 * such a database has exactly these columns. Any future
 * ALTER TABLE planned_legs ADD COLUMN migration must go after this block —
 * placed before it, a new column would exist on the old table and be silently
 * dropped by the explicit column lists below.
 */
function migratePlannedLegsTripIdNullable(db: Database.Database): void {
  const tripIdCol = (db.prepare('PRAGMA table_info(planned_legs)').all() as { name: string; notnull: number }[])
    .find(c => c.name === 'trip_id');
  if (!tripIdCol || tripIdCol.notnull === 0) return;

  // better-sqlite3 reports foreign_keys = 1 even on a handle that never set
  // it, and enforcement must be off for the DROP TABLE below: with it on, the
  // drop fires every ON DELETE action referencing planned_legs and silently
  // empties planned_waypoints, planned_alternates and the leg-scoped
  // acars_messages, and NULLs flights.planned_leg_id / ground_sessions.planned_leg_id.
  // The pragma is also a silent no-op once a transaction has begun (including
  // inside db.transaction()), so it is set here, outside any transaction, and
  // re-read before proceeding; the whole rebuild below uses raw BEGIN/COMMIT
  // rather than db.transaction() for the same reason. The prior value is
  // restored in the finally so an exception anywhere in this function cannot
  // leave the process running with foreign keys off.
  const priorForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
  try {
    db.pragma('foreign_keys = OFF');
    if (db.pragma('foreign_keys', { simple: true }) !== 0) {
      throw new Error('planned_legs migration: could not disable foreign_keys before rebuilding the table');
    }

    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE planned_legs_new (
          id                     INTEGER PRIMARY KEY AUTOINCREMENT,
          trip_id                INTEGER REFERENCES trips(id) ON DELETE CASCADE,
          seq                    INTEGER NOT NULL,
          status                 TEXT    NOT NULL DEFAULT 'planned'
                                   CHECK (status IN ('planned', 'flown', 'diverted', 'skipped')),
          departure_ident        TEXT    NOT NULL,
          departure_name         TEXT,
          departure_lat          REAL    NOT NULL,
          departure_lon          REAL    NOT NULL,
          departure_is_airport   INTEGER NOT NULL DEFAULT 0,
          departure_start        TEXT,
          departure_start_type   TEXT,
          departure_pos_lat      REAL,
          departure_pos_lon      REAL,
          destination_ident      TEXT    NOT NULL,
          destination_name       TEXT,
          destination_lat        REAL    NOT NULL,
          destination_lon        REAL    NOT NULL,
          destination_is_airport INTEGER NOT NULL DEFAULT 0,
          is_snippet             INTEGER NOT NULL DEFAULT 0,
          cruise_alt_ft          REAL,
          flightplan_type        TEXT,
          aircraft_type          TEXT,
          sid_name               TEXT,
          sid_runway             TEXT,
          sid_transition         TEXT,
          sid_type               TEXT,
          sid_custom_distance_nm REAL,
          star_name              TEXT,
          star_runway            TEXT,
          star_transition        TEXT,
          approach_name          TEXT,
          approach_runway        TEXT,
          approach_transition    TEXT,
          approach_type          TEXT,
          approach_arinc         TEXT,
          approach_suffix        TEXT,
          approach_transition_type TEXT,
          approach_custom_distance_nm REAL,
          approach_custom_altitude_ft REAL,
          approach_custom_offset_deg  REAL,
          waypoint_count         INTEGER NOT NULL DEFAULT 0,
          alternate_count        INTEGER NOT NULL DEFAULT 0,
          approx_distance_nm     REAL    NOT NULL DEFAULT 0,
          arrival_deviation_nm   REAL,
          remarks                TEXT,
          plan_created_at        TEXT,
          source_filename        TEXT    NOT NULL,
          source_sha256          TEXT    NOT NULL,
          source_program         TEXT,
          imported_at            TEXT    NOT NULL
        );

        INSERT INTO planned_legs_new (
          id, trip_id, seq, status,
          departure_ident, departure_name, departure_lat, departure_lon,
          departure_is_airport, departure_start, departure_start_type, departure_pos_lat,
          departure_pos_lon, destination_ident, destination_name, destination_lat,
          destination_lon, destination_is_airport, is_snippet, cruise_alt_ft,
          flightplan_type, aircraft_type, sid_name, sid_runway,
          sid_transition, sid_type, sid_custom_distance_nm, star_name,
          star_runway, star_transition, approach_name, approach_runway,
          approach_transition, approach_type, approach_arinc, approach_suffix,
          approach_transition_type, approach_custom_distance_nm, approach_custom_altitude_ft, approach_custom_offset_deg,
          waypoint_count, alternate_count, approx_distance_nm, arrival_deviation_nm,
          remarks, plan_created_at, source_filename, source_sha256,
          source_program, imported_at
        )
        SELECT
          id, trip_id, seq, status,
          departure_ident, departure_name, departure_lat, departure_lon,
          departure_is_airport, departure_start, departure_start_type, departure_pos_lat,
          departure_pos_lon, destination_ident, destination_name, destination_lat,
          destination_lon, destination_is_airport, is_snippet, cruise_alt_ft,
          flightplan_type, aircraft_type, sid_name, sid_runway,
          sid_transition, sid_type, sid_custom_distance_nm, star_name,
          star_runway, star_transition, approach_name, approach_runway,
          approach_transition, approach_type, approach_arinc, approach_suffix,
          approach_transition_type, approach_custom_distance_nm, approach_custom_altitude_ft, approach_custom_offset_deg,
          waypoint_count, alternate_count, approx_distance_nm, arrival_deviation_nm,
          remarks, plan_created_at, source_filename, source_sha256,
          source_program, imported_at
        FROM planned_legs;
      `);

      // Read before the drop, applied after the rename: DROP TABLE deletes
      // the table's sqlite_sequence row, and the INSERT above only carries
      // the counter up to MAX(id) — which can be behind the real counter if
      // the highest-numbered leg was ever deleted. Without this, the next
      // leg imported could be handed an id AUTOINCREMENT already issued once.
      const seqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'planned_legs'").get() as { seq: number } | undefined;

      // Drop-then-rename, never rename-the-old-one-out-of-the-way: on this
      // SQLite version, ALTER TABLE ... RENAME TO rewrites every other
      // table's REFERENCES clause to name the renamed table, regardless of
      // the foreign_keys pragma. Renaming planned_legs out of the way would
      // leave every child table pointing at a table that no longer exists
      // under that name; dropping it first means nothing ever names
      // planned_legs_new, so its rename rewrites nothing and the children's
      // clauses — still naming planned_legs — bind to the new table.
      db.exec('DROP TABLE planned_legs');
      db.exec('ALTER TABLE planned_legs_new RENAME TO planned_legs');

      // The drop took both indexes with it, and applySchema's own
      // CREATE INDEX statements have already run by the time this executes.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_planned_legs_trip   ON planned_legs(trip_id, seq);
        CREATE INDEX IF NOT EXISTS idx_planned_legs_source ON planned_legs(trip_id, source_sha256);
      `);

      // Guarded so a counter that already reads higher than the copied rows
      // (the normal case, per the comment above) is never walked backwards.
      if (seqRow) {
        db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'planned_legs' AND seq < ?").run(seqRow.seq, seqRow.seq);
      }

      // A non-empty result means the rebuild produced a dangling reference;
      // abort rather than commit a table that violates its own foreign keys.
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        throw new Error(`planned_legs migration: foreign_key_check found ${violations.length} violation(s) after rebuild`);
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    db.pragma(`foreign_keys = ${priorForeignKeys}`);
  }
}

export function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS flights (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      aircraft         TEXT,
      departure_lat    REAL,
      departure_lon    REAL,
      arrival_lat      REAL,
      arrival_lon      REAL,
      start_time       TEXT NOT NULL,
      end_time         TEXT,
      duration_sec     INTEGER,
      distance_nm      REAL,
      max_altitude_ft  REAL,
      max_airspeed_kts REAL,
      point_count      INTEGER,
      notes            TEXT,
      departure_icao   TEXT,
      departure_name   TEXT,
      arrival_icao     TEXT,
      arrival_name     TEXT
    );

    CREATE TABLE IF NOT EXISTS flight_points (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      flight_id           INTEGER NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
      ts                  TEXT NOT NULL,
      lat                 REAL NOT NULL,
      lon                 REAL NOT NULL,
      altitude_ft         REAL NOT NULL,
      airspeed_kts        REAL NOT NULL,
      ground_speed_kts    REAL NOT NULL,
      heading_deg         REAL NOT NULL,
      vertical_speed_fpm  REAL NOT NULL,
      on_ground           INTEGER NOT NULL,
      after_interruption  INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_points_flight ON flight_points(flight_id);

    CREATE TABLE IF NOT EXISTS trips (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      notes      TEXT,
      created_at TEXT NOT NULL
    );

    -- Planned legs: a route imported from a Little Navmap .lnmpln file and
    -- attached to a trip, before it is flown. Must be created before the
    -- ALTER TABLE below, which adds flights.planned_leg_id REFERENCES here.
    CREATE TABLE IF NOT EXISTS planned_legs (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      -- NULL means "loose": a prefile that belongs to no trip. Still CASCADE,
      -- so deleting a trip still deletes its legs; a NULL row references
      -- nothing and no cascade can ever reach it.
      trip_id                INTEGER REFERENCES trips(id) ON DELETE CASCADE,
      -- 1-based within a trip, dense on import, gappy after a delete. Every read
      -- orders by (seq, id) so the order stays total even if two rows shared a
      -- seq. Assigned in CHAIN order (destination ident -> next departure ident)
      -- by the import handler, not multipart upload order.
      seq                    INTEGER NOT NULL,
      -- 'linked' is deliberately absent: a leg is linked when a flight row
      -- points at it, so the two facts cannot drift apart.
      status                 TEXT    NOT NULL DEFAULT 'planned'
                               CHECK (status IN ('planned', 'flown', 'diverted', 'skipped')),

      -- First waypoint of the plan. Not necessarily an airport: Little Navmap
      -- allows plan snippets, so departure_is_airport gates any ICAO claim.
      departure_ident        TEXT    NOT NULL,
      departure_name         TEXT,
      departure_lat          REAL    NOT NULL,
      departure_lon          REAL    NOT NULL,
      departure_is_airport   INTEGER NOT NULL DEFAULT 0,
      -- <Departure> in the file: the parking spot / runway the plan starts at.
      -- More precise than departure_lat/lon but optional (commonly absent),
      -- so the matcher uses the waypoint position above and these are
      -- display-only.
      departure_start        TEXT,
      departure_start_type   TEXT,
      departure_pos_lat      REAL,
      departure_pos_lon      REAL,

      -- Last waypoint of the plan, same caveat as the departure.
      destination_ident      TEXT    NOT NULL,
      destination_name       TEXT,
      destination_lat        REAL    NOT NULL,
      destination_lon        REAL    NOT NULL,
      destination_is_airport INTEGER NOT NULL DEFAULT 0,

      is_snippet             INTEGER NOT NULL DEFAULT 0,
      -- CruisingAltF preferred over CruisingAlt; null when the file carries neither.
      cruise_alt_ft          REAL,
      flightplan_type        TEXT,
      aircraft_type          TEXT,

      -- Procedures are stored flat because the file never contains their
      -- waypoints, so there would be nothing for a procedure-leg table to
      -- hold. Eighteen columns: a real custom approach is characterised
      -- entirely by Type plus the Custom* values.
      --
      -- sid_runway is the ONLY place a departure runway appears: no real file
      -- has ever carried a <Departure> element.
      sid_name               TEXT,
      sid_runway             TEXT,
      sid_transition         TEXT,
      -- 'CUSTOMDEPART' for the manual's custom-departure form, which the XSD
      -- does not declare. NULL for an ordinary published SID.
      sid_type               TEXT,
      sid_custom_distance_nm REAL,

      -- Three columns only: no observed file and no documentation gives a STAR
      -- a type or a custom form. An unrecognised child of <STAR> surfaces as an
      -- UNKNOWN_ELEMENT parser warning rather than vanishing.
      star_name              TEXT,
      star_runway            TEXT,
      star_transition        TEXT,

      -- approach_name is an opaque label, never a fix reference: with
      -- Type=CUSTOM Little Navmap synthesizes it as ICAO+runway ("KLAX24R").
      approach_name          TEXT,
      approach_runway        TEXT,
      approach_transition    TEXT,
      approach_type          TEXT,     -- e.g. 'CUSTOM'; says whether the name means anything
      approach_arinc         TEXT,
      approach_suffix        TEXT,
      approach_transition_type TEXT,
      -- The three Custom* values. CustomOffsetAngle is written by real Little
      -- Navmap and appears NOWHERE in the official XSD.
      approach_custom_distance_nm REAL,
      approach_custom_altitude_ft REAL,
      approach_custom_offset_deg  REAL,

      waypoint_count         INTEGER NOT NULL DEFAULT 0,
      alternate_count        INTEGER NOT NULL DEFAULT 0,
      -- Great-circle sum over the en-route waypoint chain only. Named "approx"
      -- because SID/STAR/approach legs are absent from the file, so this is
      -- always short of the real routing — never render without an "approx."
      -- qualifier.
      approx_distance_nm     REAL    NOT NULL DEFAULT 0,
      -- Written at landing on both the 'flown' and the 'diverted' path.
      arrival_deviation_nm   REAL,

      remarks                TEXT,
      -- CreationDate normalised to a full ISO instant (the file writes a
      -- two-digit UTC offset, e.g. +02, which Date parses inconsistently).
      plan_created_at        TEXT,

      -- Provenance. The uploaded bytes are not kept; these three columns plus
      -- the import log are what makes a mis-parse reproducible from the
      -- user's own file.
      source_filename        TEXT    NOT NULL,
      source_sha256          TEXT    NOT NULL,
      source_program         TEXT,
      imported_at            TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS planned_waypoints (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      planned_leg_id    INTEGER NOT NULL REFERENCES planned_legs(id) ON DELETE CASCADE,
      -- 1-based document order across every <Waypoints> block in the file
      seq               INTEGER NOT NULL,
      ident             TEXT    NOT NULL,
      name              TEXT,
      region            TEXT,
      airway            TEXT,
      track             TEXT,
      -- AIRPORT | UNKNOWN | WAYPOINT | VOR | NDB | USER, or an unrecognised
      -- value passed through verbatim. Only AIRPORT is behaviourally significant.
      type              TEXT    NOT NULL,
      comment           TEXT,
      lat               REAL    NOT NULL,
      lon               REAL    NOT NULL,
      -- Pos/@Alt is optional in the format, and where present it is Little
      -- Navmap's COMPUTED profile altitude, not a planned constraint. Store
      -- it, never present it as planned.
      alt_ft            REAL
    );

    CREATE TABLE IF NOT EXISTS planned_alternates (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      planned_leg_id    INTEGER NOT NULL REFERENCES planned_legs(id) ON DELETE CASCADE,
      seq               INTEGER NOT NULL,
      ident             TEXT    NOT NULL,
      name              TEXT,
      type              TEXT,
      -- Nullable, unlike planned_waypoints: <Alternate><Pos> is optional in the XSD
      lat               REAL,
      lon               REAL,
      alt_ft            REAL
    );

    CREATE INDEX IF NOT EXISTS idx_planned_legs_trip       ON planned_legs(trip_id, seq);
    CREATE INDEX IF NOT EXISTS idx_planned_legs_source     ON planned_legs(trip_id, source_sha256);
    CREATE INDEX IF NOT EXISTS idx_planned_waypoints_leg   ON planned_waypoints(planned_leg_id, seq);
    CREATE INDEX IF NOT EXISTS idx_planned_alternates_leg  ON planned_alternates(planned_leg_id, seq);

    -- Datalink-style messages for one flight, or for the planned leg a flight
    -- has not been created for yet (a PDC or a dispatch release arrives before
    -- pushback, when no flights row exists). Exactly one of flight_id and
    -- planned_leg_id is normally set; both may be set by a writer that knows
    -- both. A row with neither is unreachable and is refused above the
    -- database, in src/db/acarsMessages.ts.
    CREATE TABLE IF NOT EXISTS acars_messages (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Nullable on purpose: startFlight() does not insert a flights row until
      -- the flight begins, and pre-pushback messages have to land somewhere.
      -- CASCADE matches flight_points: deleting a flight deletes its thread.
      flight_id      INTEGER REFERENCES flights(id) ON DELETE CASCADE,
      -- The pre-flight scope. A thread read for a flight also returns the rows
      -- carrying that flight's planned_leg_id, so a clearance issued before
      -- departure shows up in the flight's thread once the link exists.
      planned_leg_id INTEGER REFERENCES planned_legs(id) ON DELETE CASCADE,
      -- 'uplink' (from dispatch to the aircraft) | 'downlink' (from the
      -- cockpit). No CHECK: validated in src/acars.ts, so a future direction
      -- needs no migration.
      direction      TEXT    NOT NULL,
      -- 'pdc' | 'wx' | 'freetext' | 'position-report' | 'dispatch' | 'oooi' |
      -- whatever a later story needs. Deliberately NOT a CHECK constraint: the
      -- position-report feature already needs 'oooi', which the five categories
      -- this table was first specified with do not include, and a CHECK cannot
      -- be widened without rewriting the table.
      category       TEXT    NOT NULL,
      -- Short display heading, e.g. 'PDC', 'METAR EGLL', 'OUT'. NULL renders as
      -- the category.
      label          TEXT,
      -- The message as the crew reads it. Newlines are significant and are
      -- never collapsed on the way in.
      body           TEXT    NOT NULL,
      -- Optional machine-readable twin of body: the loadsheet's fixed fields, a
      -- position report's lat/lon/alt. Opaque JSON text, owned entirely by the
      -- writing feature; no column of this table is derived from it.
      payload_json   TEXT,
      -- The request this row replies to (weather and loadsheet are both
      -- request/reply). SET NULL, not CASCADE: deleting a request must not
      -- silently delete the answer the user already read.
      correlation_id INTEGER REFERENCES acars_messages(id) ON DELETE SET NULL,
      -- Idempotency for writers that must not issue twice: 'pdc:leg:29',
      -- 'oooi:81:OUT', 'dispatch:ofp:<request_id>'. Free-form and owned by the
      -- writer; NULL for everything that may legitimately repeat.
      dedup_key      TEXT,
      -- ISO 8601 UTC instant, real wall-clock, as new Date().toISOString() —
      -- the same clock and format as flights.start_time and flight_points.ts.
      -- There is no sim clock to record: SimFrame carries no sim time.
      sent_at        TEXT    NOT NULL,
      -- NULL means unread. Nothing writes it yet; the column exists so an
      -- unread affordance does not need a migration.
      read_at        TEXT
    );

    -- Covers both halves of the thread read, including its ORDER BY.
    CREATE INDEX IF NOT EXISTS idx_acars_messages_flight ON acars_messages(flight_id, sent_at, id);
    CREATE INDEX IF NOT EXISTS idx_acars_messages_leg    ON acars_messages(planned_leg_id, sent_at, id);
    -- Partial, in the same spirit as idx_flights_planned_leg: it turns "a PDC is
    -- issued once per leg" into a database guarantee while leaving every
    -- ordinary message (dedup_key IS NULL) free to repeat.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_acars_messages_dedup
      ON acars_messages(dedup_key) WHERE dedup_key IS NOT NULL;

    -- One pre-flight / on-ground session: the aircraft parked somewhere with an
    -- airport and (sometimes) a stand, from before pushback. Exists so ACARS
    -- dispatch and load-sheet actions have real context before a flights row
    -- does — flights is written at rotation and cannot answer "where am I
    -- parked right now".
    --
    -- Rows are never deleted by the app and never repurposed: a closed session
    -- is the historical record of a pre-flight, and ended_reason says how it
    -- ended.
    CREATE TABLE IF NOT EXISTS ground_sessions (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Who created the row: 'auto' (the ground-state machine, from telemetry)
      -- or 'manual' (the operator typed it). Never rewritten after insert —
      -- an automatic session adopting operator-entered detail stays 'manual'
      -- and vice versa; the per-field *_source columns below carry the finer
      -- grain.
      source                  TEXT    NOT NULL CHECK (source IN ('auto', 'manual')),
      -- findNearestAirport()'s answer at entry, or the operator's ICAO.
      -- Nullable: a cold-and-dark spawn more than 10 nm from any known field
      -- is still a real ground session, and leaving the row to exist is what
      -- gives the manual fallback something to correct.
      airport_icao            TEXT,
      -- Only the automatic path can fill this: the manual endpoint has no
      -- ICAO -> name lookup (src/airports.ts exposes none) and must not invent
      -- one.
      airport_name            TEXT,
      -- The AIRCRAFT's position at entry, not the airport reference point —
      -- it is the more precise fact, it is what the re-anchor rule measures
      -- against, and findNearestAirport() does not return airport coordinates.
      lat                     REAL,
      lon                     REAL,
      -- Free text as the pilot would say it: 'Stand 231', 'GATE A12', 'Ramp 4'.
      -- No SimVar publishes the parking spot's name, so the automatic path can
      -- only fill this from a matched planned leg's departure_start.
      parking_position        TEXT,
      parking_position_source TEXT    CHECK (parking_position_source IN ('auto', 'manual')),
      -- The planned leg this session is about, matched by matchPlannedLeg()
      -- or named by the operator. SET NULL, not CASCADE: deleting a leg must
      -- not delete the record that the aircraft sat at a gate.
      planned_leg_id          INTEGER REFERENCES planned_legs(id) ON DELETE SET NULL,
      planned_leg_link_source TEXT    CHECK (planned_leg_link_source IN ('auto', 'manual')),
      -- SimFrame.aircraft at entry. NULL on a manual session created with no
      -- agent connected.
      aircraft                TEXT,
      -- ISO 8601 UTC instants, new Date().toISOString() — the same clock and
      -- format as flights.start_time and acars_messages.sent_at.
      started_at              TEXT    NOT NULL,
      -- NULL means open. At most one row may hold NULL; see the partial UNIQUE
      -- index below.
      ended_at                TEXT,
      -- 'flight-started' | 'sim-exit' | 'crash' | 'slew' | 'superseded' |
      -- 'corrected' | 'manual'. Deliberately NOT a CHECK constraint, for the
      -- reason acars_messages.category is not one: a later reason must not
      -- need a table rewrite.
      ended_reason            TEXT,
      -- Set when the session ended because this flight started. SET NULL so
      -- deleting a flight leaves the pre-flight record standing.
      flight_id               INTEGER REFERENCES flights(id) ON DELETE SET NULL,
      created_at              TEXT    NOT NULL,
      updated_at              TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ground_sessions_started ON ground_sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_ground_sessions_leg     ON ground_sessions(planned_leg_id);
    -- "At most one open ground session" as a database guarantee, in the same
    -- spirit as idx_trips_active. The expression is not decoration: SQLite
    -- treats NULLs in a UNIQUE index as distinct, so UNIQUE(ended_at) would
    -- constrain nothing at all. ended_at IS NULL evaluates to the non-null
    -- integer 1 for every row the partial index covers, and uniqueness over
    -- that single value is exactly the invariant. A SQLITE_CONSTRAINT here
    -- means a caller opened a session without closing the previous one — fix
    -- the caller, never the index.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ground_sessions_open
      ON ground_sessions(ended_at IS NULL) WHERE ended_at IS NULL;

    -- The single operator account. id is pinned to 1 by a CHECK so a second
    -- account cannot be inserted by accident — the app supports exactly one
    -- operator. Written only by the set-password CLI (src/setPassword.ts).
    CREATE TABLE IF NOT EXISTS auth_user (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      username      TEXT NOT NULL,
      -- scrypt$N$r$p$<salt-b64>$<key-b64> — encoding frozen, do not change
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    -- express-session store backing table. data is the JSON-serialised
    -- session; expires_at is epoch milliseconds, so the sweep is an integer
    -- comparison and needs no date parsing.
    CREATE TABLE IF NOT EXISTS auth_session (
      sid        TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_auth_session_expires ON auth_session(expires_at);

    -- Server-side secrets that the operator does not have to manage. Currently
    -- one row: name='session_secret'. Values are base64 of 32 random bytes.
    CREATE TABLE IF NOT EXISTS app_secret (
      name       TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Operator-editable settings, entered through the UI and read by the
    -- server. Deliberately separate from app_secret, which holds values the
    -- server generates and the operator never sees: a DELETE-by-name bug here
    -- must not be able to log everyone out, and a future "show me the
    -- settings" endpoint must not be one SELECT * away from the session
    -- secret. One row here IS a credential — sayintentions_api_key, the
    -- operator's own SayIntentions pilot key — so no route may return an
    -- app_setting value without knowing which name it is reading (see
    -- /api/settings/sayintentions, which returns only a masked form).
    CREATE TABLE IF NOT EXISTS app_setting (
      name       TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- One msfslogger flight bound to whatever SayIntentions session the
    -- operator's key held at the moment they pressed LINK. PRIMARY KEY, not
    -- just a FK: one flight has at most one SayIntentions link, a database
    -- guarantee rather than a convention, the same way idx_flights_planned_leg
    -- makes the leg link one. CASCADE matches acars_messages: deleting a
    -- flight deletes its link and its imported thread together, leaving no
    -- orphan cursor behind.
    CREATE TABLE IF NOT EXISTS sayintentions_links (
      flight_id          INTEGER PRIMARY KEY REFERENCES flights(id) ON DELETE CASCADE,
      -- SayIntentions' own flight/session id as seen at link time, stored as
      -- TEXT because their JSON is not documented to be a number and a string
      -- compares the same either way. NULL when the response carried none.
      upstream_flight_id TEXT,
      -- The polling cursor: the highest comm_history[].id already imported.
      -- NULL before the first import, meaning "send no since_id at all".
      since_id           INTEGER,
      -- The highest comm_history[].id that existed when the link was made, so
      -- ?from=now can start the cursor there and an operator can see how much
      -- history predates the link. 0 when the session had no comms yet.
      baseline_comm_id   INTEGER NOT NULL DEFAULT 0,
      -- ISO 8601 UTC, same clock and format as flights.start_time and
      -- acars_messages.sent_at.
      linked_at          TEXT    NOT NULL,
      last_import_at     TEXT,
      -- Cumulative acars_messages rows this link has written. Display only;
      -- nothing branches on it.
      imported_count     INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Migrate existing DBs that predate the notes and trip_id columns
  const cols = (db.prepare('PRAGMA table_info(flights)').all() as { name: string }[]).map(c => c.name);
  if (!cols.includes('notes')) {
    db.exec('ALTER TABLE flights ADD COLUMN notes TEXT');
  }
  if (!cols.includes('trip_id')) {
    db.exec('ALTER TABLE flights ADD COLUMN trip_id INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS idx_flights_trip ON flights(trip_id)');
  }
  if (!cols.includes('departure_icao')) {
    db.exec('ALTER TABLE flights ADD COLUMN departure_icao TEXT');
  }
  if (!cols.includes('departure_name')) {
    db.exec('ALTER TABLE flights ADD COLUMN departure_name TEXT');
  }
  if (!cols.includes('arrival_icao')) {
    db.exec('ALTER TABLE flights ADD COLUMN arrival_icao TEXT');
  }
  if (!cols.includes('arrival_name')) {
    db.exec('ALTER TABLE flights ADD COLUMN arrival_name TEXT');
  }
  if (!cols.includes('flight_plan_name')) {
    db.exec('ALTER TABLE flights ADD COLUMN flight_plan_name TEXT');
  }

  // Planned-leg link columns on flights. ADD COLUMN ... REFERENCES requires a
  // NULL default, which is why planned_leg_id has none.
  if (!cols.includes('planned_leg_id')) {
    db.exec('ALTER TABLE flights ADD COLUMN planned_leg_id INTEGER REFERENCES planned_legs(id) ON DELETE SET NULL');
  }
  if (!cols.includes('planned_leg_link_source')) {
    db.exec("ALTER TABLE flights ADD COLUMN planned_leg_link_source TEXT"); // 'auto' | 'manual' | NULL
  }
  if (!cols.includes('planned_leg_prev_trip_id')) {
    db.exec('ALTER TABLE flights ADD COLUMN planned_leg_prev_trip_id INTEGER'); // trip_id held immediately before the link
  }

  // The first point written after a pause, slew or resume is flagged so the
  // resume replay can skip the outage gap that ends at it.
  const pointCols = (db.prepare('PRAGMA table_info(flight_points)').all() as { name: string }[]).map(c => c.name);
  if (!pointCols.includes('after_interruption')) {
    db.exec('ALTER TABLE flight_points ADD COLUMN after_interruption INTEGER NOT NULL DEFAULT 0');
  }

  const tripCols = (db.prepare('PRAGMA table_info(trips)').all() as { name: string }[]).map(c => c.name);
  if (!tripCols.includes('is_active')) {
    db.exec('ALTER TABLE trips ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0');
  }

  // Last planned_legs statement in this function, deliberately: any future
  // ALTER TABLE planned_legs ADD COLUMN migration must be placed after this
  // call, never before it (see the function's own comment for why).
  migratePlannedLegsTripIdNullable(db);

  // User intent for the navdata replica: a facility a manual request asked
  // for, kept until the replica can answer it or expires_at passes. Holds no
  // navdata content. region is nullable, so the unique index does not stop
  // two NULL-region duplicates; the writer upserts explicitly.
  db.exec(`
    CREATE TABLE IF NOT EXISTS navdata_requests (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      kind         TEXT NOT NULL CHECK (kind IN ('A','W')),
      ident        TEXT NOT NULL,
      region       TEXT,
      requested_at TEXT NOT NULL,
      expires_at   TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_navdata_requests_key
      ON navdata_requests (kind, ident, region);
  `);

  // Unconditional and idempotent: an index can be missing even when its column
  // exists. Both are partial UNIQUE indexes, and the code relies on them: they
  // turn a convention into a database guarantee. A SQLITE_CONSTRAINT from either means
  // the caller's statement order is wrong; fix the order, never the index.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_flights_planned_leg ON flights(planned_leg_id) WHERE planned_leg_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trips_active        ON trips(is_active)        WHERE is_active = 1;
  `);

  // Ingest credentials created on the Settings page. Only the SHA-256 digest of
  // the secret is stored; the plaintext exists once, in the create response.
  // public_id is a separate random value, never derived from the secret, so a
  // listing reveals nothing about any token. A revoked row is kept (revoked_at
  // set), never deleted.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ingest_tokens (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id    TEXT    NOT NULL UNIQUE,
      token_digest BLOB    NOT NULL UNIQUE CHECK (length(token_digest) = 32),
      label        TEXT    NOT NULL,
      created_at   TEXT    NOT NULL,
      last_used_at TEXT,
      revoked_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ingest_tokens_active ON ingest_tokens(id) WHERE revoked_at IS NULL;

    -- Same shape, deliberately a separate table: an MCP token and an ingest token
    -- must never be able to authenticate each other's endpoint.
    CREATE TABLE IF NOT EXISTS mcp_tokens (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id    TEXT    NOT NULL UNIQUE,
      token_digest BLOB    NOT NULL UNIQUE CHECK (length(token_digest) = 32),
      label        TEXT    NOT NULL,
      created_at   TEXT    NOT NULL,
      last_used_at TEXT,
      revoked_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_tokens_active ON mcp_tokens(id) WHERE revoked_at IS NULL;
  `);
}
