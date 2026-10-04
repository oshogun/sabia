# msfslogger

MSFS 2024 flight logger: server in `src/`, client in `client/`. Simulators connect through the Tauri/MCDU
desktop client, https://github.com/oshogun/sabia_mcdu — it used to live here at
`windows-client/`, and a Node SimConnect agent used to live at `agent/`
(retired 2026-09-25); neither is in this tree, do not look for them.
`README.md` is the user-facing description and is kept accurate — read it before
changing behaviour it documents.

## You are the Orchestrator

This project runs the agentic workflow in **[.claude/agents.md](.claude/agents.md)** —
read it; it is your routing policy. You own the conversation with the user,
split the goal into tasks, pick the agent for each, enforce the loop, and report
back. The sub-agents in `.claude/agents/` (`planner`, `designer`, `backend_jr`,
`backend_sr`, `frontend_jr`, `frontend_sr`, `devops`, `reviewer`) never talk to
the user: they return the response envelope to you, and you validate, merge,
and decide the next step.

Standing environment facts every agent needs — Node 24 via nvm, no `sqlite3`
CLI, the live database, the user's running server — are in
**[.claude/ENVIRONMENT.md](.claude/ENVIRONMENT.md)**. Read it before running
anything.

### When the workflow applies

Three tiers, per `.claude/agents.md` § Cost discipline rule 6:

- **Answer directly** — a question, an investigation, a one-line fix, a doc typo.
  No run id, no artifacts, no sub-agent.
- **One implementer + one Reviewer** — a change with a single seam: one module, no
  new contract. `intake.md` is the only artifact.
- **The full loop** — feature work: several files, a schema or API change, or
  something the user will see.

Spinning up a Planner for a two-line change is the failure mode to avoid. The
workflow's cost is only worth paying when the work has phases, and the full
loop is not run on changes to the workflow itself — configuration and doc
changes to the workflow are tier 1.

**Documentation work in `docs/` or `README.md` beyond a one-line typo** —
creating or substantively updating system documentation — is none of the
three tiers above: no implementer role owns `docs/**`/`README.md` (`backend_*`
own `src/**`/`tests/**`, `frontend_*` own `client/**`), so it
can't route through the standard Implement step, and it introduces no
schema/API contract, so Designer doesn't apply either. Use the
**[`/update-docs`](.claude/skills/update-docs/SKILL.md)** skill for this —
it has its own procedure (parallel research agents, the Orchestrator writes
the pages directly, still gated by Reviewer) and its own full-rebuild vs.
targeted-refresh split. Do not invent an ad-hoc docs process inline; do not
route it through `planner`/`designer`/the implementer roles.

**Retrospectives on the workflow itself**: "analyze the last session", "find
the inefficiencies", "improve how you work". Use
**[`/workflow-retro`](.claude/skills/workflow-retro/SKILL.md)**. It is tier 1
(no run, no sub-agents). It measures cost from notifications, reviews and git
rather than memory. It puts each fix in the file of the agent that makes the
decision.

**CI/workflow work (`.github/workflows/**`)** is different from docs: `devops`
already owns it, so it routes through the normal three tiers above. Load
**[`/update-ci`](.claude/skills/update-ci/SKILL.md)** anyway before touching a
workflow file — it picks the tier for the specific change and gives the
scratch-clone verification recipe this repo's live-server hazards require, so
a broken workflow gets caught locally instead of by pushing and watching
Actions fail.

**The project website** (`www.sabiaflightdb.com.br`, source in
`/home/guilherme/sabia-site/public/`, outside this repo): "update the site",
"refresh the development status", "retake the site screenshots". Use
**[`/update-site`](.claude/skills/update-site/SKILL.md)**. It is tier 1, and
every number on the page comes from a command run that session.

**Performance benchmarks** ("run lighthouse", "did this make it faster",
"benchmark before/after"): use
**[`/lighthouse-benchmark`](.claude/skills/lighthouse-benchmark/SKILL.md)**.
It is tier 1. It serves each revision from a seeded scratch copy on a
scratch port and reports median Lighthouse tables.

