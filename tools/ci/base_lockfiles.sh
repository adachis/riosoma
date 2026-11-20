#!/usr/bin/env bash
# Copy a pull request's base-branch lockfiles into a folder, at the same paths as in the checkout.
# Usage: base_lockfiles.sh <base branch> <folder>
# A lockfile the base branch does not have is left out, so everything in it counts as new.
set -euo pipefail

base_ref="$1"
folder="$2"
git fetch --no-tags --depth=1 origin "refs/heads/$base_ref"
for lockfile in pnpm-lock.yaml integrations/zapier/pnpm-lock.yaml apps/hub/pnpm-lock.yaml integrations/n8n/pnpm-lock.yaml; do
  mkdir -p "$folder/$(dirname "$lockfile")"
  if ! git show "FETCH_HEAD:$lockfile" > "$folder/$lockfile" 2>/dev/null; then
    rm -f "$folder/$lockfile"
  fi
done
