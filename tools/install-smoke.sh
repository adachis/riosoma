#!/usr/bin/env bash
# Run against an image already built from this checkout.  All state belongs to one temporary
# Compose project, so cleanup never touches another installation or a concurrent smoke run.
set -Eeuo pipefail
umask 077
# Failure keys must reach the caller even while a Compose command's output goes to a private log.
exec 3>&2

step=installSmoke.prerequisites
printf '%s\n' "$step"
for executable in docker openssl; do
  command -v "$executable" >/dev/null || { printf 'installSmoke.missingCommand %s\n' "$executable" >&2; exit 1; }
done
docker info >/dev/null 2>&1 || { printf '%s\n' 'installSmoke.dockerUnavailable' >&2; exit 1; }
docker compose version >/dev/null

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$script_dir/.." && pwd)
image=${RIOSOMA_IMAGE:-riosoma:dev}
connectors_image=${RIOSOMA_CONNECTORS_IMAGE:-riosoma-connectors:dev}
timeout=${INSTALL_SMOKE_TIMEOUT_SECONDS:-600}
case "$timeout" in
  ''|*[!0-9]*|0) printf '%s\n' 'installSmoke.invalidTimeout' >&2; exit 1 ;;
esac
expected_version=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" | sed -n 's/^RIOSOMA_VERSION=//p')
[[ -n "$expected_version" ]] || { printf '%s\n' 'installSmoke.imageVersionMissing' >&2; exit 1; }
connectors_version=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$connectors_image" | sed -n 's/^RIOSOMA_VERSION=//p')
[[ "$connectors_version" == "$expected_version" ]] || { printf '%s\n' 'installSmoke.connectorsVersionMismatch' >&2; exit 1; }

# Operator settings in the calling shell must not select profiles, credentials, or another image.
while IFS= read -r setting; do unset "$setting"; done < <(compgen -v RIOSOMA_)
unset COMPOSE_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME POSTGRES_PASSWORD

project="riosoma-smoke-$(openssl rand -hex 12)"
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/$project.XXXXXX")
compose() {
  docker compose --project-directory "$temp_dir" --env-file "$temp_dir/.env" \
    --project-name "$project" --file "$temp_dir/compose.yaml" \
    --file "$temp_dir/compose.smoke.yaml" "$@"
}

cleanup() {
  local status=$? cleanup_status=0 resource resources
  trap - EXIT ERR INT TERM
  set +e
  printf '%s\n' 'installSmoke.cleanup'
  if [[ -f "$temp_dir/compose.smoke.yaml" ]]; then
    compose down --volumes --remove-orphans --timeout 20 >>"$temp_dir/compose.log" 2>&1
  fi
  # Also cover partial startup and a failed Compose down, using only this project's labels.
  resources=$(docker ps -aq --filter "label=com.docker.compose.project=$project") || cleanup_status=1
  for resource in $resources; do docker rm -fv "$resource" >/dev/null 2>&1 || cleanup_status=1; done
  resources=$(docker volume ls -q --filter "label=com.docker.compose.project=$project") || cleanup_status=1
  for resource in $resources; do docker volume rm "$resource" >/dev/null 2>&1 || cleanup_status=1; done
  resources=$(docker network ls -q --filter "label=com.docker.compose.project=$project") || cleanup_status=1
  for resource in $resources; do docker network rm "$resource" >/dev/null 2>&1 || cleanup_status=1; done
  rm -rf -- "$temp_dir" || cleanup_status=1
  if (( cleanup_status != 0 )); then
    printf 'installSmoke.cleanupFailed %s\n' "$project" >&2
    status=1
  fi
  if (( status == 0 )); then printf '%s\n' 'installSmoke.complete'; fi
  exit "$status"
}
trap cleanup EXIT
trap 'if (( BASH_SUBSHELL == 0 )); then printf "installSmoke.failed %s\n" "$step" >&3; fi' ERR
trap 'exit 130' INT
trap 'exit 143' TERM

step=installSmoke.prepare
printf '%s\n' "$step"
cp -R "$repo_dir/deploy/compose/." "$temp_dir/"
cp "$temp_dir/.env.example" "$temp_dir/.env"
db_password=$(openssl rand -hex 24)
secret_key=$(openssl rand -base64 32)
setup_token=$(openssl rand -hex 32)
cat >>"$temp_dir/.env" <<EOF

COMPOSE_PROFILES=postgres
RIOSOMA_IMAGE=$image
RIOSOMA_CONNECTORS_IMAGE=$connectors_image
RIOSOMA_PUBLISH=127.0.0.1:0
POSTGRES_PASSWORD=$db_password
RIOSOMA_DATABASE_URL=postgres://riosoma:$db_password@postgres:5432/riosoma?sslmode=disable
RIOSOMA_SECRET_KEY=$secret_key
RIOSOMA_SETUP_TOKEN=$setup_token
RIOSOMA_UPDATE_CHECKS=off
RIOSOMA_TELEMETRY=off
EOF
cat >"$temp_dir/compose.smoke.yaml" <<'EOF'
services:
  riosoma:
    pull_policy: never
    # Only the default network and the connector service's are needed here.  Caddy's fixed subnet
    # would collide between runs.
    networks: !override [default, connectors]
  connectors:
    pull_policy: never
EOF

step=installSmoke.startAndWait
printf '%s\n' "$step"
compose up -d --wait --wait-timeout "$timeout" riosoma connectors postgres >"$temp_dir/compose.log" 2>&1

step=installSmoke.http
compose exec -T -e "INSTALL_SMOKE_VERSION=$expected_version" riosoma \
  /nodejs/bin/node --input-type=module <"$script_dir/install-smoke.mjs"

step=installSmoke.complete
