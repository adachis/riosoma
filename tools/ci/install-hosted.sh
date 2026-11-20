#!/usr/bin/env bash
set -euo pipefail

# Hosted jobs have separate machines and caches, so every job installs its own prerequisites.
case "${1:-}" in
  postgres16|postgres18)
    pg_version="${1#postgres}"
    sudo install -d /usr/share/postgresql-common/pgdg
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo tee /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc >/dev/null
    . /etc/os-release
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
    sudo apt-get update
    sudo apt-get install -y "postgresql-${pg_version}"
    echo "RIOSOMA_PG_BIN=/usr/lib/postgresql/${pg_version}/bin" >> "$GITHUB_ENV"
    ;;
  security)
    # The self-hosted runners use this version too.  Older releases pin a protobuf that fails to import
    # on the Python 3.14 that newer hosted images ship.
    python3 -m venv "$RUNNER_TEMP/semgrep"
    "$RUNNER_TEMP/semgrep/bin/pip" install semgrep==1.176.0
    echo "$RUNNER_TEMP/semgrep/bin" >> "$GITHUB_PATH"
    export GOBIN="$RUNNER_TEMP/security-bin"
    mkdir -p "$GOBIN"
    go install github.com/google/osv-scanner/v2/cmd/osv-scanner@v2.2.2
    go install github.com/zricethezav/gitleaks/v8@v8.24.2
    echo "$GOBIN" >> "$GITHUB_PATH"
    ;;
  osv-scanner)
    export GOBIN="$RUNNER_TEMP/security-bin"
    mkdir -p "$GOBIN"
    go install github.com/google/osv-scanner/v2/cmd/osv-scanner@v2.2.2
    echo "$GOBIN" >> "$GITHUB_PATH"
    ;;
  browser)
    pnpm exec playwright install --with-deps chromium
    ;;
  *) exit 2 ;;
esac
