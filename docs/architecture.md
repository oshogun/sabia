# Architecture

## Component map

```
┌─────────────────────┐   SimConnect (local)   ┌─────────────────────────┐
│ MSFS 2020/2024/FSX  │◄───────────────────────│ MCDU/Tauri desktop app  │
│ (Windows)           │                        │ separate repo:          │
└─────────────────────┘                        │ oshogun/sabia_mcdu      │
                                               └────────────┬────────────┘
                     HTTPS, x-ingest-token:                 │
                     POST /api/ingest/{frame,event,traffic} │
                     + ingest-scoped API (status, ACARS, …) │
                                                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  src/  — Express + TypeScript server                                 │
│                                                                      │
│  ingest router ─► FlightManager ─► db/ (better-sqlite3)              │
│                                                                      │
│  feature routers (flights, trips, planned-legs, exports, acars, …)   │
│  serve client/dist/ (static) + JSON API, session or ingest-token auth│
│                                                                      │
│  outbound: SimBrief, aviationweather.gov, SayIntentions.AI, PDF      │
└───────────────┬──────────────────────────────────────────────────────┘
                │ same-origin HTTPS
                ▼
┌──────────────────────┐
│ client/ — React SPA  │
│ (built into          │
│  client/dist, served │
│  by the Express app) │
└──────────────────────┘
```

## Components and responsibilities

### `src/` — server

Express + TypeScript, single process, single SQLite database
(`better-sqlite3`, WAL mode). Responsibilities:

- Accept telemetry from the MCDU client (`/api/ingest/*`) and drive the
  in-process flight state machine (`FlightManager`).
- Persist flights, trips, planned legs, ACARS messages, and ground sessions.
- Serve the built React client as static files and answer its JSON API.
- Serve a second, narrower JSON API to non-browser clients authenticated by
  ingest token only (status, ACARS, ground-session-current, SimBrief
  settings) — this is what the MCDU app uses.
