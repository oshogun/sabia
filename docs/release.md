# Release

Sabiá uses [semantic versioning](https://semver.org/). Each release is an
annotated git tag `vX.Y.Z` on `main`, published as a
[GitHub Release](https://github.com/oshogun/sabia/releases) whose notes come
from the tag message. CI publishes the Release, with a prebuilt server
bundle and the installers attached, and pushes the Docker image to Docker Hub,
once the tagged commit passes every check.

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

## The MCDU client's versions

The [Sabiá MCDU client](https://github.com/oshogun/sabia_mcdu) is versioned
and released the same way in its own repository: annotated `vX.Y.Z` tags,
with each tag's message as the notes on its
[Releases page](https://github.com/oshogun/sabia_mcdu/releases). Its
v0.1.0–v0.6.0 were tagged after the fact on 2026-09-27; v1.0.0 (2026-09-27)
is its first release with installers attached, an unsigned MSI and an NSIS
`setup.exe`.

Each MCDU Release says which server versions it works with:

| MCDU | Server |
|---|---|
| 1.x | 1.0.0 or newer |

When a server major version breaks a route the MCDU uses (ingest, ACARS,
navdata, ground session or prefiles), the MCDU gets a matching release that
says so, and the other way round. The MCDU's own
[release doc](https://github.com/oshogun/sabia_mcdu/blob/main/docs/release.md)
covers its install requirements and how it cuts a release.

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

**Installer.** Re-run the install command
([setup.md](setup.md#installer)); add `--version X.Y.Z` (`SABIA_VERSION`)
for a specific release. It keeps the running server up until the new
release is downloaded and prepared, and rolls back if the new version
doesn't come up healthy.

**Docker.** `docker compose pull && docker compose up -d`, with
`SABIA_VERSION=X.Y.Z` set to pin a release instead of `latest`. If you
build from your checkout, use
`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`
after `git pull`.

**Source checkout:**

```bash
git pull                  # main always has the newest code; each release is a tag on it
(cd client && npm ci)     # only when client/package.json changed
npm run build
npm start                 # or restart however you run it — see operations.md
```

To run a specific release rather than the tip of `main`, use
`git checkout vX.Y.Z` in place of `git pull`, then build the same way.

There is no staged rollout, canary, or blue/green concept. This is a
single-operator, self-hosted app with, typically, one running instance.

## Prereleases

A version with a prerelease suffix, such as `1.1.0-beta.1`, is released the
same way, from a `v1.1.0-beta.1` tag. The suffix follows semver: dot-separated
parts made of letters, digits and `-`, with no `+build` metadata. What differs:

- The GitHub Release is marked as a prerelease, so it never becomes
  "Latest". The installers' default "latest release" lookup skips it.
- Docker Hub gets only `oshogun/sabia:1.1.0-beta.1`. `latest`, `1` and `1.1`
  are not moved.
- Testers install it explicitly: `--version 1.1.0-beta.1` (install.sh),
  `SABIA_VERSION=1.1.0-beta.1` (either script), or
  `SABIA_VERSION=1.1.0-beta.1 docker compose pull`.

## Cutting a release

The version lives in four places, which must all match the tag:

- `package.json` and `client/package.json`: the `version` field.
- `package-lock.json` and `client/package-lock.json`: the top-level `version`
  and `packages[""].version`.

Then:

1. Bump all four to the new version and commit that on `main`.
2. Tag it with an annotated tag (`git tag -a`). The first line of the
   message becomes the Release title and everything after the blank line
   becomes its notes, so write them for someone running Sabiá. Keep the
   title on one line: git joins a title that wraps onto a second line into
   one line, and that second line never reaches the notes.

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
2. checks whether a Release for the tag already exists;
3. builds the client and server and packs them with
   `packaging/build-bundle.sh` into `sabia-server-X.Y.Z.tar.gz` and its
   `.sha256`, so a failed build stops the job before any Release exists;
4. if no Release exists yet: fails if the tag is a lightweight tag (made
   with plain `git tag`) or an annotated tag with an empty message, then
   creates the Release with `gh release create`, using the annotated tag's
   subject as the title and its body as the notes. A lightweight tag carries
   no message of its own, and git would hand back the tagged commit's message
   instead, so the job refuses it rather than publish a Release titled after
   a commit;
5. uploads the bundle, its `.sha256`, `packaging/install.sh` and
   `packaging/install.ps1` to the Release with `--clobber`. This step runs
   whether or not step 4 created the Release, so re-running the job is safe.

A `publish-image` job then runs after `release`. It builds the image for
`linux/amd64` and `linux/arm64` and pushes it to Docker Hub as
`oshogun/sabia`, tagged `X.Y.Z`, `X.Y`, `X` and `latest`. It logs in with the
repository secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (a Docker Hub
access token), which must exist before the first release tag. `latest`
follows the most recently pushed release tag, so a patch release on an older
line also moves `latest`.

### The release bundle

`sabia-server-X.Y.Z.tar.gz` has one top-level directory
`sabia-server-X.Y.Z/` holding `dist/`, `client/dist/`, `package.json`,
`package-lock.json`, `airports.json`, `airport-tiers.json`, `VERSION` and
`LICENSE`, and no `node_modules`. It is the same for every OS: the
installers run `npm ci --omit=dev` against it with their own Node 24, which
fetches the native `better-sqlite3` binary for the machine. The first
release with a bundle is the first after v1.0.0.

If a check fails, nothing is published. Delete the tag
(`git push origin :refs/tags/vX.Y.Z` and `git tag -d vX.Y.Z`), fix the
problem, and tag again. Reusing the number is fine because no Release went
out under it.

A failure after the Release exists, in the upload step or in
`publish-image` (for example missing Docker Hub secrets), is different:
fix the cause and re-run the failed jobs from the Actions page. Don't
re-tag, since the Release is already public.

Push one tag at a time. GitHub starts no workflow runs at all when more than
three tags are pushed together. A tag on a commit that predates the
`release` job never triggers it either, because GitHub runs the workflow
file as it was at the tagged commit. Both are why the eight tags above were
published by hand with `gh release create`.

In this repository's agentic workflow, the `/version-release` skill
(`.claude/skills/version-release/SKILL.md`) runs this whole procedure: it
proposes the version from the commits since the last tag, drafts the notes,
asks before pushing, and watches the release job.
