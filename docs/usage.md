# Usage

## Logging a flight

1. Start Sabiá (`npm start`, or your process manager of choice — see
   [operations.md](operations.md)).
2. On the Windows PC running MSFS, start the
   [MCDU client](https://github.com/oshogun/sabia_mcdu) and press `START>` on its `STATUS` page.
3. Launch MSFS and load into a flight (or even just the main menu). The
   MCDU's `STATUS` page shows the sim connected, the web UI's header
   status tag changes from *Sim not connected* to *Connected · Idle*, and
   `GET /api/status` reports `connected: true`.
4. Nothing else is required — the server detects parking, taxi, takeoff, and
   landing automatically from telemetry (see
   [architecture.md § Flight state machine](architecture.md#flight-state-machine)).
   No "start recording" action exists or is needed.
5. Pausing the sim (including the pause menu) stops the clock without ending
   the flight; a crash or MSFS exit ends it.

## Planning a trip

Two ways to pre-load a route before flying it:

- **Import `.lnmpln` files** exported from Little Navmap, either into a
  specific trip or as loose (unassigned) planned legs, from the Prefiles
  page (choose the trip in **Import into** above the import panels) or a
  trip's detail page. Multiple files in one upload are chain-ordered
  automatically (destination of one matched to departure of the next) when
  possible.
- **Import a SimBrief OFP** by pilot ID (set once under Settings) — pulls
  route, cruise altitude, and dispatch data directly from SimBrief.

A planned leg can be moved later with **Move to trip** on its row, on the
Prefiles page or in a trip's leg table: pick another trip, or "No trip" to
make it loose. It goes to the end of the target's order (the trip's, or the
loose legs'). Only a leg that is still planned or skipped and has no linked
flight can be moved.

Mark one trip **active** to enable automatic leg matching: when you take off
within 10nm of an active trip's planned departure, the flight links itself
to that leg (see [architecture.md § Leg matching](architecture.md#leg-matching-and-closing)).
You can also link/unlink a flight to a leg by hand from the flight detail
page.

## Reviewing flights and trips

Every signed-in page shares one layout: a header with the Sabiá logo, a live
status tag (*Sim not connected*, *Connected · Idle*, *Recording · <aircraft>*,
*Paused · <aircraft>*, or *Server unreachable*; *Checking...* until the
first status response arrives), your username and a log-out
button, and a side navigation with Home, All flights, Prefiles, Settings and a
tree of trips and their flights. On a narrow window the side navigation
collapses behind the menu button; it is not remembered between visits.
Destructive actions (delete, remove, skip) ask for confirmation in a dialog.

- **Home** — dashboard: live in-flight panel (map, speed/altitude/heading),
  current ground position if parked, aggregate stats, recent flights.
- **All Flights** — full log, grouped by trip, with combine/export/new-trip
  actions.
- **Prefiles** — every planned leg (trip-linked or loose), filterable by
  status/trip/search, with import actions (into a chosen trip or loose) and
  a per-leg **Move to trip** action.
- **Flight detail** — stats, notes, planned-leg link, attached flight-plan
  PDF, map (with a **Track** and a **Replay** tab, see
  [replay](#replaying-a-flight)), altitude profile under the map, PDF/KML
  export, **Edit flight details** (aircraft name and notes, in a dialog) and
  delete.
- **Trip detail** — an **Overview** (stats, notes, combined route map,
  imports, paginated leg table with flight↔leg linking) and an **Atlas**
  view; active-trip toggle, PDF/KML export, **Edit trip details** (name and
  notes, in a dialog) and delete.
- **Settings** — the SimBrief pilot ID and the optional SayIntentions API
  key; **Ingest tokens (MCDU)** and **MCP tokens**: create a labelled token
  (its secret is shown once, in a dialog with a copy button — copy it then),
  see when each was last used, and revoke any of them, all without a
  restart; a banner says whether `INGEST_TOKEN`/`MCP_TOKEN` is being ignored
  or no ingest credential exists at all
  ([rules](configuration.md#tokens-created-on-the-settings-page)); and
  **Operator password**: change it with your current password (other
  sessions are logged out).

The **Notes** tile on flight and trip detail (on the trip's Overview) is
always shown, right under the stats. With no notes it says so and offers
**Add notes**; otherwise the pencil button under the notes, or a
double-click on the text, edits them in place. **Save** stores the change,
and **Cancel** or Escape discards it. Saving an empty box clears the notes.

## Navdata on the maps

When the MCDU client has synced navdata, the maps gain a **Navdata** panel and
expanded planned routes; without it nothing changes. See [navdata.md](navdata.md)
for what each layer shows, the coverage notes, *Fetch detail*, and the dashed
*computed straight-in / computed departure* lines drawn for custom procedures.

### Map zoom

The flight, trip and journey maps fit the whole route when they load, and refit
only when the route's points genuinely change (a track that loads late, a flight
gaining points). Once you zoom or pan a map yourself, it never refits on its own
again until you leave the page — so a zoom-in to check runways stays put. The live
map on the home page still recentres on the aircraft at each position update.

## Replaying a flight

Any completed flight with at least two recorded points has a **Replay** tab on
its detail page, next to **Track** (the URL gains `?view=replay`, so a replay
link can be shared or reloaded). The tab shows the flight's map with an aircraft
marker and, below it, the replay controls, a scrubber and a live instrument
readout. Replay is read-only and works from the
track already loaded for the page — it adds no API endpoint and writes nothing.
A flight still in progress has no Replay tab; its live position is on Home.

- **Controls** — Play/Pause (Restart once the end is reached), a speed select
  (1×, 2×, 4×, 8×, 16×, 32×, 64×; default 16×), a scrubber, and a **Follow aircraft**
  checkbox (on by default) that pans the map to keep the aircraft in view.
- **Readout** — time (UTC), elapsed, altitude, IAS, ground speed, heading,
  vertical speed, state (*Airborne*, *On ground* or *Recording gap*) and the
  current point number.
- **Recording gaps** — where the log has a gap of more than 30 seconds (the sim
  was paused, or the sim client disconnected), replay does not wait it out: the
  marker holds still for 2 seconds of replay time and the state shows *Recording
  gap* with the real duration.
- **Keyboard** — with focus on the replay panel: Space plays/pauses, ←/→ seek
  5 replay-seconds (30 with Shift), Home/End jump to the start/end. Keys are
  ignored while a field, the speed select or the scrubber has focus.

Replay is not part of the PDF or KML export.

## Combining flights

If a dropped sim-client connection or a sim crash splits one real flight into two
log entries, combine them from the All Flights page (or `POST
/api/flights/combine`). This merges points and durations; it does not
re-resolve ICAO codes on the result — run `npm run backfill-icao` afterward
if you combine many flights (see [operations.md](operations.md)).

## Exporting

- **PDF** — one flight or a whole trip, rendered headlessly from the app's
  own print pages (so it looks like the web UI), with attached flight-plan
  PDFs appended unless `?plans=0`.
- **KML** — one flight, a whole trip, or an arbitrary set of flight IDs, for
  opening in Google Earth or similar.

Both are available from the relevant page's export button, or directly via
the [API](api.md#exports--srcroutesexportsts).

## ACARS (datalink)

A simulated ACARS inbox/outbox per flight and per planned leg:

- Canned downlink messages (a fixed template list).
- Weather requests — fetches live METAR/TAF for any ICAO.
- Load sheet and PDC (pre-departure clearance) generation, from dispatch data
  already on file for the leg (import a SimBrief OFP first — without
  dispatch data these return `409`).
- Automatic OOOI (Out/Off/On/In) messages and periodic position reports are
  filed by the flight state machine itself, no action needed.
- **Optional**: link a [SayIntentions.AI](https://www.sayintentions.ai/) pilot
  API key under Settings to enable link/import (flight scope) and send
  (flight and planned-leg scope) controls on the ACARS page — importing
  SayIntentions' own AI-ATC/CPDLC transcript into this same thread, and
  sending an on-file PDC into the pilot's live SayIntentions session as a
  real CPDLC message. Off by default: with no key set, the ACARS page still
  shows a disabled SayIntentions section explaining why, rather than nothing
  at all. See [api.md § SayIntentions](api.md#sayintentions--srcroutessayintentionsts).

## Run, debug, test

| Task | Command |
|---|---|
| Dev server (server + client, hot reload) | `npm run dev` |
| Production build | `npm run build` |
| Start (after build) | `npm start` |
| Type-check the app | `npx tsc --noEmit` |
| Type-check the app + tests | `npm run test:types` |
| Run the backend test suite once | `npm test` |
| Run the backend test suite in watch mode | `npm run test:watch` |
| Run the frontend component tests | `cd client && npm test` |
| Run the end-to-end (Playwright) tests | `cd client && npm run test:e2e` |

All `node`/`npm`/`npx` commands assume Node 24 is active (`nvm use`). See
[development.md](development.md) for the test suite's conventions.

## Logs

The server logs to stdout/stderr with bracketed component prefixes — among
others, `[Config]`, `[DB]`, `[Auth]`, `[HTTP]`, `[Ingest]`, `[FlightManager]`,
`[ACARS]`, `[PDF]`, `[KML]`, `[Shutdown]`, `[Airports]` — no structured log
file or log level configuration exists. Redirect stdout
yourself if you want a log file (e.g. `npm start >> server.log 2>&1 &`, or
your process manager's own log capture — see [operations.md](operations.md)).

## Common operational failures

| Symptom | Likely cause | Fix |
|---|---|---|
| Server exits immediately, `[Config] ...` on stderr | Missing/invalid env var | Read the printed message — it names the exact variable; see [configuration.md](configuration.md) |
| Server exits, `[Auth] Refusing to start: no operator account exists.` | Never ran `set-password` | `npm run set-password` |
| `better-sqlite3` fails to load / server won't start at all | No prebuilt binary for this platform/CPU | Run on Windows, Linux or macOS (x64 or arm64); see [troubleshooting.md](troubleshooting.md#server-wont-start) |
| MCDU `STATUS` shows the backend down, web UI shows `connected: false` | Wrong server URL or ingest token in the MCDU, or it doesn't trust the server's TLS cert | Check the MCDU's `ingestToken` matches an active Settings-page ingest token, or `INGEST_TOKEN` if none exists, exactly; for a self-signed cert set `certPath` on `CFG NETWORK` — see [troubleshooting.md](troubleshooting.md#sim-client--connectivity) |
| `401 Invalid or missing ingest token` on a route other than `/api/ingest/*` | Token missing/mismatched, or that route isn't ingest-scoped | See the allow-list in [api.md](api.md#auth-model-in-one-table) |
| `429` on login | Login throttle (10 failures / 15 min / IP) | Wait out the window (resets on server restart — the throttle is in-memory) |
| Every ingest request `401`, startup logged `[Auth] WARNING: no ingest token exists` | No ingest credential at all | Create an ingest token on Settings and enter it in the MCDU |
| Docker Compose created a `flights.db/` directory | Bind-mount target didn't exist before `up` | `touch flights.db` before first `docker compose up` |

More diagnostics in [troubleshooting.md](troubleshooting.md).
