#!/usr/bin/env bash
set -euo pipefail

# This script lives two directories below the repo root (client/e2e/), so
# climbing out of it takes two ../ hops.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRATCH="${MSFSLOGGER_E2E_SCRATCH:-${TMPDIR:-/tmp}/msfslogger-e2e}"
PORT="${MSFSLOGGER_E2E_PORT:-3210}"

# Guard 1: never the developer's live server port.
if [ "$PORT" = "3000" ]; then
  echo "refusing to use port 3000 (the developer's live server)" >&2
  exit 1
fi

# Guard 2: the copy and the build must land outside the tree, or the build
# step below becomes exactly the live-build accident this script exists to
# prevent.
case "$SCRATCH" in
  "$REPO_ROOT"|"$REPO_ROOT"/*)
    echo "refusing to use a scratch dir inside the repo: $SCRATCH" >&2
    exit 1
    ;;
esac

# Guard 3: the dependency trees this script symlinks from must already exist.
if [ ! -d "$REPO_ROOT/node_modules" ] || [ ! -d "$REPO_ROOT/client/node_modules" ]; then
  echo "missing node_modules; run 'npm ci' (root) and 'cd client && npm ci' first" >&2
  exit 1
fi

# Guard 4: the copy step below depends on git to know which files to take.
if ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "$REPO_ROOT is not a git work tree" >&2
  exit 1
fi

# Guard 5: the Node major must match .nvmrc. The default node on this
# machine is a different major than the one this repo is pinned to
# (package.json engines / .nvmrc), and a mismatch here fails silently later
# as a 180s webServer readiness timeout instead of a clear error up front.
want="$(tr -dc '0-9' < "$REPO_ROOT/.nvmrc" | head -c 2)"
have="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$have" != "$want" ]; then
  echo "refusing to run under Node $have; this repo needs Node $want" >&2
  echo "  export NVM_DIR=\"\$HOME/.nvm\"; . \"\$NVM_DIR/nvm.sh\"; nvm use $want" >&2
  exit 1
fi

rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"

# Copy the tracked tree, plus anything untracked-but-not-gitignored (a file
# added by a sibling task and not yet committed still has to make it into the
# scratch tree, or its absence surfaces as an opaque build/timeout failure
# instead of a clear "no such file").
git -C "$REPO_ROOT" ls-files --cached --others --exclude-standard \
    src client package.json package-lock.json tsconfig.json .nvmrc \
  | grep -v '^client/dist/' \
  | tar -C "$REPO_ROOT" -cf - -T - | tar -C "$SCRATCH" -xf -
[ -f "$REPO_ROOT/airports.json" ] && cp "$REPO_ROOT/airports.json" "$SCRATCH/"

# Link the dependency trees instead of reinstalling them; the build below
# only reads them.
ln -s "$REPO_ROOT/node_modules" "$SCRATCH/node_modules"
ln -s "$REPO_ROOT/client/node_modules" "$SCRATCH/client/node_modules"

cd "$SCRATCH"
npm run build

export FLIGHTS_DB_PATH="$SCRATCH/e2e.db"
node "$SCRATCH/dist/testSeed.js"

# exec so the process this script's caller tracks is the server itself, not
# a wrapper shell still holding the port after teardown.
exec env PORT="$PORT" BIND_HOST=127.0.0.1 \
    FLIGHTS_DB_PATH="$SCRATCH/e2e.db" \
    INGEST_TOKEN=e2e-ingest-token-not-a-secret \
    node dist/index.js