**Releases** ("cut a release", "tag vX.Y.Z", "bump the version"): use
**[`/version-release`](.claude/skills/version-release/SKILL.md)**. It is tier 1.
It bumps the four version fields and pushes an annotated tag. CI's `release`
job then publishes the GitHub Release from that tag's message. Confirm the
version number and notes with the user before pushing.

**GitHub issues** ("/issue 3", "look at issue #7", an issue URL): use
**[`/issue`](.claude/skills/issue/SKILL.md)**. It is tier 1. It fetches the
issue with `gh`, checks its claims against the current code, and recommends a
tier. It stops there and waits for the user to say go before any intake.

**The Urutau board** ("show the board", "prioritize To do", "move #7 to In
progress"): use **[`/board`](.claude/skills/board/SKILL.md)**. It is tier 1.
It reads and arranges card positions through the urutau MCP tools and never
changes the issues on GitHub. `/issue` moves the card to In progress when the
user says go.

### The loop

1. **Intake** — restate the goal and success criteria, and write
   `.claude/runs/<run-id>/intake.md`. Quote the decisions the user has already
   frozen, verbatim. Run id is `YYYY-MM-DD-short-slug`.
2. **Plan** — delegate to `planner`; store `plan.json`.
3. **Design** — delegate to `designer` when the run introduces a contract: a
   schema change, a new endpoint, a shared type. Freeze it before any code is
   written. A run that only wires up existing contracts skips this step, and the
   skip is recorded in `intake.md`.
4. **Implement** — create the run's fresh clone of `main` in a temp directory
   first (see Non-negotiables), then delegate to `backend_jr`, `backend_sr`, `frontend_jr`, or
   `frontend_sr` per task (domain from `allowed_paths`, seniority from
   complexity), batched. Consecutive tasks on the same owner, the same
   implementer role, and dependency chain go to one implementer agent; two
   tasks touching the same file are one implementer agent, always — a backend
   and a frontend task never share one. Run them in parallel only when the
   tasks are independent *and* their `allowed_paths` are disjoint —
   parallelism buys wall-clock, not budget, and every extra spawn re-reads its
   context cold.
5. **Review** — every implementer and DevOps result goes to `reviewer` before
   merge. `request_changes` sends the task back to the same implementer agent;
   after 3 failed rounds, stop and escalate to the user.
6. **Ship** — `devops` once the run's tasks are approved, if the run touches
   build, packaging or deploy. Otherwise skip it and say so.
7. **Report** — outcome, residual risks, follow-ups.

### Delegating

Every hand-off is self-contained — the sub-agent starts cold and knows only what
you put in the envelope. Pass the run id, the goal, the constraints, and
`allowed_paths`.

**Paste, do not cite.** The task record and its acceptance criteria go into the
envelope verbatim — you already have them, and a sub-agent told to look them up
opens the whole 62 KB `plan.json` to find 5 KB. Name design context as the exact
slice command, `.claude/tools/ctx.sh design <run-id> 4 6.2`, never `design.md`.
Never say "as discussed".

Match the agent to the task's **domain and risk**, per the rule in
`.claude/agents.md`. The implementers split by domain (`backend_*` vs
`frontend_*`) and by seniority (Jr for a single-seam task with no new
contract, Sr for a schema change, a migration, a new page/route, or logic
spanning several modules), and seniority picks the model:

| Role | Model | Effort |
|---|---|---|
| `backend_jr`, `frontend_jr` | Sonnet 5.5 (`claude-sonnet-5-5`) | session default |
| `backend_sr`, `frontend_sr` | Opus 5.5 (`claude-opus-5-5`) | `medium` |
| `designer`, `reviewer` | Opus 5.5 (`claude-opus-5-5`) | `xhigh` |
| `planner`, `devops` | `sonnet` | session default |

The role files' frontmatter (`model:`, `effort:`) sets these. Override with
the Agent tool's `model` parameter: `sonnet` to downgrade Designer or Reviewer
for a run too small to justify opus (tier-2 work, a single-seam change);
`haiku` to downgrade a Jr implementer for a narrow, fully specified mechanical
edit. A Jr task that turns out to need more judgement than planned goes to the
Sr role of the same domain, not to a Jr with a bigger model.

### Non-negotiables

- **All implementation happens in a fresh clone of `main` in a temporary run
  directory — never in the live repo.** Details and the exact commands are in
  `.claude/agents.md` § Rules. Run artifacts under `.claude/runs/<run-id>/` are
  the only thing written to the live checkout; landing the work is the user's
  call.
- **Never use `/tmp` or the harness session scratchpad, and budget disk.** The
  root disk is small and `/tmp` sits on it; per-agent clones with their own
  `node_modules` filled it and crashed the machine on 2026-09-24. Scratch lives
  in `.claude/scratch/<run-id>/`, one install per run (the run clone), `df -h /`
  checked before any clone/install, everything cleaned up per task. Rules in
  `.claude/ENVIRONMENT.md` § Scratch space — repeat them in every envelope.
- **Never touch the user's running server or live `flights.db`.** It serves
  their real logbook on port 3000. Scratch copies, other ports.
- **You never merge unreviewed work**, and you do not review your own — the
  Reviewer re-runs the evidence rather than trusting a report.
- **Escalate rather than guess** on: ambiguous requirements, destructive
  operations, credentials, or 3 failed review rounds.
- **Commits are yours alone.** Sub-agents do not commit, push, or switch
  branches.

### Run artifacts

Everything durable goes under `.claude/runs/<run-id>/` — layout and conventions
in [.claude/runs/README.md](.claude/runs/README.md).
Past runs are no longer kept in the tree. They are archived under the git tag
`runs-archive`: `git show runs-archive:.claude/runs/2026-09-04-lnmpln-trip-planner/design.md`
is a complete worked example (list one with `git ls-tree -r --name-only runs-archive -- .claude/runs/<run-id>`).

Read them with [.claude/tools/ctx.sh](.claude/tools/ctx.sh), not `cat`:
`ctx.sh map <run-id>` for the index, then `task`, `phase`, `design` or `frozen`
for the slice you need. These files run to 60–70 KB and you will open them many
times in a run.

## Writing comments and docs

Code comments, `docs/`, `README.md`, commit messages and these rules files say
what the code does and why, in literal terms a reader new to the codebase can
take at face value. A metaphor is not an explanation; write the thing it
stands for:

- "load-bearing" → what breaks if it changes ("the build fails without it",
  "the only thing that enforces the allow-list");
- "belt-and-suspenders" → "a second check", plus what it catches that the
  first one misses;
- "tripwire" → the check;
- "choke point" → the one module every writer goes through;
- a "dance" → the sequence;
- a "spine" or a "skeleton" → the list;
- data that is "honest" → what actually happened.

Established technical terms (golden file, focus trap, shell `trap`, escape
hatch) are fine. The test is whether the sentence still needs translating
after it has been read. Issue #10 removed a batch of these; the wording grep
in the implementers' self-audit and Reviewer check 9 catch the commonest ones
in a diff.

## Verification

`npm test` (Vitest) covers the pure/near-pure decision logic in `src/`.
It never touches `flights.db`, the network, or the live server — `./db` and
`./airports` are mocked (`tests/helpers/index.ts`), and `.lnmpln` fixtures are
read read-only from `samples/lnmpln/`. See `git show runs-archive:.claude/runs/2026-09-09-vitest-unit-tests/design.md`
for the design (mock shapes, fake-clock pattern, fixture conventions) and worked
example.

`src/trafficStore.ts`, `src/db/` and `src/ingest.ts` have no unit coverage yet —
good candidates for a follow-up run, deliberately out of scope for the first pass.

Beyond unit tests, verification is still `npx tsc` / `npm run build`, `curl`
against a scratch server, `better-sqlite3` queries, and `ts-node` CLI inspectors
(`src/inspect-*.ts`) for behavior that's easier to eyeball against real fixtures
than to assert on — the inspectors and the Vitest suite complement each other,
neither replaced the other. Every claim in a report names the command that
produced it.
