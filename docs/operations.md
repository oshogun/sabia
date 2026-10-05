# Operations

## Running the server

An install made with the one-line installer already runs as a service; see
[Installer-managed instance](#installer-managed-instance). For a source
checkout, pick whatever process manager fits your host:

```bash
npm run build
npm start
```

`npm start` runs `node dist/index.js` in the foreground. Re-run `npm run
build` after pulling application changes (the client and server are both
compiled ahead of time; nothing rebuilds itself at runtime).

For unattended operation, wrap it in your process manager of choice (a
systemd service running `npm start` with `Restart=on-failure`, `pm2`, or a
`screen`/`tmux` session) — the server handles `SIGTERM`, `SIGINT` and `SIGHUP`
the same way (cancels a running Little Navmap import and removes its temporary
files, then closes the DB cleanly, checkpointing WAL), so any manager that
sends those signals on stop/restart is safe to use.

Closing the terminal that runs the server sends it `SIGHUP`, so the server
shuts down. `nohup` does not prevent this: `nohup` starts the program with
`SIGHUP` set to be ignored, and Node sets it back to the default as it starts,
so `nohup` has no effect here. To keep a server started from a shell running
after the terminal closes, start it detached from the terminal, for example,
from the repository root: `setsid npm start > sabia.log 2>&1 < /dev/null &`,
or inside `screen`/`tmux`.

### Installer-managed instance

Everything lives in the install root ([setup.md](setup.md#where-things-go)),
which is also the server's working directory. Configuration is
`<root>/sabia.env`, loaded with Node's `--env-file`. To change a setting,
edit it and restart the service, or re-run the installer with the matching
option. The installer merges options into the file and never regenerates
`INGEST_TOKEN`.

| | Linux (systemd user unit) | macOS (LaunchAgent; unsupported, untested) | Windows (Scheduled Task) |
|---|---|---|---|
| Status | `systemctl --user status sabia` | `launchctl print gui/$(id -u)/br.com.sabiaflightdb.sabia` | `Get-ScheduledTask -TaskName Sabia` |
| Restart | `systemctl --user restart sabia` | `launchctl kickstart -k gui/$(id -u)/br.com.sabiaflightdb.sabia` | re-run the installer, or log off and on |
| Logs | `journalctl --user -u sabia -f` | `<root>/logs/sabia.log` | `<root>\logs\sabia.out.log`, `sabia.err.log` |

On Windows the task runs a hidden PowerShell supervisor
(`<root>\bin\sabia-service.ps1`) that restarts `node.exe` with a growing
back-off if it exits. Its process IDs are in `<root>\run\supervisor.pid`
and `node.pid`. To stop the server by hand, stop those two processes by ID.
Stopping the task alone may leave `node.exe` running.

The npm scripts aren't usable in an installed root, since there's no system
Node or npm there. Run the installed Node directly, from the root, with the
env file:

```bash
cd ~/.local/share/sabia        # or your install root
./node/bin/node --env-file=sabia.env dist/backup.js
./node/bin/node --env-file=sabia.env dist/setPassword.js
```

```powershell
Set-Location "$env:LOCALAPPDATA\Sabia"
.\node\node.exe --env-file=sabia.env dist\backup.js
.\node\node.exe --env-file=sabia.env dist\setPassword.js
```

The installer prints these commands with your actual root at the end of
every install. The maintenance scripts below (`backfill-*`) run through
`ts-node` from a source checkout and aren't part of the bundle.

### Docker

```bash
docker compose pull            # the published image, oshogun/sabia
docker compose up -d
docker compose logs -f
docker compose down
```

`docker-compose.yml` runs `oshogun/sabia:${SABIA_VERSION:-latest}`, published
for `linux/amd64` and `linux/arm64` on every release
([release.md](release.md#cutting-a-release)). `docker-compose.build.yml` is an
override that builds from your checkout instead (`build: .`, tagged
`sabia:local`): pass both files with `-f`. The production image (see
[`Dockerfile`](../Dockerfile)) is a 3-stage Alpine build. The client and
server stages run on the build machine's own platform, since their output
is plain JavaScript. The runtime image has system Chromium (for PDF export
via Puppeteer) and no build toolchain: `better-sqlite3` loads the musl
binary that ships inside its npm package (`linuxmusl-x64` or
`linuxmusl-arm64`). `docker-compose.yml` bind-mounts `flights.db`,
`flight_plans/` and the `navdata/` directory for persistence (`./navdata` also
holds the Little Navmap replica and is where you drop a `.sqlite` to import)
and passes
`INGEST_TOKEN`, `MCP_TOKEN`, `TLS_CERT_FILE`, `TLS_KEY_FILE`,
`ALLOW_PLAINTEXT_HTTP`, `SESSION_SECRET` through from the shell/`.env`. Mount
`./certs:/app/certs:ro` (commented out by default in the compose file) if
using TLS in the container.

## Monitoring

There's no metrics/health-check endpoint beyond the same `GET /api/status`
the UI polls — treat a `200` response as "up," and its `connected`/
`flightState` fields as the live simulator-link state. There's no
`/healthz`-style endpoint separate from this.

## Logs

See [usage.md § Logs](usage.md#logs) — stdout/stderr only, bracketed
component prefixes, no log rotation built in. Capture and rotate via your
process manager or shell redirection.

## Backups

```bash
npm run backup
```

(`npm run backup` runs the compiled `dist/backup.js`, so build first. On an
installer-managed instance, use the direct command in
[Installer-managed instance](#installer-managed-instance).)

Writes a timestamped, WAL-consistent snapshot to `./backups/<timestamp>/`
(or a path given as the first argument), using `better-sqlite3`'s online
backup API rather than a naive file copy — a plain `cp flights.db` can miss
data still sitting in `flights.db-wal` if the server is running. The script
also verifies the copy opens and runs `PRAGMA integrity_check`, and copies
`flight_plans/` (attached PDF flight plans) alongside it. Safe to run while
the server is live; suitable for cron. The navdata replicas are not included:
the MCDU client re-sends `navdata.db`, and `navdata.db.lnm` is rebuilt by
importing its Little Navmap `.sqlite` again, so keep that file somewhere safe.

```bash
npm run backup -- /path/to/destination
```

## Restoring

There's no dedicated restore script — stop the server, replace `flights.db`
(and `flight_plans/`, if restoring attachments) with the backed-up copies,
and start the server again. Because backups are taken via the online-backup
API, a backed-up file has no stray `-wal`/`-shm` siblings to worry about.

## Maintenance / backfill scripts

Run these after an upgrade that changes how a derived value is computed, or
after data changes that leave stale derived columns:

| Command | Purpose |
|---|---|
| `npm run backfill-icao` | Fills in missing `departure_icao`/`arrival_icao`/`*_name` on flights that have coordinates but no resolved airport (e.g. after combining flights, which doesn't recompute these). |
| `npm run backfill-durations` | Recomputes `duration_sec` from the recorded track for flights logged before gap-based duration accounting existed. **Dry-run by default** — prints a diff, only for flights differing by more than 2 minutes; pass `--apply` to write. It checks every flight, not just old ones, and uses only the 60 s gap rule: it ignores `flight_points.after_interruption`. On a flight whose short pauses or slews add up to more than 2 minutes, it therefore proposes a longer duration than the recorder stored. Read the dry-run diff before passing `--apply`. |

Both are idempotent to re-run and safe against a live server (they only
touch rows that need correcting).

## Resetting the operator password

If you can still log in, change it on the web UI's **Settings** page
(current password required; your other sessions are logged out). If you
can't, reset it from the command line:

```bash
npm run set-password
```

(On an installer-managed instance: `./node/bin/node --env-file=sabia.env dist/setPassword.js`
from the install root.) Prompts for a new password (hidden input, or piped stdin) and overwrites the
single operator account. Takes effect immediately — no restart needed, since
the script opens its own short-lived database connection.

## Rotating an ingest token

With tokens created on the Settings page, no restart is involved:

1. Create a new ingest token on **Settings** and copy its secret (shown once).
2. Paste it into the MCDU's `ingestToken` on `CFG NETWORK`.
3. Revoke the old token on **Settings**. It stops working on the next request.

If you're still on `INGEST_TOKEN`, creating the first Settings-page token
switches the server to Settings-page tokens immediately, and the MCDU is
rejected until step 2 — see
[configuration.md](configuration.md#tokens-created-on-the-settings-page).
MCP tokens rotate the same way, with no restart.

## Deploy ordering (server + MCDU client)

When rotating `INGEST_TOKEN` (the env var) or turning TLS on/off, change the server first:

1. Set or update `INGEST_TOKEN` and the TLS cert/key.
2. Restart the server.
3. *Then* update the MCDU client's `serverUrl`, `ingestToken` and `certPath`
   on `CFG NETWORK`, and restart its uplink.

If the MCDU client "stopped working" right after a server config change,
check the redeploy order before debugging anything else.

## Data locations

Paths are relative to the server's working directory: the checkout, the
install root, or `/app` in the container.

| Path | Contents |
|---|---|
| `flights.db` (+ `-wal`/`-shm` while running) | All application data — see [data-model.md](data-model.md) |
| `navdata.db` (+ `-wal`/`-shm`; in Docker under the `./navdata` directory; `<root>/navdata/` on an installer-managed instance) | Replica of the MCDU client's navdata. Rebuildable: not part of `npm run backup`, and safe to delete — see [navdata.md](navdata.md) |
| `navdata.db.lnm` (+ `-wal`/`-shm`, beside `navdata.db`) | Replica built by a Little Navmap import. Not part of `npm run backup`; deleting it means importing again, so keep the `.sqlite` it came from — see [navdata.md § Little Navmap import](navdata.md#little-navmap-import) |
| `*.sqlite` beside `navdata.db` | Little Navmap databases you placed there for a server-side import (Navigraph-licensed when they come from Navigraph). Never deleted by the server. `navdata.db.incoming-*`, `navdata.db.lnm.incoming-*` and `navdata.db.lnm.upload-*` files there are temporary import files, deleted at the next startup if a crash left them |
| `flight_plans/` | Attached PDF flight plans (uploaded per-flight) |
| `certs/` | TLS certificate/key, if you keep them in-repo (gitignored by default) |
| `sabia.env`, `node/`, `logs/`, `.sabia-install` | Installer-managed instance only: config, private Node 24, service logs (macOS/Windows), install marker |
| `backups/<timestamp>/` | Output of `npm run backup` |

None of these are safe to `git commit` — treat them as runtime state.
