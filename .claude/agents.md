# Agentic Workflow

**Who reads this file: the Orchestrator.** Sub-agents do not. Each role file in
`.claude/agents/` is self-contained by design — it carries the role's rules and
its response envelope — so an implementer that opens this document is paying for
context it was already given. The only shared file every agent reads is
`.claude/ENVIRONMENT.md`.

## Overview

A single **Orchestrator** agent owns the conversation with the user, decomposes
work, and delegates each unit of work to a specialized sub-agent. Sub-agents
never talk to the user directly: they return structured results to the
Orchestrator, which validates, merges, and decides the next step.

```
        ┌──────────────┐
  user ─▶│ Orchestrator │◀── final report
        └──────┬───────┘
   ┌───────┬───┴────┬───────────────────────┬──────────┐
   ▼       ▼         ▼                      ▼          ▼
Planner Designer  Implementer            DevOps    Reviewer
                (backend_jr/sr,
                 frontend_jr/sr)
```

## Roles

| Agent | Responsibility | Must produce |
| --- | --- | --- |
| **Orchestrator** | Owns the goal, splits it into tasks, picks the agent, enforces the loop, reports back to the user. | Task graph + final summary |
| **Planner** (`sonnet`) | Turns a fuzzy goal into an ordered, dependency-aware task list with acceptance criteria. | `plan.json` (tasks, deps, DoD) |
| **Designer** (`opus`) | Defines architecture, module boundaries, data models, API/UX contracts. No implementation. | Design doc + interface stubs |
| **Backend Jr** (`sonnet`) | Single-seam backend implementation: one module, no new contract. Files: `src/**`, `tests/**`. | Diff + evidence |
| **Backend Sr** (`sonnet`) | Cross-cutting or contract-adjacent backend implementation: schema changes, migrations, logic spanning several modules. Same files as Backend Jr. | Diff + evidence |
| **Frontend Jr** (`sonnet`) | Single-seam frontend implementation: one component, no new contract. Files: `client/**`. | Diff + evidence |
| **Frontend Sr** (`sonnet`) | Cross-cutting or contract-adjacent frontend implementation: new pages/routes, cross-component state, API-consuming changes. Same files as Frontend Jr. | Diff + evidence |
| **DevOps** (`sonnet`) | Build, packaging, CI/CD, environment, secrets, deployment, observability. | Pipeline changes + deploy status |
| **Reviewer** (`opus`) | Reviews diffs against the design and acceptance criteria; checks security, regressions, style. | Verdict `approve` / `request_changes` + findings |

Backend and frontend never share a task: a task's `allowed_paths` sit entirely
in one domain, and the Planner (or the Orchestrator, for tier-2 work) picks the
matching agent — Jr by default, Sr when the task is a schema change, a
migration, a new page/route, cross-module or cross-component reasoning, or
otherwise ambiguous enough to be worth a second pair of judgement. Naming the
agent by domain and seniority, rather than routing through a generic
Dispatcher, is deliberate: it makes token usage groupable by role straight from
the Agent tool's own invocation record, with no extra spawn spent classifying
the task.

## Cost discipline

A sub-agent starts cold. Everything it knows, it re-read — and it re-reads it on
every spawn. In the `2026-09-07-manual-mark-flown` run, `plan.json` and
`design.md` together came to 131 KB; an implementer that opened both spent
roughly 30k tokens before writing a line, and ten spawns spent it ten times.
These rules exist to stop that, and they bind the Orchestrator first because it
is the Orchestrator that fills the envelope.

**1. Pass slices, never whole artifacts.** `.claude/tools/ctx.sh` extracts them:

```
ctx.sh map    <run-id>                  index: goal, phases, task ids, design headings
ctx.sh task   <run-id> T-004            one task record            (5 KB, not 62 KB)
ctx.sh phase  <run-id> 1                a phase and its tasks
ctx.sh design <run-id> 3 5.2 must-not-change   named sections      (4 KB, not 69 KB)
ctx.sh frozen <run-id>                  frozen_decisions, verbatim
```

The Orchestrator **pastes the task record verbatim into the envelope** — it
already has it — and names design sections by number. An agent told to read
`design.md` reads 69 KB; an agent told `ctx.sh design <run> 3 5` reads 4.

**2. One spawn is the unit of cost, so spawn fewer.** Batch consecutive tasks
that share an owner, an implementer role, and a dependency chain into one
implementer agent when their `allowed_paths` do not collide with a parallel
task. Two tasks on the same file in the same phase are one agent, always. A
backend task and a frontend task never batch into one spawn, even if
sequential — different domain means a different agent. Reserve parallel spawns
for work that is genuinely independent — parallelism buys wall-clock, not
budget, and each extra agent re-reads its whole context from scratch.

**3. Skip the steps a run does not need.** Design is for runs that introduce a
contract — a schema change, a new endpoint, a shared type. A run that adds a
button to an existing endpoint does not need a freeze, and DevOps is for runs
that touch build, packaging or deploy. Skipping a step is a decision the
Orchestrator records in `intake.md`, not something it does silently.

