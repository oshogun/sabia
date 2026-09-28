# Security

## Threat model

Sabiá is a self-hosted, single-operator application, typically exposed
on a home LAN (occasionally further, e.g. to reach a remote simulator PC or
the operator away from home). It has no multi-tenant isolation and doesn't
attempt any — the `auth_user` table is hard-constrained to exactly one row.
Treat any client that can reach the server's `/api` as either the operator
(via login) or a trusted telemetry source (via ingest token); there is no
concept of a lower-privileged authenticated user.

## Transport

The server will not silently serve plaintext HTTP to anything but a loopback
bind. Configure `TLS_CERT_FILE`/`TLS_KEY_FILE` for any LAN-reachable
deployment; the explicit `ALLOW_PLAINTEXT_HTTP=1` escape hatch exists for
trusted-LAN/dev convenience and should not be used for anything reachable
beyond that. See [configuration.md](configuration.md). There is exactly one
listener — no separate HTTP→HTTPS redirect port.

## Authentication

Three independent mechanisms, never mixed on the same request (see
[api.md § Auth model](api.md#auth-model-in-one-table) for which routes accept
which):

- **Session cookie** (`msfslogger.sid`) for the web UI: `httpOnly`,
  `sameSite=lax`, `secure` tied to whether TLS is actually enabled (never
  hard-coded true/false). `express-session`'s `regenerate()` runs before a
  successful login sets `req.session.user`, defeating session fixation.
  Sessions are stored in the database (not in-memory), so they survive a
  restart, and are swept for expiry every 6 hours.
- **Ingest token** (`x-ingest-token` header) for the MCDU client and other
  non-browser clients: compared with `crypto.timingSafeEqual` against a
  SHA-256 digest (not a plain string compare), so response timing doesn't
  leak how much of the token was correct. The accepted digests are the
  active tokens created on the Settings page — every one is compared, with
  no early exit on a match — or, only when none exist, `INGEST_TOKEN`'s
  (full rule in [configuration.md](configuration.md#tokens-created-on-the-settings-page)).
  The lookup happens on every request, so a revoke takes effect on the next
  one. With no ingest credential at all (and no
  `ALLOW_UNAUTHENTICATED_INGEST`) the server still starts, and every ingest
  request is rejected. A token only authorizes the
  explicit route allow-list in `src/auth/ingestScope.ts` — it is not a
  blanket credential for the whole API, and a valid session always takes
  precedence over token evaluation on a shared route.
- **MCP bearer token** (`Authorization: Bearer <token>`, checked against the
  active Settings-page MCP tokens, or `MCP_TOKEN` when none exist) for an MCP
  client at `/mcp` only — see
  [api.md § MCP server](api.md#mcp-server--srcmcp). Built the same way as
  the ingest token (its own SHA-256 digest, its own `timingSafeEqual`
  compare) but with **no shared code, table, digest, or constant** with
  the ingest token — deliberately, so that revoking or rotating one credential
  can never affect the other. `/mcp` is mounted outside `/api` and above
  `express-session`, so a request the MCP gate handles never allocates or reads a session,
  and `requireAuth`/`requireSameOrigin` never see it. Unlike the ingest
  allow-list, `MCP_SCOPED_ROUTES` gates nothing live at request time (every
  MCP tool calls an in-process function, never this server's own HTTP
  surface) — it's kept honest by a startup assertion instead: a tool
  declaring an unlisted route, or a read/write kind mismatch, fails server
  construction rather than shipping silently.

**Password storage**: scrypt (`N=16384, r=8, p=1`, 32-byte key, 16-byte
salt) via Node's built-in `crypto`, chosen specifically to avoid a second
native addon dependency (bcrypt/argon2). The stored format embeds the
parameters (`scrypt$N$r$p$<salt>$<key>`) so they can change later without
invalidating existing hashes. A wrong username is checked against a dummy
hash for a constant-ish time, so failed logins don't reveal whether the
username existed.

**Login throttling**: 10 failures per 15 minutes per client IP, in-memory
(not persisted — resets on restart), enforced *before* any database read.
`X-Forwarded-For` is deliberately ignored (`trust proxy` is not set) so it
can't be used to reset the throttle key or spoof `req.protocol`; if you run
Sabiá behind a reverse proxy, be aware the throttle (and same-origin
check) will key on the proxy's IP, not the real client's, unless you
configure Express's trust-proxy setting yourself — this repository doesn't.

The Settings-page password change (`POST /api/settings/password`) is throttled
the same way by a separate `LoginThrottle` instance, so a stolen session
cookie doesn't get an unthrottled oracle for the current password, and
failed attempts there never lock out the login page.

## CSRF

`requireSameOrigin` middleware rejects any `/api` write request whose
`Origin` header doesn't match the request's own scheme+host, as
defense-in-depth behind `SameSite=Lax` cookies. Requests with no `Origin`
header at all (scripted/curl clients, and token-only sidecar clients with no
session cookie present) are allowed through — same-origin checking is
meaningful against a browser, not against a client presenting the ingest
token directly.

## Secrets

| Secret | Source | Notes |
|---|---|---|
| Ingest tokens (Settings page) | generated by the server (`sbi_` + 32 random bytes, base64url) | Shown once, in the create response, then never again: only the SHA-256 digest is stored, in `ingest_tokens`. Listed by a separate random 8-hex-char id that reveals nothing about the secret. Revoke from the Settings page; takes effect on the next request. The list/create/revoke routes are session-only and never reachable with a token. |
| `INGEST_TOKEN` | operator-set env var, optional | Used only while no Settings-page ingest token is active. Shared verbatim between the server and the MCDU client (and any other ingest-scoped client). Rotate by changing it on the server first, then every client — see [operations.md](operations.md#deploy-ordering-server--mcdu-client). |
| MCP tokens (Settings page) | generated by the server (`sbm_` + 32 random bytes, base64url) | Same as ingest tokens, in the separate `mcp_tokens` table. |
| `MCP_TOKEN` | operator-set env var, optional | Bearer credential for an MCP client (see [api.md § MCP server](api.md#mcp-server--srcmcp)), used only while no Settings-page MCP token is active. With neither, `/mcp` behaves as if it weren't mounted. Revoke by unsetting or changing it and restarting — no other component needs updating in lockstep, unlike `INGEST_TOKEN`. |
| Session signing secret | `SESSION_SECRET` env var, or a random 32-byte value generated once and stored in the `app_secret` table | Set `SESSION_SECRET` explicitly if you want it independent of the database (e.g. to invalidate all sessions by rotating it without touching the DB). |
| Operator password | never stored in plaintext | scrypt hash only, in `auth_user`. Created via `npm run set-password`'s hidden prompt or piped stdin — never as a CLI argument, to avoid it appearing in `ps` output or shell history. Changed either the same way or on the Settings page (`POST /api/settings/password`): current password required, failures throttled like login, and on success every other session is deleted and the caller's session id rotated. |
| TLS private key | file on disk (`TLS_KEY_FILE`) | Optionally passphrase-protected (`TLS_KEY_PASSPHRASE`). Not read from the database. |
| SayIntentions API key | operator-entered, `app_setting` table (unencrypted, same trust boundary as everything else in `flights.db`) | Optional — see [api.md § SayIntentions](api.md#sayintentions--srcroutessayintentionsts). Never returned by the server in any response: `GET`/`PUT /api/settings/sayintentions` return only whether one is set and a fixed `'••••••••'` placeholder, never a character of the real value or even its length. Sent to SayIntentions itself as a query parameter on every upstream call (their API's own design, not ours). |

None of these are logged. Example/dev values shown elsewhere in this
documentation (e.g. `devtoken1234567890` for loopback dev) are not fit for
any deployment reachable beyond localhost — always generate a real value
(`openssl rand -hex 24`) for anything else.

## Data at rest

`flights.db` is an unencrypted SQLite file containing full flight history,
the operator's password hash, session data, and the SHA-256 digests (not the secrets) of Settings-page tokens. There is no field-level or
file-level encryption built in — rely on filesystem/disk-level protection
(permissions, disk encryption) if that matters for your deployment, and keep
backups (`npm run backup`, after `npm run build`) under the same protection as the live file.

An installer-managed instance ([setup.md](setup.md#installer)) keeps its
secrets in the install root. `sabia.env` holds `INGEST_TOKEN`, and
`certs/sabia.key` is the TLS private key, unencrypted. On Linux (and on macOS, which is unsupported) the
helper writes both with mode `0600`. On Windows they inherit the per-user ACL
of `%LOCALAPPDATA%`. The installer generates `INGEST_TOKEN` from 32 random
bytes and never regenerates an existing one. It verifies the Node download
against nodejs.org's `SHASUMS256.txt`, and a release bundle against its
`.sha256` asset. Both come from the same host as the file they check, so
they catch corruption, not a compromised host. A bundle passed with
`--bundle` is checked only if a `.sha256` sits beside it; otherwise the
installer warns and installs it unverified.

## Navdata sync endpoints

`/api/navdata/snapshot`, `/rows`, `/demand` and `/state` authenticate by
ingest token only and are mounted above the session middleware, so they never
allocate a session row; a session cookie is rejected on them, and the ingest token
is still rejected on every session route (the scope allow-list is unchanged).
Two properties worth knowing: the 4 MiB JSON parser for `/api/navdata/rows` runs
*before* the token check, so an unauthenticated caller can make the server parse
up to 4 MiB (every other path rejects at 100 kB); and snapshot uploads are staged
in a per-process temporary directory created with mode `0700` and deleted after
import. A snapshot with zero rows is refused when the replica already holds any (it would erase the replica in exchange for nothing). Rejected sync requests are logged at warning level without the token, request body or row values. `ALLOW_UNAUTHENTICATED_INGEST`, when it is the credential in force (no Settings-page ingest token and no `INGEST_TOKEN` — see [configuration.md](configuration.md#tokens-created-on-the-settings-page)), opens these four routes too, like `/api/ingest/*`. The replica may contain Navigraph-derived data: it is git-ignored and
docker-ignored and must never be committed or baked into an image. See
[navdata.md](navdata.md).

## Uploads

File uploads (`multer`) are size- and count-capped per route (attached
flight-plan PDFs: 20MB, PDF-only, verified by both MIME type and file magic
bytes, not extension alone; `.lnmpln` imports: 512KB each, up to 25 per
request, sniffed as XML before parsing). Oversized or excess uploads are
rejected with `400` by the app-level error handler, not left to Express's
default multipart handling.

## License

GPL-3.0 (see [`LICENSE`](../LICENSE)) — no bearing on runtime security, noted
here for completeness since it's not covered elsewhere in this documentation
set.
