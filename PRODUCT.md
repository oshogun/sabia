# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Flight-sim pilots flying Microsoft Flight Simulator 2020/2024 or FSX who
self-host their own Sabiá server — the author is one operator among many.
Future work must assume a stranger installed it from the Linux/Windows
installer or the Docker image, not someone who knows the codebase. Each
server has one operator account; multi-pilot or virtual-airline use is not
a supported scenario.

## Product Purpose

Sabiá is a self-hosted flight logbook. It records every flight's track and
statistics into a local SQLite database, with no manual start/stop, and
presents the logbook, trips and planned legs in a web app. Success is a
pilot who flies, and later finds a complete, accurate record of the flight
already there — linked to the trip leg they planned.

## Positioning

Three things together, which cloud loggers and VA trackers don't combine:

- **Self-hosted, own data.** The logbook is a SQLite file on the pilot's
  machine. No cloud account, no third-party service holding the history.
- **Zero-touch logging.** No record button exists. The server's state
  machine detects parking, taxi, takeoff and landing from telemetry.
- **Trips and prefiles are central.** Routes imported from Little Navmap
  (`.lnmpln`) or SimBrief become planned legs. An *active* trip
  automatically links a flight to its leg at takeoff.

## Operating Context

The web UI is used in three situations:

- **Planning sessions** — importing `.lnmpln` files or a SimBrief OFP,
  organising legs into trips, picking the active trip.
- **Second screen in flight** — Home's live panel (map, speed, altitude,
  heading) and the header status tag, glanced at while flying.
- **After-flight review** — browsing All Flights, flight and trip detail
  (track/replay maps, altitude profile, notes), exporting PDF/KML.

Phones and tablets are not a primary context for the app.

The project website (www.sabiaflightdb.com.br) serves a different reader: a
sim pilot deciding whether to install Sabiá. It has a main page (features,
the MCDU, development status) and the Sabiá Academy tutorials page. Both
exist in English and Brazilian Portuguese, and the two languages always
ship together. It is a static site hosted on Cloudflare Pages and uploaded
by hand. Its source lives outside this repo.

The simulator connects through the separate Sabiá MCDU desktop client
(https://github.com/oshogun/sabia_mcdu) on the Windows sim PC, which sends
telemetry and ACARS/OOOI messages using an ingest token. The server can run
on a different machine (Linux service, Windows service, Docker).

## Capabilities and Constraints

- Pages: Login, Home, All Flights, Prefiles, Flight detail, Trip detail,
  ACARS messages, Settings. Every signed-in page shares one shell: a header
  with the logo, a live status tag, the username and log-out, and a side
  nav that lists Home, All Flights, Prefiles, Settings and a tree of trips
  and their flights.
- Status tag vocabulary is fixed product language: *Sim not connected*,
  *Connected · Idle*, *Recording · <aircraft>*, *Paused · <aircraft>*,
  *Server unreachable*, *Checking...*.
- Maps (Leaflet) with navdata overlays, flight replay, altitude profile,
  PDF/KML export, print layouts.
- Settings: SimBrief Pilot ID, SayIntentions API key, ingest and MCP tokens
  (the secret is shown once), and the operator password.
- The logbook web app (`client/`) is React 18 + Vite on the IBM Carbon
  Design System (Gray 100 theme) with Montserrat. That stack belongs to the
  app only; its visual design is recorded in the repo-root `DESIGN.md`. The
  project website is a separate static site with its own visual design,
  recorded next to its source. Neither surface's look is recorded in this
  file.
- Destructive actions (delete, remove, skip) always confirm in a dialog.
- Terminology: *flight*, *trip*, *leg*, *prefile* / *planned leg*, *loose
  leg* (not in any trip), *active trip*, *MCDU*, *ingest token*.
- The `/device` page is an intentional easter egg, not product surface.
- macOS is not supported.

## Brand Commitments

- Name: **Sabiá** (with the accent), renamed from "msfslogger" in September
  2026. The rebrand only covers user-facing prose. Internal identifiers
  such as the `msfslogger.sid` cookie, localStorage keys and the npm package
  names stay unchanged on purpose.
- Logo: the user-supplied bird-plus-"SABIÁ" wordmark (`assets/sabia.svg`).
  `client/public/sabia-logo.svg` is a copy with the wordmark recoloured for
  dark backgrounds. The wordmark isn't legible at small sizes, so the
  header's accessible name comes from real text.
- License: GPL-3.0.

## Evidence on Hand

- A real logbook of the author's flights exists, but it is the live
  production database and must never be used directly — work only on
  scratch copies.
- Real Little Navmap plans: `samples/lnmpln/`.
- Logo assets: `assets/sabia.svg` and `client/public/sabia-logo.svg`.
- Website screenshots are taken from a fictional, seeded logbook
  (`/home/guilherme/sabia-site-shots/`), never from the real one.
- Website numbers (commit counts, releases, status) must come from git on
  the day they're published, never from memory or earlier copy.
- No testimonials, user counts, reviews or press exist. Never fabricate
  them.

## Product Principles

1. **The pilot flies, Sabiá writes.** Logging never needs attention. Any
   manual step is a fix-up, not a requirement.
2. **Their data, their machine.** Nothing may quietly require a cloud
   service. External integrations (SimBrief, SayIntentions) are opt-in.
3. **Plan, fly, review is one loop.** Trips and legs connect planning to
   the flown record. Surfaces should make that link visible.
4. **Glanceable in flight, thorough at the desk.** Live status must read
   at a glance. Review surfaces can be dense.
5. **Installable by a stranger.** Copy, errors and setup must make sense to
   someone who has never seen the code.
