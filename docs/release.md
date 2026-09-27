# Release

Sabiá uses [semantic versioning](https://semver.org/). Each release is an
annotated git tag `vX.Y.Z` on `main`, published as a
[GitHub Release](https://github.com/oshogun/sabia/releases) whose notes come
from the tag message. CI publishes the Release once the tagged commit passes
every check.

## Versions so far

The history before 1.0.0 was tagged after the fact, on 2026-09-26, at the
commit that closed each phase:

| Tag | Commit | Date | Theme |
|---|---|---|---|
| `v0.1.0` | `8e3282e` | 2026-05-04 | First logger |
| `v0.2.0` | `cff1745` | 2026-08-24 | Windows agent, PDFs and the Atlas |
| `v0.3.0` | `d8ef683` | 2026-09-07 | Trip planning |
| `v0.4.0` | `2dada22` | 2026-09-10 | Auth, traffic and CI |
| `v0.5.0` | `5eb3571` | 2026-09-18 | ACARS and dispatch |
| `v0.6.0` | `6ce71e3` | 2026-09-22 | Replay and navdata |
| `v0.7.0` | `d598013` | 2026-09-24 | Sabiá |
| `v1.0.0` | `589e38d` | 2026-09-26 | MCDU-only sim connection |

Each Release lists what changed. There is no `CHANGELOG.md`: the Releases
page is the changelog.

## What the version number means

From 1.0.0 on, the version tracks what someone running Sabiá depends on: the
web UI, the HTTP API (the [MCDU client](https://github.com/oshogun/sabia_mcdu)
and the MCP server use the ingest, ACARS and navdata routes), the database
file you upgrade in place, and the install and run steps in
[setup.md](setup.md) and [operations.md](operations.md).

- **Major**: something that worked stops working unless you or the MCDU
  client change too. That covers removing or renaming an API route or payload
  field, a migration that can't be rolled back or needs a manual step, a new
  required environment variable, a new Node major version, or dropping a
  feature or a way to connect a sim. v1.0.0 is one: it retired the Node.js
  SimConnect agent.
- **Minor**: a new feature, a new endpoint or field, or a migration that only
  adds.
- **Patch**: fixes only, plus docs, CI, test and refactor changes that don't
  change behaviour.

The Release notes for a major version start with a `BREAKING:` paragraph that
says what to do about each break.

## Upgrading an instance

Take a backup first ([operations.md](operations.md#backups)), and read the
Release notes for every version between yours and the new one, looking for
`BREAKING:`. Then:

```bash
git pull                  # main always has the newest code; each release is a tag on it
(cd client && npm ci)     # only when client/package.json changed
npm run build
npm start                 # or restart however you run it — see operations.md
```

To run a specific release rather than the tip of `main`, use
`git checkout vX.Y.Z` in place of `git pull`, then build the same way.

For a Docker deployment: `docker compose build && docker compose up -d`. No
image is published to a registry: you build it from your checkout.

There is no staged rollout, canary, or blue/green concept. This is a
single-operator, self-hosted app with, typically, one running instance.

## Cutting a release

The version lives in four places, which must all match the tag:

- `package.json` and `client/package.json`: the `version` field.
- `package-lock.json` and `client/package-lock.json`: the top-level `version`
  and `packages[""].version`.

Then:

1. Bump all four to the new version and commit that on `main`.
2. Tag it with an annotated tag. The first line of the message becomes the
   Release title and the rest becomes its notes, so write them for someone
   running Sabiá:

   ```
   vX.Y.Z — <theme> (YYYY-MM-DD)

   BREAKING: <what breaks and what to do>      (major versions only)

   - <user-visible change>
   ```

3. Push `main`, then push the tag on its own: `git push origin vX.Y.Z`.

Pushing the tag starts a CI run on that commit. Its `release` job runs only
for tags that start with `v`, and only after `build-and-test`, `docker` and
`e2e` pass (see [development.md](development.md#ci)). The job:

1. fails if the tag without its `v` differs from the version in `package.json`
   or `client/package.json`;
2. does nothing if a Release for the tag already exists, so re-running it is
   safe;
3. creates the Release with `gh release create`, using the annotated tag's
   subject as the title and its body as the notes. A lightweight tag has no
   message, so it gets the tag name as its title and GitHub's generated notes
   instead.

If a check fails, nothing is published. Delete the tag
(`git push origin :refs/tags/vX.Y.Z` and `git tag -d vX.Y.Z`), fix the
problem, and tag again. Reusing the number is fine because no Release went
out under it.

Push one tag at a time. GitHub starts no workflow runs at all when more than
three tags are pushed together, which is why the eight tags above were
published by hand.

In this repository's agentic workflow, the `/version-release` skill
(`.claude/skills/version-release/SKILL.md`) runs this whole procedure: it
proposes the version from the commits since the last tag, drafts the notes,
asks before pushing, and watches the release job.
