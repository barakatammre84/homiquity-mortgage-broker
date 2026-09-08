#!/usr/bin/env bash
#
# One command from a fresh clone to a running local app.
#
# WHY. `pnpm dev` on a clean checkout dies with:
#
#     Error: DATABASE_URL must be set. Did you forget to provision a database?
#
# ...before it prints anything useful, and the documented fix is a five-step
# manual setup: copy a 400-line .env.example, generate three secrets with
# openssl, paste them in, provision Postgres, migrate. Every one of those steps
# is easy and the sequence is what people get wrong — so the server "has issues
# spinning up" when really it has issues being SET UP, once, correctly.
#
# This does the sequence. It is idempotent: run it as often as you like.
#
#   bash scripts/dev-up.sh          # set up if needed, then start on :5001
#   bash scripts/dev-up.sh down     # stop the dev server (leaves the DB up)
#   bash scripts/dev-up.sh logs     # tail it
#   bash scripts/dev-up.sh status   # is it up, and on what commit
#
# It NEVER overwrites a value you already have in .env — it only fills in what
# is missing, and says which keys it added.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

PORT="${PORT:-5001}"
CMD="${1:-up}"
PIDFILE="/tmp/homiquity-dev-$PORT.pid"
DEVLOG="/tmp/homiquity-dev-$PORT.log"

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

port_held() { lsof -ti ":$PORT" >/dev/null 2>&1 || { command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q ":$PORT "; }; }

# `pnpm dev` is a WRAPPER — the server is its child, in the same process group.
# Killing only the recorded pid leaves that child holding the port, and the next
# `up` then refuses with "in use by something this script did not start" (it is
# in fact this script's own orphan). `up` launches under `set -m` so the job gets
# its own process group; kill the GROUP, then fall back to the pid, then to
# whatever still holds the port. Verified before reporting success — a `down`
# that says "stopped" while the server is still serving is worse than a failure.
stop_server() {
  local pid; pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  [ -n "$pid" ] && { kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true; }
  rm -f "$PIDFILE"
  for _ in 1 2 3 4 5 6 7 8 9 10; do port_held || return 0; sleep 0.5; done
  # Still held: an orphan from an older run of this script, before the fix above.
  local stray; stray="$(lsof -ti ":$PORT" 2>/dev/null | tr '\n' ' ')"
  [ -n "$stray" ] && kill $stray 2>/dev/null
  for _ in 1 2 3 4 5 6; do port_held || return 0; sleep 0.5; done
  return 1
}

case "$CMD" in
  down)
    if running || port_held; then
      if stop_server; then echo "dev server stopped (port $PORT)"
      else echo "port $PORT is STILL held after kill — inspect: lsof -i :$PORT" >&2; exit 1; fi
    else echo "no dev server running on port $PORT"; fi
    exit 0 ;;
  logs)
    [ -f "$DEVLOG" ] || { echo "no log at $DEVLOG"; exit 1; }
    tail -f "$DEVLOG" ;;
  status)
    # ARM THE PRE-PUSH GATE. `.githooks/` is tracked, but `core.hooksPath` lives in
# .git/config, which is per-clone and untracked — so a fresh clone starts with the gate
# OFF and nothing says so. This script exists to make one-time setup correct, and that
# is one-time setup. Idempotent; safe to re-run.
#
# It matters more than it used to: CI is down and `main` carries no required status
# check, so the pre-push hook is currently the only gate there is.
if [ "$(git config --get core.hooksPath 2>/dev/null)" != ".githooks" ]; then
  git config core.hooksPath .githooks
  echo "armed the pre-push gate (core.hooksPath -> .githooks)"
fi

if running; then
      echo "running  pid $(cat "$PIDFILE")  port $PORT"
      curl --max-time 5 -s "http://localhost:$PORT/api/health" | head -c 400; echo
    else echo "not running on port $PORT"; fi
    exit 0 ;;
  up) ;;
  *) echo "usage: bash scripts/dev-up.sh [up|down|logs|status]" >&2; exit 2 ;;
esac

if running; then
  echo "already running on port $PORT (pid $(cat "$PIDFILE")) — http://localhost:$PORT"
  exit 0
fi
if port_held; then
  echo "port $PORT is already in use by something this script did not start."
  echo "  stop it:  bash scripts/dev-up.sh down    # reclaims this script's own orphans too"
  echo "  find it:  lsof -i :$PORT"
  echo "  or pick another:  PORT=5003 bash scripts/dev-up.sh"
  exit 1
fi

