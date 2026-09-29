#!/usr/bin/env bash
# Stop the scratch servers serve-rev.sh started, by their recorded PIDs only
# (never pkill by name or pattern: the live server is also `node dist/index.js`).
# Deletes nothing; SKILL.md says how to remove the scratch dir.
#
#   teardown.sh <scratch-dir>
set -uo pipefail
SCRATCH="${1:?scratch dir}"
for pidfile in "$SCRATCH"/server-*.pid; do
  [ -f "$pidfile" ] || continue
  pid=$(cat "$pidfile")
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
  case "$cwd" in
    "$SCRATCH"/*)
      kill "$pid" && echo "stopped $pid ($cwd)" ;;
    "")
      echo "$pid already gone" ;;
    *)
      echo "NOT killing $pid: its cwd $cwd is outside $SCRATCH" >&2 ;;
  esac
done
ss -ltnH "sport = :3000" | grep -q . && echo "live server on :3000 still listening"
