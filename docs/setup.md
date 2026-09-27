# Setup

Detailed local/dev setup. For the shortest path to a running instance, see
the [README](../README.md#quickstart) instead — this page covers the same
ground with more explanation, plus Docker and troubleshooting-adjacent notes.

## Required versions

| Tool | Version | Why |
|---|---|---|
| Node.js | **24** (pinned by [`.nvmrc`](../.nvmrc)), also declared via `engines.node` in `package.json` | `better-sqlite3` is a native addon; the pin keeps every contributor and CI on a Node ABI it has a confirmed prebuilt binary for. |
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
[configuration.md](configuration.md). The two you need for a first run:

| Variable | Required | Example |
|---|---|---|
| `INGEST_TOKEN` | Yes (unless `ALLOW_UNAUTHENTICATED_INGEST=1`) | `$(openssl rand -hex 24)` |
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

Loopback binds don't require TLS or a real ingest token:

```bash
export BIND_HOST=127.0.0.1
export INGEST_TOKEN=devtoken1234567890
npm run dev
```

This runs the server (`ts-node`, no build step) and the Vite dev server
together. Open `http://localhost:5173` — Vite proxies `/api` to the backend
on port 3000.

## Docker

Create the bind-mount targets before starting Compose — otherwise Docker
creates a *directory* named `flights.db` instead of using it as a file:

```bash
touch flights.db
mkdir -p flight_plans navdata
export INGEST_TOKEN="$(openssl rand -hex 24)"
export ALLOW_PLAINTEXT_HTTP=1   # trusted LAN only; prefer TLS in production
docker compose build
```

Create the operator account inside the container, then start it:

```bash
printf '%s\n' '<password>' | \
  docker compose run --rm -T msfslogger node dist/setPassword.js
docker compose up -d
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
   the server's `INGEST_TOKEN`, and a `certPath` if the server uses a
   self-signed certificate.
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
