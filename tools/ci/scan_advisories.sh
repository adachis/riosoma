#!/usr/bin/env bash
# Scan every lockfile CI checks for known advisories and write one osv-scanner JSON report.
# Usage: scan_advisories.sh <checkout root> <output file>
# Each lockfile is scanned with the osv-scanner.toml beside it in this checkout, or with the root
# one when its folder has none.  A pull request's base is scanned with the same ignores as the pull
# request itself.
set -euo pipefail

root="$1"
output="$2"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
parts="$(mktemp -d)"
trap 'rm -rf "$parts"' EXIT
for lockfile in pnpm-lock.yaml integrations/zapier/pnpm-lock.yaml apps/hub/pnpm-lock.yaml \
  integrations/n8n/pnpm-lock.yaml; do
  if [ ! -f "$root/$lockfile" ]; then continue; fi
  folder="$(dirname "$lockfile")"
  config="$repo/$folder/osv-scanner.toml"
  if [ ! -f "$config" ]; then config="$repo/osv-scanner.toml"; fi
  # osv-scanner exits 1 when it finds advisories, and the gate decides what they mean.
  status=0
  osv-scanner scan source --config "$config" --format json --lockfile "$root/$lockfile" \
    > "$parts/${lockfile//\//_}.json" || status=$?
  if [ "$status" -gt 1 ]; then
    echo "osv-scanner failed with status $status on $lockfile" >&2
    exit "$status"
  fi
done
python3 - "$output" "$parts" <<'PY'
import json
import sys
from pathlib import Path

output, parts = sys.argv[1], Path(sys.argv[2])
results = []
for part in sorted(parts.glob("*.json")):
    results.extend(json.loads(part.read_text(encoding="utf-8")).get("results") or [])
Path(output).write_text(json.dumps({"results": results}), encoding="utf-8")
PY
