#!/usr/bin/env bash
# Install and upgrade smoke test for the Helm chart.  It creates a throwaway kind cluster, installs
# the chart as it was at the previous release, waits for readiness, writes a row that must survive,
# then helm upgrades to the working tree's chart and checks readiness and the row again.  The
# cluster is always deleted on exit, including on failure.
#
# Usage: tools/release/helm-smoke.sh [PREVIOUS_SOURCE_DIR] [--cache-dir DIR]
#
#   PREVIOUS_SOURCE_DIR  A checkout of the previous release (its root, holding deploy/helm/riosoma).
#                        In CI the nightly job fills this with git archive of the newest v* tag.
#                        Without it, and without a v* tag to archive, the upgrade half is skipped
#                        and only the current chart is installed and checked.
#   --cache-dir DIR      Where the pinned kind, helm, and kubectl binaries are downloaded and kept.
#                        Defaults to .cache/helm-smoke under the repository root, which git ignores.
#
# The current images are built from the repository's Dockerfile and loaded into kind.  For the
# previous release, the published image is pulled when the old chart points at a public registry.
# When that pull fails, or the registry is private, the image is built from PREVIOUS_SOURCE_DIR.
#
# Only linux/amd64 is supported, matching tools/release/install-tools.sh.  Docker must be usable by
# the calling user.  Nothing is installed globally.
set -euo pipefail

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
  exit 2
}

die() {
  echo "helm-smoke: $*" >&2
  exit 1
}

root="$(cd "$(dirname "$0")/../.." && pwd)"
chart="$root/deploy/helm/riosoma"
cache_dir="$root/.cache/helm-smoke"
prev_dir=''

while (($#)); do
  case "$1" in
    --cache-dir)
      [[ $# -ge 2 ]] || usage
      cache_dir="$2"
      shift 2
      ;;
    --cache-dir=*)
      cache_dir="${1#--cache-dir=}"
      shift
      ;;
    -h | --help) usage ;;
    -*) usage ;;
    *)
      [[ -z "$prev_dir" ]] || usage
      prev_dir="$1"
      shift
      ;;
  esac
done

[[ "$(uname -s)" = Linux && "$(uname -m)" = x86_64 ]] ||
  die 'only linux/amd64 is supported, matching tools/release/install-tools.sh'
docker info >/dev/null 2>&1 || die 'Docker is not usable by this user'
[[ -f "$chart/Chart.yaml" ]] || die "no chart at $chart"
cache_dir="$(mkdir -p "$cache_dir" && cd "$cache_dir" && pwd)"
mkdir -p "$cache_dir/bin"
export PATH="$cache_dir/bin:$PATH"

# No previous release given: try the newest v* tag, the same source the nightly job archives.
# The first release has no tag, and then only the current chart is installed and checked.
if [[ -z "$prev_dir" ]] && git -C "$root" rev-parse --git-dir >/dev/null 2>&1; then
  newest_tag="$(git -C "$root" tag --list 'v*' --sort=-v:refname | head -n 1)"
  if [[ -n "$newest_tag" ]]; then
    prev_dir="$cache_dir/previous-source"
    rm -rf "$prev_dir"
    mkdir -p "$prev_dir"
    git -C "$root" archive "$newest_tag" | tar -x -C "$prev_dir"
    echo "==> Using previous release $newest_tag"
  fi
fi
if [[ -n "$prev_dir" ]]; then
  prev_dir="$(cd "$prev_dir" && pwd)"
  [[ -f "$prev_dir/deploy/helm/riosoma/Chart.yaml" ]] ||
    die "no chart under $prev_dir/deploy/helm/riosoma"
fi

# Each download must match the SHA-256 recorded here when its version was chosen, so a release
# asset replaced upstream stops the test.  The helm pin matches tools/release/install-tools.sh.
# Change a version and its checksum together.
fetch_tool() { # url filename sha256
  local url="$1" filename="$2" sha="$3"
  if [[ ! -f "$cache_dir/$filename" ]]; then
    echo "==> Downloading $filename"
    curl -fsSL -o "$cache_dir/$filename" "$url"
  fi
  printf '%s  %s\n' "$sha" "$cache_dir/$filename" | sha256sum --check --strict - >/dev/null ||
    die "checksum mismatch for $filename, remove it from $cache_dir to download again"
}

kind_version=0.27.0
kubectl_version=1.32.2
helm_version=3.17.3
# The node image kind v0.27.0 ships with, pinned so a kind bump can't move the cluster version.
node_image='kindest/node:v1.32.2'

fetch_tool \
  "https://github.com/kubernetes-sigs/kind/releases/download/v${kind_version}/kind-linux-amd64" \
  kind-linux-amd64 a6875aaea358acf0ac07786b1a6755d08fd640f4c79b7a2e46681cc13f49a04b
install -m 0755 "$cache_dir/kind-linux-amd64" "$cache_dir/bin/kind"
fetch_tool \
  "https://dl.k8s.io/release/v${kubectl_version}/bin/linux/amd64/kubectl" \
  kubectl 4f6a959dcc5b702135f8354cc7109b542a2933c46b808b248a214c1f69f817ea