# --------------------------------------------------------------- 1. deps ---
if [ ! -x node_modules/.bin/tsx ]; then
  echo "installing dependencies (pnpm install --frozen-lockfile)…"
  pnpm install --frozen-lockfile --prod=false || exit 1
fi

# ----------------------------------------------------------- 2. database ---
DB_URL="${DATABASE_URL:-}"
if [ -z "$DB_URL" ] && [ -f .env ]; then
  DB_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"' ')"
fi
if [ -z "$DB_URL" ]; then
  echo "no DATABASE_URL yet — bringing up a local one…"
  bash scripts/local-db.sh up >/tmp/dev-up-db.log 2>&1 || {
    echo "could not start a local database — see /tmp/dev-up-db.log"; tail -12 /tmp/dev-up-db.log; exit 1; }
  DB_URL="$(bash scripts/local-db.sh url)"
  echo "  database: $DB_URL"
fi

# ---------------------------------------------------------------- 3. env ---
# The three secrets are generated, not templated: a shared placeholder secret in
# a tracked example file is how a weak key reaches production. `.env` is
# gitignored; these never leave the machine.
added=()
add_if_missing() {
  local key="$1" value="$2"
  if [ ! -f .env ] || ! grep -qE "^${key}=" .env; then
    printf '%s=%s\n' "$key" "$value" >> .env
    added+=("$key")
  fi
}
if [ ! -f .env ]; then
  {
    echo "# Local development environment — generated by scripts/dev-up.sh"
    echo "# Gitignored. .env.example documents every OPTIONAL key (vendors, AI, uploads);"
    echo "# what follows is the minimum the app needs to boot and run offline."
    echo ""
  } > .env
  echo "creating .env"
fi
add_if_missing DATABASE_URL "$DB_URL"
add_if_missing NODE_ENV development
add_if_missing PORT "$PORT"
add_if_missing SESSION_SECRET "$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"
add_if_missing PII_HASH_SALT "$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
add_if_missing CREDIT_ENCRYPTION_KEY "$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
add_if_missing DEV_TEST_PASSWORD test1234
# Vendor calls are deterministic simulations behind adapters until real
# contracts exist (CLAUDE.md), so a local run needs no vendor keys. This one
# keeps document extraction on the simulated path instead of reaching for an API
# key that is not there.
add_if_missing EXTRACTION_SIMULATE true
[ ${#added[@]} -gt 0 ] && echo "  added to .env: ${added[*]}"

# ----------------------------------------------------------- 4. migrate ----
export DATABASE_URL="$DB_URL"
if ! pnpm -s db:migrate >/tmp/dev-up-migrate.log 2>&1; then
  echo "db:migrate failed — see /tmp/dev-up-migrate.log"; tail -12 /tmp/dev-up-migrate.log; exit 1
fi

# ------------------------------------------------------------- 5. serve ----
echo "starting the dev server on port ${PORT}…"
# `set -m` puts this background job in its own process group (pgid == pid), which
# is what lets `down` kill the wrapper AND the server it spawns. Without it the
# child outlives the kill and keeps the port. Works on bash 3.2 (macOS) too.
set -m
PORT="$PORT" pnpm dev > "$DEVLOG" 2>&1 &
echo $! > "$PIDFILE"
set +m

code=000
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/api/health" 2>/dev/null || true)"
  [ "${code:-000}" = "200" ] && break
  kill -0 "$(cat "$PIDFILE")" 2>/dev/null || break
  sleep 1
done

if [ "${code:-000}" != "200" ]; then
  echo
  echo "the server did not become healthy. Last 30 lines:"
  tail -30 "$DEVLOG" | sed 's/^/  | /'
  # A slow or failed boot must not leave the wrapper and its child behind.
  # Otherwise the next attempt sees an occupied port but has no pidfile with
  # which to reclaim the process group.
  stop_server || true
  exit 1
fi

cat <<EOF

  http://localhost:$PORT   ← the app
  http://localhost:$PORT/api/health

  sign in with any seeded account, password: ${DEV_TEST_PASSWORD:-test1234}
    buyer@test.com · lo@test.com · admin@test.com · underwriter@test.com
    broker@test.com · lender@test.com · closer@test.com · cpa@test.com

  logs:   bash scripts/dev-up.sh logs
  stop:   bash scripts/dev-up.sh down
  look:   node scripts/browser-probe.cjs --url http://localhost:$PORT/ --width 320 --out /tmp/shot.png
  gate:   bash scripts/preflight.sh          # everything CI runs, before you push
EOF
