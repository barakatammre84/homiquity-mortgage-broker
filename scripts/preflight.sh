#!/usr/bin/env bash
#
# Preflight — run the WHOLE CI gate locally, before it costs anything.
#
# `.githooks/pre-push` runs the typecheck and the twelve guards (the unit suite is
# opt-in there: PREPUSH_TESTS=1) and is deliberately cheap enough to leave on.
# This runs the whole gate — the count is deliberately not written here, because it was
# wrong before anyone noticed (it said sixteen while running eighteen). It includes the
# three that only ever ran in CI and are
# the ones that catch a broken DEPLOY rather than a broken diff: the production
# build, the self-host boot, and the integration lane.
#
# WHY IT MATTERS BEYOND MINUTES. A merge to `main` is a Railway deploy. The gate
# is the last thing between a diff and production, and until now half of it was
# unreproducible on a laptop — so the only way to find out whether the bundle
# boots was to spend the minutes and wait. Roadmap KTLO-2 measures ~4 billed
# minutes per push against a 2,000-minute allowance, and a red one costs the
# re-run too; but the real saving is the loop time, not the money.
#
#   bash scripts/preflight.sh           # everything (needs a database)
#   bash scripts/preflight.sh --fast    # skip build + boot + integration
#   bash scripts/preflight.sh --no-db   # skip the two database stages explicitly
#
# A stage that cannot run is reported SKIPPED with the reason and does NOT pass.
# Green here is not a promise CI is green — it is the same checks on the same
# code, and the gaps are named at the bottom of the run.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

FAST=0; NO_DB=0
for a in "$@"; do
  case "$a" in
    --fast) FAST=1 ;;
    --no-db) NO_DB=1 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "preflight: unknown flag $a" >&2; exit 2 ;;
  esac
done

BOOT_PORT="${PREFLIGHT_BOOT_PORT:-3999}"
INT_PORT="${PREFLIGHT_INT_PORT:-4000}"
LOG=/tmp/preflight.log
RESULTS=()
FAILED=0
SKIPPED=0

step() {
  local label="$1"; shift
  printf '  %-38s' "$label"
  local start; start=$(date +%s)
  if "$@" >"$LOG" 2>&1; then
    local t=$(( $(date +%s) - start ))
    printf 'ok       %3ss\n' "$t"
    RESULTS+=("ok       $label")
  else
    local t=$(( $(date +%s) - start ))
    printf 'FAIL     %3ss\n' "$t"
    RESULTS+=("FAIL     $label")
    FAILED=$((FAILED+1))
    tail -25 "$LOG" | sed 's/^/      | /'
  fi
}

skip() {
  printf '  %-38s' "$1"
  printf 'SKIPPED  — %s\n' "$2"
  RESULTS+=("SKIPPED  $1 — $2")
  SKIPPED=$((SKIPPED+1))
}

if [ ! -x node_modules/.bin/vitest ]; then
  echo "preflight: dependencies are not installed in this checkout ($(pwd))."
  echo "  pnpm install --frozen-lockfile"
  echo "  (a fresh git worktree has no node_modules of its own — expected, not an error)"
  exit 1
fi

echo "preflight — mirroring CI's \`gate\` job on $(git rev-parse --short HEAD)"
echo

# --- cheap first: a type error should not wait behind three minutes of vitest ---
step "pre-push gate armed"            node scripts/hooks-installed-guard.cjs
step "typecheck (tsc)"                npx tsc --noEmit
step "schema <-> migrations"          node scripts/schema-migration-guard.cjs
step "migration ledger"               node scripts/migration-ledger-guard.cjs
step "delivery-stack freeze"          node scripts/delivery-stack-freeze-guard.cjs
step "design tokens"                  node scripts/design-token-guard.cjs
step "UI standard ratchet"            node scripts/ui-standard-guard.cjs
step "knowledge-base index"           node scripts/kb-index-guard.cjs
step "doc staleness ratchet"          node scripts/doc-staleness-guard.cjs
step "routine seat roster"            node scripts/seat-roster-guard.cjs --no-freshness
step "gating reality"                  pnpm guard:gating
step "vocabulary registry"             pnpm guard:vocab
# tsc covers the app; nothing covered scripts/*.cjs. #594 shipped a syntax error
# in browser-probe.cjs to main green, and every probe run crashed while a sweep
# grepping its output reported the pages clean. A parse is not a test — but it is
# the check that would have caught it.
step "guard scripts parse"            bash -c 'for f in scripts/*.cjs; do node --check "$f" || exit 1; done'
step "query-key convergence"          node scripts/query-key-guard.cjs
step "query-key reachability"         node scripts/query-key-reachability.cjs
step "query-key transport"            node scripts/query-key-transport-guard.cjs
step "citation ratchet"               node scripts/citation-guard.cjs
step "selling-guide corpus"           node scripts/selling-guide-corpus-guard.cjs
step "selling-guide coverage"         node scripts/selling-guide-coverage.cjs --check
step "selling-guide conformance"      node scripts/selling-guide-conformance-guard.cjs

