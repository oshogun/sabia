---
name: lighthouse-benchmark
description: Benchmark the logbook web app (client/) with Lighthouse in headless Chromium, usually comparing two revisions (before/after a change, a branch vs main, or the uncommitted working tree), and report a median table of performance score, FCP, LCP, TBT, CLS and bytes per page. Use for "run lighthouse", "benchmark the page", "did this make it faster", "measure load performance", "compare performance before and after". Runs against seeded scratch servers on scratch ports, never the live server or the real logbook. Not for the project website (sabia-site) and not for fixing what it finds (that is /impeccable optimize or a normal run).
---

You are running **lighthouse-benchmark** as the Orchestrator. It is **tier 1**:
measurement, no run id of its own, no sub-agents. Run it yourself. When it
measures a run's change, save the final table to
`.claude/runs/<run-id>/reports/lighthouse.md`; otherwise report in chat.

Everything here was executed on 2026-09-29, benchmarking edbca0f against 1561571
(the lazy-loading run). The pitfalls below are ones that session actually hit.

## Hard rules (from CLAUDE.md and .claude/ENVIRONMENT.md)
- **Never touch the live server (port 3000), `flights.db`, or the live
  `client/dist`.** `serve-rev.sh` builds in a scratch copy and aborts if the
  live `client/dist/index.html` mtime changes during its build.
- Scratch lives under `.claude/scratch/<name>/`, never `/tmp` or the session
  scratchpad. The scripts set `TMPDIR=.claude/scratch/tmp` (kept short:
  Chrome puts a Unix socket there, and the path limit is 107 characters).
- **Disk:** run `df -h /` first. Each revision costs about 30 MB, because
  node_modules is symlinked, not installed. Below the 8 GB floor in
  ENVIRONMENT.md, ask the user before proceeding.
- **Never stop servers by name or pattern.** The live server is also
  `node dist/index.js`. `teardown.sh` kills recorded PIDs, and only when
  their cwd is inside the scratch dir.
- **Don't `rm -rf` a path built from a shell variable.** The harness blocks
  it, and it is dangerous. Delete the scratch dir at the end with a literal
  absolute path.

## Tools
- **Chromium:** use the Playwright cache's `chrome-headless-shell`
  (`~/.cache/ms-playwright/chromium_headless_shell-*/…`). The full
  `chromium-*/chrome-linux64/chrome` hangs headless on this machine, even on
  `about:blank`, and Lighthouse then reports "Unable to connect to Chrome".
  Never install a second Chromium.
- **Lighthouse:** 13.x is installed globally under nvm's Node 26
  (`~/.nvm/versions/node/v26.*/bin/lighthouse`), and it runs fine under Node
  24; `run.sh` finds it. If it's missing, ask before installing it
  (`npm i -g lighthouse` into the Node 24 nvm prefix).
- Lighthouse 13 dropped the `uses-text-compression` audit. `aggregate.js`
  reads compression from the network log instead: "JS+CSS sent / unpacked".
  When the two are equal, the files were served uncompressed.

## Procedure

1. **Pick the revisions and pages.** The defaults are `before` =
   the commit before the change and `after` = HEAD. Use `WORKTREE` to include
   uncommitted work. Default pages: `login:/login home:/ flights:/flights flight:/flight/1`.
   The seed (`src/testSeed.ts`) is a small fictional logbook with flights 1–2, a trip and
   planned legs, logged in as `e2e` / `e2e-password-123`. The seed has no live
   flight, so Home's in-flight panel and live map aren't measured. Say so in the report.
2. **Serve each revision** on its own port, never 3000:
   ```
   S=/home/guilherme/msfslogger/.claude/scratch/lighthouse-$(date +%Y%m%d-%H%M)
   mkdir -p "$S"
   .claude/skills/lighthouse-benchmark/scripts/serve-rev.sh "$S" before <rev> 3211
   .claude/skills/lighthouse-benchmark/scripts/serve-rev.sh "$S" after  HEAD  3212
   ```
   Each build takes about 30 s. The script prints the PID and confirms the login.
3. **Smoke-test first** (one run, one page), so a broken setup doesn't burn
   the whole batch:
   `RUNS=1 PRESETS=desktop .claude/skills/lighthouse-benchmark/scripts/run.sh "$S" after:3212 -- flight:/flight/1`
   Then check `"$S"/results/` has a JSON report and `errors.log` is empty.
   Remove that smoke report (a literal path) so it doesn't skew the medians, or give it its own scratch dir.
4. **Full run in the background.** 4 pages × 2 revisions × 2 presets × 3 runs
   is 48 runs, about 15 minutes:
   `.claude/skills/lighthouse-benchmark/scripts/run.sh "$S" before:3211 after:3212`
   Use Bash `run_in_background`, and tell the user roughly how long it will take.
5. **Aggregate:** `node .claude/skills/lighthouse-benchmark/scripts/aggregate.js "$S"/results`
   prints medians as markdown tables, per preset.
6. **Tear down:** `.claude/skills/lighthouse-benchmark/scripts/teardown.sh "$S"`, confirm port 3000
   still listens, then delete the scratch dir with a **literal** path
   (`rm -rf /home/guilherme/msfslogger/.claude/scratch/lighthouse-20260929-1730`).
   The raw reports are about 300 KB each.

## Reading the numbers honestly
- Lighthouse *simulates* throttling (Lantern) from a local trace. The absolute
  times say what a throttled link would see, not what the pilot sees on a LAN.
  Compare revisions in the same session on the same machine, and treat
  differences under about 5 score points or 100 ms as noise.
- The desktop preset matches the app's real context (PRODUCT.md: the desk
  and a second screen). Mobile exaggerates transfer-size effects; report it
  as a stress case, not a target.
- Report medians together with the run count. Report `runtimeError` runs and
  skipped reports; don't hide them.
- The express server sets no compression (`src/server.ts` has no
  compression middleware). "sent ≈ unpacked" is expected until that changes,
  and it is itself a finding worth stating.
