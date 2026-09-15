#!/usr/bin/env bash
#
# Short commands for the repository's local checks.
#
#   pnpm harness:t0    static — types, script syntax, selected structural guards
#   pnpm harness:t1    unit   — both vitest lanes, with the collection floor
#   pnpm harness:t2    fast   — preflight --fast; skips build, boot and integration
#   pnpm harness:t3    full   — preflight; includes build, boot and integration when available
#
# These are engineering checks. AGENTS.md describes project validation expectations.
# Inspect the individual results and skipped checks: preflight can exit 0 with
# skips. Browser behavior and production deployment need separate verification.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

TIER="${1:-}"
[ -z "$TIER" ] && { echo "usage: bash scripts/harness.sh t0|t1|t2|t3" >&2; exit 2; }

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

t0() {
  step "T0 static — types"
  pnpm check || return 1
  step "T0 static — guard scripts parse"
  for f in scripts/*.cjs; do node --check "$f" || return 1; done
  step "T0 static — ratchets and structural guards"
  pnpm guard:schema && pnpm guard:migrations && pnpm guard:channel \
    && pnpm guard:sources && pnpm guard:staleness && pnpm guard:citations \
    && pnpm guard:querykeys && pnpm guard:tokens && pnpm guard:ui
}

# `pnpm test` runs scripts/test-collection-guard.cjs, which compares each lane's
# include patterns with the files on disk and fails on a collection shortfall.
t1() { step "T1 unit — both lanes + the collection floor"; pnpm test; }

t2() { step "T2 — preflight --fast"; bash scripts/preflight.sh --fast; }

t3() { step "T3 — full preflight"; bash scripts/preflight.sh; }

case "$TIER" in
  t0) t0 ;;
  t1) t1 ;;
  t2) t2 ;;
  t3) t3 ;;
  *) echo "unknown tier '$TIER' — expected t0, t1, t2 or t3" >&2; exit 2 ;;
esac
rc=$?

if [ $rc -eq 0 ]; then
  printf '\n\033[32m✓ %s passed\033[0m — review the checks and any skips above.\n' "$TIER"
else
  printf '\n\033[31m✗ %s FAILED (exit %d)\033[0m — see the failed checks above.\n' "$TIER" "$rc"
fi
exit $rc
