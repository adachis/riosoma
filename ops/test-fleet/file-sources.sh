#!/bin/sh
set -eu
unit_root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
FILE_SOURCES_STATE_DIR=$(mktemp -d)
FILE_SOURCES_PASSWORD=$(openssl rand -hex 24)
export FILE_SOURCES_STATE_DIR FILE_SOURCES_PASSWORD
compose() {
  docker compose --project-name riosoma-file-sources --file "$unit_root/file-sources.compose.yaml" --profile file-sources "$@"
}
file_sources_started=false
cleanup() {
  if [ "$file_sources_started" = true ]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf -- "$FILE_SOURCES_STATE_DIR"
}
trap cleanup EXIT HUP INT TERM
python3 - <<'PY'
import json
import os
from pathlib import Path
config = {
    'auth': [{'user': 'reader', 'group': 'readers', 'uid': 1001, 'gid': 1001,
              'password': os.environ['FILE_SOURCES_PASSWORD']}],
    'share': [{'name': 'files', 'path': '/samba/files', 'readonly': True,
               'guestok': False, 'validusers': 'reader'}],
}
path = Path(os.environ['FILE_SOURCES_STATE_DIR']) / 'samba.json'
path.write_text(json.dumps(config))
path.chmod(0o600)
PY
compose config --quiet
if [ "${1:-}" = '--check' ]; then exit 0; fi
file_sources_started=true
compose up --detach --wait --wait-timeout 90
compose ps
if [ "$#" -gt 0 ]; then "$@"; fi
