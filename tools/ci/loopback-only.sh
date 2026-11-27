#!/usr/bin/env bash
# Runs a CI browser step in a network namespace that holds only loopback and one dummy interface.
# Interface changes on the host, as Docker network churn makes, never reach a process in another
# network namespace, so Chromium's in-flight requests to 127.0.0.1 survive them.  The whole test
# stack listens on loopback, so it moves into the namespace with the browser.
#
# Usage: bash tools/ci/loopback-only.sh CMD [ARGS...]
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo 'Usage: bash tools/ci/loopback-only.sh CMD [ARGS...]' >&2
  exit 2
fi

# Already inside the namespace, so a nested call does nothing.
if [ "${RIOSOMA_LOOPBACK_ONLY:-}" = 1 ]; then
  exec "$@"
fi

if [ "$(uname -s)" != Linux ]; then
  echo 'This step runs without a private network namespace on this platform.' >&2
  export RIOSOMA_LOOPBACK_ONLY=unavailable
  exec "$@"
fi

uid=$(id -u)
gid=$(id -g)

# The outer user namespace maps root to the real user, so it may set up the interfaces.  Browsers
# report navigator.onLine as false when loopback is the only interface, and the app then holds its
# writes as if offline, so a dummy interface with a documentation address (RFC 5737) makes the
# namespace count as online.  Nothing routes through it, so every outside address stays
# unreachable.  The inner, nested user namespace maps the real uid and gid back, so the command
# runs as an ordinary user with no capabilities, which PostgreSQL's initdb and pg_ctl require.  The
# command and its arguments pass through positionally, never through string interpolation.
# shellcheck disable=SC2016  # The inner sh expands these, not this script.
enter_namespace='
  set -e
  uid=$1 gid=$2
  shift 2
  ip link set lo up
  ip link add rio-online type dummy
  ip address add 192.0.2.1/32 dev rio-online
  ip link set rio-online up
  exec unshare --user --map-user="$uid" --map-group="$gid" -- "$@"
'

# Probe the full chain before the real command, so a runner without usable user namespaces still
# runs the step instead of failing it.
if probe_error=$(unshare --user --map-root-user --net sh -c "$enter_namespace" sh "$uid" "$gid" true 2>&1); then
  export RIOSOMA_LOOPBACK_ONLY=1
  echo 'This step runs in a loopback-only network namespace.' >&2
  exec unshare --user --map-root-user --net sh -c "$enter_namespace" sh "$uid" "$gid" "$@"
else
  printf '%s\n' "$probe_error" >&2
  warning='The loopback-only network namespace is unavailable, so this step runs on the host network.  Host interface changes can fail Chromium requests with net::ERR_NETWORK_CHANGED.'
  echo "Warning: $warning" >&2
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    printf '::warning::%s\n' "$warning" >&2
  fi
  export RIOSOMA_LOOPBACK_ONLY=unavailable
  exec "$@"
fi
