#!/usr/bin/env bash
# Temporary (WP-04). Runs every project check and writes a Markdown summary.
set -uo pipefail
NAME="$1"
OUT="$RUNNER_TEMP/wp04-verify"
mkdir -p "$OUT"
R="$OUT/$NAME.md"
echo "### $NAME (Node $(node -v), npm $(npm -v), commit $(git rev-parse --short HEAD))" > "$R"
echo >> "$R"

run() {
  local label="$1"
  shift
  local log="$OUT/$NAME-${label//[^a-zA-Z0-9]/_}.log"
  local start=$SECONDS
  "$@" > "$log" 2>&1
  local code=$?
  echo "- \`$label\`: exit $code ($((SECONDS - start)) s)" >> "$R"
  if [ $code -ne 0 ]; then
    { echo; echo '```'; tail -n 200 "$log"; echo '```'; echo; } >> "$R"
  fi
}

run "npm ci" npm ci --no-audit --no-fund
run "npm run lint" npm run lint
run "npm run format:check" npm run format:check
run "npm run typecheck" npm run typecheck
run "npm run typecheck:extension" npm run typecheck:extension
run "npm run build" npm run build
run "npm run build:extension" npm run build:extension
run "npm test" npm test
run "npm run test:extension" npm run test:extension
run "npm run check" npm run check
if [ "$RUNNER_OS" = "Linux" ]; then
  # npm test (default vitest config) must not pick up the real-browser E2E.
  run "vitest list (default config) has no tests-e2e" bash -c \
    'npx --no-install vitest list --filesOnly > "$1" 2>&1; c=$?; cat "$1"; [ $c -eq 0 ] && ! grep -q "tests-e2e" "$1"' _ "$OUT/vitest-list.txt"
  echo "- default vitest files: $(grep -c '\.test\.ts' "$OUT/vitest-list.txt"), of which tests-e2e: $(grep -c 'tests-e2e' "$OUT/vitest-list.txt")" >> "$R"
fi
left=$(git status --porcelain)
if [ -n "$left" ]; then echo "- working tree after checks: $(echo "$left" | tr '\n' ' ')" >> "$R"; else echo "- working tree clean after checks" >> "$R"; fi
