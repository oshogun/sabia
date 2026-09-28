#!/usr/bin/env bash
# Packages a reproducible release tarball from an already-built tree.
#
# Usage: packaging/build-bundle.sh <version> <out-dir>
#
# Preconditions: dist/index.js and client/dist/index.html already exist at
# the repo root (the caller builds the server and client first). This script
# never runs npm or a build itself — it only copies and archives.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION="${1:-}"
OUT_DIR="${2:-}"

if [ -z "$VERSION" ] || [ -z "$OUT_DIR" ]; then
  echo "usage: $0 <version> <out-dir>" >&2
  exit 1
fi

# X.Y.Z, optionally followed by a semver 2.0 prerelease (-alpha, -beta.1, ...).
# No build metadata (+...): a bundle name and a release tag both need to stay
# a single unambiguous string, and build metadata is defined by semver to be
# ignored in comparisons, which would make two different bundles collide.
SEMVER_IDENT='(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
VERSION_RE="^[0-9]+\\.[0-9]+\\.[0-9]+(-${SEMVER_IDENT}(\\.${SEMVER_IDENT})*)?\$"
if ! [[ "$VERSION" =~ $VERSION_RE ]]; then
  echo "error: version '$VERSION' does not match X.Y.Z or X.Y.Z-PRERELEASE (semver 2.0 prerelease identifiers)" >&2
  exit 1
fi

if [ ! -f "$REPO_ROOT/dist/index.js" ] || [ ! -f "$REPO_ROOT/client/dist/index.html" ]; then
  echo "error: dist/index.js and client/dist/index.html must exist before running this script (build first)" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

STAGE_NAME="sabia-server-$VERSION"
STAGE_DIR="$OUT_DIR/$STAGE_NAME"

if [ -e "$STAGE_DIR" ]; then
  echo "error: staging directory $STAGE_DIR already exists" >&2
  exit 1
fi

TARBALL="$OUT_DIR/$STAGE_NAME.tar.gz"

mkdir -p "$STAGE_DIR"
# A failed tar/gzip/sha256sum below must not leave the staging directory
# behind, or the next run in this out-dir refuses with "already exists" —
# and must not leave a partial tarball/.sha256 either, which a later
# `sha256sum -c` or `tar -tzf` would otherwise silently fail against.
# shellcheck disable=SC2154 # rc is assigned by this trap's own command string; shellcheck checks it out of that context
trap 'rc=$?; rm -rf "$STAGE_DIR"; [ $rc = 0 ] || rm -f "$TARBALL" "$TARBALL.sha256"' EXIT

cp -R "$REPO_ROOT/dist" "$STAGE_DIR/dist"
mkdir -p "$STAGE_DIR/client"
cp -R "$REPO_ROOT/client/dist" "$STAGE_DIR/client/dist"
cp "$REPO_ROOT/package.json" "$STAGE_DIR/package.json"
cp "$REPO_ROOT/package-lock.json" "$STAGE_DIR/package-lock.json"
cp "$REPO_ROOT/airports.json" "$STAGE_DIR/airports.json"
cp "$REPO_ROOT/airport-tiers.json" "$STAGE_DIR/airport-tiers.json"
cp "$REPO_ROOT/LICENSE" "$STAGE_DIR/LICENSE"
printf '%s\n' "$VERSION" > "$STAGE_DIR/VERSION"

# Fail loudly if something outside the expected entry list slipped into the
# staging directory before it gets archived. LC_ALL=C on both sides so the
# comparison doesn't depend on the caller's locale collation.
EXPECTED_ENTRIES="$(printf 'dist\nclient\npackage.json\npackage-lock.json\nairports.json\nairport-tiers.json\nVERSION\nLICENSE\n' | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')"
ACTUAL_ENTRIES="$(cd "$STAGE_DIR" && find . -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')"
if [ "$ACTUAL_ENTRIES" != "$EXPECTED_ENTRIES" ]; then
  echo "error: staged bundle entries do not match the expected list" >&2
  echo "  expected: $EXPECTED_ENTRIES" >&2
  echo "  actual:   $ACTUAL_ENTRIES" >&2
  exit 1
fi

COMMIT_TIME="$(git -C "$REPO_ROOT" log -1 --format=%ct 2>/dev/null || echo 0)"

(
  cd "$OUT_DIR"
  tar --sort=name --owner=0 --group=0 --numeric-owner \
      --mtime="@$COMMIT_TIME" --mode='u+rwX,go+rX,go-w' \
      -cf - "$STAGE_NAME" | gzip -n > "$TARBALL"
)

# Same entry-list check, repeated on the finished tarball rather than only the
# staging directory it was built from.
TARBALL_ENTRIES="$(tar -tzf "$TARBALL" | cut -d/ -f2 | grep -v '^$' | LC_ALL=C sort -u | tr '\n' ' ' | sed 's/ $//')"
if [ "$TARBALL_ENTRIES" != "$EXPECTED_ENTRIES" ]; then
  echo "error: tarball entries do not match the expected list" >&2
  echo "  expected: $EXPECTED_ENTRIES" >&2
  echo "  actual:   $TARBALL_ENTRIES" >&2
  exit 1
fi

(
  cd "$OUT_DIR"
  sha256sum "$STAGE_NAME.tar.gz" > "$STAGE_NAME.tar.gz.sha256"
)

echo "$TARBALL"
echo "$OUT_DIR/$STAGE_NAME.tar.gz.sha256"
