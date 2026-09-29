#!/usr/bin/env bash
# Build one revision of the app into a scratch copy, seed a fictional logbook,
# start it on a scratch port and log in. Never touches the live checkout's
# client/dist, flights.db or port 3000.
#
#   serve-rev.sh <scratch-dir> <tag> <rev|WORKTREE> <port>
#
# <scratch-dir> must be an absolute path under .claude/scratch/ and must
# already exist. <tag> becomes <scratch-dir>/<tag>/ and must not exist yet (a
# fresh dir per run: this script never deletes anything). WORKTREE copies the
# live working tree, including uncommitted and untracked-but-not-ignored files.
# Writes <scratch-dir>/server-<tag>.pid and <scratch-dir>/cookie-<tag>.txt.
set -euo pipefail

SCRATCH="${1:?scratch dir}"; TAG="${2:?tag}"; REV="${3:?rev or WORKTREE}"; PORT="${4:?port}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

[ "$PORT" = 3000 ] && { echo "refusing port 3000 (the live server)" >&2; exit 1; }
case "$SCRATCH" in
  "$REPO_ROOT"/.claude/scratch/*) ;;
  *) echo "scratch dir must be under $REPO_ROOT/.claude/scratch/: $SCRATCH" >&2; exit 1 ;;
esac
[ -d "$SCRATCH" ] || { echo "create $SCRATCH first" >&2; exit 1; }
[[ "$TAG" =~ ^[a-z0-9]+$ ]] || { echo "tag must be [a-z0-9]+ (it is parsed out of result file names)" >&2; exit 1; }
DIR="$SCRATCH/$TAG"
[ -e "$DIR" ] && { echo "$DIR already exists; pick a new tag or scratch dir" >&2; exit 1; }
if ss -ltnH "sport = :$PORT" | grep -q .; then echo "port $PORT is already in use" >&2; exit 1; fi
[ -d "$REPO_ROOT/node_modules" ] && [ -d "$REPO_ROOT/client/node_modules" ] \
  || { echo "live checkout has no node_modules to link" >&2; exit 1; }

export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null
nvm use "$(tr -dc '0-9' < "$REPO_ROOT/.nvmrc" | head -c 2)" >/dev/null
export TMPDIR="$REPO_ROOT/.claude/scratch/tmp"; mkdir -p "$TMPDIR"

mkdir -p "$DIR"
if [ "$REV" = WORKTREE ]; then
  git -C "$REPO_ROOT" ls-files --cached --others --exclude-standard \
      src client package.json package-lock.json tsconfig.json .nvmrc \
    | grep -v '^client/dist/' | tar -C "$REPO_ROOT" -cf - -T - | tar -C "$DIR" -xf -
else
  git -C "$REPO_ROOT" archive "$REV" src client package.json package-lock.json tsconfig.json .nvmrc \
    | tar -C "$DIR" -xf -
fi
[ -f "$REPO_ROOT/airports.json" ] && cp "$REPO_ROOT/airports.json" "$DIR/"
# Linked, not installed: the build only reads them. A revision whose
# package-lock differs from the live one needs its own install instead.
ln -s "$REPO_ROOT/node_modules" "$DIR/node_modules"
ln -s "$REPO_ROOT/client/node_modules" "$DIR/client/node_modules"
if ! git -C "$REPO_ROOT" diff --quiet "${REV/WORKTREE/HEAD}" -- package-lock.json client/package-lock.json 2>/dev/null; then
  echo "warning: $REV's lockfiles differ from the live checkout's; linked node_modules may not match" >&2
fi

live_mtime=$(stat -c %Y "$REPO_ROOT/client/dist/index.html" 2>/dev/null || echo none)
(cd "$DIR" && npm run build > "$SCRATCH/build-$TAG.log" 2>&1) \
  || { echo "build failed; see $SCRATCH/build-$TAG.log" >&2; exit 1; }
[ "$live_mtime" = "$(stat -c %Y "$REPO_ROOT/client/dist/index.html" 2>/dev/null || echo none)" ] \
  || { echo "LIVE client/dist changed during the build; stop and tell the user" >&2; exit 1; }

export FLIGHTS_DB_PATH="$DIR/lh.db"
(cd "$DIR" && node dist/testSeed.js > /dev/null)

(cd "$DIR" && PORT="$PORT" BIND_HOST=127.0.0.1 FLIGHTS_DB_PATH="$DIR/lh.db" \
  INGEST_TOKEN=lighthouse-benchmark-not-a-secret \
  nohup node dist/index.js > "$SCRATCH/server-$TAG.log" 2>&1 &)

# `$!` from a backgrounded subshell is not the server's PID; the listening
# socket is the only reliable source.
pid=""
for _ in $(seq 1 30); do
  pid=$(ss -ltnpH "sport = :$PORT" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)
  [ -n "$pid" ] && break; sleep 0.5
done
[ -n "$pid" ] || { echo "server did not start; see $SCRATCH/server-$TAG.log" >&2; exit 1; }
echo "$pid" > "$SCRATCH/server-$TAG.pid"

user="${MSFSLOGGER_E2E_USERNAME:-e2e}"; pass="${MSFSLOGGER_E2E_PASSWORD:-e2e-password-123}"
code=$(curl -s -o /dev/null -w '%{http_code}' -c "$SCRATCH/cookie-$TAG.txt" \
  -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:$PORT" \
  -d "{\"username\":\"$user\",\"password\":\"$pass\"}" "http://127.0.0.1:$PORT/api/auth/login")
[ "$code" = 200 ] || { echo "login returned $code" >&2; exit 1; }
echo "$TAG: $REV on http://127.0.0.1:$PORT (pid $pid), logged in as $user"
