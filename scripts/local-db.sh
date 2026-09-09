#!/usr/bin/env bash
#
# Local Postgres for the full local gate — Docker optional, not required.
#
# WHY. `pnpm db:start` needs Docker. The heavy half of CI's `gate` — the
# self-host boot check and the integration lane — needs a database, so on any
# machine without Docker those checks could only ever run in CI. That is the
# expensive place to discover a failure (roadmap KTLO-2: ~4 billed minutes per
# push, and a red one costs the re-run too) and the slow place to fix it.
#
# This brings up a throwaway cluster with whatever is available, in this order:
#   1. $DATABASE_URL already set  -> use it, touch nothing
#   2. Docker                     -> the existing `db:start` container
#   3. pg_ctl on the machine      -> a private cluster under $HOME, port 5433
#
#   bash scripts/local-db.sh up      # start + migrate + seed, print DATABASE_URL
#   bash scripts/local-db.sh url     # print the URL only (for eval/export)
#   bash scripts/local-db.sh reset   # drop and rebuild from migrations + seed
#   bash scripts/local-db.sh down    # stop it
#
#   export DATABASE_URL="$(bash scripts/local-db.sh url)"
#
# NEVER point this at the shared dev database or at prod. It runs `db:seed`,
# which writes demo data, and `seedLendingGrids`, which WIPES and rebuilds the
# pricing matrices. Both are correct against a throwaway cluster and destructive
# against anything else — the same reason CHARTER §10 forbids `db:push` from a
# worktree.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

PORT="${LOCAL_DB_PORT:-5433}"
DB="${LOCAL_DB_NAME:-homiquity_local}"
CLUSTER="${LOCAL_DB_DIR:-$HOME/.homiquity-local-pg}"
CMD="${1:-up}"

log() { [ "$CMD" = "url" ] || echo "$@"; }

