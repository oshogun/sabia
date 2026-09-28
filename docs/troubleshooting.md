# Troubleshooting

## Server won't start

**`[Config] ...` printed, process exits immediately.**
Configuration failed validation before the database or listener were
touched. The message names the exact variable and problem — cross-reference
[configuration.md](configuration.md). Common cases: only one of
`TLS_CERT_FILE`/`TLS_KEY_FILE` set; a non-loopback `BIND_HOST` with no TLS
and no `ALLOW_PLAINTEXT_HTTP=1`; `INGEST_TOKEN` unset and
`ALLOW_UNAUTHENTICATED_INGEST` not set either; `SESSION_SECRET` set but
shorter than 16 characters.

**`[Auth] Refusing to start: no operator account exists.`**
Run `npm run set-password`. There is no HTTP-based first-run setup flow —
the account must exist before the server will listen at all.

**`better-sqlite3` throws on require, or the process fails with a native
module / ABI error.**
Wrong Node version. This project pins Node 24 (`.nvmrc`) because
`better-sqlite3` is a native addon and needs a Node ABI it has a prebuilt
binary for. Run `nvm use` (or `nvm install` first) before any
`node`/`npm`/`npx` command. If this happens on Node 24 itself, `node_modules`
likely has a stale native build from a previous Node version — delete
`node_modules` and reinstall rather than assuming `better-sqlite3` itself is
broken.

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
2. Its `ingestToken` matches the server's `INGEST_TOKEN` exactly. The server
   rejects a mismatch with `401` on every ingest request, and a wrong token
   fails the same way as a missing one.
3. If the server runs HTTPS with a self-signed certificate, the MCDU's
   `certPath` must point at that certificate file, or the connection is
   rejected. With a publicly trusted certificate, leave `certPath` `null`.

The MCDU's own [troubleshooting guide](https://github.com/oshogun/sabia_mcdu/blob/main/docs/troubleshooting.md) covers its side.

**The MCDU client and server were both reconfigured and it still doesn't work.**
Check that *both* sides picked up the change. The server must be restarted,
because a running process doesn't pick up new environment variables. The
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
extends it) or on server restart if `SESSION_SECRET` isn't set *and* the
generated secret somehow changed (it shouldn't — it's persisted in the
database, not regenerated per boot). A `401` on any `/api` call while the UI
is open bounces the client to `/login` automatically.

## Data

**A flight looks split into two entries with a gap.**
The MCDU client likely lost its connection to the server mid-flight (network
blip, server restart), or MSFS itself paused or hung in a way the client
recorded as a disconnect. Use "Combine flights" from the All Flights page,
then run `npm run backfill-icao` if the merged flight is missing
departure/arrival airport codes (combining doesn't re-resolve them).

**A flight's logged duration looks too short.**
Expected if the flight was paused, in the pause menu, or the MCDU client
reconnected after a drop — none of that time is counted (see
[architecture.md § Flight state machine](architecture.md#flight-state-machine)).
If the flight predates this behavior, `npm run backfill-durations` (dry-run
first) recomputes it.

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
Check the client's navdata state in `GET /api/navdata/status` (`sidecar`).

**The sidecar is stuck retrying `/api/navdata/rows`.** Read `server.log` for
`navdata: /rows rejected <status> <code>: <message>`: the message names the row,
table and column or the limit that refused the batch. A batch over 2000 rows is
accepted only if every row shares one `rev`; a body over 4 MiB is a `413`
(not logged yet).

**No Navdata panel on the maps.** The server has no replica (`GET /api/navdata/status`
returns `present: false`): the MCDU client has not uploaded a snapshot, or the
file is unreadable. Check the server log for `[Navdata]` lines and confirm
`NAVDATA_DB_PATH` points into a writable directory. In Docker, the
`./navdata` **directory** must exist and be mounted (a file bind-mount cannot be
swapped).

**The sidecar keeps getting `409 NAVDATA_SNAPSHOT_MISMATCH`.** The server holds a
different epoch (or none, for example after deleting `navdata.db`): the sidecar
resends a full snapshot. If it loops, check `/api/navdata/status` for
`snapshotId`.

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
appear only once the sidecar has fetched them for that airport or fix.

## Where else to look

- [configuration.md](configuration.md) — every environment variable.
- [api.md](api.md) — exact auth requirement and error shape per route.
- [security.md](security.md) — the auth/CSRF/token model, for anything that
  looks like an authorization bug rather than a config mistake.
