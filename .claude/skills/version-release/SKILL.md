---
name: version-release
description: Cut a new Sabiá version — pick the next semver from the commits since the last v* tag, bump the four package version fields, commit, write the annotated tag (its subject and body become the GitHub Release title and notes), push, and watch CI's `release` job publish the GitHub Release. Use for "release", "cut a release", "tag a new version", "ship vX.Y.Z", "bump the version". Not for fixing the release job itself in .github/workflows/ci.yml (that's /update-ci) and not for the website's release count (follow up with /update-site).
---

You are running the **version-release** skill as the Orchestrator. This is
tier 1 work (`.claude/agents.md` § Cost discipline rule 6): no run id, no
sub-agents, no run clone. The only files it changes are four `version` fields,
which no code, build or Dockerfile reads (checked 2026-09-26:
`grep -rn -E "package\.json|npm_package_version|\.version\b" src client/src Dockerfile`
finds nothing). So the bump is safe to make in the live checkout: it doesn't
rebuild anything and doesn't touch the running server.

Pushing a tag publishes a Release that anyone can see. **Confirm the version
number and the notes with the user before pushing anything** (step 5).

## How a release gets published

`.github/workflows/ci.yml` runs on every push, including tag pushes. Its
`release` job runs only for `refs/tags/v*` and only after `build-and-test`,
`docker` and `e2e` pass on that commit. Then it:

1. fails unless the tag minus its `v` equals `package.json` **and**
   `client/package.json` `version`;
2. skips if a Release for the tag already exists;
3. fails unless the tag is annotated (`git cat-file -t refs/tags/vX.Y.Z` is
   `tag`) with a non-empty message. For a lightweight tag, git's
   `%(contents:subject)` returns the tagged **commit's** subject, so without
   this check a plain `git tag` would publish a Release titled after a commit;
4. runs `gh release create` with the **annotated tag's subject as title** and
   **its body as notes**. Always tag with `git tag -a`.

So the tag message *is* the release page. Write it for users of the logbook,
not as a commit log.

## 1. Preflight

Run each command and stop on anything unexpected:

```bash
cd /home/guilherme/msfslogger
gh auth status                       # must be logged in (account oshogun)
git switch main 2>/dev/null; git status -sb | head -1   # on main
git fetch -q origin --tags
git log main..origin/main --oneline  # must be empty; if not, ask the user before pulling
git status --short -- package.json package-lock.json client/package.json client/package-lock.json
                                     # must be empty: never mix the bump with someone's WIP
gh run list --workflow CI --commit "$(git rev-parse HEAD)" --limit 5 \
  --json event,status,conclusion     # the commit you'll release on should be green
```

If HEAD's CI is red or still running, say so. Releasing on top of it just
means the `release` job will fail or wait. Let the user decide whether to wait.

The working tree often has other sessions' uncommitted work in it (see
`git status`). That's fine. You will stage only the four version files.

## 2. What's in this release

```bash
LAST=$(git describe --tags --abbrev=0 --match 'v[0-9]*' HEAD); echo "$LAST"
git log "$LAST"..HEAD --no-merges --format='%h %ad %s' --date=short
git tag -l "$LAST" --format='%(contents)'   # style reference for the new message
```

If the log is empty, there's nothing to release. Say so and stop. Read the
commit bodies (`git show <sha> --stat`) for anything whose subject line doesn't
make its user-visible effect clear.

## 3. Pick the version (semver, from 1.0.0 on)

The public surface is the web UI, the HTTP API (the MCDU client in
https://github.com/oshogun/sabia_mcdu and the MCP server depend on the ingest,
ACARS and navdata routes), the database file a user upgrades in place, and the
install/run procedure in `README.md`/`docs/`.

- **MAJOR**: something that worked stops working without the user or the
  MCDU client changing too. That covers removing or renaming an API route or
  payload field, a DB migration that can't be rolled back or needs a manual
  step, a required new config/env var, a Node major bump, or dropping a
  feature or a supported sim connection (v1.0.0 retired the Node agent).
- **MINOR**: a new user-visible feature, a new endpoint or field (additive), or
  an additive migration.
- **PATCH**: fixes only. Docs, CI, tests and refactors with no behaviour change
  also go here. If *only* `.claude/**`, `docs/**` or CI changed, suggest not
  releasing at all.

Commits touching only `.claude/**` (workflow, skills, agents) never count
toward the bump or the notes.

## 4. Draft the tag message

Match the existing tags exactly:

