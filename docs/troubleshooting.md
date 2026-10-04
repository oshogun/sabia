# Troubleshooting

## Server won't start

**`[Config] ...` printed, process exits immediately.**
Configuration failed validation before the database or listener were
touched. The message names the exact variable and problem — cross-reference
[configuration.md](configuration.md). Common cases: only one of
`TLS_CERT_FILE`/`TLS_KEY_FILE` set; a non-loopback `BIND_HOST` with no TLS
and no `ALLOW_PLAINTEXT_HTTP=1`; `SESSION_SECRET` set but
shorter than 16 characters. (A missing `INGEST_TOKEN` is no longer one of
them — see the next entry.)

**`[Auth] WARNING: no ingest token exists …` at startup, and every ingest
request gets `401`.**
Neither `INGEST_TOKEN` nor a Settings-page ingest token exists, so the
server is up but rejects all telemetry; the MCDU can't connect. Log in,
create an ingest token under **Settings**, and paste its secret into the
MCDU's `ingestToken`. Settings shows a banner while in this state.

**`[Config] INGEST_TOKEN is not set - ingest accepts only tokens created on
the Settings page …` at startup.**
Informational, printed on every start without `INGEST_TOKEN` — the server
does not exit. It is logged before the database is opened, so it can't see
Settings-page tokens; if you have created one, ingest works and you can
ignore it. The `[Auth]` line logged after it reflects the real state.

**`[Auth] Refusing to start: no operator account exists.`**
Run `npm run set-password`. There is no HTTP-based first-run setup flow —
the account must exist before the server will listen at all.

**`better-sqlite3` throws on require, naming
`build/Release/better_sqlite3.node`.**
There is no prebuilt binary for this platform. `better-sqlite3` ships its
binaries inside the npm package for Windows, Linux (glibc and musl) and
macOS, each on x64 and arm64, and loads the matching one from `prebuilds/`.
Anywhere else it falls back to a local build. There isn't one: `package.json`
denies the package's `node-gyp` install step (`allowScripts`), so npm never
compiles it. Changing the Node version doesn't help, since the binary is
chosen by platform and CPU only; run Sabiá on one of the platforms above.

## Docker

**`flights.db` ends up as a directory instead of a file.**
Docker creates the bind-mount target if it doesn't exist, and creates a
directory when the source path doesn't already exist as a file. Always
`touch flights.db` (and `mkdir -p flight_plans navdata`) before the first `docker
compose up`.

## Installer

**The installer stops because the port is already in use.**
Something else is listening on the requested port. Pick another with
`--port` (`SABIA_PORT`), or stop the other program. On an upgrade the
installer checks the port before stopping the running server, so the old
server keeps running.

