---
name: update-site
description: Update the Sabiá project website (www.sabiaflightdb.com.br) — most often refreshing its "Development status" section (commit counts, releases, working/in-progress/not-yet list, milestones) from git, but also feature copy, the MCDU section, the Sabiá Academy tutorials page, the Brazilian Portuguese (pt-BR) translation of both pages, or screenshots when the product changed. Use for "update the site", "refresh the website", "the website's status is stale", "add X to the website", "retake the site screenshots". Not for docs/ or README.md (that's /update-docs) and not for the logbook web app in client/ (that's a normal run).
---

You are running the **update-site** skill as the Orchestrator. This is tier 1
work (`.claude/agents.md` § Cost discipline rule 6): no run id, no planner, no
sub-agents. You edit static HTML files, in both languages, and republish them. The only thing that
makes it more than a typo fix is that **every fact on the page must come from a
command you ran this session**, not from memory or from the page's own previous
text.

## Where everything lives

| What | Path | Notes |
|---|---|---|
| Site source (what you edit) | `/home/guilherme/sabia-site/public/` | **Outside the repo.** Only `public/` is published. Layout below. Every page starts with four standalone lines: `<!doctype html>`, `<html lang="…">`, and the charset and viewport `<meta>` tags. |
| Publish staging copy | `.claude/scratch/sabia-site/` (gitignored) | Built by `stage.py` (see § 6); never edit it by hand. The Artifact tool only reads files under the repo. |
| Preview artifacts | EN main https://claude.ai/artifact/GwWmuCttZbb64QkSKHVKwD · EN Academy https://claude.ai/artifact/QGZyFKBVDxTjHW2oQ1ia3S · PT main https://claude.ai/artifact/FqkETjfYabX64xzZS3Q3JG · PT Academy https://claude.ai/artifact/DbjHJEVc2MTqiKE1YuVd4U | Private claude.ai artifacts, one per page. Republish each with its `url`, or it creates a new artifact. The same URLs are in `stage.py`. |
| Design context | `/home/guilherme/sabia-site/PRODUCT.md` (symlink to this repo's `PRODUCT.md`) and, once written, `/home/guilherme/sabia-site/DESIGN.md` | Impeccable's context for the site, with `sabia-site/` as its project root. Kept outside `public/` so it's never uploaded; never move either file into `public/`. The app's Carbon design (`DESIGN.md` at the msfslogger repo root) does not apply to the site. |
| Public site | `www.sabiaflightdb.com.br` via Cloudflare Pages | The user uploads it. You have no Cloudflare access and never ask for an API token. |
| Full-size screenshots | `/home/guilherme/sabia-site-shots/screenshots/*.png` | Taken from a fictional logbook. |
| Screenshot and publish tooling | `/home/guilherme/sabia-site-shots/scripts/` | `seed.js`, `feeder.js`, `final.mjs`, `towebp.mjs` (§ 4); `stage.py` (§ 6). |

Site layout, inside `public/`:

```
index.html  academy.html            English (x-default), at the site root
pt-br/index.html  pt-br/academy.html  Brazilian Portuguese; refer to ../assets/ and ../img/
assets/site.css                      main-page styles, shared by both languages
assets/academy.css  assets/academy.js  Academy styles and behaviour, shared by both languages
img/                                 screenshots and the logo, shared
```

Each page has a `canonical` link, `hreflang` alternates (`en`, `pt-BR`, `x-default` → English) and an
`EN`/`PT` switcher (`a.lang`) in the top bar that links to the same page in the other language.

If `/home/guilherme/sabia-site/public/` is missing, stop and ask the user where the
site source went. Don't rebuild the page from the published artifact without
telling them. You can read that artifact (`Artifact` `action: "read"`) to
recover it if they agree.

## Procedure

### 1. Decide the scope

Ask nothing if the request is "update the status" or "refresh the site". That
means § 2 only, plus § 3 for anything shipped since the last update. Screenshots
(§ 4) only when the user asks, or when a feature the page shows has visibly
changed. Say which one you're doing before you start.

### 1b. Both languages, always

Every change to content lands in **both** languages in the same session:
`index.html` and `pt-br/index.html`, `academy.html` and `pt-br/academy.html`.
Never publish one language ahead of the other. Translate as you edit:
don't leave English in a pt-BR page to "fix later".

- **Styles and behaviour** live in `assets/`, so a CSS or JS change is made
  once. The Academy script reads its visible strings from a table `T`. The
  English defaults are in `assets/academy.js`, and the pt-BR page overrides
  them in an inline `window.SABIA_I18N` block before loading the script.
  That block holds the progress text, the lock messages, the copy buttons,
  every line drawn on the certificate, the date locale (`pt-BR`) and the
  logo path (`../img/sabia-bird.svg`). A new visible string in the JS gets
  an English default in `T` and a pt-BR entry in `SABIA_I18N`.
- **Interface names stay in English** in the pt-BR pages: the Sabiá web app
  and the MCDU are English-only. Write `<span class="ui">Set as Active
  Trip</span>` or `<span class="cdu">CFG NETWORK</span>` exactly as the
  screen shows them. The pt-BR Academy's opening note says so. The alt text
  on screenshots is translated.
- **Terms used in pt-BR:**
  - diário de bordo (logbook), viagem (trip), trecho (leg), voado/alternado/pulado (flown/diverted/skipped)
  - token de ingestão (ingest token), auto-hospedado (self-hosted), decolagem/pouso, proa (heading)
  - razão de subida (vertical speed), fixo (waypoint), aerovia, auxílio à navegação (navaid)
  - reporte de posição, autorização pré-partida (PDC)
  - Kept in English, as Brazilian pilots use them: step climb, load sheet, pushback, ground school, checkride, scratchpad
- **Numbers and dates:**
  - pt-BR uses `38.000 pés`, `0,6 NM` and dates like `25 set 2026`.
  - The `<time datetime>` values stay ISO.
- **Links to `docs/`** point at the English docs. Say *(em inglês)* next to them in pt-BR.

### 2. Refresh "Development status" (`<section id="status">`)

Run these from `/home/guilherme/msfslogger` and replace the numbers and lists
with what they print. Don't edit counts by hand-arithmetic on the old ones.

```bash
git fetch -q origin 2>/dev/null; B=origin/main; git rev-parse -q --verify $B >/dev/null || B=main
git rev-list --count $B                                   # "commits on main"
git log $B --reverse --format=%ad --date=short | head -1  # first commit date (2026-05-03)
git log $B --format=%ad --date=format:%Y-%m | sort | uniq -c   # per-month counts for the second tile
git tag -l 'v*' | wc -l                                   # tagged releases
cat package.json | grep '"version"'
sed -n '1,200p' .github/workflows/ci.yml | grep -n 'name:'     # what CI runs on every push
git log $B --format='%ad %s' --date=short --since='<date of the newest milestone on the page>'
```

- **Releases:** count only version tags (`v*`). The repo also carries the
  `runs-archive` tag, which is an archive of old workflow runs and not a
  release. A bare `git tag | wc -l` gets this wrong.
- **Second stat tile:** the page shows the busiest month ("178 of them in
  September 2026"). Keep that framing only if it's still true and still
  interesting. Otherwise replace it with something the commands above
  support, such as commits in the last 30 days (`git rev-list --count --since='30 days ago' $B`).
- **"Recent milestones":** add an entry only for a user-visible capability or
  a structural change (a new client, a platform move, auth, deployment).
  Refactors, test-only commits, docs, and `.claude/` workflow changes stay off
  the list. Use the date of the commit that landed the feature on `main`, in
  the page's `25 Sep 2026` format with `<time datetime="YYYY-MM-DD">`. Mark at
  most three entries `class="key"` (the orange dots): the biggest shifts.
  Keep the list to about 15 entries by dropping the least interesting old
  ones, and always keep "First commit".
- **Working / In progress / Not yet:** move an item between pills only on
  evidence you can cite: a merged commit, the README, `docs/release.md`.
  "Not yet: versioned releases, a changelog and a published container image"
  stays until `docs/release.md` or the git tags say otherwise.
- **Section lede:** it says there are no versioned releases and you run
  `main`. Update it in the same edit if that changes.
- **MCDU facts** (only if they changed): read the MCDU repo's current README
  with `curl -s https://raw.githubusercontent.com/oshogun/sabia_mcdu/main/README.md`
  and its page map from `docs/cdu-reference.md` there. The MCDU is a separate
  repo and its own Claude session. Don't guess its features from this repo.

### 3. Feature copy (`#features`, `#self-hosted`, `#mcdu`)

Check each claim you touch against `README.md`, `docs/usage.md`,
`docs/security.md` or the code. Keep the page's style:

- Plain, active sentences, written from the pilot's side ("you take off within
  10 nm…"), not the system's.
- No em-dash asides, no "not X but Y", no marketing superlatives.
- Aviation terms are fine and wanted: OOOI, PDC, FL380, METAR/TAF.
- Screenshots and anything else from the demo data stay described as
  fictional. The footer line saying so stays.

Design follows `/home/guilherme/sabia-site/DESIGN.md`; read it before any
visual change. In short: Roboto for text and Roboto Mono for data, and every
colour a token on `:root` with dark-mode overrides. The logo's sunset
gradient appears in a few signature moments only (today the hero flight
profile and the Academy certificate). It is always a line, bar or stroke,
never a fill, button or text. A change to a colour token also goes into
DESIGN.md and into any hard-coded copy of it, such as the certificate
canvas in `assets/academy.js`. Don't add libraries or external hosts;
Google Fonts is the only external resource the page loads.

### 4. Screenshots (only when needed)

The shots come from a scratch server running a fictional logbook, never from
the user's live server or `flights.db`. All of `.claude/ENVIRONMENT.md`
applies. In particular:

- Nothing goes in `/tmp`. Set `TMPDIR=/home/guilherme/msfslogger/.claude/scratch/tmp`.
- Run `df -h /` first and stop if less than 8 GB is free.
- Use Node 24 (`nvm use 24`).
- Stay on port 3310, never 3000.
- Kill processes by their saved PID, never with `pkill`.
- Build from a scratch copy of the tree, never by building in the live checkout.

Recipe (it recreates what the scripts expect):

```bash
S=/home/guilherme/msfslogger/.claude/scratch/site-shots; mkdir -p $S/tree $S/final
cd /home/guilherme/msfslogger
git ls-files --cached --others --exclude-standard src client package.json package-lock.json tsconfig.json .nvmrc \
  | grep -v '^client/dist/' | tar -cf - -T - | tar -C $S/tree -xf -
cp airports.json airport-tiers.json $S/tree/
cp navdata.db navdata.db-wal navdata.db-shm $S/tree/ 2>/dev/null   # map navdata; not the logbook
ln -s $PWD/node_modules $S/tree/node_modules; ln -s $PWD/client/node_modules $S/tree/client/node_modules
cp /home/guilherme/sabia-site-shots/scripts/{seed.js,feeder.js,final.mjs} $S/
cd $S/tree && npm run build
```

Then:

- **Landed phase (most shots):**
  1. Seed with `FLIGHTS_DB_PATH=$S/demo-landed.db LANDED=1 node ../seed.js`.
  2. Start the server with `PORT=3310 BIND_HOST=127.0.0.1 FLIGHTS_DB_PATH=$S/demo-landed.db NAVDATA_DB_PATH=$S/tree/navdata.db INGEST_TOKEN=site-shots-ingest-token-0001 node dist/index.js`, in the background, saving its PID.
  3. Start the feeder with `PARK=-1.3875,-48.4790 node feeder.js`, saving its PID too.
  4. Run `node final.mjs landed [names…]`.
- **Live phase (hero and live ACARS):**
  1. Stop both processes.
  2. Reseed with `FLIGHTS_DB_PATH=$S/demo.db` and no `LANDED`. Reseed right before shooting, because the in-flight leg is timed from "now".
  3. Restart the server on `demo.db` and start `node feeder.js` with no `PARK`.
  4. Run `node final.mjs live`.

`seed.js` refuses any database path outside `.claude/scratch/site-shots/`.
Keep that guard.

Review shots on a contact sheet or with a low `DPR`, not one full-size image
at a time. Convert the ones the page uses with
`node /home/guilherme/sabia-site-shots/scripts/towebp.mjs`. It reads
`screenshots/` and writes `sabia-site/public/img/`, so first copy the new PNGs over
the old ones in `/home/guilherme/sabia-site-shots/screenshots/`. Keep
`width`/`height` on each `<img>` in step with the new files.

Clean up in the same session:
- Kill the server and feeder by PID.
- Run `rm -rf .claude/scratch/site-shots`.
- Check `df -h /`.
- Confirm `client/dist/index.html`'s mtime in the live checkout didn't change.

### 5. Sabiá Academy (`academy.html`)

The tutorials page. It teaches operation step by step, so it goes stale when
a procedure changes, not just when a feature lands. When § 2 or § 3 turns up
a change to setup, configuration, the flight state machine, leg matching,
ACARS, navdata, replay, exports, backups or MCP, check the matching lesson:

- Check steps against `docs/setup.md`, `docs/configuration.md`,
  `docs/usage.md`, `docs/operations.md`, `docs/troubleshooting.md`,
  `docs/navdata.md` and `docs/api.md` (MCP section).
- Check thresholds and timings against the code, because the docs can lag.
  The flight states are in `src/flightManager.ts`; OOOI timing is
  `buildOooiMessage` and its call sites there.
- Check button and field names with a `grep` over `client/src/pages` and
  `client/src/components`. Write them exactly as the UI shows them, upper
  case included.
- **Quizzes:** each module's checkride has one `data-right="1"` answer per
  question and a `.why` explanation. Rewrite the pair together if the fact
  behind it changes.
- **Lesson count:** the table of contents shows "N of 18 done" ("N de 18 concluídas"). The script
  counts the `data-done` checkboxes, so adding or removing a lesson needs a
  new TOC entry, a `data-l`/`data-done` id, and the static text in `#prog`.
- **Progress storage:** progress lives only in the reader's browser, under
  `localStorage['sabia-academy-done']`. Keep lesson ids stable so readers
  don't lose it.
- **Certificate** (`#certificate`): it unlocks when every `data-done` box is
  ticked. The completion date is stored as `_completedAt` in that same
  object, and the name under `sabia-academy-name`. The page draws the
  certificate on a canvas in `draw()` and shows it as an image the reader
  saves. That's deliberate: a download link does nothing in the artifact
  preview. The canvas text (`cLine1`, `cModules` in `T` and in the pt-BR
  `SABIA_I18N`) names "all 18 lessons" and the five module names. Update those strings in both languages, and the section's intro, if lessons or modules
  change. It must keep saying it's self-issued and unverified. To test it
  once, serve `/home/guilherme/sabia-site/public` over `http://127.0.0.1` on a spare
  port, not 3000, because a `file://` page taints the canvas. Set
  `localStorage` with every lesson id, issue a certificate in each language,
  watch for 404s (a wrong relative path fails silently: the certificate just
  loses its logo), then stop the server by its PID. `scripts/i18ncheck.mjs`
  does all of this for the four pages.

### 6. Check once, then publish

1. Serve the site on `http://127.0.0.1:3311` (`python3 -m http.server 3311
   --bind 127.0.0.1` from `/home/guilherme/sabia-site/public`, PID saved). Run
   `node /home/guilherme/sabia-site-shots/scripts/i18ncheck.mjs` under
   Node 24, then stop the server by its PID. For each of the four pages at
   1440 px and 390 px it reports:
   - `lang`, and `scrollWidth`, which must equal the width (no sideways scroll),
   - the switcher target, and HTTP errors,
   - script errors, and the certificate on both Academies.

   A "broken=1" on an Academy page is the certificate `<img>` before it's
   issued, not a fault. Look at one screenshot of each changed language, then
   make one pass of fixes, with no test loop. pt-BR text runs longer than
   English, so check short labels for overlap, especially the hero profile
   tags and the top bar at 390 px.
2. Stage: `python3 /home/guilherme/sabia-site-shots/scripts/stage.py`.
   For each page, it:
   - drops the four standalone header lines,
   - inlines `assets/*.css` and `assets/*.js`, since preview artifacts are single pages,
   - flattens `../img/` to `img/`,
   - rewrites links between pages to the four preview URLs,
   - copies only referenced images.

   Output files are `index.html`, `academy.html`, `pt-br-index.html` and
   `pt-br-academy.html`. The script prints each page's `img/…` list for step 3.
3. Republish each changed page with `Artifact`, its `url` from the table
   above, `file_path` the staged file, `root` the **absolute** path
   `/home/guilherme/msfslogger/.claude/scratch/sabia-site` (a relative root
   breaks if the shell's working directory moved), and `files` from that
   page's printed list. Leave `icon` out on a republish.
4. Tell the user it's ready to upload. In Cloudflare Pages, open the site's
   project and choose *Create deployment*. Upload the contents of
   `/home/guilherme/sabia-site/public/` (not its parent, which holds
   PRODUCT.md and DESIGN.md): `index.html`, `academy.html`, `pt-br/`,
   `assets/` and `img/`. You don't deploy it.

### 7. Report

- What changed on the page, section by section, with the command behind each
  new number or milestone.
- The artifact link for each page you republished, in both languages.
- The reminder to upload to Cloudflare Pages.
- Anything you left alone because you couldn't verify it.

No commit is needed: the site lives outside the repo.
The pt-BR text is Claude's translation. Say so in the report whenever you
add or change pt-BR copy, so a native speaker can review it. The only repo file
this skill touches is `.claude/scratch/`, which is gitignored.
