---
name: update-ci
description: Add, change, or debug a step/job in .github/workflows/ci.yml (or add a new workflow file). Use for "add a step to CI", "CI is failing", "add caching/a new check to the pipeline", "wire X into CI". Unlike docs, CI already has an owner in .claude/agents.md (devops) — this skill picks the right tier for a CI-shaped change and gives the scratch-clone verification recipe specific to this repo's live-server hazards, so nobody debugs a workflow by pushing and watching Actions burn minutes. Not for docs (use update-docs) and not for a feature run that happens to include a CI task as one of several tasks (that's the standard loop, with devops as one of the implementers).
---

You are running the **update-ci** skill as the Orchestrator defined in
`.claude/agents.md`. This is a reference for CI-shaped work, not a
replacement loop — `devops` already owns `.github/workflows/**` in the
standard role table, so a CI change routes through the normal three tiers in
`CLAUDE.md` § "When the workflow applies". What this skill adds: which tier a
CI change usually is, the repo's specific CI hazards, and a verification
recipe that catches a broken workflow *before* it reaches GitHub Actions.

## Why verify locally before touching `.github/workflows/ci.yml`

A workflow YAML bug (wrong indentation, a step that references an env var
never set, a script that only works on the runner's clean checkout) is cheap
to catch locally and expensive to catch by pushing and watching a run fail —
each iteration costs CI minutes and round-trip time, and per
`.claude/agents.md`'s non-negotiables, sub-agents don't commit or push, so a
broken workflow that reaches `main` sits there until someone notices. Treat
every new or changed step the same way `2026-09-17-frontend-integration-tests`
treated the e2e job: run every command the workflow will run, by hand, in a
scratch clone, before considering the diff done.

## Tier for a CI change

- **Tier 1 — answer/fix directly.** A one-line fix: bump a pinned action
  version (`actions/checkout@v4` → `@v5`), fix a typo in a step `name:`,
  reorder two steps with no dependency between them, correct an env var name
  that's clearly wrong. No run id.
- **Tier 2 — one `devops` + one `reviewer`, `intake.md` only.** Adding a
  step or job that reuses an already-established pattern in this repo: another
  test-suite step, another `actions/upload-artifact` call, a lint/typecheck
  step, a cache step for an existing dependency install. Single seam, no new
  infrastructure contract. This is the common case.
- **Tier 3 — full loop, Design first.** The change introduces a pattern
  future CI work will build on: a new deploy target, a new secrets-handling
  approach, a self-hosted runner, a matrix build, or — as in
  `2026-09-17-frontend-integration-tests` §4 — a new kind of scratch resource
  (a database, a server, an external service) that CI needs to provision and
  tear down. Freeze the provisioning recipe in `design.md` before writing the
  workflow step, the same way that run froze the scratch-server contract
  before any implementer touched `ci.yml`. Use that run's `design.md` §4/§5
  as the reference shape for what "frozen" looks like here: exact env vars,
  exact ordering, exact teardown, prototyped and proven against the real app
  before being written down as a rule.

## This repo's CI-specific hazards

All from `.claude/ENVIRONMENT.md` — read it in full before writing a step,
this is the condensed version:

- **Never let a local verification command touch the user's live server or
  `flights.db`.** GitHub's own runners are ephemeral and fine to write to
  from the workflow itself; the hazard is entirely about the commands *you*
  run by hand in this checkout while developing the change.
- **`npm run build` / `vite build` overwrite `dist/` and `client/dist/`**,
  which the user's running server reads live off disk on every request —
  running either directly in this checkout, even "just to check the workflow
  step works," is a live action against the running server. Verify build
  steps in a scratch clone only.
- **Node 24 (the `.nvmrc` pin) via nvm for every command** — this machine's default `node` is a
  later major with no prebuilt `better-sqlite3` binary for its ABI:
  `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use` (reads `.nvmrc`) prefixed on
  everything, in the same command (shell state doesn't persist across Bash
  calls). `actions/setup-node` with `node-version-file: .nvmrc` already
  does this correctly inside the workflow — the guard is only for your local
  dry run.
- **Only one workflow file.** `.github/workflows/ci.yml` is the whole CI
  surface today. Add a job to it rather than a second file unless the user
  explicitly wants a separately-triggered pipeline (e.g. a schedule-only
  job) — a scattered set of workflow files with overlapping triggers is
  harder to reason about than one file with several jobs.

## The scratch-clone verification recipe

Same shape regardless of tier — scale the depth to the change's size.

```bash
# All CI work happens in a fresh clone of main, never in the live checkout
# (.claude/agents.md § Rules): edit the workflow and verify it there.
RUN_DIR=/home/guilherme/msfslogger/.claude/run-clones/<run-id>   # never /tmp — see ENVIRONMENT.md § Scratch space
git clone --local --branch main /home/guilherme/msfslogger "$RUN_DIR/tree"
cd "$RUN_DIR/tree" && git switch -c run/<run-id>

export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use
npm ci
(cd client && npm ci)
# then run, in order, exactly the commands the new/changed workflow step(s) run
```

If the change adds a job needing its own scratch resource (a server, a
seeded database), `client/e2e/scratch-server.sh` from this run is a working
example of a provisioning-and-teardown script written to be run identically
by a human locally and by a CI job — look at it and
`git show runs-archive:.claude/runs/2026-09-17-frontend-integration-tests/design.md` §4 before
inventing a new pattern.

Confirm afterward: the live checkout's `client/dist/index.html` and
`flights.db` md5s are unchanged (`.claude/ENVIRONMENT.md` has the caveat that
WAL checkpointing can change `flights.db`'s bytes on its own — compare
structure/content if the md5 moved, don't assume contamination from that
alone), and nothing is left listening on a port you opened.

## Reviewer brief for a CI diff

Whether tier 2 or tier 3, the Reviewer pass should specifically:

- Re-diff `.github/workflows/ci.yml` (and any other changed file) itself,
  not read the implementer's report of it.
- Confirm step/job ordering, `needs:`, working directory and env vars match
  what was intended (the task record, or the frozen design for a tier-3
  change) exactly.
- Confirm every new step runs only against the CI runner's own ephemeral
  checkout/port/DB — nothing could resolve to a real, persisted resource.
- Confirm a failure in the new step(s) actually fails the job (check
  `if:` conditions like `!cancelled()` vs `failure()` are the right choice
  for what they gate — a report-upload step should usually run on `
  !cancelled()` so it uploads even for a passing run; a debug-artifact step
  usually wants `failure()` only).
- Name, as a standing non-blocking residual risk (it will recur on every CI
  run in this repo until someone acts on it once): making the job(s) a
  required status check is a GitHub repository setting outside any workflow
  diff — `Settings → Branches → Branch protection rules → Require status
  checks to pass before merging` — and no workflow file can enable it.

## Committing

Same discipline as any Orchestrator commit: check `git status` for unrelated
in-progress work before staging (this repo regularly has other sessions'
uncommitted WIP sitting in the tree — see `git status` output, don't assume
everything unstaged belongs to your change), stage only the files this change
actually touched, and don't push unless asked.
