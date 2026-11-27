#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"
RESULTS_DIR="$SCRIPT_DIR/.contract-results"

cd "$REPO_ROOT"

if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$SCRIPT_DIR/.env"
  set +a
fi

mkdir -p "$RESULTS_DIR"

ACTIVE_PROFILES=()
FIXTURE_PID=""

cleanup_active() {
  if [ -n "$FIXTURE_PID" ] && kill -0 "$FIXTURE_PID" 2>/dev/null; then
    kill "$FIXTURE_PID" 2>/dev/null || true
    wait "$FIXTURE_PID" 2>/dev/null || true
  fi
  FIXTURE_PID=""
  unset NODE_EXTRA_CA_CERTS || true
  if [ "${#ACTIVE_PROFILES[@]}" -gt 0 ]; then
    local profile_args=()
    for p in "${ACTIVE_PROFILES[@]}"; do
      profile_args+=(--profile "$p")
    done
    docker compose -f "$COMPOSE_FILE" "${profile_args[@]}" down -v >/dev/null 2>&1 || true
    ACTIVE_PROFILES=()
  fi
}

trap cleanup_active EXIT INT TERM

write_fallback_result() {
  local family="$1"
  local kinds_csv="$2"
  local check_id="$3"
  local reason="$4"
  local elapsed="$5"
  local out_file="$RESULTS_DIR/$family.json"
  node -e '
    const fs = require("node:fs");
    const [outFile, family, kindsCsv, checkId, reason, elapsed] = process.argv.slice(1);
    const outcomes = kindsCsv.split(",").filter(Boolean).map((connector) => ({
      connector,
      status: "failed",
      check: checkId,
      reason,
    }));
    fs.writeFileSync(outFile, JSON.stringify({
      family,
      elapsedSeconds: Number(elapsed),
      mode: "contract:live",
      suitesPassed: false,
      outcomes,
    }, null, 2) + "\n");
  ' "$out_file" "$family" "$kinds_csv" "$check_id" "$reason" "$elapsed"
}

extract_contract_json() {
  local log_file="$1"
  local out_file="$2"
  local family="$3"
  local kinds_csv="$4"
  local elapsed="$5"
  node -e '
    const fs = require("node:fs");
    const [logFile, outFile, family, kindsCsv, elapsed] = process.argv.slice(1);
    const text = fs.readFileSync(logFile, "utf8");
    const start = text.lastIndexOf("\n{\n  \"mode\": \"contract:live\"");
    const altStart = start >= 0 ? start + 1 : text.lastIndexOf("{\n  \"mode\": \"contract:live\"");
    if (altStart < 0) process.exit(1);
    const end = text.indexOf("\n}", altStart);
    if (end < 0) process.exit(1);
    const parsed = JSON.parse(text.slice(altStart, end + 2));
    const expected = new Set(kindsCsv.split(",").filter(Boolean));
    parsed.family = family;
    parsed.elapsedSeconds = Number(elapsed);
    parsed.outcomes = (parsed.outcomes || []).filter((entry) => expected.has(entry.connector));
    fs.writeFileSync(outFile, JSON.stringify(parsed, null, 2) + "\n");
  ' "$log_file" "$out_file" "$family" "$kinds_csv" "$elapsed"
}