# --------------------------------------------------------------- discovery ---
find_pg_bin() {
  for c in pg_ctl /usr/lib/postgresql/*/bin/pg_ctl /opt/homebrew/opt/postgresql@*/bin/pg_ctl \
           /usr/local/opt/postgresql@*/bin/pg_ctl /Applications/Postgres.app/Contents/Versions/*/bin/pg_ctl; do
    if command -v "$c" >/dev/null 2>&1; then dirname "$(command -v "$c")"; return 0; fi
    [ -x "$c" ] && { dirname "$c"; return 0; }
  done
  return 1
}

have_docker() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

PG_BIN="$(find_pg_bin || true)"
PSQL_BIN=""
if [ -n "$PG_BIN" ] && [ -x "$PG_BIN/psql" ]; then
  PSQL_BIN="$PG_BIN/psql"
elif command -v psql >/dev/null 2>&1; then
  PSQL_BIN="$(command -v psql)"
fi

# Running initdb/postgres as root is refused by Postgres itself, so on a root
# container we drop to the `postgres` account. On a normal dev machine this is a
# no-op and everything runs as you.
as_pg() {
  if [ "$(id -u)" = "0" ] && id postgres >/dev/null 2>&1; then
    su postgres -c "$1"
  else
    bash -c "$1"
  fi
}

url_for() { echo "postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB}"; }

# -------------------------------------------------------------------- down ---
if [ "$CMD" = "down" ]; then
  if have_docker && docker ps --format '{{.Names}}' | grep -q '^homiquity-db$'; then
    docker stop homiquity-db >/dev/null && log "stopped the Docker container"
  fi
  if [ -n "$PG_BIN" ] && [ -d "$CLUSTER" ]; then
    as_pg "$PG_BIN/pg_ctl -D $CLUSTER stop" >/dev/null 2>&1 && log "stopped the local cluster at $CLUSTER"
  fi
  exit 0
fi

# ------------------------------------------------------------------ bring up ---
if [ -n "${DATABASE_URL:-}" ] && [ "$CMD" != "reset" ]; then
  log "DATABASE_URL is already set — using it, starting nothing."
  echo "$DATABASE_URL"
  exit 0
fi

started=""
if [ -n "$PG_BIN" ]; then
  if [ ! -d "$CLUSTER/base" ]; then
    log "initialising a private cluster at $CLUSTER"
    mkdir -p "$CLUSTER"
    [ "$(id -u)" = "0" ] && id postgres >/dev/null 2>&1 && chown -R postgres:postgres "$(dirname "$CLUSTER")" "$CLUSTER" 2>/dev/null
    # -A trust: local-only, throwaway, never reachable off this machine.
    as_pg "$PG_BIN/initdb -D $CLUSTER -A trust -U postgres" >/tmp/local-db-initdb.log 2>&1 || {
      echo "local-db: initdb failed — see /tmp/local-db-initdb.log" >&2; exit 1; }
  fi
  if ! as_pg "$PG_BIN/pg_ctl -D $CLUSTER status" >/dev/null 2>&1; then
    as_pg "$PG_BIN/pg_ctl -D $CLUSTER -o '-p $PORT' -l /tmp/local-db.log start" >/dev/null 2>&1 || {
      echo "local-db: could not start the cluster — see /tmp/local-db.log" >&2; exit 1; }
    sleep 2
  fi
  started="pg_ctl"
elif have_docker; then
  docker start homiquity-db >/dev/null 2>&1 || \
    docker run -d --name homiquity-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB="$DB" \
      -p "${PORT}:5432" postgres:16 >/dev/null || { echo "local-db: docker run failed" >&2; exit 1; }
  sleep 3
  started="docker"
else
  cat >&2 <<'EOF'
local-db: no database available.

  Neither Docker nor a local Postgres (pg_ctl) was found, and DATABASE_URL is
  not set. Install one, or point DATABASE_URL at a throwaway database you own:

    macOS:  brew install postgresql@16
    Debian: sudo apt install postgresql-16

  Never point it at the shared dev database — this script seeds and wipes.
EOF
  exit 1
fi

export PGPASSWORD=postgres
if [ -z "$PSQL_BIN" ]; then
  echo "local-db: psql was not found; install the PostgreSQL client tools" >&2
  exit 1
fi
"$PSQL_BIN" -h 127.0.0.1 -p "$PORT" -U postgres -tc "SELECT 1" >/dev/null 2>&1 || {
  echo "local-db: cluster is up ($started) but not answering on port $PORT" >&2; exit 1; }

if [ "$CMD" = "reset" ]; then
  log "dropping $DB"
  "$PSQL_BIN" -h 127.0.0.1 -p "$PORT" -U postgres -c "DROP DATABASE IF EXISTS ${DB}" >/dev/null 2>&1
fi
"$PSQL_BIN" -h 127.0.0.1 -p "$PORT" -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='${DB}'" 2>/dev/null | grep -q 1 \
  || "$PSQL_BIN" -h 127.0.0.1 -p "$PORT" -U postgres -c "CREATE DATABASE ${DB}" >/dev/null

if [ "$CMD" = "url" ]; then url_for; exit 0; fi

export DATABASE_URL="$(url_for)"
log "database: $DATABASE_URL  (via $started)"

log "applying migrations"
pnpm -s db:migrate >/tmp/local-db-migrate.log 2>&1 || { echo "local-db: db:migrate failed — /tmp/local-db-migrate.log" >&2; exit 1; }

# Grids BEFORE content: the content seed's best-execution rate sync resolves
# FANNIE_LLPA, and without the grids it logs a CRITICAL COMPLIANCE ERROR and
# leaves the rate table empty. Nothing in package.json or the seed path calls
# seedLendingGrids — that is why a fresh database cannot price a loan.
log "seeding pricing matrices (seedLendingGrids)"
./node_modules/.bin/tsx server/scripts/seedLendingGrids.ts >/tmp/local-db-grids.log 2>&1 || {
  echo "local-db: seedLendingGrids failed — /tmp/local-db-grids.log" >&2; exit 1; }

log "seeding content + test accounts"
DEV_TEST_PASSWORD="${DEV_TEST_PASSWORD:-test1234}" pnpm -s db:seed >/tmp/local-db-seed.log 2>&1 || {
  echo "local-db: db:seed failed — /tmp/local-db-seed.log" >&2; exit 1; }

log ""
log "ready. Export it for this shell:"
log "  export DATABASE_URL=\"$(url_for)\""
log "  export DEV_TEST_PASSWORD=test1234"
