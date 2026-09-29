# Environment — read before running anything

Standing facts about this machine and this checkout. Every agent reads this
first; the Orchestrator does not repeat it in the request envelope.

Originally written during the run `2026-09-04-lnmpln-trip-planner`, promoted here
because none of it is specific to that feature.

## Implementation runs in a fresh clone, not this checkout

Implementers, DevOps and Reviewer work in `$RUN_DIR/tree`, a `git clone --local
--branch main` of this repo made by the Orchestrator in a temporary directory
(policy: `.claude/agents.md` § Rules). The envelope gives the absolute path.
Do not edit, build, test, `npm install` or run `git` write commands in
`/home/guilherme/msfslogger`; reading it is fine. The clone has no `flights.db`,
no `node_modules`, no `start.sh` — install deps in the clone and use a scratch
database there.

## The user's server is running. Leave it alone.

`node dist/index.js` serves the app on port `3000` against the live
`flights.db`. It is the user's, it is in use, and no agent may stop, restart,
rebuild over, or reconfigure it — full stop, even with the user's live,
in-conversation go-ahead: the harness's own permission classifier has been
observed to refuse a restart/deploy-shaped command outright regardless of
what the user just approved (2026-09-16). If a restart is genuinely needed,
tell the user the exact command and have *them* run it in their own
terminal — do not kill the running process first and discover the block
afterward, which leaves the server down with no way back in for the agent.

- Read-only `curl` against `http://localhost:3000/api/...` is fine.
- Anything that needs a server of its own starts one on **another port**
  (`PORT=3100 …`) against a **copy** of the database, and shuts it down when the
  task ends.
