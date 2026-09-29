#!/usr/bin/env bash
# Run Lighthouse (performance only) against scratch servers started by
# serve-rev.sh. Raw reports land in <scratch-dir>/results/ as
# <tag>-<page>-<preset>-<n>.json, the names aggregate.js parses.
#
#   run.sh <scratch-dir> <tag:port>... [-- <page:path>...]
#
# Env: RUNS (default 3), PRESETS (default "desktop mobile").
# Default pages: login:/login home:/ flights:/flights flight:/flight/1
set -uo pipefail

SCRATCH="${1:?scratch dir}"; shift
TARGETS=(); PAGES=()
while [ $# -gt 0 ] && [ "$1" != -- ]; do TARGETS+=("$1"); shift; done
[ "${1:-}" = -- ] && { shift; PAGES=("$@"); }
[ ${#PAGES[@]} -eq 0 ] && PAGES=(login:/login home:/ flights:/flights flight:/flight/1)
RUNS="${RUNS:-3}"; PRESETS="${PRESETS:-desktop mobile}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null
nvm use "$(tr -dc '0-9' < "$REPO_ROOT/.nvmrc" | head -c 2)" >/dev/null
export TMPDIR="$REPO_ROOT/.claude/scratch/tmp"; mkdir -p "$TMPDIR"

# The full Playwright Chromium hangs headless on this machine, even on
# about:blank. chrome-headless-shell (same Playwright cache) works.
CHROME_PATH=$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | sort -V | tail -1)
[ -x "${CHROME_PATH:-}" ] || { echo "no chrome-headless-shell in ~/.cache/ms-playwright" >&2; exit 1; }
export CHROME_PATH

LH=$(command -v lighthouse || ls "$HOME"/.nvm/versions/node/*/bin/lighthouse 2>/dev/null | sort -V | tail -1)
[ -x "${LH:-}" ] || { echo "lighthouse not installed; see SKILL.md § Tools" >&2; exit 1; }

OUT="$SCRATCH/results"; mkdir -p "$OUT"
for target in "${TARGETS[@]}"; do
  tag=${target%%:*}; port=${target#*:}
  [ "$port" = 3000 ] && { echo "refusing port 3000" >&2; exit 1; }
  sid=$(awk '$6=="msfslogger.sid"{print $7}' "$SCRATCH/cookie-$tag.txt")
  [ -n "$sid" ] || { echo "no session cookie for $tag" >&2; exit 1; }
  for page in "${PAGES[@]}"; do
    name=${page%%:*}; path=${page#*:}
    headers="{\"Cookie\":\"msfslogger.sid=$sid\"}"
    [ "$name" = login ] && headers='{}'
    for preset in $PRESETS; do
      flags=(); [ "$preset" = desktop ] && flags=(--preset=desktop)
      for i in $(seq 1 "$RUNS"); do
        f="$OUT/$tag-$name-$preset-$i.json"
        "$LH" "http://127.0.0.1:$port$path" "${flags[@]}" --only-categories=performance \
          --extra-headers="$headers" --output=json --output-path="$f" --quiet \
          --chrome-flags="--no-sandbox" > /dev/null 2>> "$OUT/errors.log" \
          || echo "FAIL $tag $name $preset $i" >> "$OUT/errors.log"
        echo "$tag $name $preset $i"
      done
    done
  done
done
echo "done: $(ls "$OUT"/*.json 2>/dev/null | wc -l) reports in $OUT"
