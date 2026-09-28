# API reference

All application routes are mounted under `/api`. There is no API versioning
(no `/v1` prefix) and no OpenAPI/Swagger spec — this document is the source
of truth, generated from `src/server.ts` and `src/routes/*.ts`.

## Auth model, in one table

| Auth type | How | Used by |
|---|---|---|
| **Session** | `msfslogger.sid` cookie, set by `POST /api/auth/login` | The web UI |
| **Ingest token** | `x-ingest-token` header, checked against the active Settings-page ingest tokens, or `INGEST_TOKEN` when none exist ([precedence](configuration.md#tokens-created-on-the-settings-page)) | The MCDU client, for `/api/ingest/*` and a small allow-listed set of other routes (below) |
| **MCP bearer token** | `Authorization: Bearer <token>`, checked against the active Settings-page MCP tokens, or `MCP_TOKEN` when none exist | An MCP client (e.g. Claude Desktop/Code) at `/mcp` only — see [MCP server](#mcp-server--srcmcp) below |
| **Public** | none | `/api/auth/*`, the served client, and the SPA catch-all |

Every `/api` route below is one of exactly three values: **session**
(cookie only), **session or token** (either credential works), or
**public** (no auth at all). "Session or token" is not a default for
`/api` — it applies *only* to the 19 method+path pairs in the explicit
allow-list `INGEST_SCOPED_ROUTES` (`src/auth/ingestScope.ts`). Everything
else under `/api` is session-only: an otherwise-valid ingest token is never
read for an off-list route, let alone accepted. `/mcp` is a separate,
top-level endpoint outside `/api` entirely — it is never reachable by
session or ingest token, and `/api` never accepts an MCP token — see below.
Full mechanism (CSRF, throttling, token scoping) is in
[security.md](security.md); this page only documents *which* routes accept
which credential.

## `GET /api/status`

Live application state, polled by the client (1s while flying, else 3s).

Session or token — allow-listed.

Response: `connected`, `flightState`, `currentFlightId`, `paused`,
`pauseFlags`, `simRunning`, `onGround`, `aircraft`, `frame` (`lat`, `lon`,
`altitudeFt`, `airspeedKnots`, `groundSpeedKnots`, `headingDeg`,
`verticalSpeedFpm`, `onGround`), plus conditionally: `plannedLeg` (only while
`flightState === 'FLYING'` with a frame present), `groundSession` (only
while `flightState === 'GROUND'`), `traffic` (only when non-empty).

## Flights — `src/routes/flights.ts`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/flights` | session | List all flights |
| POST | `/api/flights/combine` | session | Merge two flights (`{id1, id2}`) → `201 {id}` |
| GET | `/api/flights/search` | session | Free-text match over a flight's text columns. `q` required (1–200 chars, 1–8 terms), `limit` (1–100, default 25), `offset` (≥0, default 0). `400 INVALID_QUERY`/`TOO_MANY_TERMS`/`INVALID_LIMIT`/`INVALID_OFFSET` |
| GET | `/api/flights/stats` | session | Aggregates over the whole logbook, optionally bounded by `from`/`to` (`YYYY-MM-DD` or a UTC timestamp; `to` exclusive). Empty logbook/range → zeros and `null`, never `404`. `400 INVALID_RANGE` on a bad date |
| GET | `/api/flights/:id` | session | Single flight |
| PATCH | `/api/flights/:id` | session | Edit `aircraft` and/or `notes` |
| DELETE | `/api/flights/:id` | session | Delete a flight → `{deleted:true}` |
| POST | `/api/flights/:id/flight-plan` | session | Upload attached PDF (multipart, field `file`, ≤20MB, PDF only) |
| GET | `/api/flights/:id/flight-plan` | session | Stream the attached PDF inline |
| DELETE | `/api/flights/:id/flight-plan` | session | Remove the attached PDF |

None of this router's routes are ingest-token-scoped — note this is a
different router than the flight-scoped ACARS routes below, which share the
`/api/flights/:id/...` prefix but are allow-listed.

Registration order matters: `/flights/search` and `/flights/stats` are
registered *before* `/flights/:id`, the same load-bearing reason
`/flights/combine` already sits there — Express matches literals in
registration order, so a later-registered literal would otherwise be
shadowed by the earlier `:id` parameter route.

## Trips — `src/routes/trips.ts`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/trips` | session | Create a trip (`{name, notes?}`) → `201 {id}` |
| GET | `/api/trips` | session | List trips |
| GET | `/api/trips/:id` | session | Single trip, fully populated |
| PATCH | `/api/trips/:id` | session | Edit `name`/`notes` |
| DELETE | `/api/trips/:id` | session | Delete a trip → `{deleted:true}` |
| POST | `/api/trips/:id/flights` | session | Assign a flight to the trip (`{flightId}`) |
| DELETE | `/api/trips/:id/flights/:flightId` | session | Remove a flight from the trip |
| GET | `/api/active-trip` | session | Currently active trip |
| PUT | `/api/active-trip` | session | Set active trip (`{tripId: number\|null}`) |
| GET | `/api/trips/:id/journey` | session | Journey/atlas summary (`buildJourney`) |

## Planned legs — `src/routes/plannedLegs.ts`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/trips/:id/planned-legs` | session | Bulk `.lnmpln` import into a trip (multipart, field `lnmpln`, ≤25 files, ≤512KB each) |
| POST | `/api/planned-legs` | session | Same, as loose legs (no trip) |
| POST | `/api/trips/:id/planned-legs/simbrief` | session | Import a SimBrief OFP into the trip using the saved pilot ID |
| POST | `/api/planned-legs/simbrief` | session or token — allow-listed | Same, as a loose leg |
| GET | `/api/trips/:id/planned-legs` | session | Legs for a trip |
| GET | `/api/planned-legs` | session | All planned legs |
| PATCH | `/api/trips/:id/planned-legs/order` | session | Reorder legs (`{legIds: number[]}`, must be an exact permutation) |
| GET | `/api/planned-legs/:legId` | session | Single leg |
| DELETE | `/api/planned-legs/:legId` | session | Delete a leg |
| PATCH | `/api/planned-legs/:legId` | session | Set status to `'planned'` or `'skipped'` only — `409` if a flight is linked |
| PUT | `/api/planned-legs/:legId/trip` | session | Move a leg to another trip or make it loose (`{tripId: number\|null}`); it lands last in the target's order. `400 SAME_POOL` if already there; `409` if a flight is linked, its status is not `planned`/`skipped`, or the target already holds the same plan |
| PUT | `/api/flights/:id/planned-leg` | session | Manually link/unlink a flight and a leg (`{plannedLegId: number\|null}`) |
| PUT | `/api/flights/:id/planned-leg-status` | session | Hand-close/reopen a manually-linked leg (`{status:'flown'\|'planned'}`) |

Note the asymmetry: importing a SimBrief OFP into a *trip* requires a
session, but the *loose-leg* variant (`/api/planned-legs/simbrief`) is
allow-listed for a token too — a client with only an ingest token can
prefile a loose leg but not attach it to a trip in the same call.

## Exports — `src/routes/exports.ts`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/flights/:id/export.pdf` | session | Headless-rendered PDF; query `plans=0` skips attached flight-plan PDFs, `tz`/`locale` control formatting |
| GET | `/api/trips/:id/export.pdf` | session | Same, for a whole trip |
| GET | `/api/flights/:id/export.kml` | session | KML track for one flight |
| GET | `/api/trips/:id/export.kml` | session | KML for all flights in a trip |
| POST | `/api/flights/export.kml` | session | KML for an arbitrary flight set (`{ids: number[]}`, capped at 100) |

## ACARS — `src/routes/acars.ts`

Every route in this router is allow-listed — a token-only client (the
MCDU client) can read and post ACARS messages without a
session.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/acars/canned-messages` | session or token | List canned downlink message templates |
| GET | `/api/flights/:id/acars-messages` | session or token | Thread for a flight |
| POST | `/api/flights/:id/acars-messages` | session or token | Send a canned downlink message (`canned_id` or matching `body`) |
| POST | `/api/flights/:id/acars-messages/wx` | session or token | Request/receive METAR/TAF for an arbitrary ICAO |
| GET | `/api/planned-legs/:legId/acars-messages` | session or token | Leg-scoped thread (pre-flight) |
| POST | `/api/planned-legs/:legId/acars-messages` | session or token | Leg-scoped canned downlink |
| POST | `/api/planned-legs/:legId/acars-messages/wx` | session or token | Leg-scoped weather request |
| POST | `/api/planned-legs/:legId/acars-messages/loadsheet` | session or token | Generate load sheet from on-file dispatch data — `409 NO_DISPATCH_DATA` if none |
| POST | `/api/planned-legs/:legId/acars-messages/clearance` | session or token | Generate PDC from on-file dispatch data — `409 NO_FLIGHT_PLAN` if none |

## Ground sessions — `src/routes/groundSessions.ts`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/ground-sessions` | session | Manually create/refine the open ground session |
| GET | `/api/ground-sessions/current` | session or token — allow-listed | Currently open ground session, or `{session: null}` |
| DELETE | `/api/ground-sessions/current` | session | Close the open ground session — `404 NO_OPEN_GROUND_SESSION` if none |

## Settings — `src/routes/settings.ts`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/settings/simbrief` | session or token — allow-listed | `{simbrief_user_id}` — null if unset |
| PUT | `/api/settings/simbrief` | session | Set the SimBrief pilot ID — note only the GET is allow-listed, not this write |
| GET | `/api/settings/sayintentions` | session or token — allow-listed | `{sayintentions_api_key_set, sayintentions_api_key_masked}` — the raw key is never returned, only a fixed `'••••••••'` placeholder when set |
| PUT | `/api/settings/sayintentions` | session | Set/clear the SayIntentions API key — like the SimBrief pair, only the GET is allow-listed; writing a credential is never token-reachable, categorically |
| GET | `/api/settings/ingest-tokens` | session | `{tokens, mode, env_token_set, unauthenticated_opt_out_set}` — active tokens as `{id, public_id, label, created_at, last_used_at}`, never the secret or its digest. `mode` is `ui_tokens` \| `env_token` \| `unauthenticated` \| `closed`. `Cache-Control: no-store` |
| POST | `/api/settings/ingest-tokens` | session | Body `{label}` (1–64 chars). `201` with the list fields plus `{created, secret}` — the only time the secret is ever returned. `400 INVALID_BODY` (body not a JSON object) / `INVALID_LABEL`, `409 TOO_MANY_TOKENS` (20 active). `Cache-Control: no-store` |
| DELETE | `/api/settings/ingest-tokens/:id` | session | Revoke; takes effect on the next request. `200` with the updated list; revoking an already-revoked token is also `200`. `400 INVALID_ID`, `404 TOKEN_NOT_FOUND` only for an id that never existed. Revoked rows are kept (`revoked_at`), never deleted or reactivated |
| GET | `/api/settings/mcp-tokens` | session | `{tokens, mode, env_token_set}`; `mode` is `ui_tokens` \| `env_token` \| `disabled`. Otherwise as the ingest-token GET |
| POST | `/api/settings/mcp-tokens` | session | As the ingest-token POST, for MCP tokens |
| DELETE | `/api/settings/mcp-tokens/:id` | session | As the ingest-token DELETE, for MCP tokens |
| POST | `/api/settings/password` | session | Body `{current_password, new_password}`. `200 {ok: true, other_sessions_revoked}`: every other session is logged out and the caller's session id is rotated. `403 WRONG_CURRENT_PASSWORD` (403, not 401, so the client doesn't treat it as a logged-out session), `400 INVALID_BODY` (either field missing or not a string) / `PASSWORD_TOO_SHORT` / `PASSWORD_TOO_LONG` / `PASSWORD_BLANK` / `PASSWORD_UNCHANGED`, `429 TOO_MANY_ATTEMPTS` with `Retry-After` — throttled by its own instance of the login throttle |

None of the token or password routes is in `INGEST_SCOPED_ROUTES`: an ingest
or MCP token can never list, create or revoke tokens, or change the password.
Which credential is in force, and when the env vars stop counting, is in
[configuration.md § Tokens created on the Settings page](configuration.md#tokens-created-on-the-settings-page).

## SayIntentions — `src/routes/sayIntentions.ts`

Optional, default-off integration with [SayIntentions.AI](https://www.sayintentions.ai/)'s
pilot-key API: importing its AI-ATC/CPDLC comms transcript into a flight's
ACARS thread, and sending an on-file PDC into the pilot's live SayIntentions
session as a real ACARS/CPDLC message. The link/import/clearance routes
require a saved key (`409 NO_API_KEY` otherwise) — the link-status GET and
the DELETE do not, since reporting or clearing a link needs no key. None of
them ever returns the raw key. Every route in this table is allow-listed
(six, counting the settings GET above) — see
[architecture.md](architecture.md#external-integration-points) for why: the
Sabiá server is the only thing that talks to SayIntentions directly,
and the MCDU app is meant to be a full interface to this feature through the
server, the same trust level already extended to the ACARS routes above.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/flights/:id/sayintentions/link` | session or token — allow-listed | Current link status for a flight: `{flight_id, linked, link, api_key_set}` |
| POST | `/api/flights/:id/sayintentions/link` | session or token — allow-listed | Bind this flight to whatever SayIntentions session the saved key currently holds. `?from=now` imports only from this point forward; any other/missing value means "from session start" (the safe default — never an error) |
| DELETE | `/api/flights/:id/sayintentions/link` | session or token — allow-listed | Remove the link, if any — always `200 {flight_id, unlinked}`, never errors on a missing link |
| POST | `/api/flights/:id/sayintentions/import` | session or token — allow-listed | Pull new comms since the last import into the flight's ACARS thread (`category: 'atc'`), deduped and cursor-driven — safe to press repeatedly |
| POST | `/api/planned-legs/:legId/sayintentions/clearance` | session or token — allow-listed | Condense the leg's on-file PDC to SayIntentions' 128-char `ACARS_IN` cap and send it as a real CPDLC message. Needs the key but not a link — leg-scoped, same as `planned-leg-acars-clearance` above |

Errors specific to this feature: `409 NO_API_KEY`, `409 BAD_API_KEY`
(upstream rejected the saved key), `409 NOT_LINKED`, `409 SESSION_CHANGED`
(the flight's linked session no longer matches what the key returns — unlink
and relink), `409 NO_COMMS_TO_LINK`, `409 NO_ACTIVE_SESSION` (push attempted
with no active SayIntentions session — an expected outcome, not a fault),
`409 NO_CLEARANCE`, `502 UPSTREAM_UNREACHABLE`/`UPSTREAM_ERROR`/
`UPSTREAM_BAD_BODY`, `504 UPSTREAM_TIMEOUT`. The upstream call has a fixed
10s client-side timeout (`SAYINTENTIONS_TIMEOUT_MS`,
`src/sayIntentionsClient.ts`) — not something SayIntentions documents, our
own margin.

## Auth — `src/auth/routes.ts`

Mounted at `/api/auth`, always public (never behind the `requireAuth` gate).

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` | `{username, password}` → `200 {user}` or `401`. Rate-limited: 10 failures / 15 min / IP → `429` with `Retry-After`. |
| POST | `/api/auth/logout` | Destroys the session. Always `204`. |
| GET | `/api/auth/session` | `{authenticated, user}`. Always `200`, never `401` — used for client-side auth-state polling. |

## Ingest — `src/ingest.ts`

Mounted at `/api/ingest`, authenticated independently by ingest token (not
session-gated, not behind `requireAuth`). This is the path the MCDU client's
sidecar uses to feed telemetry, events and AI traffic.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/ingest/frame` | ingest token | One `SimFrame` sample — the sole path into the flight state machine |
| POST | `/api/ingest/event` | ingest token | A discrete event: `pause` (`{flags}`), `connected`, `disconnected`, `paused`, `unpaused`, `crashed` |
| POST | `/api/ingest/traffic` | ingest token | A batch of nearby AI/multiplayer aircraft (≤200 objects); in-memory only, never persisted |

`/api/ingest/*` also has its own narrow CORS handling for `Origin:
coui://html_ui` (the in-sim MCDU browser) — no other route in the server sets
CORS headers.

## MCP server — `src/mcp/`

A [Model Context Protocol](https://modelcontextprotocol.io/) endpoint for a
remote MCP client (e.g. Claude Desktop/Code) to read and make a small set of
edits to the logbook. Opt-in: it works once an MCP token exists — one
created on the Settings page or `MCP_TOKEN` (see
[configuration.md](configuration.md#tokens-created-on-the-settings-page)).
The router is always mounted, but with no MCP credential at all its gate
passes every request straight through (`next('router')`), so `/mcp` behaves
exactly as if it weren't there: `POST`/`DELETE` get Express's `404`, and
`GET /mcp` falls through to the SPA catch-all like any other unknown path.
Creating or revoking a token takes effect on the next request, no restart.

| | |
|---|---|
| Path | `POST /mcp` — top-level, outside `/api` entirely |
| Auth | `Authorization: Bearer <token>` (a Settings-page MCP token, or `MCP_TOKEN` when none exists), checked before the MCP transport sees the request. Missing/wrong → `401` with `WWW-Authenticate: Bearer realm="msfslogger-mcp"` |
| Methods | `POST` only — with a valid token, `GET` and `DELETE` (and everything else) answer `405 Allow: POST` |
| Transport | [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http), stateless — a fresh `McpServer`/transport per request, `enableJsonResponse: true` (plain `application/json`, no SSE stream for a normal call). The client must send `Accept: application/json, text/event-stream`, or the request is rejected |
| Independent from ingest tokens | Own env var, own table (`mcp_tokens`), own digest, own compare function, own allow-list, own gate (`src/auth/mcpToken.ts`, `src/auth/mcpAuth.ts`, `src/db/mcpTokens.ts`, `src/auth/mcpScope.ts`) — no shared code with the ingest-token path. Revoking one has no effect on the other. `/mcp` is mounted above `express-session` and sets no CORS headers, so a request it handles never touches a session cookie and a browser cannot reach it cross-origin |

Every tool call runs the same underlying `src/db/*.ts`/`FlightManager`
functions the corresponding `/api` route uses — never an internal HTTP
request back into this server — so a tool and its nearest route can't
disagree about *data*, only about how much of it they return.

### Tool inventory (18)

Read tools return data only; write tools are the only four edits reachable
through MCP at all — no delete, no combine, no PDF/export, no SayIntentions,
no settings or credential write is reachable this way.

| Tool | Kind | Purpose | Nearest `/api` route |
|---|---|---|---|
| `list_flights` | read | Paginated flight list, optionally by `trip_id` | `GET /api/flights` |
| `get_flight` | read | Single flight, optional downsampled track (≤200 points) | `GET /api/flights/:id` |
| `search_flights` | read | Free-text flight search | `GET /api/flights/search` |
| `get_flight_stats` | read | Logbook aggregates, optional date range | `GET /api/flights/stats` |
| `list_trips` | read | All trips | `GET /api/trips` |
| `get_trip` | read | Single trip with its flights and planned legs | `GET /api/trips/:id` |
| `get_journey` | read | Journey/atlas summary for a trip | `GET /api/trips/:id/journey` |
| `list_planned_legs` | read | Planned legs, by trip or all, filterable by status | `GET /api/planned-legs` / `GET /api/trips/:id/planned-legs` |
| `get_planned_leg` | read | Single planned leg with waypoints/alternates | `GET /api/planned-legs/:legId` |
| `get_acars_thread` | read | ACARS thread for a flight or a planned leg (newest 100) | `GET /api/flights/:id/acars-messages` / the leg-scoped equivalent |
| `get_weather` | read | Cached METAR/TAF for an ICAO — no route of its own; calls the same cache the ACARS weather-request route reads before it writes anything | — |
| `list_canned_messages` | read | Canned ACARS downlink templates | `GET /api/acars/canned-messages` |
| `get_status` | read | Live app/flight/ground-session state — its own flat projection, not `GET /api/status`'s body (that endpoint's serialization contract is frozen separately); omits the AI-traffic array entirely | `GET /api/status` |
| `get_ground_session` | read | Currently open ground session, if any | `GET /api/ground-sessions/current` |
| `update_flight_notes` | write | Set a flight's `notes` — cannot touch `aircraft` or any other field, by construction (the tool's input schema has no such key, and the handler never spreads its arguments into the update call) | `PATCH /api/flights/:id` |
| `create_trip` | write | Create a trip | `POST /api/trips` |
| `assign_flight_to_trip` | write | Assign a flight to a trip (and refresh its planned-leg link) | `POST /api/trips/:id/flights` |
| `import_simbrief_leg` | write | Import a SimBrief OFP as a loose planned leg | `POST /api/planned-legs/simbrief` |

Every tool's declared route is checked at server startup against a hardcoded
allow-list (`MCP_SCOPED_ROUTES`) — a tool with no matching entry, or a
mismatched read/write kind, fails startup rather than shipping silently.

## Navdata — `src/routes/navdataSync.ts`, `src/routes/navdata.ts`, `src/routes/navdataRouteGeometry.ts`

Full behaviour, error codes and merge rules: [navdata.md](navdata.md).

**Sidecar endpoints — ingest token only** (`x-ingest-token`, checked per route,
mounted above the session middleware; a session cookie is rejected; none of them
is in `INGEST_SCOPED_ROUTES`):

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/navdata/snapshot` | ingest token | Multipart, one part `navdataSnapshot`, gzipped NDJSON, ≤ 64 MiB. Replaces the replica atomically. |
| POST | `/api/navdata/rows` | ingest token | JSON incremental batch: a single-`rev` batch may exceed 2000 rows (20 000 ceiling), a mixed-`rev` batch may not; 4 MiB byte bound (exempt from the 100 kB JSON limit). |
| GET | `/api/navdata/demand` | ingest token | What the sidecar should fetch next (≤ 50 per poll); waypoint entries carry `kind` `W`/`V`/`N`, fixes before navaids; optional `skipAirports`/`skipWaypoints` lists of parked idents. |
| POST | `/api/navdata/state` | ingest token | Sidecar health report; `204` (`400` if the body is not a state report). |

**Query endpoints — session only** (an ingest token is rejected; with no replica
they answer empty with `200`):

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/navdata/status` | session | Whether a replica exists (`present`), its epoch/counts, sidecar state |
| GET | `/api/navdata/features` | session | Map features in a bbox at a zoom, with coverage metadata |
| GET | `/api/navdata/airports/:ident` | session | Airport detail; `404` only if not in the index |
| POST | `/api/navdata/request` | session + same-origin | Queue a "fetch detail" request (stored in `flights.db`) |
| GET | `/api/planned-legs/:legId/route-geometry` | session | A planned leg expanded into SID/enroute/STAR/approach chains |

## Errors

Errors are JSON: `{"error": "<message>"}`, sometimes with a `code` field for
programmatic handling (e.g. `INVALID_INGEST_TOKEN`, `NOT_A_CANNED_MESSAGE`,
`NO_DISPATCH_DATA`, `NO_OPEN_GROUND_SESSION`). A malformed JSON body on a
handful of write endpoints (`/api/settings/*`, `*/acars-messages`,
`*/acars-messages/wx`, `/api/ground-sessions*`) is normalized to `400
{"error":"Invalid request body","code":"INVALID_BODY"}`; other invalid-JSON
routes fall through to Express's default error response.

## Consumers beyond the web UI

The ingest-scoped routes above (status, ACARS, ground-session-current,
SimBrief settings, SayIntentions) exist so a non-browser client
authenticated only by ingest token — the separate MCDU/Tauri desktop
client (`oshogun/sabia_mcdu`) — can read status,
exchange ACARS messages, and drive the SayIntentions integration without a
session login. An MCP client (above) is a third kind of non-browser
consumer, authenticated independently by its own bearer token rather than
the ingest token. See [architecture.md](architecture.md) for how these
pieces fit together.
