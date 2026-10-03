#!/usr/bin/env bash
# Temporary (WP-04). Read-only job: resolves the dev dependencies with npm,
# formats with Prettier and exports the resulting commits as patches.
set -uo pipefail
OUT="$RUNNER_TEMP/wp04"
mkdir -p "$OUT/patches"
NOTES="$OUT/prepare.md"
BASE=$(git rev-parse HEAD)
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
DEV_PKGS=(eslint@^9 @eslint/js@^9 typescript-eslint@^8 eslint-config-prettier@^10 prettier@^3)

note() { echo "$*" >> "$NOTES"; }
block() { { echo; echo '```'; tail -n "${2:-80}" "$1"; echo '```'; echo; } >> "$NOTES"; }
finish() {
  git format-patch -q "$BASE"..HEAD -o "$OUT/patches"
  note "- Commits exported: $(git rev-list --count "$BASE"..HEAD)"
  exit "$1"
}

note "## prepare (ubuntu-latest, Node $(node -v), npm $(npm -v))"
note ""
note "- Base commit: $BASE"

if node -e 'process.exit(require("./package.json").devDependencies?.eslint ? 0 : 1)'; then
  note "- Dev dependencies already in package.json; lockfile step skipped."
else
  cp package.json "$OUT/package.before.json"
  cp package-lock.json "$OUT/package-lock.before.json"
  if ! npm install -D --package-lock-only --ignore-scripts --no-audit --no-fund "${DEV_PKGS[@]}" > "$OUT/npm-install.log" 2>&1; then
    note "- **npm install --package-lock-only failed**"
    block "$OUT/npm-install.log"
    finish 1
  fi
  if ! node .github/wp04/verify-lock.mjs "$OUT/package.before.json" "$OUT/package-lock.before.json" >> "$NOTES" 2>&1; then
    note "- **Lockfile verification failed; nothing committed.**"
    git checkout -- package.json package-lock.json
    finish 1
  fi
  git add package.json package-lock.json
  git commit -q -m "build(deps-dev): add ESLint and Prettier" \
    -m "Resolved with npm on a GitHub runner (npm install -D --package-lock-only --ignore-scripts). Existing package-lock.json entries are unchanged."
fi

if ! npm ci --no-audit --no-fund > "$OUT/npm-ci.log" 2>&1; then
  note "- **npm ci failed**"
  block "$OUT/npm-ci.log"
  finish 1
fi

if ! npx --no-install prettier --write . > "$OUT/prettier.log" 2>&1; then
  note "- **prettier --write failed**"
  block "$OUT/prettier.log"
  finish 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git commit -q -a -m "style: format the code base with Prettier" \
    -m "Formatting only (prettier --write .); no functional changes."
  note "- Prettier: $(git show --shortstat --format= HEAD | xargs)"
  note ""
  note '```'
  git show --stat=200 --format= HEAD >> "$NOTES"
  note '```'
else
  note "- Prettier: no changes"
fi
left=$(git status --porcelain)
if [ -n "$left" ]; then note "- Uncommitted after formatting: $(echo "$left" | tr '\n' ' ')"; fi
finish 0
