#!/usr/bin/env bash
set -euo pipefail

directory="$RUNNER_TEMP/release-tools"
mkdir -p "$directory"
cd "$directory"

# Each download must match the SHA-256 recorded here when its version was chosen, so a release
# asset replaced upstream stops the job.  A checksum file fetched beside the download proves
# nothing, since whoever replaces one can replace the other.  Change a version and its checksum
# together, after confirming the checksum from two independent sources.
verify() {
  printf '%s  %s\n' "$1" "$2" > "$2.sha256"
  sha256sum --check --strict "$2.sha256"
}

case "${1:-}" in
  image)
    cosign_version=2.4.3
    curl -fsSLO "https://github.com/sigstore/cosign/releases/download/v${cosign_version}/cosign-linux-amd64"
    verify caaad125acef1cb81d58dcdc454a1e429d09a750d1e9e2b3ed1aed8964454708 cosign-linux-amd64
    install -m 0755 cosign-linux-amd64 cosign
    trivy_version=0.74.0
    curl -fsSLO "https://github.com/aquasecurity/trivy/releases/download/v${trivy_version}/trivy_${trivy_version}_Linux-64bit.tar.gz"
    verify 2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a "trivy_${trivy_version}_Linux-64bit.tar.gz"
    tar -xzf "trivy_${trivy_version}_Linux-64bit.tar.gz" trivy
    ;;
  chart)
    helm_version=3.17.3
    curl -fsSLO "https://get.helm.sh/helm-v${helm_version}-linux-amd64.tar.gz"
    verify ee88b3c851ae6466a3de507f7be73fe94d54cbf2987cbaa3d1a3832ea331f2cd "helm-v${helm_version}-linux-amd64.tar.gz"
    tar -xzf "helm-v${helm_version}-linux-amd64.tar.gz" linux-amd64/helm
    mv linux-amd64/helm helm
    ;;
  *) exit 2 ;;
esac
echo "$directory" >> "$GITHUB_PATH"