**4. Evidence is quoted, not pasted.** Reports and reviews cite the command and
the lines of output that decide the question — a `tsc` run that passes is one
line, not eighty. Cap a report at ~150 lines; if the raw output matters, leave it
in a file under `reports/` and cite the path. The 41 KB review is the artifact
this rule is aimed at.

**5. The Reviewer does not read the report it is checking.** Its own doctrine is
that the implementer's report is not evidence. Reading 30 KB it is required to
distrust is the worst line item in the run. It reads the diff, the criteria and
the report's `risks` list — nothing else.

**6. Tier the work.** Not everything is a run:

| Work | Path |
| --- | --- |
| Question, investigation, one-line fix, doc typo | Orchestrator answers directly. No run id, no artifacts. |
| A change with one seam — one module, no new contract | One implementer (Jr) + one Reviewer. `intake.md` only. |
| Feature work: several files, a schema or API change, something the user sees | The full loop below. |

Spinning up a Planner for a two-line change is the failure mode. So is running
the full loop on the workflow's own config.

## Delegation contract

Every hand-off uses the same envelope.

**Request (Orchestrator → agent)**

```json
{
  "task_id": "T-004",
  "role": "backend_sr",
  "goal": "Implement flight log persistence layer",
  "task_record": { "…the task object from plan.json, pasted verbatim…" },
  "context": ["ctx.sh design 2026-09-07-run 4 6.2", "src/db.ts"],
  "constraints": ["no new runtime deps", "keep public API stable"],
  "acceptance_criteria": ["…verbatim from the task record…"],
  "allowed_paths": ["src/storage/**"]
}
```

`task_record` and `acceptance_criteria` are pasted in full so the agent never
opens `plan.json`. `context` lists exact commands or paths — never a bare
document name, and never "as discussed".

**Response (agent → Orchestrator)**

```json
{
  "task_id": "T-004",
  "status": "done | blocked | needs_input",
  "artifacts": ["src/storage/log_store.py"],
  "summary": "…",
  "risks": ["…"],
  "next_suggested_role": "reviewer"
}
```

## Standard loop

For tier-3 work only — see Cost discipline rule 6.

1. **Intake** — Orchestrator restates the goal and success criteria, and records
   which steps this run skips and why.
2. **Plan** — delegate to Planner; store `plan.json`.
3. **Design** — delegate to Designer *if the run introduces a contract*; freeze
   before code is written.
4. **Implement** — first create the run's fresh clone of `main` in a temporary
   directory (Rules § "All implementation happens in a fresh clone"), then
   delegate to the implementer agents (`backend_jr`, `backend_sr`, `frontend_jr`,
   `frontend_sr`), batched per rule 2. Nothing is written to the live repo.
5. **Review** — every implementer and DevOps result goes to Reviewer before
   merge, at phase granularity. `request_changes` sends the task back to the
   same implementer agent (max 3 rounds, then escalate to the user).
6. **Ship** — delegate to DevOps *if the run touches build, packaging or deploy*.
7. **Report** — Orchestrator summarizes outcome, residual risks, follow-ups.

## Rules

- One task, one agent, one owner at a time.
- **Nothing is frozen until it has been executed.** Before a command or
  standing rule goes into `intake.md`, `design.md`, `plan.json`,
  `ENVIRONMENT.md` or a user-facing report, run it or dry-run it. If it runs a
  script, read that script. Write the proving command next to it. This applies
  to deploy, rollback and restart commands aimed at the user, to environment
  rules every agent will follow, and to the scratch paths in envelopes. In
  `2026-09-23-carbon-migration`, three unexecuted items slipped through:
  - The plan's deploy note `cd client && npm ci && ./start.sh -r -d` was
    carried verbatim through the plan and three reviews. It could never work:
    `start.sh` lives at the repo root and installed nothing.
  - A new `TMPDIR` rule broke the PDF e2e test, because Chrome's socket path
    has a 107-character limit. A reviewer lost time diagnosing it.
  - `start.sh -r` stopped the live server before building, so the user
    watched it be down for the whole build.

  A reviewer who sees a user-facing command in a report checks it the same
  way (see `agents/reviewer.md`).
- **Non-blocking findings are folded in, not given their own round.** The
  Reviewer tags each non-blocking finding `fold` or `follow-up`:
  - `fold`: the change stays inside files the run already touches, is under
    about 30 lines, and needs no design decision.
  - `follow-up`: anything else.

  The Orchestrator appends `fold` items verbatim to the envelope of the next
  task already planned for the same implementer role, and that task's review
  checks them. When no such task remains, all outstanding `fold` items become
  one fix task. Its review re-runs only the suites that cover the changed
  files, plus the diff. The final review is the one place where full suites
  run twice. `follow-up` items go to the run report. In
  `2026-09-23-carbon-migration`, a dedicated fix task plus a full re-review
  for six phase-3 test findings cost about 250k tokens and 33 minutes. Four
  of the six were test weakenings that the implementer's self-audit (see the
  implementer role files) now catches before hand-back.
