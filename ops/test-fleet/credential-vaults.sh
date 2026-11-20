#!/usr/bin/env bash
set -euo pipefail

unit_project="credential-vaults-$$"
unit_root="$(cd "$(dirname "$0")/../.." && pwd)"
unit_compose="$unit_root/ops/test-fleet/compose.yaml"
unit_override="$(mktemp "${TMPDIR:-/tmp}/$unit_project.XXXXXX")"
printf 'networks:\n  default:\n    name: %s\n' "$unit_project" >"$unit_override"
unit_compose_command=(docker compose -p "$unit_project" -f "$unit_compose" -f "$unit_override")
export CREDENTIAL_VAULTS_TOKEN="$(openssl rand -hex 32)"
cleanup() {
  docker rm -f -v "$unit_project-vault" "$unit_project-openbao" >/dev/null 2>&1 || true
  docker network rm "$unit_project" >/dev/null 2>&1 || true
  rm -f "$unit_override"
}
trap cleanup EXIT

"${unit_compose_command[@]}" run -d --no-deps \
  --name "$unit_project-vault" -p '127.0.0.1::8200' \
  -e "VAULT_DEV_ROOT_TOKEN_ID=$CREDENTIAL_VAULTS_TOKEN" vault >/dev/null
"${unit_compose_command[@]}" run -d --no-deps \
  --name "$unit_project-openbao" -p '127.0.0.1::8200' \
  -e "BAO_DEV_ROOT_TOKEN_ID=$CREDENTIAL_VAULTS_TOKEN" openbao >/dev/null

for unit_service in vault openbao; do
  unit_command=vault
  if [ "$unit_service" = openbao ]; then unit_command=bao; fi
  for unit_attempt in $(seq 1 30); do
    if docker exec "$unit_project-$unit_service" "$unit_command" status >/dev/null 2>&1; then break; fi
    if [ "$unit_attempt" = 30 ]; then exit 1; fi
    sleep 1
  done
done

export CREDENTIAL_VAULTS_VAULT_ENDPOINT="http://$(docker port "$unit_project-vault" 8200/tcp)"
export CREDENTIAL_VAULTS_OPENBAO_ENDPOINT="http://$(docker port "$unit_project-openbao" 8200/tcp)"
RIOSOMA_CREDENTIAL_TEST_PROFILES="$(node --input-type=module <<'JS'
const profiles = []
for (const kind of ['vault', 'openbao']) {
  const endpoint = process.env[`CREDENTIAL_VAULTS_${kind.toUpperCase()}_ENDPOINT`]
  const token = process.env.CREDENTIAL_VAULTS_TOKEN
  for (const [path, body] of [
    ['sys/mounts/transit', { type: 'transit' }],
    ['transit/keys/credentials', { type: 'aes256-gcm96', derived: true }],
  ]) {
    const response = await fetch(`${endpoint}/v1/${path}`, {
      method: 'POST', headers: { 'x-vault-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) process.exit(1)
  }
  profiles.push({ id: kind, kind, endpoint, auth: { kind: 'token', token }, transit: { key: 'credentials' } })
}
process.stdout.write(JSON.stringify(profiles))
JS
)"
export RIOSOMA_CREDENTIAL_TEST_PROFILES
cd "$unit_root"
pnpm --filter @riosoma/server exec vitest run src/credentials/live.test.ts --maxWorkers=3
