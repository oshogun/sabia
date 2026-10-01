---
name: update-docs
description: Bring docs/ and README.md back in sync with actual system behavior — full rebuild if docs/ doesn't exist yet, targeted refresh of the affected pages if it does. Use for "update the docs", "the docs are stale", "document this feature", or any request to create/maintain system documentation. Not for a one-line doc typo (fix that directly) and not for API/type docstrings (that's the implementer's job on the task that changes the code).
---

You are running the **update-docs** skill as the Orchestrator defined in
`.claude/agents.md`. This skill is how documentation work gets done in this
project — read it fully before starting; it replaces the standard Plan →
Design → Implement loop for this one kind of work, for a specific reason
explained below.

## Why this isn't the standard loop

`.claude/agents.md` gives every implementer a domain: `backend_jr/sr` own
`src/**`/`tests/**`, `frontend_jr/sr` own `client/**`. **Nobody
owns `docs/**` or `README.md`.** There's also no schema/API/type contract
being introduced by a docs change, so Designer doesn't apply either. Rather
than force-fitting documentation work into roles built for code, the
Orchestrator does the research and writing itself, and the run keeps the one
piece of the loop that is still worth its cost here: an independent **Reviewer**
pass before anything is called done. This mirrors the tier-2 shape (one
effective implementation pass + one Reviewer pass) with the Orchestrator
standing in as implementer, recorded as a routing decision in `intake.md`,
not silently.

## Scope decision: full rebuild vs. targeted refresh

```bash
ls docs/index.md 2>/dev/null && echo EXISTS || echo MISSING
```