```
vX.Y.Z — <short theme, 2–5 words> (YYYY-MM-DD)

BREAKING: <one paragraph per breaking change, what to do about it>   ← MAJOR only, first

- <user-visible change, present tense, one line>
- …
```

- Name the effect, not the implementation: "Prefiles can be moved between
  trips", not "add PATCH /api/prefiles/:id/trip".
- Group related commits into one bullet. Aim for 3–10 bullets. Leave out
  internal-only commits (tests, refactors, workflow).
- The date is today's date, which is the release date.
- The title line must be **one line**, followed by a blank line. Git joins
  a title that wraps onto a second line into one subject, and that second
  line then appears nowhere in the notes.

## 5. Confirm with the user

Show the user, in one message:
- the proposed version, and why that bump (quote the breaking or feature
  commit);
- the full tag message;
- what the push will send: `git log origin/main..main --oneline` plus the new
  bump commit.

Wait for approval or edits. Don't proceed on silence.

## 6. Bump, commit, tag

```bash
cd /home/guilherme/msfslogger
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use >/dev/null
V=X.Y.Z   # no leading v
node -e '
const fs=require("fs"); const v=process.argv[1];
for (const f of ["package.json","package-lock.json","client/package.json","client/package-lock.json"]) {
  const o=JSON.parse(fs.readFileSync(f,"utf8")); o.version=v;
  if (o.packages && o.packages[""]) o.packages[""].version=v;
  fs.writeFileSync(f, JSON.stringify(o,null,2)+"\n");
}' "$V"
git diff --stat -- package.json package-lock.json client/package.json client/package-lock.json
                                     # expect exactly 4 files, 6 changed lines (1+2+1+2)
git add package.json package-lock.json client/package.json client/package-lock.json
git commit -m "Release v$V" -m "Co-Authored-By: <the attribution line from the system reminder>"
git tag -a "v$V" -F <file-with-the-approved-message>   # write it under .claude/scratch/, delete after
git cat-file -t "refs/tags/v$V"                        # must print: tag
git tag -l "v$V" --format='%(contents:subject)'        # check the title came out right
```

Don't use `npm version`. It runs lifecycle scripts, and it makes its own
commit and tag with a message you didn't write. The node one-liner above
produces byte-identical formatting (tested 2026-09-26: a round-trip of all four
files without changing anything gives no diff).

## 7. Push and watch

```bash
git push origin main
git push origin "v$V"
```

Push **one tag per push**. GitHub creates no workflow events at all when more
than three tags are pushed at once. The eight retroactive tags pushed together
on 2026-09-26 started no CI run. A tag on a commit older than the `release`
job can't trigger it at all, whatever the batch size, because GitHub reads
the workflow file from the tagged commit. So a retroactive Release is made by
hand: `gh release create vX.Y.Z --verify-tag --title <subject> --notes <body>`.

The tag push starts its own CI run, on the same commit as the `main` run but
with the tag as `headBranch`:

```bash
gh run list --workflow CI --commit "$(git rev-parse HEAD)" --limit 5 \
  --json databaseId,headBranch,status,conclusion \
  --jq ".[] | select(.headBranch==\"v$V\")"
gh run watch <databaseId> --exit-status   # run_in_background: it takes several minutes (e2e + docker)
gh release view "v$V" --json name,url,isLatest
```

Report the Release URL. v1.x Releases published this way should show
`isLatest: true`.

## 8. When it goes wrong

No Release exists until the `release` job succeeds, so a failed run publishes
nothing. Deleting a pushed tag is outward-facing, so **ask the user first**,
then:

- **Version mismatch** (the job's `::error::Tag … does not match`): someone
  tagged without bumping. Delete the tag (`git push origin :refs/tags/vX.Y.Z`
  and `git tag -d vX.Y.Z`), run step 6's bump, and re-tag.
- **Lightweight tag or empty message** (the job refuses a tag that isn't
  annotated or has no title): delete the tag the same way and re-tag with
  `git tag -a "v$V" -F <message file>`.
- **Tests, e2e or Docker failed**: the commit isn't releasable. Delete the tag
  the same way, fix it through the normal workflow, and re-run this skill.
  Reusing the version number is fine, because nothing was published under it.
- **The release job itself errored** (gh/permissions): that's CI work. Fix it
  with `/update-ci`, then re-run the failed job (`gh run rerun <id> --failed`).
  The job skips Releases that already exist, so a re-run is safe.

## 9. Follow-ups to offer

- `/update-site`: the website's Development status shows the release count
  and the latest version.
- For a MAJOR release that changes an API the MCDU client uses, tell the MCDU
  session (find it with `ListAgents`) and send it the exact breaking change.
