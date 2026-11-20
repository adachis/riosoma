#!/usr/bin/env bash
# Runs the live import suites against NocoDB, Baserow, Grist, Teable, and SeaTable in Docker, one
# product at a time: starts the pinned image on 127.0.0.1, makes a throwaway account and token
# through its API, runs its suite, and removes the containers, their volumes, and their network
# again, however the run ends.  Nothing it makes outlives it, and the accounts' passwords are made
# up on the spot and never written down.  Teable and SeaTable each bring the database and cache they
# need along, on a network of their own.
#
#   apps/server/scripts/import-platforms-live.sh [nocodb] [baserow] [grist] [teable] [seatable]
#
# With no products named, it runs all five.  `RECORD=1` also rewrites the recordings the unit tests
# replay.  `PREFIX` names the containers, volumes, and network, and `PORT` is the first port it tries.
set -euo pipefail

NOCODB_IMAGE=nocodb/nocodb:2026.09.0
BASEROW_IMAGE=baserow/baserow:2.3.4
GRIST_IMAGE=gristlabs/grist:1.7.19
# The same pins the local test fleet uses; see ops/test-fleet/compose.yaml.
TEABLE_IMAGE=teableio/teable:release.2026-09-27T02-14-26Z.3273
TEABLE_DB_IMAGE=pgvector/pgvector:0.8.6-pg16-trixie
TEABLE_CACHE_IMAGE=redis:8.6.7-alpine
SEATABLE_IMAGE=seatable/seatable-developer:6.2.1
SEATABLE_DB_IMAGE=mariadb:10.11.19-ubi9
SEATABLE_CACHE_IMAGE=memcached:1.6.45
PREFIX=${PREFIX:-riosoma-import-test}
PORT=${PORT:-18380}
EMAIL=owner@example.com
SERVER_DIR=$(cd "$(dirname "$0")/.." && pwd)
PRODUCTS=("$@")
[ ${#PRODUCTS[@]} -eq 0 ] && PRODUCTS=(nocodb baserow grist teable seatable)

started=()
results=()
cleanup() {
  for name in ${started[@]+"${started[@]}"}; do
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker volume rm "$name-data" >/dev/null 2>&1 || true
  done
  docker network rm "$PREFIX-net" >/dev/null 2>&1 || true
}
trap cleanup EXIT

secret() { openssl rand -hex 16; }

free_port() {
  local port=$PORT
  while lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do port=$((port + 1)); done
  echo "$port"
}

# SeaTable initializes its own database on first boot, which takes minutes rather than seconds.
wait_for() {
  local url=$1 tries=${2:-120}
  for _ in $(seq 1 "$tries"); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$url")" = 200 ] && return 0
    sleep 3
  done
  echo "Nothing answered at $url" >&2
  return 1
}

# One network for a product and the services it needs, made once and removed with the containers.
network() { docker network create "$PREFIX-net" >/dev/null 2>&1 || true; }

json() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }

run_suite() {
  local product=$1
  shift
  (cd "$SERVER_DIR" && env "$@" ${RECORD:+RIOSOMA_TEST_RECORD=1} \
    npx vitest run "src/data/imports/platforms/$product/$product.live.test.ts")
}