# The full extraction proof needs pymupdf; CI always runs it (pinned, in a venv).
# Locally it runs only where pymupdf is importable — and SAYS so when skipped,
# because a silently skipped check reads as a pass.
if python3 -c "import pymupdf" >/dev/null 2>&1; then
  step "selling-guide extraction"       python3 scripts/extract-selling-guide.py --check
else
  echo "  ~ selling-guide extraction        SKIPPED (no pymupdf — CI runs the pinned proof)"
fi

# §9 needs the PR's changed-file set, which CI computes from the pull request.
# Locally the equivalent is the diff against origin/main. If origin/main is not
# fetched we cannot form that set, and the guard skips SILENTLY when
# CHANGED_FILES is unset — so we report it skipped rather than let it lie.
security_review() {
  local tmp; tmp="$(mktemp -d)"
  git diff --name-only origin/main...HEAD > "$tmp/files.txt" 2>/dev/null || return 2
  git diff -U0 origin/main...HEAD > "$tmp/lines.diff" 2>/dev/null || return 2
  CHANGED_FILES_FILE="$tmp/files.txt" CHANGED_LINES_FILE="$tmp/lines.diff" \
    PR_BODY="$(git log -1 --pretty=%B)" node scripts/security-review-guard.cjs
}
selling_guide_authority() {
  local tmp; tmp="$(mktemp -d)"
  git diff --name-only origin/main...HEAD > "$tmp/files.txt" 2>/dev/null || return 2
  git diff -U0 origin/main...HEAD > "$tmp/lines.diff" 2>/dev/null || return 2
  CHANGED_FILES_FILE="$tmp/files.txt" CHANGED_LINES_FILE="$tmp/lines.diff" \
    PR_BODY="$(git log -1 --pretty=%B)" pnpm guard:authority
}
if ! git rev-parse --verify origin/main >/dev/null 2>&1; then
  skip "security review (§9 triggers)" "origin/main not fetched — run: git fetch origin"
elif [ -z "$(git diff --name-only origin/main...HEAD 2>/dev/null)" ]; then
  # Nothing COMMITTED yet on this branch, so there is no PR-shaped diff to audit
  # and the guard correctly refuses to pass on an empty file set. That is a state,
  # not a defect — reporting it FAIL sent three consecutive clean runs red on
  # 2026-08-18 and trains people to read past a red §9 line, which is the one
  # line that must never be read past. Working-tree changes are deliberately NOT
  # substituted in: §9 audits what a PR would ship, and that means commits.
  skip "security review (§9 triggers)" "nothing committed on this branch yet — commit, then re-run"
else
  step "security review (§9 triggers)" security_review
fi

if git rev-parse --verify origin/main >/dev/null 2>&1 \
  && [ -n "$(git diff --name-only origin/main...HEAD 2>/dev/null)" ]; then
  step "selling-guide authority (§10)" selling_guide_authority
else
  skip "selling-guide authority (§10)" "no committed diff against origin/main"
fi

step "unit tests + collection floor" pnpm test
step "dependency audit (prod, high+)" pnpm audit --prod --audit-level=high

if [ "$FAST" = 1 ]; then
  skip "production build"             "--fast"
  skip "client bundle ratchet"        "--fast"
  skip "self-host boot"               "--fast"
  skip "integration lane"             "--fast"