run_family() {
  local family="$1"
  local kinds_csv="$2"
  local profiles_str="$3"
  local seed_str="$4"
  local use_http_fixture="${5:-0}"

  local started
  started="$(date +%s)"
  local out_file="$RESULTS_DIR/$family.json"
  local log_file="$RESULTS_DIR/$family.log"
  : > "$log_file"

  echo ""
  echo "=== Family: $family (kinds: $kinds_csv) ==="

  local profile_args=()
  ACTIVE_PROFILES=()
  if [ -n "$profiles_str" ]; then
    read -ra ACTIVE_PROFILES <<< "$profiles_str"
    for p in "${ACTIVE_PROFILES[@]}"; do
      profile_args+=(--profile "$p")
    done
  fi

  if [ "${#profile_args[@]}" -gt 0 ]; then
    if [ "$family" = "graph-metrics" ] && [ -f "$SCRIPT_DIR/prometheus/prometheus.yml" ]; then
      chmod a+r "$SCRIPT_DIR/prometheus/prometheus.yml" || true
    fi
    if ! docker compose -f "$COMPOSE_FILE" "${profile_args[@]}" up -d --wait --wait-timeout 900 2>&1 | tee -a "$log_file"; then
      if ! node -e '
        const { execFileSync } = require("node:child_process");
        const fs = require("node:fs");
        const composeArgs = process.argv.slice(1);
        const deadline = Date.now() + 900_000;
        while (Date.now() < deadline) {
          const text = execFileSync("docker", ["compose", ...composeArgs, "ps", "--all", "--format", "json"], { encoding: "utf8" }).trim();
          if (!text) process.exit(1);
          const rows = text.startsWith("[") ? JSON.parse(text) : text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
          if (!rows.length) process.exit(1);
          if (rows.some((r) => (r.State === "exited" && Number(r.ExitCode) !== 0) || r.Health === "unhealthy")) process.exit(1);
          if (rows.every((r) => r.Health === "healthy" || (r.State === "exited" && Number(r.ExitCode) === 0))) process.exit(0);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
        }
        process.exit(1);
      ' -- -f "$COMPOSE_FILE" "${profile_args[@]}"; then
        local elapsed=$(( $(date +%s) - started ))
        echo "Family $family failed during container startup." | tee -a "$log_file"
        write_fallback_result "$family" "$kinds_csv" "live.service" "container startup failed" "$elapsed"
        cleanup_active
        return 0
      fi
    fi
  fi

  if [ "$use_http_fixture" = "1" ]; then
    node "$SCRIPT_DIR/fixture-server.mjs" >>"$log_file" 2>&1 &
    FIXTURE_PID="$!"
    local ready=0
    for _ in $(seq 1 30); do
      if node -e 'fetch("http://127.0.0.1:18900/file/items.csv").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' 2>/dev/null; then
        ready=1
        break
      fi
      sleep 0.2
    done
    if [ "$ready" != "1" ]; then
      local elapsed=$(( $(date +%s) - started ))
      echo "Family $family failed starting local fixture server." | tee -a "$log_file"
      write_fallback_result "$family" "$kinds_csv" "live.prepare" "fixture server failed" "$elapsed"
      cleanup_active
      return 0
    fi
  fi

  if [ -n "$seed_str" ]; then
    local -a seed_args=()
    read -ra seed_args <<< "$seed_str"
    local seed_out
    if ! seed_out="$(node "$SCRIPT_DIR/contract-seed.mjs" "${seed_args[@]}" 2>>"$log_file")"; then
      local elapsed=$(( $(date +%s) - started ))
      echo "Family $family failed during fixture seeding." | tee -a "$log_file"
      write_fallback_result "$family" "$kinds_csv" "live.prepare" "seeding failed" "$elapsed"
      cleanup_active
      return 0
    fi
    echo "Seed output: $seed_out" >>"$log_file"
    local last_json
    last_json="$(printf '%s\n' "$seed_out" | tail -n 1)"
    if [[ "$last_json" == \{* ]]; then
      local key_val
      key_val="$(node -e 'const d = JSON.parse(process.argv[1]); if (d.RIOSOMA_SFTP_HOST_KEY) process.stdout.write(d.RIOSOMA_SFTP_HOST_KEY)' "$last_json")"
      if [ -n "$key_val" ]; then export RIOSOMA_SFTP_HOST_KEY="$key_val"; fi
      key_val="$(node -e 'const d = JSON.parse(process.argv[1]); if (d.RIOSOMA_DUCKDB_FILE) process.stdout.write(d.RIOSOMA_DUCKDB_FILE)' "$last_json")"
      if [ -n "$key_val" ]; then export RIOSOMA_DUCKDB_FILE="$key_val"; fi
      key_val="$(node -e 'const d = JSON.parse(process.argv[1]); if (d.RIOSOMA_DRIVERS_DIR) process.stdout.write(d.RIOSOMA_DRIVERS_DIR)' "$last_json")"
      if [ -n "$key_val" ]; then export RIOSOMA_DRIVERS_DIR="$key_val"; fi
      key_val="$(node -e 'const d = JSON.parse(process.argv[1]); if (d.NODE_EXTRA_CA_CERTS) process.stdout.write(d.NODE_EXTRA_CA_CERTS)' "$last_json")"
      if [ -n "$key_val" ]; then export NODE_EXTRA_CA_CERTS="$key_val"; fi
    fi
  fi

  local -a kind_args=()
  IFS=',' read -ra kind_args <<< "$kinds_csv"
  local exports_script
  if ! exports_script="$(node "$SCRIPT_DIR/contract-settings.mjs" "${kind_args[@]}")"; then
    local elapsed=$(( $(date +%s) - started ))
    write_fallback_result "$family" "$kinds_csv" "live.prepare" "settings generation failed" "$elapsed"
    cleanup_active
    return 0
  fi

  (
    eval "$exports_script"
    RIOSOMA_CONTRACT_KINDS="$kinds_csv" node "$REPO_ROOT/tools/connector_contract.mjs" contract:live
  ) 2>&1 | tee -a "$log_file" || true

  local elapsed=$(( $(date +%s) - started ))
  if ! extract_contract_json "$log_file" "$out_file" "$family" "$kinds_csv" "$elapsed"; then
    write_fallback_result "$family" "$kinds_csv" "live.crash" "runner exited without JSON summary" "$elapsed"
  fi

  cleanup_active
}

FAMILIES=(
  "baseline|postgres,webhook,duckdb-file||duckdb-file|0"
  "local-http|file-url,graphql,odata,rest,feed|||1"
  "storage-files|bucket,ftp,ftps,webdav|minio ftp webdav|bucket ftp webdav|0"
  "storage-sftp|sftp|sftp|sftp|0"
  "sql-core|mysql,oracle,firebird|mysql84 oracle firebird5||0"
  "sql-mssql|sqlserver|mssql2022||0"
  "sql-db2|db2|db2|db2|0"
  "sql-informix|informix|informix|informix|0"
  "warehouse-sql|clickhouse,trino|clickhouse trino postgres17|clickhouse trino|0"
  "warehouse-druid|druid|druid|druid|0"
  "nosql|mongodb,couchdb,couchbase|mongodb couchdb couchbase|mongodb couchdb couchbase|0"
  "nosql-dynamodb|dynamodb|dynamodb|dynamodb|0"
  "nosql-cosmos|cosmosdb|cosmos|cosmosdb|0"
  "search-core|elasticsearch,opensearch,meilisearch|elasticsearch opensearch meilisearch|elasticsearch opensearch meilisearch|0"
  "search-typesense|typesense|typesense|typesense|0"
  "graph-metrics|neo4j,prometheus|neo4j prometheus|neo4j prometheus|0"
  "metrics-influxdb|influxdb|influxdb3|influxdb|0"
)

SELECTED=("$@")
if [ "${#SELECTED[@]}" -eq 0 ]; then
  rm -f "$RESULTS_DIR"/*.json "$RESULTS_DIR"/*.log
fi

for spec in "${FAMILIES[@]}"; do
  IFS='|' read -r family kinds_csv profiles_str seed_str use_http <<< "$spec"
  if [ "${#SELECTED[@]}" -gt 0 ]; then
    local_match=0
    for want in "${SELECTED[@]}"; do
      if [ "$want" = "$family" ]; then
        local_match=1
        break
      fi
    done
    if [ "$local_match" -eq 0 ]; then
      continue
    fi
  fi
  run_family "$family" "$kinds_csv" "$profiles_str" "$seed_str" "$use_http"
done

echo ""
echo "=== Combined Contract Results ==="
node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = process.argv[1];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const rows = [];
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    for (const outcome of data.outcomes || []) {
      rows.push({
        connector: outcome.connector,
        status: outcome.status,
        check: outcome.check || "-",
        reason: outcome.reason || "-",
        family: data.family || file.replace(/\.json$/, ""),
        elapsed: data.elapsedSeconds ?? "-",
      });
    }
  }
  const order = [
    "postgres", "webhook",
    "mysql", "sqlserver", "oracle", "firebird", "duckdb-file",
    "clickhouse", "trino", "druid", "db2", "informix",
    "bucket", "sftp", "ftp", "ftps", "webdav",
    "file-url", "graphql", "odata", "rest", "feed",
    "mongodb", "dynamodb", "couchdb", "couchbase", "cosmosdb",
    "elasticsearch", "opensearch", "meilisearch", "typesense",
    "neo4j", "influxdb", "prometheus",
  ];
  rows.sort((a, b) => {
    const ai = order.indexOf(a.connector);
    const bi = order.indexOf(b.connector);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
  });
  console.log("| Kind | Outcome | Check | Reason | Family | Elapsed (s) |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const r of rows) {
    console.log(`| ${r.connector} | ${r.status} | ${r.check} | ${r.reason} | ${r.family} | ${r.elapsed} |`);
  }
  const passed = rows.filter((r) => r.status === "passed").length;
  console.log(`\nTotal: ${rows.length} kinds, ${passed} passed, ${rows.length - passed} failed/other.`);
' "$RESULTS_DIR"