install -m 0755 "$cache_dir/kubectl" "$cache_dir/bin/kubectl"
fetch_tool \
  "https://get.helm.sh/helm-v${helm_version}-linux-amd64.tar.gz" \
  "helm-v${helm_version}-linux-amd64.tar.gz" \
  ee88b3c851ae6466a3de507f7be73fe94d54cbf2987cbaa3d1a3832ea331f2cd
tar -xzf "$cache_dir/helm-v${helm_version}-linux-amd64.tar.gz" -C "$cache_dir" linux-amd64/helm
install -m 0755 "$cache_dir/linux-amd64/helm" "$cache_dir/bin/helm"
rm -rf "$cache_dir/linux-amd64"

cluster=riosoma-smoke
namespace=riosoma-smoke
release=smoke
# Every object the chart makes is named from this override, in both releases.
fullname=riosoma
workdir="$(mktemp -d "$cache_dir/run-XXXXXX")"
export KUBECONFIG="$workdir/kubeconfig"
cluster_created=''
pf_pids=()

kubectl() { command kubectl --context "kind-$cluster" "$@"; }

diagnose() {
  echo '==> Pods at failure:' >&2
  kubectl get pods -n "$namespace" -o wide >&2 || true
  local pod
  while IFS= read -r pod; do
    [[ -n "$pod" ]] || continue
    echo "==> describe $pod" >&2
    kubectl describe pod -n "$namespace" "$pod" >&2 || true
    echo "==> logs $pod (last 40 lines)" >&2
    kubectl logs -n "$namespace" "$pod" --all-containers --tail=40 >&2 || true
  done < <(kubectl get pods -n "$namespace" -o name 2>/dev/null | sed 's|^pod/||')
}

cleanup() {
  local status=$?
  trap - EXIT
  local pid
  for pid in "${pf_pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  if [[ -n "$cluster_created" ]]; then
    if ((status != 0)); then
      diagnose
    fi
    echo '==> Deleting the kind cluster'
    kind delete cluster --name "$cluster" || true
  fi
  rm -rf "$workdir"
  exit "$status"
}
trap cleanup EXIT

echo '==> Building the current images'
# Provenance attestations ride along as extra manifests in the image index, and kind's importer
# can't resolve them, so the builds turn them off.
docker build --provenance=false -t riosoma-smoke:current "$root"
docker build --provenance=false --target connectors -t riosoma-smoke-connectors:current "$root"

# The previous release's image: published when the old chart points at a public registry and the
# pull works, built from the old source otherwise.  A published image is pulled by the cluster
# itself, since a multi-arch save from Docker's containerd image store can't be loaded into kind.
prev_image=''
prev_overrides=()
if [[ -n "$prev_dir" ]]; then
  prev_chart="$prev_dir/deploy/helm/riosoma"
  prev_repo="$(awk '/^image:/{f=1; next} /^[^ ]/{f=0} f && /^  repository:/{print $2; exit}' \
    "$prev_chart/values.yaml")"
  prev_tag="$(sed -n 's/^appVersion:[[:space:]]*//p' "$prev_chart/Chart.yaml" | tr -d "\"'" |
    head -n 1)"
  [[ -n "$prev_repo" && -n "$prev_tag" ]] || die 'cannot read the previous chart image reference'
  public=''
  case "$prev_repo" in
    ghcr.io/* | docker.io/* | quay.io/* | public.ecr.aws/* | mcr.microsoft.com/* | registry.k8s.io/*)
      public=yes
      ;;
    */*) public='' ;;
    *) public=yes ;; # A bare name is Docker Hub.
  esac
  if [[ -n "$public" ]] && timeout 300 docker pull "$prev_repo:$prev_tag"; then
    echo "==> Using the published previous image $prev_repo:$prev_tag, pulled by the cluster"
  else
    echo '==> Published previous image unavailable, building it from the previous source'
    # Older releases built the server with plain tsc, whose default Node heap is too small for the
    # server's type graph.  Give the build stage the same headroom the current build script sets,
    # through a Dockerfile read from stdin, so the previous source stays untouched.  The compiled
    # output is unchanged.
    sed '/ AS build$/a ENV NODE_OPTIONS=--max-old-space-size=4096' "$prev_dir/Dockerfile" |
      docker build --provenance=false -f - -t riosoma-smoke:prev "$prev_dir"
    prev_image=riosoma-smoke:prev
    prev_overrides=(--set image.repository=riosoma-smoke --set image.tag=prev)
  fi
fi

# The bundled PostgreSQL is pulled by the cluster itself, not loaded from the host.  A multi-arch
# image saved by Docker's containerd image store references platform blobs the save omits, and
# kind's importer rejects it.  The bounded rollout wait below covers a slow registry pull.

if kind get clusters 2>/dev/null | grep -qx "$cluster"; then
  echo '==> Removing a leftover cluster from an earlier run'
  kind delete cluster --name "$cluster"