**The MCDU on another PC can't reach a Windows install.**
Check that the `SabiaServer-In` firewall rule exists: the installer creates
it only if you accepted the UAC prompt. Also check that the network is
classified Private (the rule doesn't apply to Public networks), and that you
didn't press Cancel on Windows' own "allow access" dialog, which adds a
blocking rule that wins over the allow rule. The installer prints the admin
commands for all three cases.

**The MCDU rejects the certificate after the server's IP changed.**
The self-signed certificate lists the LAN addresses the machine had at
install time. Re-run the installer with `--renew-cert` (and `--tls-san` for
any extra name), then copy the new `certs/sabia.crt` to the MCDU's
`certPath`.

**`install.sh` says to run it without sudo.**
The install is per-user by design. Run it as the user who should own the
service, without `sudo`.

## Sim client / connectivity

**Web UI shows `connected: false` while the MCDU client is running.**
Check these in order:

1. The MCDU's `serverUrl` (`CFG NETWORK`) is reachable and correct.
2. Its `ingestToken` matches a credential the server accepts **right now**,
   exactly: an active ingest token from the Settings page, or — only if none
   exists — `INGEST_TOKEN`. Creating the first Settings-page token makes the
   server ignore `INGEST_TOKEN` at once, and revoking a token rejects it on
   the next request; the Settings page shows which applies. The server
   rejects a mismatch with `401` on every ingest request, and a wrong token
   fails the same way as a missing one.
3. If the server runs HTTPS with a self-signed certificate, the MCDU's
   `certPath` must point at that certificate file, or the connection is
   rejected. With a publicly trusted certificate, leave `certPath` `null`.

The MCDU's own [troubleshooting guide](https://github.com/oshogun/sabia_mcdu/blob/main/docs/troubleshooting.md) covers its side.

**The header shows *Waiting for sim · &lt;aircraft&gt;* during a flight.**
The server stopped receiving data from the MCDU client mid-flight and is
holding the flight open. It waits up to 3 minutes from the last frame it
received. If frames from the same aircraft and place come back in that
time, the flight continues as one entry. Otherwise it is closed at the last
frame received (see
[architecture.md § Flight state machine](architecture.md#flight-state-machine)).
If the simulator itself is still running, check the client's connection as
in the entry above.

**The MCDU client and server were both reconfigured and it still doesn't work.**
Check that *both* sides picked up the change. After changing an env var
the server must be restarted, because a running process doesn't pick up new
environment variables (tokens created or revoked on the Settings page need
no restart). The
MCDU's uplink must be restarted too. See
[operations.md § Deploy ordering](operations.md#deploy-ordering-server--mcdu-client).

**`401 Invalid or missing ingest token` on a route other than
`/api/ingest/*`.**
The ingest token only authorizes an explicit allow-list of routes without a
session — see [api.md § Auth model](api.md#auth-model-in-one-table). A token
that's valid but hitting a non-allow-listed route still gets a generic `401`
with `X-Ingest-Token-Scope: accepted` on the response, which distinguishes
"right token, wrong route" from "wrong token" if you're debugging
programmatically.

## Web UI / auth

**`429` on login.**
10 failed attempts within 15 minutes from the same IP locks out further
attempts (`Retry-After` header gives the remaining seconds). This is
in-memory and per-process — it clears on server restart, not just after the
window elapses, if you truly need to bypass it during development.

**Logged out unexpectedly mid-session.**
Sessions expire after 30 days of inactivity (rolling — each request
extends the cookie; the server saves the new expiry at most once an hour, so
the server-side session can end up to 1 h before the cookie) or on server restart if `SESSION_SECRET` isn't set *and* the
generated secret somehow changed (it shouldn't — it's persisted in the
database, not regenerated per boot). A `401` on any `/api` call while the UI
is open bounces the client to `/login` automatically.

**Logged out on another device right after a password change.**
Expected: changing the password on the Settings page deletes every session
except the one you changed it from. Log in again with the new password.

**`429` when changing the password on Settings.**
The same 10-per-15-minutes throttle as login, counted separately — repeated
wrong "current password" attempts lock the password form, not the login page.

## Data

**A flight looks split into two entries with a gap.**
The server stopped hearing from the MCDU client mid-flight, and the data
that came back did not continue the flight. When no frame arrives for 10 s,
or the client sends a `disconnected` event, the server holds the flight open
for up to 3 minutes from the last frame. That happens with a network drop,
the client crashing or being killed, or MSFS hanging or pausing in a way
that stops the client's frames. The flight is split when the data:
- came back more than 3 minutes after the last frame;
- came back from a different aircraft (the aircraft name changed); or
- came back more than 5 nm from the last position, plus the distance the
  aircraft would have flown at its last ground speed when the sim was not
  paused.

A crash, or a frame reporting the sim not running, during the hold also
closes the flight. The held flight is closed at the last frame received,
and the frames that arrive later in the air start a new one.

A server restart does **not** split a flight: the restarted server resumes
the open flight on its first frame (see
[architecture.md § Flight state machine](architecture.md#flight-state-machine)).

Use "Combine flights" from the All Flights page. Then run
`npm run backfill-icao` if the merged flight is missing departure/arrival
airport codes (combining doesn't re-resolve them).

**A flight's logged duration looks too short.**
Expected if the flight was paused, in the pause menu or slewed, if the
server was restarted mid-flight, or if the simulator's data stopped for a
while and the flight then continued. None of that time is counted (see
[architecture.md § Flight state machine](architecture.md#flight-state-machine)).
If the flight predates this behavior, `npm run backfill-durations` (dry-run
first) recomputes it.

**A flight's logged duration looks too long after a server restart.**
A resumed flight doesn't count the outage, or any pause or slew from before
the restart. The exception is a flight that was already open when the server
was upgraded to the version that added `flight_points.after_interruption`.
Its earlier points carry no interruption mark, so on resume a pause or slew
shorter than about a minute from before the upgrade is counted again (see
[architecture.md § Flight state machine](architecture.md#flight-state-machine)).

**Takeoff didn't auto-link to the planned leg you expected.**
Leg matching requires: an active trip, a planned leg for that trip whose
departure is within 10nm of the actual takeoff position, that leg not
already flown/skipped/linked, and no other equally-close eligible leg (an
ambiguous match is never auto-resolved). Link it by hand from the flight
detail page if the automatic match didn't fire, or wasn't what you wanted.

**Load sheet / PDC generation returns `409`.**
`NO_DISPATCH_DATA` / `NO_FLIGHT_PLAN` means no SimBrief OFP has been
imported for that leg yet — those two ACARS features are generated from
on-file dispatch data, not invented from nothing.

## Navdata

**"Fetch detail" stays "Queued".** The request is stored (`navdata_requests` in
`flights.db`) and waits for the MCDU client to poll `/api/navdata/demand` and fetch
the airport from the simulator; it is cleared when the replica holds the airport's
detail or a record that the simulator does not have it. Nothing else can answer it.
Check the client's navdata state in `GET /api/navdata/status` (`sidecar`). While
Little Navmap data is shown the button is hidden and nothing is queued; requests
queued earlier wait until the simulator source is selected again.

**The sidecar is stuck retrying `/api/navdata/rows`.** Read `server.log` for
`navdata: /rows rejected <status> <code>: <message>`: the message names the row,
table and column or the limit that refused the batch. A batch over 2000 rows is
accepted only if every row shares one `rev`; a body over 4 MiB is a `413`
(not logged yet).

**No Navdata panel on the maps.** The server has no replica for the source being
shown (`GET /api/navdata/status` returns `present: false`): the MCDU client has
not uploaded a snapshot (and no Little Navmap import is selected), or the file
is unreadable. Little Navmap cannot be selected before something is imported;
if a selected import file goes missing, the map shows simulator data instead
(`sourceFallback: 'lnm-unavailable'`), so the panel is missing only when
there is no simulator replica either. Check the server log for `[Navdata]` lines and confirm
`NAVDATA_DB_PATH` points into a writable directory. In Docker, the
`./navdata` **directory** must exist and be mounted (a file bind-mount cannot be
swapped).

**The sidecar keeps getting `409 NAVDATA_SNAPSHOT_MISMATCH`.** The server holds a
different epoch (or none, for example after deleting `navdata.db`): the sidecar
resends a full snapshot. If it loops, check `/api/navdata/status` for
`snapshotId` — with the simulator source shown (`source: 'mcdu'`); while Little
Navmap data is shown, `snapshotId` is the import's, not `navdata.db`'s.

**`409 NAVDATA_SCHEMA_UNSUPPORTED`.** The two repositories are on different
navdata schema versions; update whichever is older. Also raised when a replica's
columns do not match the schema.

**`503 NAVDATA_BUSY`.** A snapshot is being imported or swapped; retry after the
`Retry-After` interval. Incremental rows are refused for the whole import.

**`400 NAVDATA_BAD_BATCH`.** Malformed batch, unknown column, or a child row
whose parent (e.g. a runway's airport) is not in the replica; the batch is rolled
back.

**A planned route is not expanded, or shows "custom procedure … not a simulator
procedure".** Custom departures/approaches are drawn from the runway once
airport detail has been fetched — use *Fetch detail*. Procedures and airways
appear only once the sidecar has fetched them for that airport or fix. With a
Little Navmap import shown, every airport already has its detail; a procedure
that is still missing is not in the imported file.

**A Little Navmap import is refused or fails.** The Settings tile shows the
message; the code is in `GET /api/navdata/lnm-import` (`job.error.code`) or the
refused request:

- `507 LNM_INSUFFICIENT_STORAGE` / `LNM_INSUFFICIENT_MEMORY` — free at least the
  upload size plus 1.25 GiB in the navdata directory, or 1 GiB of memory.
- `500 LNM_SPOOL_FAILED` — the upload could not be written into the navdata
  directory (check its permissions; the server log names the error code).
- `413 LNM_TOO_LARGE` — over 2 GiB; or a reverse proxy in front of the server
  answered `413` itself (raise its body limit, or put the file in the import
  folder and import it from there).
- `411 LNM_LENGTH_REQUIRED` — a proxy stripped `Content-Length`.
- `LNM_UPLOAD_ABORTED` — the page was closed or the connection dropped before
  the upload finished (also what a body still arriving after 1 h ends as).
  Upload the file again. The upload is not restarted for you: when Chromium
  resends an upload whose connection dropped, the server refuses the resend
  (`LNM_UPLOAD_REPEATED`, below). On an unreliable link, put the file in the
  import folder and import it from there.
- `409 LNM_UPLOAD_REPEATED` — the browser resent an upload the server had
  already started a job for, usually after *Cancel* or a dropped connection.
  The resend needs no action: no new job is created and the Settings page shows
  the first job's result. That is *Import cancelled.* after *Cancel*; after a
  dropped connection it is *Import failed* (`LNM_UPLOAD_ABORTED`, above), and
  you upload the file again. If you call the endpoint yourself, send a new
  `X-Upload-Attempt` id with every upload.
- `LNM_NOT_ATOOLS`, `LNM_UNSUPPORTED_SOURCE`, `LNM_EMPTY` — not a Little Navmap
  database, a `data_source` other than `NAVIGRAPH`/`MSFS`/`MSFS24`, or no
  airports in it.
- `LNM_INTERRUPTED` — the server stopped during the import; start it again.

**The file I put in the import folder is not listed.** Only regular files
directly in `dirname(NAVDATA_DB_PATH)` whose name ends in `.sqlite` and does not
start with `.` are listed (a symlink is not); in Docker that folder is
`./navdata` next to `docker-compose.yml`. Click *Refresh* after copying it.

**"Expired AIRAC — not for navigation".** The imported Navigraph dataset's
valid-through date has passed. Import a current file; the old one keeps working
for the map, but the warning stays.

## Where else to look

- [configuration.md](configuration.md) — every environment variable.
- [api.md](api.md) — exact auth requirement and error shape per route.
- [security.md](security.md) — the auth/CSRF/token model, for anything that
  looks like an authorization bug rather than a config mistake.
