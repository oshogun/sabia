# Development

## Repository layout

```
src/                  Express + TypeScript server
  routes/             One file per feature's HTTP routes
  db/                 One file per table; only place raw SQL is allowed to live
  auth/               Session, ingest-token, MCP-token, password, login-throttle logic
  mcp/                Optional MCP server: router, tool registry, the 18 read/write tools
  inspect-*.ts        ts-node CLI inspectors for eyeballing behavior against real data
  install/            Helper CLI the installers call (dist/install/cli.js): self-signed cert, env-file merge, port/health checks, pairing
client/               React + Vite web app on IBM Carbon (@carbon/react, Gray 100 theme)
  src/shell/          AppShell (header + side nav), SessionContext (auth), RequireAuth, live status, nav tree
  src/pages/          One component per route, most with a *.test.tsx beside it; page-private parts in pages/<page>/
  src/components/     Shared UI: maps/ (all Leaflet maps), replay/, charts/, legs/, modals, stat tiles
  src/api/            Typed calls per resource; mutations notify the nav tree to refresh
  src/print/          Headless PDF-export pages — separate entry, plain print.css, no Carbon
  src/hooks/          useStatus (live polling), useReplayClock (replay animation loop), navdata hooks
  src/utils/          api.ts (fetch wrapper), format.ts, geo.ts, replay.ts (replay engine)
  src/styles/         index.scss — the Carbon theme and the component styles the app uses
  scripts/            check-print-chunk.mjs (keeps Carbon out of the print bundle)
  e2e/                Playwright end-to-end specs, run against a scratch instance
tests/                Vitest suite — mirrors src/ for unit tests, tests/db/ for the db/ modules
samples/              Read-only fixtures (e.g. .lnmpln files) used by tests
packaging/            build-bundle.sh (release tarball), install.sh (Linux/macOS), install.ps1 (Windows)
docs/                 This documentation set
.claude/, .codex/, AGENTS.md, CLAUDE.md   Agentic-coding workflow config — not part of the runtime, see below
```