else
  step "production build"             pnpm build
  step "client bundle ratchet"        node scripts/bundle-size-guard.cjs

  # ---------------------------------------------------------- database half ---
  DB_URL="${DATABASE_URL:-}"
  if [ "$NO_DB" = 1 ]; then
    DB_URL=""
    DB_REASON="--no-db"
  elif [ -z "$DB_URL" ]; then
    if DB_URL="$(bash scripts/local-db.sh url 2>/dev/null)" && [ -n "$DB_URL" ]; then
      # `url` starts the cluster if it is not running, but does not migrate or
      # seed. An unseeded database fails the integration lane for a reason that
      # is not the code, so bring it fully up.
      bash scripts/local-db.sh up >/dev/null 2>&1 || DB_URL=""
    fi
    [ -z "$DB_URL" ] && DB_REASON="no database — run: bash scripts/local-db.sh up"
  fi

  boot() { # <port> <node_env> <logfile> [deterministic-extraction]
    local port="$1" node_env="$2" logfile="$3" profile="${4:-}"
    (
      export NODE_ENV="$node_env" PORT="$port" DATABASE_URL="$DB_URL"
      export DEV_TEST_PASSWORD="${DEV_TEST_PASSWORD:-test1234}" RATE_LIMIT_RELAXED=true
      export SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(48).toString("base64"))')"
      export PII_HASH_SALT="$(node -e 'console.log(require("crypto").randomBytes(48).toString("base64"))')"
      export CREDIT_ENCRYPTION_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
      if [ "$profile" = "deterministic-extraction" ]; then
        # The HTTP suite verifies routing, consent, persistence, and queue behavior.
        # Give only that development server deterministic model output so the lane
        # never depends on private object storage or a live model credential.
        export EXTRACTION_SIMULATE=true ANTHROPIC_API_KEY="" CLAUDE_API_KEY=""
      fi
      exec node dist/index.js
    ) > "$logfile" 2>&1 &
    echo $! > "/tmp/preflight-$port.pid"
    local code=000
    for _ in $(seq 1 45); do
      code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$port/api/health" 2>/dev/null || true)"
      [ "${code:-000}" = "200" ] && return 0
      kill -0 "$(cat "/tmp/preflight-$port.pid")" 2>/dev/null || break
      sleep 1
    done
    cat "$logfile"
    return 1
  }
  stop() { kill "$(cat "/tmp/preflight-$1.pid" 2>/dev/null)" 2>/dev/null; rm -f "/tmp/preflight-$1.pid"; }

  if [ -z "$DB_URL" ]; then
    skip "self-host boot (production mode)" "$DB_REASON"
    skip "integration lane"                 "$DB_REASON"
  else
    # Same claim CI makes: the PRODUCTION bundle boots in PRODUCTION mode and
    # serves /api/health. Build success is not boot success — that is the
    # 2026-07-17 postmortem rule.
    selfhost() { boot "$BOOT_PORT" production /tmp/preflight-selfhost.log; local r=$?; stop "$BOOT_PORT"; return $r; }
    step "self-host boot (production mode)" selfhost

    # The suite cannot authenticate against a production-mode server:
    # /api/test-login hard-404s there and the CSRF guard needs an Origin only
    # some of these files send. Same dist bundle, NODE_ENV=development. Each run
    # gets a fresh process on purpose — the auth limiter is in-memory and a
    # second pass inside 15 minutes 429s.
    integration() {
      boot "$INT_PORT" development /tmp/preflight-integration.log deterministic-extraction || { stop "$INT_PORT"; return 1; }
      TEST_BASE_URL="http://localhost:$INT_PORT" DATABASE_URL="$DB_URL" \
        DEV_TEST_PASSWORD="${DEV_TEST_PASSWORD:-test1234}" pnpm test:integration
      local r=$?; stop "$INT_PORT"; return $r
    }
    step "integration lane"                 integration
  fi
fi

echo
echo "────────────────────────────────────────────────────────────────"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo "────────────────────────────────────────────────────────────────"

# What green here still does not prove. Stated every run, on purpose: a preflight
# that implies more than it checked is worse than no preflight.
cat <<'EOF'

  Not covered by this run, even all-green:
    · migrate-prod and verify-deploy — they run on push to main, against prod
    · rendered layout, contrast, real devices — see scripts/browser-probe.cjs
    · anything that depends on prod data shape; this ran against a seeded DB
EOF

if [ "$FAILED" -gt 0 ]; then
  echo
  echo "PREFLIGHT FAILED — $FAILED check(s). Full output of the last one: $LOG"
  exit 1
fi
if [ "$SKIPPED" -gt 0 ]; then
  echo
  echo "preflight passed, $SKIPPED skipped (see reasons above) — CI will still run them."
  exit 0
fi
echo
echo "preflight green — every gate check passed locally."