- **`docs/` doesn't exist** — full rebuild. Go to [Full rebuild](#full-rebuild).
- **`docs/` exists** — targeted refresh. Go to
  [Targeted refresh](#targeted-refresh) instead; don't re-audit the whole
  system when only a slice of it changed.

Either way, start with a run: id `YYYY-MM-DD-update-docs` (or a
more specific slug if the user named a feature/area), directory
`.claude/runs/<run-id>/`, and an `intake.md` stating the goal, which of the
two paths this run takes, and why. See `.claude/runs/README.md` for the
directory's conventions.

## Full rebuild

This is the path the run `2026-09-17-docs-overhaul` took; the doc set it
produced is the current baseline — read `docs/index.md` there is none yet in
this checkout, this section is what builds it for the first time.

### 1. Required page set

Unless the user's request narrows it, `docs/` gets exactly these pages, plus
a trimmed `README.md` that links to them:

```
docs/index.md            navigation home, links every page below
docs/architecture.md     component map, runtime flow, core domain logic
docs/setup.md            versions, bootstrap from zero, validation step
docs/configuration.md    every env var: name, required, default, description
docs/usage.md            primary workflows, run/debug/test commands, common failures
docs/api.md              every route: method, path, auth, purpose
docs/data-model.md       schema tables, relationships, the db-module map
docs/operations.md       running in production, backups, maintenance scripts
docs/troubleshooting.md  diagnostics by symptom, cross-linked to the above
docs/development.md      repo layout, testing strategy, CI, branching
docs/security.md         threat model, auth design, secrets, data at rest
docs/release.md          the actual (possibly informal) release process
docs/glossary.md         domain terms — write this one last, once you know them
```

A page may be thin (e.g. `release.md` if there's no formal release process)
but not omitted — if a page doesn't apply, it says so and explains why,
rather than being skipped silently. Add a page beyond this set only if the
system has a facet none of these cover; don't drop one of these without
asking the user first.

`README.md` gets trimmed to: name + one-paragraph purpose, prerequisites,
minimal setup, minimal run, minimal test/lint reference, and links to
`docs/`. Target 120–250 lines. Anything longer belongs in `docs/`, not
repeated in both places — a README that duplicates a `docs/` page word-for-
word is a maintenance liability, not thoroughness.

### 2. Audit the codebase with parallel research agents

Don't read the whole tree yourself — spawn `Explore` agents in parallel, one
per area that maps cleanly to a few doc pages, each strictly read-only and
told to report **facts with exact identifiers** (env var names, route
paths, table/column names, function names) copied from source, not
paraphrased, since you'll write the docs directly from their reports without
re-reading the source yourself in most cases. A shape that has worked well
in this project (adjust boundaries to whatever the actual module layout is):

- Backend server/routes/auth/config → feeds `api.md`, `configuration.md`,
  part of `architecture.md`.
- Backend domain logic + db schema → feeds `data-model.md`, the rest of
  `architecture.md`, `operations.md`'s maintenance-script section.
- Frontend (client) architecture → feeds `architecture.md`'s client section,
  `usage.md`'s page-by-page walkthrough.
- Build/test/CI/deploy → feeds `setup.md`, `development.md`,
  `operations.md`'s deploy section, `release.md`.

Each agent prompt should say explicitly: read-only, no edits, no
`npm run build`/`npm start`/anything with a live-server side effect (see
`.claude/ENVIRONMENT.md` — `npm run build` overwrites `client/dist`/`dist`,
which the user's running server reads live off disk), report facts not
summaries, and name the exact files it read so a claim can be traced back.

Run them `run_in_background: true` and in parallel — waiting on four
research agents serially costs nothing here since none depends on another.

### 3. Write the pages

Once the research is back, write every page yourself (don't delegate this —
there's no role to delegate it to, and a docs page benefits from one
consistent voice across the set more than most artifacts do). Rules that
came out of the first run, worth keeping:

- **Precision over prose.** A route table with method/path/auth/purpose
  columns beats a paragraph describing the same routes. Tables for schemas,
  env vars, npm scripts, routes; short paragraphs for behavior/algorithms.
- **Literal wording, no metaphors.** Say what the code does and why; a
  metaphor in place of the reason is a Reviewer finding. The rule and its
  examples are in `CLAUDE.md` § Writing comments and docs.
- **State the current implementation, not the aspiration.** If a section of
  the app is thin (no metrics endpoint, no formal release process, one test
  file missing), say so plainly rather than describing what it should have.
- **Cross-link instead of duplicating.** When two pages would otherwise
  repeat the same table, one owns it and the other links to the anchor.
- **Every auth/permission claim needs the exact gating logic behind it.**
  This is the highest-risk category for drift — see the incident under
  [What the Reviewer actually catches](#what-the-reviewer-actually-catches)
  below. Don't write "requires auth" from a route file alone; find the
  middleware/gate that enforces it and match the doc's claim to what that
  gate's logic actually does, not to what the route's own comment claims.
- **Link relative, not absolute**, and get the `../` depth right from
  `docs/*.md` back to repo-root files (`README.md`, `LICENSE`,
  component READMEs elsewhere in the tree).

### 4. Self-verify before sending to Reviewer

Do these yourself first — they're cheap, and a Reviewer round spent on
something you could have caught is a wasted spawn:

```bash
# every internal link in README.md and docs/*.md resolves
for f in README.md docs/*.md; do
  grep -oE '\]\(([^)]+)\)' "$f" | sed -E 's/^\]\(([^)]+)\)$/\1/' | while read -r link; do
    path="${link%%#*}"
    case "$path" in http*|"") continue ;; esac
    resolved=$(python3 -c "import os; print(os.path.normpath(os.path.join(os.path.dirname('$f'), '$path')))")
    [ -e "$resolved" ] || echo "BROKEN in $f: $link -> $resolved"
  done
done
```

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use
npx tsc --noEmit && npm run test:types && npm test
```

Never `npm run build` or `npm start` in this checkout — see
`.claude/ENVIRONMENT.md`. These three commands prove every code example that
matters (the app typechecks, the test suite the docs claim passes actually
does) without writing `dist/`.

Then spot-check your own highest-confidence-required claims — the schema
table, the config table — by reading the real source file directly (not the
research agent's report a second time) for the one or two pages a wrong
claim would hurt most (usually `configuration.md` against `src/config.ts` or
equivalent, and `data-model.md`/`api.md` against the schema/route source).
This isn't a substitute for Reviewer; it's a cheap check that stops an
obviously wrong page from reaching a Reviewer spawn, which costs more to run.

### 5. Reviewer, with a docs-specific brief

Send the diff to `reviewer` — but write the envelope to say plainly that
this is **not** a correctness/security code review, it's an accuracy and
consistency review, or the agent will apply the wrong lens. Give it:

- The acceptance criteria the docs must meet (adapt from the spec that
  triggered this if there is one, otherwise the shape in
  `git show runs-archive:.claude/runs/2026-09-17-docs-overhaul/intake.md`'s Success Criteria
  section is a good default: README concise + links out, index links
  everything, required pages present, commands/claims verified against
  source, no broken links, a new contributor can get running from
  README + setup.md alone).
- An explicit instruction to **re-verify claims against source directly**,
  not against the Orchestrator's report of having verified them — the whole
  point of this gate is that it doesn't trust the report.
- Priority order for what to check first: anything encoding an
  auth/permission boundary, then schema/config, then everything else — see
  below for why.
- The same constraints every agent gets in this repo: read-only, never
  `npm run build`/`npm start`, never touch the live server or `flights.db`
  beyond an md5 sanity check, stay off port 3000.

#### What the Reviewer actually catches

Worth knowing before you skip this step to save a spawn: in the first run of
this skill, the Orchestrator's own `docs/api.md` mismarked 35 of 42 routes
as accepting an ingest token, because it wrote the auth column from the
route table structure instead of the actual scope-gating allow-list buried
in a different file. Every other page — schema, config, architecture,
security — checked out clean on independent re-verification. **Auth/
permission claims are the category most likely to be wrong even after
careful writing**, because the gating logic usually lives one file away from
the routes it gates, and it's easy to describe what a route *looks like* it
requires instead of what actually enforces it. Give the Reviewer that
context so it spends its effort where the last run's actual defect was, not
spread evenly.

### 6. Iterate

`request_changes` → fix → re-verify (re-run the link checker and any
command whose claim changed; you don't need to redo the full research pass)
→ resend to the same Reviewer agent (`SendMessage`, not a fresh spawn — it
already has the context). Cap at 3 rounds; escalate to the user past that,
per `.claude/agents.md`'s standard rule. `approve` ends the loop.

### 7. Report and stop short of committing

Update `intake.md` with the outcome (verdict history, residual risks the
Reviewer flagged as non-blocking, anything explicitly out of scope). Tell
the user what changed, what the Reviewer caught, and what's still open —
then stop. **Do not commit.** Per `.claude/agents.md`'s non-negotiables,
commits are the Orchestrator's call to make with the user, not something a
workflow step does on its own — and a docs run is exactly the kind of change
likely to land in a working tree that also has unrelated in-progress edits,
which must not get swept into the same commit. Ask.

## Targeted refresh

`docs/` already exists. Don't re-run the full audit — scope the work to what
actually changed.

1. **Find what moved.** Compare the docs' own currency against the code:

   ```bash
   # newest commit touching src/ or client/src, vs. docs/'s own history
   git log -1 --format=%H -- src client/src
   git log -1 --format=%H -- docs README.md
   # what changed in the app since docs/ was last meaningfully updated
   git log --oneline <docs-commit>..<code-commit> -- src client/src
   ```

   Or, if the user named the feature/change directly, skip the git
   archaeology and just ask which doc pages it touches by reading the
   relevant source yourself (small enough scope not to need a research
   agent).

2. **Map changed source to affected pages.** A new route → `api.md` (and
   maybe `usage.md`). A new/changed table or column → `data-model.md`. A new
   env var → `configuration.md` (and `setup.md`'s minimum-to-start table if
   it's required). A new npm script or CI step → `development.md`,
   `operations.md`. A behavior change to the state machine or a core
   algorithm → `architecture.md`. When in doubt, `grep` the changed
   identifiers (route paths, env var names, table names) across `docs/` —
   if a page mentions the old shape, it needs updating regardless of which
   bucket above it falls in.

   **Then grep for what moved, not just for identifiers.** An identifier grep
   finds `components/ReplayPanel`. It won't find a sentence that is still true
   of the code but false for the user. In `2026-09-23-carbon-migration`, the
   docs said "SayIntentions API key under Prefiles" after the key had moved
   to `/settings`, and neither the Orchestrator nor the docs Reviewer caught
   it. The frozen decisions and accepted deviations in the triggering run's
   `intake.md` list every user-visible move, rename and removal. So:
   - For each item, grep `docs/` and `README.md` for the **old** wording:
     the old page name next to the feature ("under Prefiles"), the old label
     ("User ID", "Replay flight"), the removed thing ("gallery", "?fail=").
   - Put that list of phrases in the Reviewer envelope too.

   **Re-verify every sentence in a paragraph you edit**, not only the words
   you changed. A retained sentence ("uses Leaflet's SVG renderer") sits
   inside an edit that makes it look freshly verified. In the same run, one
   such sentence was false and was only caught by chance.

3. **Spawn a research agent only for pages that need one.** If the change is
   small (one new route, one new env var), read the source yourself and edit
   the page directly — spinning up an Explore agent for a five-line diff is
   the failure mode `.claude/agents.md` warns about. Reserve parallel
   research agents for a refresh that touches several unrelated areas at
   once.

4. **Same verification, Reviewer, and report steps as the full rebuild**
   (§4–7 above), scoped to the pages you actually touched. The Reviewer
   envelope should say which pages changed and why, so it doesn't spend
   effort re-verifying pages that didn't move.

5. **Check `docs/index.md` and `README.md` still match** — a new page added
   during a refresh needs a link from `index.md`; a page that became
   obsolete needs removing from both, not just deleting the file.
