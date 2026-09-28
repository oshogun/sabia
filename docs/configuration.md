# Configuration

All configuration is via environment variables — there is no config file.
The server reads security-relevant variables in exactly one place,
`src/config.ts` (`loadConfig()`), and fails fast on a bad value: any
`ConfigError` is printed to stderr and the process exits before opening the
database or listening on a port. A handful of non-security variables are
read directly by the module they affect, noted below.

## Server — validated by `src/config.ts`

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP(S) listen port. |
| `BIND_HOST` | No | `0.0.0.0` | Listen address. Loopback values (`127.0.0.1`, `::1`, `localhost`) get relaxed plaintext-HTTP rules — see `ALLOW_PLAINTEXT_HTTP`. |
| `TLS_CERT_FILE` | No, but must be set together with `TLS_KEY_FILE` | — | Path to a PEM certificate. Setting only one of the pair is a startup error. |
| `TLS_KEY_FILE` | No, paired with `TLS_CERT_FILE` | — | Path to a PEM private key. |
| `TLS_KEY_PASSPHRASE` | No | — | Passphrase for an encrypted private key. |
| `ALLOW_PLAINTEXT_HTTP` | No (only consulted when TLS isn't configured) | off | Opt-in to serve plaintext HTTP on a non-loopback `BIND_HOST`. Without TLS *and* without this on a non-loopback host, the server refuses to start. Loopback hosts always get plaintext regardless of this value. Truthy values: `1`, `true`, `yes`, `on` (case-insensitive). |
| `INGEST_TOKEN` | No | — | Shared secret accepted on `x-ingest-token` for `/api/ingest/*`, the four `/api/navdata/*` sync routes, and the ingest-scoped API routes (see [api.md](api.md)). **Ignored while any ingest token created on the Settings page is active** — see [Tokens created on the Settings page](#tokens-created-on-the-settings-page). With neither this nor a Settings-page token, the server still starts, logs a warning, and rejects every ingest request with `401` until you create one. Recommended ≥16 characters (shorter values only warn). Must match the MCDU client's `ingestToken` exactly while it is the credential in force. |
| `ALLOW_UNAUTHENTICATED_INGEST` | No | off | Disables the ingest-token check entirely. Development/trusted-LAN only — see [security.md](security.md). If both this and `INGEST_TOKEN` are set, the token wins (with a startup warning). Also ignored while any Settings-page ingest token is active. |
| `SESSION_SECRET` | No | random, persisted in the DB | Signs the session cookie. If unset, a random 32-byte secret is generated once and stored in the `app_secret` table, so sessions survive a restart without one. If set, must be ≥16 characters. |
| `MCP_TOKEN` | No | — | Bearer token for the [MCP server](api.md#mcp-server--srcmcp) (`Authorization: Bearer <token>`). Ignored while any MCP token created on the Settings page is active. With neither, `/mcp` behaves as if it didn't exist (see [api.md](api.md#mcp-server--srcmcp)). Independent of `INGEST_TOKEN` — no shared digest, module, or allow-list — so rotating or unsetting one never affects the other. Recommended ≥16 characters and different from `INGEST_TOKEN` (shorter or matching values only warn, don't block startup). |

Example, generating a strong ingest token for the env var (the Settings page
generates its own — see below):

```bash
export INGEST_TOKEN="$(openssl rand -hex 24)"
```

## Tokens created on the Settings page

Ingest and MCP tokens can also be created and revoked in the web UI
(**Settings → Ingest tokens (MCDU) / MCP tokens**), with no env var and no restart.
Each token has a label; the secret (`sbi_…` for ingest, `sbm_…` for MCP, 32
random bytes base64url-encoded) is shown **once**, in the create response, and
only its SHA-256 digest is stored (`ingest_tokens` / `mcp_tokens`, see
[data-model.md](data-model.md)). The list shows each token's label, an
8-character random id unrelated to the secret, when it was created and when it
was last used (updated at most once a minute). At most 20 active tokens of each
kind.

The credential in force is decided on every request, first match wins
(`ingestAuthMode()` in `src/auth/ingestAuth.ts`, `mcpAuthMode()` in
`src/auth/mcpAuth.ts`):

| # | Condition | Ingest | `/mcp` |
|---|---|---|---|
| 1 | ≥1 active Settings-page token of that kind | Only those tokens; `INGEST_TOKEN` and `ALLOW_UNAUTHENTICATED_INGEST` ignored | Only those tokens; `MCP_TOKEN` ignored |
| 2 | Env token set | `INGEST_TOKEN` | `MCP_TOKEN` |
| 3 | `ALLOW_UNAUTHENTICATED_INGEST` | No check | — |
| 4 | Otherwise | Every ingest request `401` | `/mcp` passes through as if not mounted |

Consequences worth knowing:

- **Creating the first Settings-page ingest token disconnects an MCDU that is
  still using `INGEST_TOKEN`** — paste the new secret into its `ingestToken`
  (`CFG NETWORK`). The page asks for confirmation first.
- Revoking the last Settings-page token puts the env var (or the opt-out) back
  in force, immediately.
- Ingest and MCP tokens live in separate tables and are checked by separate
  code; neither kind ever authenticates the other's endpoint.

The page's `mode` field (`ui_tokens`, `env_token`, `unauthenticated`,
`closed`; `disabled` instead of the last two for MCP) reports which row
applies; see [api.md § Settings](api.md#settings--srcroutessettingsts).

## Server — read outside `config.ts` (not fail-fast validated)

| Variable | Default | Description |
|---|---|---|
| `FLIGHTS_DB_PATH` | `./flights.db` (relative to CWD) | SQLite database file path. |
| `NAVDATA_DB_PATH` | `./navdata.db` (relative to CWD) | Path of the navdata replica ([navdata.md](navdata.md)). A separate SQLite file from `flights.db`; safe to delete (the MCDU sidecar re-sends it). Its directory must be writable, because a snapshot is staged beside it and swapped in by rename — in Docker, mount the *directory*, not the file. |
| `EXPORT_BASE_URL` | `http(s)://127.0.0.1:${PORT}` (scheme follows TLS config) | Base URL the headless PDF renderer (Puppeteer) navigates to internally. Override only for advanced/dev setups (e.g. pointing exports at a Vite dev server). |
| `TRAFFIC_ENABLED` | on | Server-side opt-out for AI-traffic ingestion. `0`/`false`/`off`/`no` disables; anything else (including unset) leaves it on. **Independent of the MCDU client's own `trafficEnabled`** — both sides must be configured, setting one doesn't imply the other. |
| `POSITION_REPORT_INTERVAL_MIN` | `10` | Minutes between automatic ACARS position reports while flying a linked leg. `0` disables. Values between 0 and 0.5 are clamped to 0.5 (30s); unparseable or negative values fall back to the default. |
| `SIMBRIEF_API_BASE_URL` | SimBrief's public API | Test/dev seam — not normally set. |
| `WEATHER_API_BASE_URL` | `https://aviationweather.gov/api/data` | Test/dev seam — not normally set. |
| `SAYINTENTIONS_API_BASE_URL` | `https://apipri.sayintentions.ai/sapi` | Test/dev seam — not normally set. |

## Simulator side (MCDU client)

The simulator-side settings live in the
[Sabiá MCDU client](https://github.com/oshogun/sabia_mcdu) and are edited on its CDU pages, not on the server.
Its [configuration guide](https://github.com/oshogun/sabia_mcdu/blob/main/docs/configuration.md) is the source of truth. The settings that
must agree with this server are:

| MCDU setting (CDU page) | Must match / relates to |
|---|---|
| `serverUrl` (`CFG NETWORK`) | This server's base URL, e.g. `https://192.168.0.30:3000`. |
| `ingestToken` (`CFG NETWORK`) | A Settings-page ingest token's secret, or this server's `INGEST_TOKEN` when no Settings-page token exists — exactly. |
| `certPath` (`CFG NETWORK`) | Only for a self-signed server certificate; leave `null` with a publicly trusted one. |
| `trafficEnabled` (`CFG TRAFFIC`) | Read independently of the server's `TRAFFIC_ENABLED`. |

The retired `agent/` read these as `SERVER_URL`, `INGEST_TOKEN`,
`NODE_EXTRA_CA_CERTS`, `TRAFFIC_ENABLED`, `TRAFFIC_RADIUS_M` and `--sim`. The
MCDU configuration guide maps each one to its CDU field.

## Installer-managed instances

The one-line installers ([setup.md](setup.md#installer)) write these
variables to `<root>/sabia.env`. The service loads that file with Node's
`--env-file`, and the server reads `process.env` exactly as above. The
installer sets `PORT`, `BIND_HOST` (`0.0.0.0`), `TLS_CERT_FILE`/`TLS_KEY_FILE`
(its self-signed certificate under `<root>/certs/`), `INGEST_TOKEN`,
`NAVDATA_DB_PATH` (`<root>/navdata/navdata.db`) and `PUPPETEER_CACHE_DIR`
(`<root>/chrome`). `MCP_TOKEN` is present only as a comment, and
`SESSION_SECRET` is left for the server to generate. The file format is
Node's: `KEY=value`, no quotes, no `export`, and no `#` inside a value (Node
cuts the value there). When the installer launches the server it removes
these variables from its own environment, so a stray exported `PORT` or
`FLIGHTS_DB_PATH` in your shell can't override the file.

## Docker Compose

`docker-compose.yml` passes these through from the shell/`.env` — none are
baked into the image: `INGEST_TOKEN`, `MCP_TOKEN`, `TLS_CERT_FILE`,
`TLS_KEY_FILE`, `ALLOW_PLAINTEXT_HTTP`, `SESSION_SECRET`. Compose also sets `NAVDATA_DB_PATH=/app/navdata/navdata.db` and
mounts `./navdata:/app/navdata`. See
[setup.md](setup.md#docker) and [operations.md](operations.md).

## Validating your configuration

There's no `config check` command — configuration is validated implicitly by
starting the server:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use
npm start
```

A bad or missing value prints one or more `[Config] ...`-prefixed lines to
stderr and exits with status 1 before touching the database or opening a
port. A clean start prints `[HTTP] Server running at <scheme>://<host>:<port>`.