- Serve an optional [MCP](https://modelcontextprotocol.io/) endpoint
  (`/mcp`, its own bearer-token credential, off until an MCP token is created on the Settings page or `MCP_TOKEN` is set)
  exposing the logbook as 18 tools to a remote MCP client such as Claude
  Desktop/Code. See [api.md § MCP server](api.md#mcp-server--srcmcp).
- Keep a replica of MSFS navigation data pushed by the MCDU client (`src/navdata/`, a separate SQLite file, `navdata.db`), optionally build a second replica from an imported Little Navmap database (`src/navdata/lnm/`, run in a worker thread, `navdata.db.lnm`), and answer map queries and route-expansion requests from whichever source is selected in Settings. See [navdata.md](navdata.md).
- Generate PDF (via a self-navigated headless Chromium instance) and KML
  exports.
- Integrate with three external HTTP services: SimBrief (OFP import),
  aviationweather.gov (METAR/TAF for ACARS weather replies), and
  optionally SayIntentions.AI (pull its ATC/CPDLC comms into a flight's
  ACARS thread, push an on-file PDC into the pilot's live session — off by
  default, gated on an operator-supplied API key).

See [api.md](api.md) for the full route table and [configuration.md](configuration.md)
for every environment variable.

### `client/` — web UI

React 18 + Vite + `react-router-dom` (browser history routing), styled with
IBM's [Carbon Design System](https://carbondesignsystem.com/) (`@carbon/react`,
the dark **Gray 100** theme, compiled from `client/src/styles/index.scss`) and
`react-leaflet`/Leaflet for all maps (tiles from the public OpenStreetMap tile
server, darkened by a CSS filter to sit in the theme). Built to `client/dist/`,
which the server serves at the same origin — the client has **no configurable
API base URL**; every request is a bare relative `/api/...` path and depends on
same-origin cookies. In dev, Vite's own dev server proxies `/api` to the backend
on port 3000.

`client/src/main.tsx` splits the bundle in two: a path starting `/print/` loads
`client/src/print/entry.tsx` (the headless PDF-export pages — plain CSS in
`print/print.css`, a light document, no Carbon), anything else loads
`appEntry.tsx` (the Carbon app). CI's `npm run check:print-chunk`
(`client/scripts/check-print-chunk.mjs`) fails the build if a Carbon or app
module leaks into the print chunk.

Auth is a `SessionProvider` context (`client/src/shell/SessionContext.tsx`)
that calls `GET /api/auth/session` once on load; any `401` from the API layer
(`client/src/api/*`) expires the session and sends the browser to `/login`.
"Live" data (position, status, AI traffic) comes from `useStatus()` polling
`GET /api/status` (1s while flying, 3s otherwise) — not a WebSocket or SSE
connection — and feeds the status tag in the header. The side navigation's
trip/flight tree (`client/src/shell/useNavTree.ts`) reloads after any mutation
made through the API layer, on route change, every 30 s, and when the tab
becomes visible again.

Pages (`client/src/pages/`): `Home` (dashboard), `AllFlights`, `Prefiles`
(planned legs), `FlightDetail`, `TripDetail`, `AcarsMessages` (shared by
flight- and leg-scoped threads), `Settings` (SimBrief pilot ID, SayIntentions
key), `Login`, and two standalone easter-egg pages (`Device`, `Override`). The
headless `PrintFlight`/`PrintTrip` routes live in `client/src/print/` and exist
purely as the render target for server-side PDF export. See [usage.md](usage.md)
for what each page is for.

**Flight replay** is entirely client-side. `FlightDetail`'s **Replay**
tab renders a `ReplayPanel` under the flight's own map and drives an aircraft
marker on that map (`client/src/pages/flightdetail/ReplayMarker.tsx`), from the
full track that `GET /api/flights/:id` already returns. The print pages have
their own map components and are untouched by replay. Three pieces, each independently
testable:

- `client/src/utils/replay.ts` — a pure engine (no React or Leaflet):
  `buildTimeline` turns the points into a timeline (recording gaps longer than
  `GAP_THRESHOLD_SEC` = 30 s are collapsed to `COLLAPSED_GAP_SEC` = 2 s of
  virtual time) and `sample` returns the interpolated position, heading (shortest
  arc), altitude and speeds at a virtual time. Longitude is interpolated after
  `unwrapLonChain`, so a track crossing the antimeridian stays continuous.
- `client/src/hooks/useReplayClock.ts` — one `requestAnimationFrame` loop holding
  virtual time in a ref (per-frame advance clamped to 0.25 s), with an injectable
  scheduler for tests.
- `client/src/components/replay/ReplayPanel.tsx` + `pages/flightdetail/ReplayMarker.tsx` — the
  marker is moved directly with `setLatLng` rather than through React state,
  and the panel writes the readout and scrubber at no more than 10 Hz
  (`UI_INTERVAL_MS` = 100), so the map does not re-render per frame.

### Simulator connection — the MCDU client (separate repo)

The [Sabiá MCDU client](https://github.com/oshogun/sabia_mcdu) is a Tauri
desktop app that runs on the Windows PC with the simulator. Its Node sidecar
connects to SimConnect locally, the same way any local addon does, so no
firewall or TCP configuration is needed. It pushes telemetry, sim events and
AI-traffic batches to `/api/ingest/*` over HTTP(S), and uses the
ingest-scoped API for its CDU pages (status, ACARS, SimBrief). This is the
only supported way to feed the server. Dialing SimConnect's TCP port directly
from the server is not supported. The Node.js agent that used to live in
`agent/` did the ingest half of this job and was retired on 2026-09-25.

### External integration points

| Service | Direction | Used for |
|---|---|---|
| SimConnect (local, Windows only) | MCDU client reads | Live simulator telemetry |
| SimBrief public API | server calls out | Importing a dispatch OFP as planned legs |
| aviationweather.gov | server calls out | METAR/TAF for ACARS weather requests |
| SayIntentions.AI SAPI | server calls out (optional) | Pull ATC/CPDLC comms into a flight's ACARS thread; push an on-file PDC as a real CPDLC message — off by default, needs an operator-supplied API key. See [api.md § SayIntentions](api.md#sayintentions--srcroutessayintentionsts). |
| OpenStreetMap tile server | browser calls out | Map tiles in the web UI |
| MCDU/Tauri desktop client (`oshogun/sabia_mcdu`) | calls in, via ingest-scoped API | In-sim datalink UI, including the SayIntentions feature above; separate repository, not documented here |
| MCP client (e.g. Claude Desktop/Code) | calls in, via `/mcp` with its own bearer token | Read/edit the logbook through 18 MCP tools — off by default, needs an MCP token (created on the Settings page, or `MCP_TOKEN`). See [api.md § MCP server](api.md#mcp-server--srcmcp). |

## Runtime flow

### Startup (`src/index.ts`)

1. `loadConfig()` — any invalid environment variable exits the process here,
   before anything else runs.
2. `initDb()` — opens the SQLite file, applies schema/migrations. Then the
   navdata directory is created if missing and the navdata replicas are opened
   (deleting leftover temporary import files; a failure is logged, never fatal) and the stored navdata source
   (`app_setting.navdata_source`) is applied, with a warning when Little
   Navmap is selected but its file is missing.
3. Refuse to start if no operator account exists yet (`npm run set-password`
   creates one — there is no HTTP-based setup flow). Then log which ingest
   credential is in force: a warning when none exists at all (the server
   still starts; ingest is rejected), or a note when Settings-page tokens
   override `INGEST_TOKEN`, `ALLOW_UNAUTHENTICATED_INGEST` or `MCP_TOKEN`.
4. Sweep expired sessions once, then every 6 hours.
5. Ensure the flight-plans attachment directory exists; start airport-data
   loading in the background (non-blocking).
6. Construct `FlightManager` and the Express app (`createServer`).
7. Listen — HTTP or HTTPS depending on TLS config, on one port. There is no
   second listener redirecting HTTP to HTTPS. The server is created with
   `headersTimeout` 60 s and no whole-request timeout; instead every request
   gets a 300 s deadline for its body (the socket is closed if the body is still
   arriving), which only an authenticated Little Navmap upload extends to 1 h
   (`src/bodyDeadline.ts`).

### Request lifecycle (`src/server.ts`)

Middleware order is deliberate, and reordering it changes behaviour:

1. `express.json()` (100KB body limit) and static file serving from
   `client/dist`.
2. `/api/ingest/*` — mounted **before** session middleware, authenticated
   independently by ingest token, looked up in the token store on every
   request (`checkIngestCredential()`, `src/auth/ingestAuth.ts`).
3. `/mcp` — always mounted, also **before** session middleware and outside
   `/api` entirely, authenticated independently by its own bearer token
   (`checkMcpCredential()`, `src/auth/mcpAuth.ts`). With no MCP credential
   anywhere its gate calls `next('router')`, so it behaves as if unmounted. See [api.md § MCP server](api.md#mcp-server--srcmcp).
4. Session middleware (cookie `msfslogger.sid`, SQLite-backed store).
5. An ingest-token *scope classifier* (marks eligible requests; doesn't gate
   by itself).
6. `requireSameOrigin` (CSRF defense-in-depth).
7. `/api/auth/*` — public, mounted before the auth gate.
8. `requireAuth` — the single gate for everything else under `/api`: passes
   with a valid session **or** a validly-scoped ingest token.
9. Feature routers (flights, trips, settings, planned legs, navdata queries,
   route geometry, the Little Navmap import, exports, acars, ground sessions).
10. SPA catch-all (`GET *` → `client/dist/index.html`) for client-side
    routing.
11. A final error handler normalizing upload and malformed-JSON errors.

### Shutdown

`SIGINT`/`SIGTERM` first cancels a running Little Navmap import (the job ends
`LNM_INTERRUPTED` and its temporary files are removed), then closes the
HTTP(S) listener, both navdata replicas, and the database (which
checkpoints WAL back into the main file, so a hard kill without this step
can strand recent writes in `flights.db-wal`), with a 3-second fallback timer
in case a lingering connection blocks the graceful close.

## Flight state machine

The core of the domain logic — driven entirely by telemetry frames arriving
over ingest, not by any client request. `src/flightManager.ts`
(`FlightManager`) is the coordinator. It owns:
- the state;
- the transition guards: the airborne and landed debounces, and entering
  GROUND once `GroundTracker` reports the parked debounce met;
- the order of every step in a takeoff, a resume, a hold after the sim goes
  silent, and a landing.

It is the only code that changes the state. Each concern it orchestrates
lives in its own module under `src/flight/`:

| Module | Responsibility |
|---|---|
| `groundTracker.ts` (`GroundTracker`) | Ground sessions: the parked streak; entry by adopting an open session or inserting a new one; the slew, superseded, crash and sim-exit exits; the off-blocks (OUT) memo; handing the session's airport and stand to the takeoff. |
| `plannedLegLink.ts` (`PlannedLegLink`) | The planned-leg link: auto-link at takeoff, the non-consuming match at ground entry, the arrival outcome at landing, and the live progress reported by `GET /api/status`. |
| `flightRecorder.ts` (`FlightRecorder`) | The `flights` row and its track points, and the duration, distance and maxima accounting (below). |
| `oooiReporter.ts` (`OooiReporter`) | ACARS OUT/OFF/ON/IN messages and periodic position reports. |
| `bootRecovery.ts` | The one-time open-flight lookup after a restart (below). |
| `legProgress.ts`, `summarizeTrack.ts` | Pure helpers: progress along a planned route; rebuilding a flight's totals from its stored track. |
| `sameFlight.ts` | Pure helper: whether the first frame after a silence belongs to the flight being held (below). |
| `constants.ts` | Shared thresholds: `MAX_COUNTED_GAP_MS` (60 s) and `TAXI_OUT_SPEED_KTS` (3 kt), both also re-exported from `src/flightManager.ts`; `SIM_SILENCE_HOLD_MS` (180 s) and `SAME_FLIGHT_BASE_NM` (5 nm), used by the hold (below). |

**States:** `IDLE` → `GROUND` → `FLYING` → back to `IDLE`.

- **IDLE → GROUND**: 5 consecutive "parked" frames (on ground, groundspeed
  &lt;1kt, engines off or parking brake set). Resolves the nearest airport and
  attempts a non-consuming planned-leg match; opens a `ground_sessions` row.
- **IDLE/GROUND → FLYING**: 3 consecutive airborne frames (not in slew, not
  on ground, airspeed &gt;30kt). Inserts a `flights` row, closes any open
  ground session, attempts to auto-link a planned leg (see leg matching,
  below), and files OUT/OFF ACARS messages.
- **GROUND exit without flying**: slew, or moving more than 10nm from the
  ground-session's anchor position, closes the session back to IDLE. A crash
  or sim disconnect while grounded closes only an auto-created session,
  leaving a manually-created one open for the operator.
- **FLYING → IDLE (landing)**: 10 consecutive landed frames (on ground,
  groundspeed &lt;5kt); immediately on a crash or on a frame reporting the sim
  not running; or when a hold after a sim silence ends without the flight
  continuing (below). Writes final flight stats, records the leg outcome
  (below), files IN, and ON if no touchdown filed it earlier.
- **Hold after the sim goes silent**: in FLYING, losing the client's data
  does not end the flight at once.
  - It starts when no frame and no `pause` or `connected` event has arrived
    for more than 10 s (the check runs every 5 s, so 10–15 s after the last
    of them), or when the client sends a `disconnected` event. The flight
    stays `FLYING`, `GET /api/status` reports `connected: false`, the
    header shows *Waiting for sim · &lt;aircraft&gt;*, and nothing is filed.
    Log: "Flight #N sim silent — holding up to 180s from the last frame".
  - It lasts up to `SIM_SILENCE_HOLD_MS` (180 s), counted from the time the
    last frame was received. A second silence or `disconnected` during the
    hold changes nothing.
  - The first frame that arrives decides (`sameFlight.ts`). It continues the
    flight when it is from the same aircraft (the same `aircraft` string),
    arrives within the 180 s, and is within 5 nm of the last frame; when
    the sim was not paused as the hold started, the 5 nm grows by the
    distance the last ground speed covers in the time since the last frame.
    A continuation keeps the same `flights` row and the leg link, files no
    OUT/OFF, and marks the silence as an interruption (its time is not
    counted, the distance to the new point is). The frame is then handled
    as a normal flying frame, so an on-ground frame counts toward the
    landing debounce. Log: "Flight #N continued after Ns of silence — X.X nm
    from the last frame".
  - Any other first frame, the 180 s running out ("Flight #N hold expired
    after 180s without data — closing at the last frame"), a frame reporting
    the sim not running, or a `crashed` event closes the flight at the last
    frame received before the silence: `end_time` is the time that frame
    arrived, the arrival position and airport come from it, and IN carries
    that time; so does ON, unless a touchdown earlier in the flight already
    filed it at the touchdown time. A frame that ended the hold this way is
    then handled as usual, for example as the first frame of a new takeoff.
  - While a flight is held, `pause` and `connected` events do not mark the
    client connected, because they carry no frame. A pause during the hold
    updates the pause state but does not mark an interruption; a
    continuation marks one anyway.
  - In GROUND a silence or `disconnected` closes only an auto-created
    ground session (above); in IDLE it only marks the client disconnected. A
    server shutdown during a hold leaves the row open, and the restarted
    server resumes it like any open flight (below), with no position or
    aircraft check.
- **Resume after a server restart**: shutdown never ends a flight. On the
  first running frame after the process starts, the server looks once for a
  `flights` row that was never closed. If it finds one, it continues that
  flight instead of starting a new one:
  - it rebuilds distance, maxima, point count and counted time from the
    stored points (`summarizeTrack`), applying the same gap rule as the live
    path (below);
  - it excludes the outage from the duration;
  - it reloads the existing leg link without matching again;
  - it does not insert a row, close a ground session or re-file OUT/OFF.

  If the resume fails, the outcome depends on where:
  - **The lookup, or the read of the stored points.** The error is logged
    ("Open-flight check failed…") and the server carries on as if no flight
    were open. A takeoff then starts a new flight, and the old row stays
    open.
  - **The leg reload.** It is logged ("planned-leg cache not restored"),
    and the flight continues without a live leg status.
  - **The first point write.** It is logged as "Open-flight check
    failed…", and the flight stays resumed.

**Pause handling**: the MCDU client forwards SimConnect's `Pause_EX1` bitmask,
distinguishing a full pause, an "active pause," and a menu pause — all three
stop the flight clock and suspend track recording, unlike the legacy
`Paused`/`Unpaused` events (kept only as a fallback) which miss active pause
entirely.

**Duration**: not wall-clock time.
- **What is summed.** The gaps *between recorded points*, plus the final gap
  when the flight ends. A point is stored at most every 5 s while flying.
- **When a gap counts.** Only when it is ≤60s and the flight wasn't
  interrupted since the previous point. Interrupted means paused (any
  `Pause_EX1` flag, or the legacy `Paused` event), slewed, resumed after a
  restart, or continued after a sim silence.
- **The interruption is stored with the point.** The first point stored
  after an interruption is written with `flight_points.after_interruption`
  = 1. When a restarted server resumes the flight, it skips the gap that ends
  at a flagged point, so pauses, slews and earlier outages from before the
  restart are not counted again. Points stored before this column existed
  read 0, so for those only the 60 s rule applies.
- **Pauses and slews.** No point is recorded during a pause or a slew, so
  that time falls inside a gap that isn't counted. A pause, the pause menu
  or a frozen sim is therefore excluded rather than inflating the duration,
  whether or not frames keep arriving. What depends on the frames is whether
  a pause longer than the 180 s hold keeps the flight as one entry.
  - The MCDU client sends one frame per SimConnect per-second data callback
    and doesn't stop on pause, so whether a long pause keeps the flight open
    depends on whether MSFS keeps delivering that data while paused. On
    2026-10-03 it did, through a 45-minute pause: the flight stayed open and
    the pause was excluded.
  - If MSFS stops delivering, a pause longer than about 10–15 s starts a
    hold (above), and the flight closes at the last frame unless the data
    is back within 180 s of it.
  - A loading stall or other hang makes the client go silent the same way.
    When the frames come back within the hold, from the same aircraft and
    place, the flight continues.
- **A silence or a dropped MCDU connection.** The server checks every 5 s,
  so it notices silence 10–15 s after the last frame (or the last `pause` or
  `connected` event, if one came later). It then marks the
  client disconnected and, in FLYING, holds the flight (above). A
  `disconnected` event from the client does the same immediately.
  - The silence itself is never counted: a continuation marks it as an
    interruption, and a close ends the flight at the last frame received.
  - When the hold closes the flight, the time between the last stored point
    and the last frame counts as the flight's last seconds, unless the
    flight was paused or slewed between that point and the silence.
  - After a close, later frames are handled as in IDLE: whether they came
    after the hold, from another aircraft or too far away, three consecutive
    airborne frames start a new flight, and frames on the ground start none
    (see [troubleshooting.md § Data](troubleshooting.md#data)).
  - A drop shorter than 10 s is never noticed, and its gap counts like any
    other.

## Leg matching and closing

`src/legMatcher.ts` (`matchPlannedLeg`) is a pure, deterministic function run
at takeoff (and non-consumingly at ground-session entry): it finds planned
legs for the active trip within 10nm of the takeoff position, filters out
ones that are already flown/skipped/linked or lack a departure airport, and
either returns exactly one match, or a specific reason it couldn't (no active
trip, no legs, none in radius, none eligible, or more than one equally
eligible candidate — it never guesses on an ambiguous match).

At landing, a linked leg is marked `'flown'` if the arrival is within 10nm of
the leg's destination, or `'diverted'` otherwise — the link is kept either
way. A leg linked **manually** (not by this auto-match) can instead be
hand-closed by the operator via the API, gated by `src/plannedLegClose.ts`'s
rules (flight must have ended, leg must be in the expected status for the
requested transition); a manual hand-close never produces `'diverted'`.

## Where to go next

- [api.md](api.md) — every route, request/response shape, and its auth requirement.
- [data-model.md](data-model.md) — full schema.
- [usage.md](usage.md) — what an operator actually does with all this.
- [security.md](security.md) — the auth/CSRF/token model in detail.