fi
echo '==> Creating the kind cluster'
kind create cluster --name "$cluster" --image "$node_image" --wait 120s
cluster_created=yes

echo '==> Loading images into kind'
load_images=(riosoma-smoke:current riosoma-smoke-connectors:current)
[[ -z "$prev_image" ]] || load_images+=("$prev_image")
kind load docker-image --name "$cluster" "${load_images[@]}"

# The only values the test sets, shared by the install and the upgrade.  The upgrade renders the
# new chart's defaults plus these, never --reuse-values, so a value renamed between releases can't
# carry a stale setting forward.
values="$workdir/values.yaml"
cat >"$values" <<'EOF'
fullnameOverride: riosoma
postgresql:
  enabled: true
  persistence:
    size: 1Gi
persistence:
  size: 1Gi
EOF

current_overrides=(
  --set image.repository=riosoma-smoke
  --set image.tag=current
  --set connectors.image.repository=riosoma-smoke-connectors
  --set connectors.image.tag=current
)

wait_rollout() { # kind name timeout-seconds
  local kind="$1" name="$2" timeout="$3"
  echo "==> Waiting for $kind/$name (up to ${timeout}s)"
  kubectl rollout status "$kind/$name" -n "$namespace" --timeout="${timeout}s" ||
    die "$kind/$name did not become ready within ${timeout}s, see the pod report above"
}

wait_readyz() { # service local:remote deadline-seconds
  local svc="$1" ports="$2" deadline="$3" port="${2%%:*}" old
  # A port-forward from the previous phase dies with its pod, but clear any survivor so the local
  # port is free.
  for old in "${pf_pids[@]}"; do
    kill "$old" 2>/dev/null || true
  done
  pf_pids=()
  sleep 1
  echo "==> Waiting for $svc /readyz through a port-forward (up to ${deadline}s)"
  kubectl port-forward -n "$namespace" "svc/$svc" "$ports" >"$workdir/pf-$svc.log" 2>&1 &
  local pf_pid=$!
  pf_pids+=("$pf_pid")
  local end=$((SECONDS + deadline)) code=''
  while :; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
      "http://127.0.0.1:$port/readyz" || true)"
    if [[ "$code" = 200 ]]; then
      break
    fi
    if ((SECONDS >= end)); then
      die "$svc /readyz answered '$code' after ${deadline}s, see the pod report above"
    fi
    kill -0 "$pf_pid" 2>/dev/null ||
      die "port-forward to $svc exited early: $(cat "$workdir/pf-$svc.log")"
    sleep 2
  done
  echo "==> $svc /readyz answered 200"
}

pg_exec() {
  kubectl exec -n "$namespace" "$fullname-postgresql-0" -c postgresql -- \
    psql -U riosoma -d riosoma -v ON_ERROR_STOP=1 "$@"
}

marker_note='written before the upgrade'
write_marker() {
  echo '==> Writing the marker row through psql'
  pg_exec \
    -c 'CREATE TABLE IF NOT EXISTS helm_smoke_marker (id integer PRIMARY KEY, note text NOT NULL)' \
    -c "INSERT INTO helm_smoke_marker VALUES (1, '$marker_note') ON CONFLICT (id) DO NOTHING"
}
check_marker() {
  echo '==> Checking the marker row survived'
  local note
  note="$(pg_exec -tAc 'SELECT note FROM helm_smoke_marker WHERE id = 1')"
  [[ "$note" = "$marker_note" ]] || die "marker row changed or vanished: '$note'"
  echo '==> Marker row survived'
}

wait_server() {
  wait_rollout statefulset "$fullname-postgresql" 300
  # Migrations run before the server listens, and the startup probe allows ten minutes for them.
  wait_rollout deployment "$fullname" 600
  wait_readyz "$fullname" 18080:80 120
}

wait_connectors() {
  # The previous release may predate the connector service.
  if kubectl get deployment "$fullname-connectors" -n "$namespace" >/dev/null 2>&1; then
    wait_rollout deployment "$fullname-connectors" 300
    wait_readyz "$fullname-connectors" 18091:8091 120
  fi
}

if [[ -n "$prev_dir" ]]; then
  echo "==> Installing the previous release's chart from $prev_dir"
  helm install "$release" "$prev_chart" -n "$namespace" --create-namespace \
    -f "$values" "${prev_overrides[@]}"
  wait_server
  wait_connectors
  write_marker

  echo '==> Upgrading to the working tree chart'
  helm upgrade "$release" "$chart" -n "$namespace" -f "$values" "${current_overrides[@]}"
  wait_server
  wait_connectors
  check_marker
else
  echo '==> No previous release found, skipping the upgrade half.  Installing the current chart only.'
  helm install "$release" "$chart" -n "$namespace" --create-namespace \
    -f "$values" "${current_overrides[@]}"
  wait_server
  wait_connectors
  write_marker
  check_marker
fi

echo '==> Helm install and upgrade smoke test passed'