A Tauri/MCDU desktop client used to live in this repository at
`windows-client/`; it has moved to its own repository,
[`oshogun/sabia_mcdu`](https://github.com/oshogun/sabia_mcdu), and
isn't part of this tree. It is also the supported way to connect a simulator:
the standalone Node.js SimConnect agent that used to live at `agent/` was
retired on 2026-09-25, and its source is still in git history.

## Setting up

See [setup.md](setup.md) for the full bootstrap. Short version:

```bash
nvm use
npm install && (cd client && npm install)
npm run build
npm run set-password
```

## Testing strategy

`npm test` (Vitest) covers pure/near-pure decision logic: flight state
transitions and pause/duration handling (`src/flightManager.ts`), leg
matching (`src/legMatcher.ts`), hand-close rules (`src/plannedLegClose.ts`),
`.lnmpln`/SimBrief/ICAO parsing, and most of `src/db/*.ts` (`tests/db/`
covers `connection`, `flights`, `trips`, `plannedLegs`, `settings`,
`acarsMessages`, and `schema`/migrations — `groundSessions.ts` has no
dedicated test file yet, only indirect coverage via
`tests/flightManager.ground.test.ts`). It never touches the real
`flights.db`, the network, or a live server:

- `tests/setup.ts` points `FLIGHTS_DB_PATH` at a tmpdir path before anything
  else runs, and silences `console.*` output.
- Most test files mock `./db`/`./airports` at the module boundary
  (`tests/helpers/index.ts` provides the mock objects and fixture builders);
  a smaller set of tests (the four CLI scripts, and `tests/db/*`) use a real
  scratch SQLite database instead (`tests/helpers/db.ts`), never the
  repository's own `flights.db`.
- `restoreMocks: true` in `vitest.config.ts` only restores `vi.spyOn()`
  spies, not plain `vi.fn()` mocks — call `resetMocks()` from the helpers in
  `beforeEach`/`afterEach` if a test needs a clean mock between cases.

```bash
npm test            # run once
npm run test:watch  # watch mode
npm run test:types  # typecheck src/ + tests/ together (npm run build only typechecks src/)
```

`src/db/groundSessions.ts` (see above) is the clearest gap; a reasonable
place to add a dedicated test file before changing that module's logic.

Beyond Vitest: `npx tsc --noEmit` for a fast typecheck, `curl` against a
locally-run scratch server (different port, scratch database — never the
real `flights.db` or the port your own instance runs on), direct
`better-sqlite3` queries, and the `src/inspect-*.ts` CLI scripts
(`ts-node src/inspect-<name>.ts`) for behavior that's easier to check
against a real fixture than to assert on in a unit test.

### Frontend component tests

`client/src/pages/*.test.tsx` and the component tests beside them
(Vitest + React Testing Library, same `npm
test` runner as the backend suite, run from `client/`) cover page-level
behavior with the real fetch calls replaced by `mockFetchRoutes`
(`client/src/test/mockFetch.ts`) and rendered via `renderWithProviders`
(`client/src/test/renderWithProviders.tsx`) — no real server, no network.
Covers 8 of the 12 page components; the two easter-egg pages (`Device`,
`Override`) and the two headless print-export targets (`PrintFlight`,
`PrintTrip`) have no dedicated test file. The print pages are checked instead
by comparing exported PDFs against a baseline, and by `npm run
check:print-chunk` (below).

```bash
cd client
npm test            # run once
npm run test:watch  # watch mode
npm run test:types  # typecheck client/src + client tests
```

### End-to-end tests (Playwright)

`client/e2e/specs/*.spec.ts` drive a real browser against a real,
disposable instance of the app — the one place this project's test suite
does start a live server, deliberately isolated from the developer's own:

- `client/e2e/scratch-server.sh` provisions it: copies the repo into a
  scratch directory outside the tree (refuses to run inside the repo, and
  refuses port `3000` outright — both are hard guards in the script, not
  conventions), builds it there, seeds a deterministic fixture database via
  `src/testSeed.ts` (compiled into `dist/`, invoked as `FLIGHTS_DB_PATH=...
  node dist/testSeed.js` — idempotent, and refuses to run against a
  database that isn't either brand-new or already carries its own
  fixtures), and starts the server on a scratch port (`3210` by default).
- `npm run test:e2e` (from `client/`) runs Playwright against that instance;
  `npm run test:e2e:ui` opens Playwright's interactive UI mode for the same
  suite.
- Covers the journeys named in `specs/frontend_testing.md`:
  authentication, core data-visualization/interaction, and error/
  loading-state handling (`client/e2e/specs/auth.spec.ts`,
  `data-viz.spec.ts`, `error-states.spec.ts`, `smoke.spec.ts`), the
  flight replay panel (`flight-replay.spec.ts`), and the Carbon shell —
  navigation tree, confirm dialogs, session expiry, PDF export
  (`carbon-shell.spec.ts`).
- The server's PDF export starts Chrome, which puts a Unix socket in
  `TMPDIR`; keep `TMPDIR` short (the full socket path must stay under 108
  characters) or the PDF test fails with "Socket path too long".

Navdata tests (`tests/navdata*.test.ts`, client `Navdata*`/`RouteGeometry*`
tests) use **synthetic idents and coordinates only** — never real navdata, which
is licensed content (see [navdata.md](navdata.md#data-provenance-and-licensing)).
The procedure-key collision ordering is pinned by a shared fixture,
`tests/fixtures/navdata/approach-collision-vectors.json`, whose sha256 and length
the suite asserts; it is shared byte for byte with the MCDU repository, so neither
side edits it alone. The navdata schema in `src/navdata/schema.ts` is likewise the
MCDU repository's canonical file, adopted verbatim and pinned by sha256. Tests
build scratch databases in a temp directory and never touch `flights.db` or
the live server.

## CI

`.github/workflows/ci.yml` runs on every push and every pull request (no
branch filter, so tag pushes run it too), on Node 24 (from `.nvmrc`), as five jobs:

- **`build-and-test`**: `npm ci` (root and `client/`), then the same build
  `npm run build` does, split into steps: `tsc` in `client/` (typecheck),
  `vite build --manifest`, `npm run build:server`. Then the print-chunk guard
  (`npm run check:print-chunk` on that same build — fails if a Carbon or app
  module ends up in the `/print/` bundle), `npm run test:types` (root and
  client), `npm test` (root and client's component suite).
- **`docker`**: builds the `Dockerfile` image with Buildx (no push, GitHub
  Actions layer cache), in parallel with `build-and-test`, so a broken image
  build fails CI.
- **`e2e`** (depends on `build-and-test` passing first; the Playwright config
  retries a failed test once on CI): installs the
  Playwright Chromium browser, runs `cd client && npm run test:e2e` (with
  `MSFSLOGGER_E2E_SCRATCH` pointed at the runner's temp directory), and
  uploads Playwright's HTML report as a build artifact on success and
  failure both (skipped only if the job is cancelled), plus traces/
  screenshots/JUnit XML on failure only.
- **`release`** (runs only for pushed tags starting with `v`, after
  `build-and-test`, `docker` and `e2e` all pass; the only job with
  `contents: write`): checks the tag matches the `version` in `package.json`
  and `client/package.json`, and builds the release bundle with
  `packaging/build-bundle.sh`. It creates a GitHub Release from the
  annotated tag's message if none exists yet. Then it uploads the bundle,
  its `.sha256` and the two installers to that Release.
- **`publish-image`** (after `release`, tags only; the only job that logs in
  to Docker Hub, with the `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` secrets):
  builds the image for `linux/amd64` and `linux/arm64` (QEMU) and pushes
  `oshogun/sabia` tagged `X.Y.Z`, `X.Y`, `X` and `latest`. Branch pushes and
  pull requests never push an image. See
  [release.md](release.md#cutting-a-release).

`build-and-test` and `e2e` set `IBM_TELEMETRY_DISABLED=true` (the `Dockerfile`
sets it itself) so
Carbon's install-time telemetry never runs. There's no separate lint step and no coverage gate configured.

## Branching and review

This repository doesn't enforce a formal process (no `CONTRIBUTING.md`, no
PR template, no branch-protection config checked in). In practice, work
happens on short-lived branches prefixed by kind — `feat/...`, `fix/...`,
`docs/...` — merged into `main`, with CI required to pass. Treat that as a
convention to follow, not a hard rule this repo can enforce for you.

## Agentic coding workflow

If you're working in this repo via Claude Code or Codex, [`CLAUDE.md`](../CLAUDE.md)
(and its Codex mirror, [`AGENTS.md`](../AGENTS.md)) define an orchestrator/
sub-agent workflow with its own routing rules, run artifacts under
`.claude/runs/`, and cost-discipline conventions. That's tooling
configuration for AI-assisted development, not application behavior — this
page won't repeat it; start there directly if that's what you're looking
for.
