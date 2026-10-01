# Data model

Sabiá stores everything in a single SQLite database file (`better-sqlite3`,
WAL journal mode, foreign keys enforced), opened by `src/db/connection.ts` and
schema-managed by `src/db/schema.ts` (`CREATE TABLE IF NOT EXISTS` plus
idempotent `ALTER TABLE` migrations run on every startup — there is no
separate migration-runner or migration-file directory).

Path: `FLIGHTS_DB_PATH` env var, default `./flights.db` (relative to the
process's working directory). See [configuration.md](configuration.md).

## Entity overview

```
trips (1) ──── (N) flights            [flights.trip_id, no FK constraint]
trips (1) ──── (N) planned_legs       [planned_legs.trip_id, ON DELETE CASCADE]
planned_legs (1) ── (N) planned_waypoints   [ON DELETE CASCADE]
planned_legs (1) ── (N) planned_alternates  [ON DELETE CASCADE]
planned_legs (0..1) ── (0..1) flights        [flights.planned_leg_id, unique, ON DELETE SET NULL]
flights (1) ──── (N) flight_points    [ON DELETE CASCADE]
flights (1) ──── (N) acars_messages   [nullable FK, ON DELETE CASCADE]
planned_legs (1) ── (N) acars_messages [nullable FK, ON DELETE CASCADE]
ground_sessions ── flights            [flight_id, nullable, ON DELETE SET NULL]
ground_sessions ── planned_legs       [planned_leg_id, nullable, ON DELETE SET NULL]
flights (1) ── (0..1) sayintentions_links  [flight_id, PK, ON DELETE CASCADE]
```

A message needs at least one of `flight_id`/`planned_leg_id` (enforced in
`src/db/acarsMessages.ts`, not a database `CHECK`). `flights.trip_id` is a
plain integer column with no `REFERENCES` clause — trip membership is managed
entirely in application code (`src/db/trips.ts`).

## Tables

### `flights`

One row per recorded flight (in progress or completed).

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `aircraft` | TEXT | |
| `departure_lat`, `departure_lon` | REAL | |
| `arrival_lat`, `arrival_lon` | REAL | |
| `start_time` | TEXT NOT NULL | ISO 8601 |
| `end_time` | TEXT | NULL while in progress |
| `duration_sec` | INTEGER | excludes pauses/interruptions — see [architecture.md](architecture.md#flight-state-machine) |
| `distance_nm` | REAL | |
| `max_altitude_ft`, `max_airspeed_kts` | REAL | |
| `point_count` | INTEGER | |
| `notes` | TEXT | operator-editable |
| `departure_icao`, `departure_name`, `arrival_icao`, `arrival_name` | TEXT | resolved via nearest-airport lookup |
| `flight_plan_name` | TEXT | filename of an attached PDF flight plan |
| `trip_id` | INTEGER | loose reference, no FK constraint |
| `planned_leg_id` | INTEGER REFERENCES `planned_legs(id)` ON DELETE SET NULL | unique (one flight per leg) |
| `planned_leg_link_source` | TEXT | `'auto'` \| `'manual'` \| NULL |
| `planned_leg_prev_trip_id` | INTEGER | trip held before a leg-link moved the flight; restored on unlink |

### `flight_points`

Track log — one row per recorded telemetry sample.

| Column | Type |
|---|---|
| `id` | INTEGER PK |
| `flight_id` | INTEGER NOT NULL → `flights(id)` ON DELETE CASCADE |
| `ts` | TEXT NOT NULL |
| `lat`, `lon` | REAL NOT NULL |
| `altitude_ft`, `airspeed_kts`, `ground_speed_kts`, `heading_deg`, `vertical_speed_fpm` | REAL NOT NULL |
| `on_ground` | INTEGER NOT NULL (0/1) |
| `after_interruption` | INTEGER NOT NULL DEFAULT 0 (0/1) |

`after_interruption` is 1 on the first point stored after a pause, a slew or
a resume after a server restart. When a flight is resumed, the gap that ends at
a flagged point is not counted toward its duration (see
[architecture.md § Flight state machine](architecture.md#flight-state-machine)).
The column was added in place by a migration in `applySchema`, so points
recorded before it existed read 0. It is internal: the flight and trip
endpoints select an explicit column list that leaves it out.

### `trips`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `name` | TEXT NOT NULL | |
| `notes` | TEXT | |
| `created_at` | TEXT NOT NULL | |
| `is_active` | INTEGER NOT NULL DEFAULT 0 | at most one row may be active (partial unique index) |

### `planned_legs`

A route leg imported from `.lnmpln` or SimBrief, before (or instead of) being
flown.

| Column group | Notes |
|---|---|
| `id`, `trip_id` (nullable = loose leg), `seq` | identity/ordering |
| `status` | `'planned'` \| `'flown'` \| `'diverted'` \| `'skipped'` — CHECK-constrained. No `'linked'` status; linkage is derived from `flights.planned_leg_id`. |
| `departure_ident`, `departure_name`, `departure_lat`, `departure_lon`, `departure_is_airport` | first waypoint |
| `departure_start`, `departure_start_type`, `departure_pos_lat`, `departure_pos_lon` | parking spot, display-only |
| `destination_ident`, `destination_name`, `destination_lat`, `destination_lon`, `destination_is_airport` | last waypoint |
| `is_snippet` | route fragment, not full airport-to-airport |
| `cruise_alt_ft`, `flightplan_type`, `aircraft_type` | |
| `sid_*` (5 cols), `star_*` (3 cols), `approach_*` (10 cols) | procedures flattened; no per-procedure waypoints stored |
| `waypoint_count`, `alternate_count`, `approx_distance_nm` | `approx_distance_nm` sums en-route waypoints only, excluding SID/STAR/approach |
| `arrival_deviation_nm` | written at landing, for both `'flown'` and `'diverted'` outcomes |
| `remarks`, `plan_created_at` | |
| `source_filename`, `source_sha256`, `source_program`, `imported_at` | provenance; raw file bytes are not retained |

### `planned_waypoints` / `planned_alternates`

En-route waypoints and alternate airports for a planned leg.

| Column | `planned_waypoints` | `planned_alternates` |
|---|---|---|
| `id`, `planned_leg_id` (→ `planned_legs`, ON DELETE CASCADE), `seq` | ✓ | ✓ |
| `ident`, `name`, `type` | ✓ | ✓ |
| `region`, `airway`, `track`, `comment` | ✓ | — |
| `lat`, `lon` | NOT NULL | nullable (optional in source format) |
| `alt_ft` | computed profile altitude | — |

### `acars_messages`

Datalink thread, scoped to a flight and/or a planned leg (at least one
required).

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `flight_id` | → `flights(id)` ON DELETE CASCADE | nullable — pre-pushback messages have no flight yet |
| `planned_leg_id` | → `planned_legs(id)` ON DELETE CASCADE | nullable |
| `direction` | TEXT NOT NULL | `'uplink'` / `'downlink'` |
| `category` | TEXT NOT NULL | `'pdc'`, `'wx'`, `'freetext'`, `'position-report'`, `'dispatch'`, `'oooi'` — the *known/styled* set (`KNOWN_ACARS_CATEGORIES`, `src/acars.ts`), each with a client badge class. The column itself accepts any lower-kebab string up to 32 characters (`isValidAcarsCategory`'s shape check, not a `CHECK` constraint) — e.g. `'atc'`, written by the SayIntentions import (below), which renders through the client's generic fallback badge rather than a dedicated one |
| `label` | TEXT | display heading |
| `body` | TEXT NOT NULL | |
| `payload_json` | TEXT | opaque machine-readable twin |
| `correlation_id` | → `acars_messages(id)` ON DELETE SET NULL | request/reply link |
| `dedup_key` | TEXT | idempotency key; unique where non-null |
| `sent_at` | TEXT NOT NULL | |
| `read_at` | TEXT | unused — no writer sets this yet |

### `sayintentions_links`

At most one row per flight, binding it to a SayIntentions.AI session for the
optional pull/import feature (see [architecture.md](architecture.md#external-integration-points)
and [api.md](api.md#sayintentions--srcroutessayintentionsts)). Created by the
operator explicitly (there is no automatic linking); never populated for a
flight that hasn't been linked.

| Column | Type | Notes |
|---|---|---|
| `flight_id` | INTEGER PK → `flights(id)` ON DELETE CASCADE | one row per flight, at most |
| `upstream_flight_id` | TEXT | SayIntentions' own session id at link time, stored as text since their JSON shape isn't documented to be numeric; NULL if the response carried none |
| `since_id` | INTEGER | import cursor — the highest `comm_history[].id` already imported; NULL before the first import (send no `since_id` at all) |
| `baseline_comm_id` | INTEGER NOT NULL DEFAULT 0 | highest upstream id that existed at link time, so `?from=now` can start the cursor there |
| `linked_at` | TEXT NOT NULL | ISO 8601 UTC |
| `last_import_at` | TEXT | NULL until the first successful import |
| `imported_count` | INTEGER NOT NULL DEFAULT 0 | cumulative rows written by this link; display only, nothing branches on it |

### `ground_sessions`

A record of being parked/taxiing at an airport, before a `flights` row
exists. Never deleted by the application.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `source` | TEXT NOT NULL CHECK (`'auto'` \| `'manual'`) | fixed at insert |
| `airport_icao`, `airport_name`, `lat`, `lon` | nullable | |
| `parking_position`, `parking_position_source` | TEXT | free text; source CHECK (`'auto'` \| `'manual'`) |
| `planned_leg_id` | → `planned_legs(id)` ON DELETE SET NULL | |
| `planned_leg_link_source` | TEXT CHECK (`'auto'` \| `'manual'`) | |
| `aircraft` | TEXT | |
| `started_at` | TEXT NOT NULL | |
| `ended_at` | TEXT | NULL = open; at most one open row (partial unique index) |
| `ended_reason` | TEXT | `'flight-started'` \| `'sim-exit'` \| `'crash'` \| `'slew'` \| `'superseded'` \| `'corrected'` \| `'manual'` |
| `flight_id` | → `flights(id)` ON DELETE SET NULL | set when the session ended because a flight started |
| `created_at`, `updated_at` | TEXT NOT NULL | |

### `auth_user`

Single operator account — `id` pinned to `1` via `CHECK (id = 1)`. Columns:
`id`, `username`, `password_hash` (`scrypt$N$r$p$<salt>$<key>`), `created_at`,
`updated_at`. Created by `npm run set-password` (see
[operations.md](operations.md)); the password can later be changed by that
command or on the Settings page (`POST /api/settings/password`).

### `auth_session`

`express-session` store backing the web UI's login cookie: `sid` TEXT PK,
`data` TEXT NOT NULL (JSON), `expires_at` INTEGER NOT NULL (epoch ms). Swept
periodically by the server (see [operations.md](operations.md)).

### `app_secret` / `app_setting`

Two small key-value tables: `app_secret` holds server-generated secrets (e.g.
a session secret, when `SESSION_SECRET` isn't set); `app_setting` holds
operator-editable settings (the SimBrief pilot ID under key
`simbrief_user_id`, and the SayIntentions API key under
`sayintentions_api_key`). Both are `name` (TEXT PK) / `value` (TEXT NOT NULL) plus
a timestamp.

### `ingest_tokens` / `mcp_tokens`

Credentials created on the Settings page (see
[configuration.md](configuration.md#tokens-created-on-the-settings-page)).
Same columns in both, deliberately two tables so an ingest token and an MCP
token can never authenticate each other's endpoint:

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | used in the revoke route's path |
| `public_id` | TEXT NOT NULL UNIQUE | 8 random hex chars shown in the list — not derived from the secret |
| `token_digest` | BLOB NOT NULL UNIQUE, `CHECK (length(token_digest) = 32)` | SHA-256 of the secret; the secret itself is never stored |
| `label` | TEXT NOT NULL | operator-chosen, 1–64 chars |
| `created_at` | TEXT NOT NULL | ISO-8601 |
| `last_used_at` | TEXT | NULL = never used; updated at most once a minute |
| `revoked_at` | TEXT | NULL = active. Revoked rows are kept, never deleted or reactivated |

A partial index on `id WHERE revoked_at IS NULL` (`idx_ingest_tokens_active`,
`idx_mcp_tokens_active`) serves the per-request lookup. Access is in
`src/db/ingestTokens.ts` and `src/db/mcpTokens.ts`, which share no code.

### `navdata_requests`

Manual "fetch detail" requests from the map (`POST /api/navdata/request`),
remembered until the sidecar's next demand poll. Lives in `flights.db`, not in
`navdata.db`, so replacing the replica cannot wipe a pending request. Rows
expire after 7 days (`NAVDATA_REQUEST_TTL_MS`) and are deleted once the replica
holds the answer. Added additively with `CREATE TABLE IF NOT EXISTS`; access is
in `src/db/navdataRequests.ts`.

The navdata replica itself is a separate SQLite file with its own 13-table schema
(`nav_*`); see [navdata.md](navdata.md). It is never part of `flights.db`.

## CRUD modules

Each table has a matching module under `src/db/` exposing typed functions —
application code never writes raw SQL outside `src/db/`:

| Module | Owns |
|---|---|
| `connection.ts` | The shared `better-sqlite3` handle: `initDb()`, `getDb()`, `closeDb()` (checkpoints WAL on close). |
| `flights.ts` | `insertFlight`, `closeFlight`, `updateFlight`, `insertPoint`, `getFlights`/`getFlightById`, `deleteFlight`, `combineFlights`, flight-plan filename helpers. |
| `trips.ts` | `createTrip`, `getTrips`/`getTripById`, `updateTrip`, `deleteTrip`, `assignFlightToTrip`/`removeFlightFromTrip`. |
| `plannedLegs.ts` | `createPlannedLeg` (leg + waypoints + alternates, atomic), leg reads/reorder/status, leg↔flight linking, active-trip get/set. |
| `groundSessions.ts` | Open/close/list a ground session, gap-filling and the manual-entry precedence rules. |
| `acarsMessages.ts` | Insert (with dedup-key upsert), list by flight or by planned leg. |
| `sayIntentionsLinks.ts` | Get/upsert/delete a flight's SayIntentions link row, advance its import cursor. |
| `settings.ts` | Auth user, app secrets, app settings, and the `auth_session` store's own get/set/destroy/sweep. |

## Flight state machine → data model

Flight rows and their track points are created by the flight state machine
(`src/flightManager.ts` and its collaborators in `src/flight/`) as a flight
is detected. The one client request that creates them is "Combine flights"
(`POST /api/flights/combine`), which merges two finished flights into a new
row. Ground-session rows also come from the operator's manual entry. See
[architecture.md § Flight state machine](architecture.md#flight-state-machine)
for the full IDLE → GROUND → FLYING transition logic, pause/duration
accounting, and how leg matching decides `planned_leg_id`.
