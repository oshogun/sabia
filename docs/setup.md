# Setup

Detailed local/dev setup. For the shortest path to a running instance, see
the [README](../README.md#install) instead — this page covers the same
ground with more explanation, plus Docker and troubleshooting-adjacent notes.

## Required versions

| Tool | Version | Why |
|---|---|---|
| Node.js | **24** (pinned by [`.nvmrc`](../.nvmrc)), also declared via `engines.node` in `package.json` | The version CI, the installers and the Docker image run, and the only one tested. `better-sqlite3` is a native addon, but its N-API binaries aren't tied to one Node version. |
| npm | bundled with Node 24 | |
| Simulator | MSFS 2020, MSFS 2024, or FSX, on Windows | Only needed to actually log flights — the server/client run on any OS. |
| Docker + Docker Compose | any recent version | Only for the [Docker install](#docker) path. |

Always select Node 24 before running any `node`/`npm`/`npx` command in this
repo:

```bash
nvm install
nvm use
```

## Environment variables (minimum to start)

Full table with every variable, default, and description:
[configuration.md](configuration.md). The two that matter for a first run:

| Variable | Required | Example |
|---|---|---|
| `INGEST_TOKEN` | No — you can instead create an ingest token on the Settings page after logging in. Without either, the server starts but rejects all ingest (the MCDU can't connect) | `$(openssl rand -hex 24)` |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | Yes for a non-loopback `BIND_HOST` | see [HTTPS](#https) below |

## Bootstrap from zero

```bash
git clone git@github.com:oshogun/sabia.git
cd sabia
nvm install
nvm use

npm install
cd client && npm install && cd ..

npm run build
npm run set-password
```

`npm run set-password` prompts for a password on a hidden terminal line (or
reads it from piped stdin) and creates the single operator account. The
server refuses to start without one.

### HTTPS

The server serves TLS by default and will not fall back to plaintext HTTP
except on a loopback bind or with an explicit opt-in (see
[configuration.md](configuration.md#server--validated-by-srcconfigts)). For a
LAN-accessible install, generate a self-signed certificate whose SAN covers
however you'll reach the server (IP, hostname, or both):

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout certs/msfslogger-key.pem -out certs/msfslogger-cert.pem \
  -subj "/CN=msfslogger" \
  -addext "subjectAltName=IP:192.168.0.30,DNS:msfslogger.local"
```

```bash
export TLS_CERT_FILE="$(pwd)/certs/msfslogger-cert.pem"
export TLS_KEY_FILE="$(pwd)/certs/msfslogger-key.pem"
export INGEST_TOKEN="$(openssl rand -hex 24)"
npm start
```

The MCDU client and any other HTTPS client (browsers included, once) will
need to trust this self-signed certificate. In the MCDU, point `certPath` on
`CFG NETWORK` at it; see its [configuration guide](https://github.com/oshogun/sabia_mcdu/blob/main/docs/configuration.md).

### Development (loopback, no TLS)

Loopback binds don't require TLS. The dev ingest token below is only for
convenience — you can leave it out and create one on the Settings page:

```bash
export BIND_HOST=127.0.0.1
export INGEST_TOKEN=devtoken1234567890
npm run dev
```

This runs the server (`ts-node`, no build step) and the Vite dev server
together. Open `http://localhost:5173` — Vite proxies `/api` to the backend
on port 3000.

## Installer

`packaging/install.sh` (Linux) and `packaging/install.ps1` (Windows)
install a packaged release without a checkout, a build, or a system Node.
Packaged releases start with the first release after v1.0.0; v1.0.0 has no
bundle, and the installers say so.

```bash
curl -fsSL https://raw.githubusercontent.com/oshogun/sabia/main/packaging/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/oshogun/sabia/main/packaging/install.ps1 | iex
```

Each Release also carries both scripts as assets, for a pinned install.

### Supported platforms

| Platform | Status |
|---|---|
| Linux x64, glibc 2.28+ | Supported (`install.sh`) |
| Windows 10/11 x64 | Supported (`install.ps1`) |
| Docker `linux/amd64` | Supported (`oshogun/sabia`) |
| Linux arm64, Windows arm64, Docker `linux/arm64` | Expected to work, not yet tested on arm64 hardware |
| macOS 13.5+ | **Not supported.** `install.sh` has a macOS path (a per-user LaunchAgent), but it has never been run on a Mac. You can try it with no guarantee that it works; the installer prints a warning saying so. Docker is the fallback. |
| Linux with musl (e.g. Alpine) | Not supported natively: the official Node binaries need glibc. Use Docker. |

To try a prerelease, name it; the default install never picks one:

```bash
curl -fsSL https://raw.githubusercontent.com/oshogun/sabia/main/packaging/install.sh | bash -s -- --version 1.1.0-beta.1
```

```powershell
$env:SABIA_VERSION = '1.1.0-beta.1'; irm https://raw.githubusercontent.com/oshogun/sabia/main/packaging/install.ps1 | iex
```

### What it does

1. Downloads the latest Node 24 from nodejs.org into `<root>/node`, checked
   against `SHASUMS256.txt`. Your system Node is never used or changed.
2. Resolves the latest release (GitHub API, falling back to the
   `releases/latest` redirect). It downloads `sabia-server-X.Y.Z.tar.gz`,
   verifies it against its `.sha256`, and runs `npm ci --omit=dev`. That
   includes Chrome for PDF export (about 390 MB) unless you pass
   `--no-chromium`.
3. Writes `<root>/sabia.env`: `PORT`, `BIND_HOST`, `TLS_CERT_FILE`,
   `TLS_KEY_FILE`, `INGEST_TOKEN` (random, 64 hex characters),
   `NAVDATA_DB_PATH`, `PUPPETEER_CACHE_DIR`. It creates a self-signed
   certificate in `<root>/certs/` whose names cover `localhost`, the host
   name, `<hostname>.local`, `127.0.0.1`, `::1` and the machine's LAN IPv4
   addresses. Add more with `--tls-san`.
4. Asks for the operator password if no operator exists yet. It reads the
   terminal even under `curl | bash`, or `SABIA_OPERATOR_PASSWORD` /
   `--password-file` for an unattended install.
5. Registers a service (below), starts it, waits until it answers, and
   prints the pairing block: server URLs, `INGEST_TOKEN`, the certificate's
   path and SHA-256 fingerprint, plus the backup, password-reset and log
   commands. That `INGEST_TOKEN` stops being accepted once you create an
   ingest token on the Settings page — see
   [configuration.md](configuration.md#tokens-created-on-the-settings-page).

`install.sh` installs per-user and never uses `sudo`; it refuses to run
under `sudo`.

### Where things go

| OS | Default root | Service |
|---|---|---|
| Linux | `~/.local/share/sabia` (`$XDG_DATA_HOME/sabia`) | systemd user unit `sabia.service`; the installer enables linger so it starts at boot, not only at login (`--no-linger` to skip) |
| macOS (unsupported, untested) | `~/Library/Application Support/Sabia` | LaunchAgent `br.com.sabiaflightdb.sabia`, starts at login |
| Windows | `%LOCALAPPDATA%\Sabia` | Scheduled Task `\Sabia` at logon, running a hidden supervisor that restarts the server if it exits; falls back to a Startup-folder shortcut if the task can't be registered |

The root is the server's working directory, so `flights.db`,
`flight_plans/`, `navdata/`, `backups/`, `certs/` and `logs/` (macOS and
Windows) all live in it, next to the app.

The server listens on `0.0.0.0:3000` by default on every OS. On Windows the
installer also creates an inbound firewall rule `SabiaServer-In` (Private
networks, `<root>\node\node.exe`, the chosen port). It needs one UAC prompt,
shared with the task registration if that needs one too. If you decline, or
pass `-NoElevate`, an MCDU on the same PC still connects through
`https://127.0.0.1:<port>`. The installer prints the admin commands that open
the port to the LAN. It also warns when the active network is classified
Public, since the rule doesn't apply there.

### Options

Each option also has a `SABIA_*` environment variable. That is the only way
to pass options through `irm | iex`. With `curl | bash`, you can use either
the variables or `bash -s -- <flags>`:

```bash
curl -fsSL https://raw.githubusercontent.com/oshogun/sabia/main/packaging/install.sh | bash -s -- --port 3443
```

```powershell
$env:SABIA_PORT = '3443'; irm https://raw.githubusercontent.com/oshogun/sabia/main/packaging/install.ps1 | iex
```

| install.sh | install.ps1 | Variable | Meaning |
|---|---|---|---|
| `--version X.Y.Z` | `-Version` | `SABIA_VERSION` | Install this release instead of the latest (a prerelease such as `1.1.0-beta.1` too) |
| `--bundle PATH_OR_URL` | `-Bundle` | `SABIA_BUNDLE` | Install from this bundle instead of a release lookup |
| `--install-dir DIR` | `-InstallDir` | `SABIA_INSTALL_DIR` | Install root |
| `--port N` | `-Port` | `SABIA_PORT` | Port, 1024–65535 (default 3000, or the existing value) |
| `--bind-host HOST` | `-BindHost` | `SABIA_BIND_HOST` | Bind address (default `0.0.0.0`, or the existing value) |
| `--username NAME` | `-Username` | `SABIA_OPERATOR_USERNAME` | Operator username for a new install (default `operator`) |
| `--password-file FILE` | `-PasswordFile` | `SABIA_OPERATOR_PASSWORD_FILE` | Read the operator password from the file's first line |
| — | — | `SABIA_OPERATOR_PASSWORD` | The operator password itself (never a flag, so it stays out of `ps` and history) |
| `--tls-san a,b` | `-TlsSan` | `SABIA_TLS_SAN` | Extra certificate names or IPs |
| `--renew-cert` | `-RenewCert` | `SABIA_RENEW_CERT=1` | Regenerate the certificate (copy the new one to the MCDU afterwards) |
| `--no-chromium` | `-NoChromium` | `SABIA_NO_CHROMIUM=1` | Skip Chrome; PDF export won't work |
| `--no-service` | `-NoService` | `SABIA_NO_SERVICE=1` | Install files only, register no service |
| `--force` | `-Force` | `SABIA_FORCE=1` | Redo the install even if already current |
| `--uninstall` | `-Uninstall` | `SABIA_UNINSTALL=1` | Remove the service and the app, keep data |
| `--purge` | `-Purge` | `SABIA_PURGE=1` | With uninstall: delete the whole root |
| `--yes` | `-Yes` | `SABIA_YES=1` | Answer yes to confirmations |
| `--no-linger` | — | `SABIA_NO_LINGER=1` | Linux only: don't enable linger |
| — | `-NoElevate` | `SABIA_NO_ELEVATE=1` | Windows only: never ask for UAC (no firewall rule; autostart may fall back to the Startup folder) |

Boolean variables take effect only when set to `1`.

### Upgrading, uninstalling

Re-run the installer to upgrade. Before it stops the running server, it
downloads and checks the new release, prepares its config, and checks the
port. If any of that fails, the old server keeps running unchanged. It never
regenerates `INGEST_TOKEN`, so a paired MCDU keeps working, and it never
touches `flights.db` or its `-wal`/`-shm` files. If the new version doesn't
come up healthy, it restores the previous app, config and certificate, and
restarts the old version.

`--uninstall` (`-Uninstall`) removes the service, the firewall rule and the
app files. It keeps `sabia.env`, `flights.db*`, `flight_plans/`, `navdata/`,
`backups/`, `certs/` and `logs/`, so a later install picks up where it left
off. Adding `--purge` (`-Purge`) deletes the whole root after you type
`purge`, or with `--yes`.

## Docker

`docker-compose.yml` runs the published image
`oshogun/sabia:${SABIA_VERSION:-latest}` (tags `X.Y.Z`, `X.Y`, `X` and
`latest`, for `linux/amd64` and `linux/arm64`). You only need the compose
file, not a checkout. Create the bind-mount targets before starting Compose;
otherwise Docker creates a *directory* named `flights.db` instead of using it
as a file:

```bash
curl -fsSLO https://raw.githubusercontent.com/oshogun/sabia/main/docker-compose.yml
touch flights.db
mkdir -p flight_plans navdata
export INGEST_TOKEN="$(openssl rand -hex 24)"
export ALLOW_PLAINTEXT_HTTP=1   # trusted LAN only; prefer TLS in production
docker compose pull
```

Set `SABIA_VERSION=X.Y.Z` to pin a release instead of `latest`. Create the
operator account inside the container, then start it:

```bash
printf '%s\n' '<password>' | \
  docker compose run --rm -T msfslogger node dist/setPassword.js
docker compose up -d
```

To build the image from your checkout instead of pulling it, add the
override file, which sets `build: .` and tags the result `sabia:local`:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml build
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d
```

See [operations.md](operations.md#docker) for the production-hardening notes
(TLS mount, WAL-safe backups) before relying on this for real data.

## Connect the simulator

The supported path is the [Sabiá MCDU client](https://github.com/oshogun/sabia_mcdu), run on the Windows
machine that has the simulator (MSFS 2020/2024 or FSX):

1. Install it from its [latest Release](https://github.com/oshogun/sabia_mcdu/releases/latest)
   (the MSI or the `setup.exe`), or build it from source per its README.
   The installers are unsigned, so Windows SmartScreen warns on first run.
   The app runs its sidecar with the simulator PC's own `node`, so that PC
   needs Node 20 on `PATH` (or the client's `nodePath` setting pointing at
   one). MCDU 1.x needs this server at 1.0.0 or newer, and it
   installs alongside an old msfslogger client instead of upgrading it; see
   its [release notes](https://github.com/oshogun/sabia_mcdu/releases/tag/v1.0.0).
2. On `CFG NETWORK`, enter the server URL (`https://<server-address>:3000`),
   the ingest token, and a `certPath` if the server uses a self-signed
   certificate. The ingest token is either the server's `INGEST_TOKEN`, or —
   once you create any on the web UI's Settings page, which then replaces
   `INGEST_TOKEN` — the secret shown when you create one there (see
   [configuration.md](configuration.md#tokens-created-on-the-settings-page)).
3. Choose the simulator on `CFG SIM`.
4. Press `START>` on `STATUS`.

Full setup, including AI-traffic settings and auto-start, is in its
[configuration guide](https://github.com/oshogun/sabia_mcdu/blob/main/docs/configuration.md).

## Validate the setup

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24
npm run build
npm run test:types
npm test
npm start
```

Then, in another terminal:

```bash
curl -k https://localhost:3000/api/auth/session
# {"authenticated":false,"user":null}
```

A new contributor can get here using only this page and the
[README](../README.md).