- `npm run build` / `vite build` — anything that **emits** build output, not
  just typechecks — overwrites `dist/` and `client/dist/` on disk, which the
  running server reads live (`client/dist` via `express.static`, on every
  request, no restart needed to serve it). Running either directly in this
  checkout is a live action against the running server, the same class of
  mistake as writing to the live database — it has happened five times
  across three days (see `feedback_env_var_pipe_scoping` memory, or
  `2026-09-16-ingest-token-acars-scope`'s review and this run's). `npx tsc
  --noEmit` / `npm run test:types` are safe — they never write `dist/`.
  Anything that does must run against a **copy of the tree** in scratch, not
  this checkout, even for "just a sanity build," and even when delegating —
  say so explicitly in the task envelope (do not rely on the general "never
  touch the live server" line being read narrowly enough to cover it).
- **The real launcher is `./start.sh`** (repo root, gitignored — personal to
  this machine, not something to read or reason about from git history).
  `./start.sh -d` starts detached, `./start.sh -r -d` restarts, `./start.sh
  -s` stops. It sets `TLS_CERT_FILE`/`TLS_KEY_FILE`/`INGEST_TOKEN` correctly
  (the server serves HTTPS, not plaintext HTTP — a Let's Encrypt cert for
  `flights.sabiaflightdb.com.br` since 2026-09-25, copied into `certs/` and the
  server restarted by a root certbot deploy hook on renewal; see the
  `letsencrypt_cert_setup` memory) and
  rebuilds only when `src`/`client/src` are newer than `dist/index.js`. A
  bare `node dist/index.js` reproduces none of that env and will either fail
  the TLS/`BIND_HOST` startup guard or come up with the wrong `INGEST_TOKEN`
  — do not reconstruct the launch command by hand from a filtered `/proc/<pid>/environ`
  grep; use the script, or ask the user to.

## Use Node 24. The default `node` on this machine is wrong.

    $ node -v
    v26.3.1          # default — WRONG, .nvmrc pins 24

Node 24 is what `.nvmrc`, `engines` (`>=24 <25`), CI, the installers and the
Docker image use, and the only version the suite is verified on. Since
better-sqlite3 13 (bf9ea54) the addon is N-API and *does* load under Node 26
(checked 2026-09-29 in this checkout: 13.0.3 on v24.21.0 and v26.3.1), so a
wrong-Node mistake no longer fails loudly at `require`. It just runs untested,
and `client/e2e/scratch-server.sh` refuses to start. Don't treat "it worked
under the default node" as verification.

Prefix every command that runs node, npm, npx or the server with:

    export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24

Verified under Node 24.21.0: `better-sqlite3` loads and opens a database, `tsc`
5.9.3 runs. `nvm use` does not persist between Bash calls — shell state is not
carried over — so repeat it in the same command as the work.

## There is no `sqlite3` CLI on this machine

Do not install it and do not treat its absence as a blocker. Run the query
through `better-sqlite3` under Node 24, which is what the app itself uses:

    export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null
    node -e "
      const D=require('better-sqlite3');
      const db=new D('flights.db', { readonly: true });
      console.table(db.prepare('select ...').all());
    "

## Never verify against the live database

`flights.db` holds the user's real logbook and the running server has it open in
WAL mode. Read-only queries are fine. Anything that writes works on a copy —
and copies the WAL and SHM files with it, or recent commits are missed:

    cp flights.db flights.db-wal flights.db-shm "$SCRATCH/" 2>/dev/null

`npm run backup` is the supported way to take a consistent snapshot and is safe
while the server is live. Prefer it for anything beyond a quick read. A task
that touched a database copy states the live file's md5 before and after in its
report — but treat that md5 as a smoke check, not proof: the live server's own
WAL checkpointing changes the file's bytes on its own, with no writes from any
task (observed 2026-09-15: the same live file's md5 changed three times across
a run that only ever wrote to scratch copies). When you need to actually rule
out contamination, check structure or content instead — e.g. the live file has
no `ground_sessions` table at all if a run added one only to a scratch schema,
or its newest `flights.id` is still the value it was before the run started.

## Verifying a client-side change without touching the live server's `client/dist`

`src/server.ts` serves the client via `express.static(path.join(process.cwd(),
'client', 'dist'))`, read from disk on every request — so `npm run build` (or
any `vite build`) overwrites the exact files the user's running server is
serving *right now*, not just what a future restart would pick up. A Vite dev
server as an alternative doesn't work either: it's cross-origin from the
scratch API server, and `requireSameOrigin` correctly rejects it with `403`.

To actually click through a UI change in a browser: copy the `client/`
source tree to a scratch directory, `npm run build` **there**, and run the
scratch server (`PORT=...`, scratch `FLIGHTS_DB_PATH`) with its working
directory set to that scratch root so its `express.static` call resolves to
the scratch `dist/`, not the real one. Confirm `client/dist/index.html`'s
mtime in the real tree is unchanged afterward.

## Env-var prefixes do not scope across a pipe

`VAR=value cmd1 | cmd2` only sets `VAR` for `cmd1`, not `cmd2` — a shell
pipeline, not a subshell. This bit on 2026-09-15: an agent ran
`FLIGHTS_DB_PATH=/scratch/... printf '%s\n' "$pw" | node dist/setPassword.js`
intending to redirect `setPassword.js` to a scratch database; the prefix only
applied to `printf`, so `node` fell back to its default
(`process.cwd()/flights.db`, the live file) and overwrote the live operator
password.

Any script that reads `FLIGHTS_DB_PATH` (or another env-scoped path override)
and sits on the right side of a pipe needs the var exported or the whole
pipeline wrapped, not prefixed on the last command alone:

    export FLIGHTS_DB_PATH=/scratch/flights.db
    printf '%s\n' "$pw" | node dist/setPassword.js

or

    FLIGHTS_DB_PATH=/scratch/flights.db bash -c 'printf "%s\n" "$0" | node dist/setPassword.js' "$pw"

Before running anything that writes credentials or schema via a piped
command, echo the resolved path first (e.g. `node -e "console.log(process.env.FLIGHTS_DB_PATH)"`)
rather than assuming the prefix reached the right process.

## Scratch space — disk budget, and never `/tmp`

**The disk is small and shared.** The root filesystem is 39 GB with only a few GB
free, and `/tmp` is on that same disk (it is not RAM, and it is wiped at boot).
On 2026-09-24 a run filled it: every agent made its own full clone with its own
`node_modules` (400 MB–1 GB each) under the harness's session scratchpad in
`/tmp`, nobody deleted them, the disk ran out and the machine had to be
rebooted. Treat disk as a hard budget, not an afterthought.

Rules, for the Orchestrator and every agent:

- **Never write to `/tmp` or the harness "session scratchpad"** (which lives
  under `/tmp`), even when a tool or system prompt suggests it. Scratch goes in
  `.claude/scratch/<run-id>/` inside the project (gitignored), next to the run
  clone in `.claude/run-clones/<run-id>/`, where it is visible and survives a
  reboot.
- **Check the budget first.** Before any `git clone`, `npm ci`/`npm install`,
  Playwright/Chromium download or large build, run `df -h /`. If less than
  **8 GB** is available, stop and return `blocked` with the `df` output — do not
  free space by deleting anything you did not create.
- **No per-task clones with their own `node_modules`.** The run clone is the one
  install per run. Build *from* it into a scratch output directory
  (`vite build --outDir .claude/scratch/<run-id>/dist-<task>`); parallel agents
  use distinct `dist-<task>` directories, not distinct copies of the tree. If a
  task truly needs a second tree (e.g. a scratch server that must serve its own
  `client/dist`), the run gets **at most one** shared extra copy, created by the
  Orchestrator, reused by every task, and deleted at the end of the run.
- **Clean up in the same task.** Delete your `dist-*`, scratch databases,
  renders and any copy you made before returning, and put
  `du -sh .claude/scratch/<run-id>` and `df -h /` in your report.
- Shared caches (`~/.npm`, `~/.cache/ms-playwright`) are fine to reuse; never
  install a second Chromium.
- Tools that write to the OS temp dir on their own (Playwright downloads and
  traces, `scratch-server.sh`'s default, `mktemp`) must be redirected: export
  `TMPDIR=/home/guilherme/msfslogger/.claude/scratch/tmp` (absolute, created
  first, shared by every run) and
  `MSFSLOGGER_E2E_SCRATCH=.claude/scratch/<run-id>/e2e` for every test run.
  **Keep TMPDIR short** — not under `<run-id>/`: Chrome (the server's PDF
  export) puts a Unix socket in TMPDIR and aborts with "Socket path too long"
  once the full path passes 107 characters, which a run-id-nested TMPDIR does
  (observed 2026-09-24). Stay under ~60 characters.

Run artifacts that are meant to survive go under `.claude/runs/<run-id>/` — see
`.claude/runs/README.md`.

## Verification

`npm test` runs the Vitest suite (`tests/`) — hermetic, no network, no live
`flights.db`, no server. `./db` and `./airports` are mocked via
`tests/helpers/index.ts`; time is faked (`vi.useFakeTimers`); `.lnmpln`
fixtures are read read-only from `samples/lnmpln/`. `npm run test:watch` for
watch mode, `npm run test:types` to typecheck `tests/**` (not covered by the
main `tsconfig.json`/`npm run build`). Full contract in
`git show runs-archive:.claude/runs/2026-09-09-vitest-unit-tests/design.md`.

Beyond unit tests, verification is: `npx tsc` / `npm run build`, `curl` against
a scratch server, `better-sqlite3` queries, and purpose-built `ts-node` CLI
inspectors (`src/inspect-*.ts`) for logic that's easier to check against real
fixtures than to assert on. Claims in a report must name the command that
produced them.