- **Implementation is always sonnet; judgement roles may spend opus.** Credits
  are finite, and implementation is where the workflow spawns the most agents
  (one per task, sometimes several per run) — so that's where the model floor
  matters most. The judgement roles that run once per run and decide what the
  implementers do, or that catch a bad diff before it merges, are the cheapest
  place in the workflow to spend opus. The defaults in the role files reflect
  this; override with the Agent tool's `model` parameter:
  - `opus` — Designer and Reviewer by default. The Orchestrator (this
    conversation) may also run on opus; that's a model choice for the user's
    session, not something the workflow restricts.
  - `sonnet` — Planner, and every implementer (Backend Jr/Sr, Frontend Jr/Sr),
    and DevOps, always. Implementation never escalates to opus, regardless of
    task complexity — a genuinely hard implementation task is a signal to have
    Designer narrow the contract further, not to spend a bigger model on it.
  - `haiku` — override a Jr implementer down for a narrow, fully specified
    mechanical edit with no judgement in it.
  - Downgrade Designer or Reviewer to `sonnet` for a run too small to justify
    opus (tier-2 work, a single-seam change) — the opus default is for
    tier-3 runs where the design or the review is deciding something with
    real downstream cost.
- Agents only read/write inside their `allowed_paths`.
- **All implementation happens in a fresh clone, never in the live repo.** At
  the start of the Implement step the Orchestrator creates the run's working
  tree, once per run, and every implementer, DevOps and Reviewer command runs
  there:

  ```
  RUN_DIR=/home/guilherme/msfslogger/.claude/run-clones/<run-id>
  mkdir -p "$RUN_DIR"
  git clone --local --branch main /home/guilherme/msfslogger "$RUN_DIR/tree"
  git -C "$RUN_DIR/tree" switch -c run/<run-id>
  ```

  `.claude/run-clones/` is gitignored (never committed, never part of `dist/`)
  but lives inside the project, not `/tmp` or the session scratchpad — a
  disk-cleanup pass elsewhere on the machine deleted an entire unmerged run's
  clone on 2026-09-23 (the commit was never fetched into the live repo, so it
  was unrecoverable) precisely because nothing about a path under `/tmp`
  signals "don't touch this." Keeping it in-project doesn't make it safe to
  delete carelessly, but it does keep it out of reach of cleanup aimed at
  generic temp directories.

  - **The run clone is the only install per run, and nothing goes in `/tmp`.**
    Per-agent copies of the tree with their own `node_modules` under the
    `/tmp` session scratchpad filled the (small, shared) root disk and crashed
    the machine on 2026-09-24. Scratch output (builds via `--outDir`, scratch
    DBs, renders) goes in `.claude/scratch/<run-id>/`; agents check `df -h /`
    (≥ 8 GB free) before any clone/install and clean up per task. Details:
    `.claude/ENVIRONMENT.md` § Scratch space. Every envelope repeats this.
  - The clone is of **committed `main`** — uncommitted or untracked files in
    the live checkout (`.claude/runs/**`, `start.sh`, `flights.db`,
    `node_modules`) are deliberately absent. Install dependencies inside the
    clone (`npm ci` in root and `client/`); never symlink the live
    `node_modules` or point anything at the live `flights.db`.
  - `allowed_paths` are relative to `$RUN_DIR/tree`. The envelope names the
    absolute tree path; an agent that finds itself editing under
    `/home/guilherme/msfslogger` (outside `.claude/runs/<run-id>/`) has made
    the exact mistake this rule exists to stop, and returns `blocked`.
  - Reading the live repo is fine (`ctx.sh` against the run's plan/design,
    which are untracked and so not in the clone). Writing to it is not — with
    one exception: run artifacts under `.claude/runs/<run-id>/` (intake, plan,
    design, reviews, reports) live in the live repo, are written there by the
    Orchestrator/Planner/Designer/Reviewer, and are not implementation.
  - The Orchestrator commits on the `run/<run-id>` branch **in the clone** (the
    only commits in the run). Landing the work in the live repo is the user's
    call: the Orchestrator reports the clone path and the branch, and offers the
    exact `git fetch <clone> run/<run-id>` / `git merge` (or `format-patch`)
    command for the user to run. It does not merge into the live checkout
    itself.
  - The clone is throwaway. Scratch servers and builds inside it still use
    another port and a copy of the database; `npm run build` there is safe
    (it emits into the clone's `dist/`), which supersedes the
    "build in a scratch copy of the tree" step per run. Delete `$RUN_DIR` only
    after the user has taken the branch, or say where it was left.
- No agent may skip Review; Orchestrator never merges unreviewed work.
- Any agent may return `blocked` with a concrete question instead of guessing.
- Orchestrator escalates to the user on: ambiguous requirements, destructive
  operations, credentials/secrets, or 3 failed review rounds.
- Keep every hand-off self-contained: context is passed explicitly, never
  assumed — and passed as slices, never as whole documents.