nocodb() {
  local name=$PREFIX-nocodb port password jwt token
  port=$(free_port)
  password="T$(secret)!"
  started+=("$name")
  docker run -d --name "$name" -p "127.0.0.1:$port:8080" -v "$name-data:/usr/app/data" "$NOCODB_IMAGE" >/dev/null
  wait_for "http://127.0.0.1:$port/api/v1/health" || return 1
  jwt=$(curl -s -X POST "http://127.0.0.1:$port/api/v1/auth/user/signup" -H 'content-type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$password\"}" | json "['token']")
  token=$(curl -s -X POST "http://127.0.0.1:$port/api/v1/tokens" -H "xc-auth: $jwt" -H 'content-type: application/json' \
    -d '{"description":"import test"}' | json "['token']")
  run_suite nocodb RIOSOMA_TEST_NOCODB_URL="http://127.0.0.1:$port" RIOSOMA_TEST_NOCODB_TOKEN="$token"
}

baserow() {
  local name=$PREFIX-baserow port password
  port=$(free_port)
  password="T$(secret)!"
  started+=("$name")
  docker run -d --name "$name" -p "127.0.0.1:$port:80" -v "$name-data:/baserow/data" \
    -e "BASEROW_PUBLIC_URL=http://127.0.0.1:$port" "$BASEROW_IMAGE" >/dev/null
  wait_for "http://127.0.0.1:$port/api/_health/" || return 1
  curl -s -X POST "http://127.0.0.1:$port/api/user/" -H 'content-type: application/json' \
    -d "{\"name\":\"Owner\",\"email\":\"$EMAIL\",\"password\":\"$password\"}" >/dev/null
  run_suite baserow RIOSOMA_TEST_BASEROW_URL="http://127.0.0.1:$port" RIOSOMA_TEST_BASEROW_EMAIL="$EMAIL" \
    RIOSOMA_TEST_BASEROW_PASSWORD="$password"
}

grist() {
  local name=$PREFIX-grist port cookies key
  port=$(free_port)
  started+=("$name")
  docker run -d --name "$name" -p "127.0.0.1:$port:8484" -v "$name-data:/persist" \
    -e "GRIST_DEFAULT_EMAIL=$EMAIL" -e "GRIST_SESSION_SECRET=$(secret)" -e GRIST_IN_SERVICE=true "$GRIST_IMAGE" >/dev/null
  wait_for "http://127.0.0.1:$port/status" || return 1
  # With no sign-in configured, Grist signs everyone in as its default user, who makes the key.
  cookies=$(mktemp)
  curl -s -L -c "$cookies" -b "$cookies" "http://127.0.0.1:$port/login" -o /dev/null
  key=$(curl -s -b "$cookies" -X POST -H 'X-Requested-With: XMLHttpRequest' -H 'content-type: application/json' \
    "http://127.0.0.1:$port/api/profile/apiKey" -d '{}' | tr -d '"')
  rm -f "$cookies"
  run_suite grist RIOSOMA_TEST_GRIST_URL="http://127.0.0.1:$port" RIOSOMA_TEST_GRIST_TOKEN="$key"
}

teable() {
  local name=$PREFIX-teable port password cookies token scopes
  port=$(free_port)
  password="T$(secret)!"
  network
  started+=("$name" "$name-db" "$name-cache")
  docker run -d --name "$name-db" --network "$PREFIX-net" -e POSTGRES_USER=teable \
    -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=teable "$TEABLE_DB_IMAGE" >/dev/null
  docker run -d --name "$name-cache" --network "$PREFIX-net" "$TEABLE_CACHE_IMAGE" \
    redis-server --save '' --appendonly no >/dev/null
  docker run -d --name "$name" --network "$PREFIX-net" -p "127.0.0.1:$port:3000" -e TZ=UTC \
    -e "PRISMA_DATABASE_URL=postgresql://teable:$password@$name-db:5432/teable?schema=teable" \
    -e "PUBLIC_ORIGIN=http://127.0.0.1:$port" -e BACKEND_CACHE_PROVIDER=redis \
    -e "BACKEND_CACHE_REDIS_URI=redis://$name-cache:6379/0" "$TEABLE_IMAGE" >/dev/null
  wait_for "http://127.0.0.1:$port/api/health" || return 1
  # The first account on a fresh Teable is its admin, and signs in for the token that follows.
  curl -s -X POST "http://127.0.0.1:$port/api/auth/signup" -H 'content-type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$password\"}" >/dev/null
  cookies=$(mktemp)
  curl -s -c "$cookies" -X POST "http://127.0.0.1:$port/api/auth/signin" -H 'content-type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$password\"}" >/dev/null
  scopes='["space|create","space|read","base|create","base|delete","base|read","base|read_all","table|create","table|read","table|delete","field|create","field|read","field|update","field|delete","record|create","record|read","record|update","view|create","view|read","view|update"]'
  token=$(curl -s -b "$cookies" -X POST "http://127.0.0.1:$port/api/access-token" \
    -H 'content-type: application/json' \
    -d "{\"name\":\"import test\",\"scopes\":$scopes}" | json "['token']")
  rm -f "$cookies"
  run_suite teable RIOSOMA_TEST_TEABLE_URL="http://127.0.0.1:$port" RIOSOMA_TEST_TEABLE_TOKEN="$token"
}

seatable() {
  local name=$PREFIX-seatable port password
  port=$(free_port)
  password="T$(secret)!"
  network
  started+=("$name" "$name-db" "$name-cache")
  docker run -d --name "$name-db" --network "$PREFIX-net" -e MARIADB_ROOT_PASSWORD="$password" \
    -e MARIADB_LOG_CONSOLE=true "$SEATABLE_DB_IMAGE" --character-set-server=utf8mb4 \
    --collation-server=utf8mb4_unicode_ci >/dev/null
  # SeaTable looks its cache up as `memcached`, so the alias keeps the name descriptive.
  docker run -d --name "$name-cache" --network "$PREFIX-net" --network-alias memcached \
    "$SEATABLE_CACHE_IMAGE" memcached -m 256 >/dev/null
  # SeaTable publishes its developer edition build for amd64 only.
  docker run -d --name "$name" --network "$PREFIX-net" --platform linux/amd64 \
    -p "127.0.0.1:$port:80" -e DB_HOST="$name-db" -e DB_ROOT_PASSWORD="$password" \
    -e MEMCACHED_HOST=memcached -e TIME_ZONE=Etc/UTC -e SEATABLE_ADMIN_EMAIL="$EMAIL" \
    -e SEATABLE_ADMIN_PASSWORD="$password" -e SSL=false "$SEATABLE_IMAGE" >/dev/null
  wait_for "http://127.0.0.1:$port/api/v2.1/ping/" 300 || return 1
  run_suite seatable RIOSOMA_TEST_SEATABLE_URL="http://127.0.0.1:$port" \
    RIOSOMA_TEST_SEATABLE_EMAIL="$EMAIL" RIOSOMA_TEST_SEATABLE_PASSWORD="$password"
}

failed=0
for product in "${PRODUCTS[@]}"; do
  case $product in
    nocodb | baserow | grist | teable | seatable) ;;
    *)
      echo "Unknown product: $product" >&2
      exit 2
      ;;
  esac
  if "$product"; then results+=("$product passed"); else results+=("$product FAILED"); failed=1; fi
  cleanup
  started=()
done
# Recordings are kept in the repository's own style.
[ -n "${RECORD:-}" ] && (cd "$SERVER_DIR" && npx prettier --write src/test/platforms/*.recording.json >/dev/null)
printf '%s\n' "${results[@]}"
exit "$failed"
