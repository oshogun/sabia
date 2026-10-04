# Glossary

Domain terms used throughout this documentation and in the codebase's own
identifiers (table names, route names, variable names).

| Term | Meaning |
|---|---|
| **Flight** | One continuous, recorded period of flying — from takeoff debounce to landing debounce. Stored as one row in the `flights` table plus its `flight_points` track. |
| **Trip** | A named collection of flights and/or planned legs, e.g. a multi-leg journey. At most one trip can be the **active trip** at a time. |
| **Planned leg** | A single route (departure → destination, with waypoints/procedures) imported from a `.lnmpln` file or a SimBrief OFP, before it is flown. Belongs to a trip, or is "loose" (`trip_id IS NULL`). |
| **Loose leg** | A planned leg with no `trip_id` — imported ahead of assigning it to a trip. |
| **Leg link / linking** | The association between a flown `flights` row and the `planned_legs` row it satisfies, recorded in `flights.planned_leg_id`. Created either **automatically** at takeoff (see leg matching) or **manually** by the operator. |
| **Ghost row** | The web UI's term for a planned leg with no linked flight yet — rendered alongside real flight rows in trip/prefile lists. |
| **Leg matching** | The deterministic algorithm (`src/legMatcher.ts`) that finds the one planned leg a takeoff corresponds to, based on distance from the departure position and leg eligibility. See [architecture.md](architecture.md#leg-matching-and-closing). |
| **Ground session** | A record of the aircraft parked/taxiing at an airport before (or between) flights — `ground_sessions` table. Created automatically on debounce, or manually by the operator. |
| **`.lnmpln`** | Little Navmap's native flight-plan XML format. The source format for imported planned legs (`src/lnmpln.ts` parses it). |
| **SimBrief / OFP** | [SimBrief](https://www.simbrief.com/) is a third-party flight-dispatch planning service. An **OFP** (Operational Flight Plan) is the dispatch package it produces (route, fuel, weights); Sabiá can import one directly by pilot ID. |
| **ACARS** | Aircraft Communications Addressing and Reporting System — the real-world datalink protocol this app's `acars_messages` feature is modeled on. Used here for canned uplink/downlink messages, weather requests, load sheets, and PDC. |
| **OOOI** | Out / Off / On / In — the four real-world timestamp events marking pushback, takeoff, landing, and arrival at the gate. Filed automatically as ACARS messages by the flight state machine. |
| **PDC** | Pre-Departure Clearance — an ACARS message type generated from on-file dispatch data. |
| **Position report** | A periodic ACARS message filed automatically while flying a linked planned leg (interval configurable via `POSITION_REPORT_INTERVAL_MIN`). |
| **SayIntentions.AI** | A third-party AI-ATC/CPDLC service for flight simulators. Sabiá has an optional, default-off integration with its pilot-key API: importing its comms transcript into a flight's ACARS thread, and sending an on-file PDC into a pilot's live SayIntentions session. See [api.md § SayIntentions](api.md#sayintentions--srcroutessayintentionsts). |
| **Ingest** | The one-way data path from the MCDU client's SimConnect sidecar into the server: `POST /api/ingest/frame`, `/event`, `/traffic`. Authenticated by ingest token, not a session. |
| **Ingest token** | The secret the MCDU client (and any other non-browser client) presents on the `x-ingest-token` header instead of a session cookie: one created on the Settings page (`sbi_…`), or `INGEST_TOKEN` when none exists. See [configuration.md](configuration.md#tokens-created-on-the-settings-page) and [security.md](security.md). |
| **MCP** | Model Context Protocol — the open protocol an AI client (e.g. Claude Desktop/Code) uses to call tools exposed by a server. Sabiá optionally serves one at `/mcp`, gated by its own bearer credential (an MCP token created on the Settings page, or `MCP_TOKEN`), exposing 18 read/write tools over the logbook. See [api.md § MCP server](api.md#mcp-server--srcmcp). |
| **Frame** | One telemetry sample from SimConnect: position, altitude, airspeed, heading, on-ground flag, etc. The MCDU client posts one roughly every second. |
| **SimConnect** | Microsoft's local API for MSFS/FSX addons to read simulator state. Used only by the MCDU client's sidecar on the Windows PC, never by the server directly. |
| **Operator** | The single administrative user of a self-hosted Sabiá instance. There is exactly one account (`auth_user`, `id = 1`); this project has no multi-user/multi-tenant model. |
| **Hold (sim silence)** | The up-to-3-minute window in which a flight stays open after the simulator's data stops arriving (no frame for 10 s, or the client's `disconnected` event). Data from the same aircraft and place continues the flight; otherwise it is closed at the last frame received. See [architecture.md](architecture.md#flight-state-machine). |
| **Combine (flights)** | Merging two `flights` rows into one, used when one real flight was logged as two, for example because the simulator's data stopped for longer than the hold. See `combineFlights()` in [data-model.md](data-model.md). |
| **Backfill** | An operator-run maintenance script (`npm run backfill-icao`, `npm run backfill-durations`) that recomputes derived columns on existing rows after a behavior change. See [operations.md](operations.md). |
| **Navdata** | Navigation data (airports, navaids, fixes, airways, runways, procedures) shown on the maps: either extracted by the MCDU client and replicated here, or imported from a Little Navmap database. One source is shown at a time. See [navdata.md](navdata.md). |
| **Little Navmap import** | Building `navdata.db.lnm` from a Little Navmap (atools) `.sqlite` file — Navigraph's (`NAVIGRAPH`, with an AIRAC cycle) or one Little Navmap compiled from the simulator's scenery (`MSFS`/`MSFS24`). See [navdata.md § Little Navmap import](navdata.md#little-navmap-import). |
| **Selected / effective navdata source** | The source stored in Settings (`mcdu` or `lnm`) versus the one actually shown: Little Navmap selected but its file missing shows simulator data (`sourceFallback: lnm-unavailable`). |
| **AIRAC cycle / expired** | The 28-day aeronautical data cycle a Navigraph file belongs to; the dataset counts as expired from 00:00 UTC on the day after its valid-through date, and the map then warns it is not for navigation. |
| **Replica / epoch (`snapshotId`)** | `navdata.db` is a rebuildable copy of the sidecar's store; an epoch is one bulk extraction, and a snapshot of a new epoch replaces the replica wholesale. `navdata.db.lnm` is the Little Navmap import's replica; each import is its own epoch (`lnm-<provider>-…`). |
| **Computed straight-in / departure** | The dashed line drawn for a Little Navmap *custom* approach or departure, computed from the runway rather than read from a simulator procedure. |
