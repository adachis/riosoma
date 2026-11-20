# Helm install and upgrade smoke test

`tools/release/helm-smoke.sh` installs the chart into a throwaway [kind](https://kind.sigs.k8s.io/) cluster, upgrades it from the previous release, and checks that the server and connector service come back ready and that data survives.  The nightly workflow runs it on the Docker-capable runner.  Linting and rendering the chart, as described in [Kubernetes](../install/kubernetes.md), don't cover any of that.

## Run it locally

You need Docker usable by your user, on linux/amd64, and nothing else.  The script downloads pinned kind, helm, and kubectl binaries into `.cache/helm-smoke` under the repository root, which git ignores, and never installs anything globally.

```bash
# Upgrade from the previous release, taken from the newest v* tag in the checkout.
bash tools/release/helm-smoke.sh

# Or name the previous release's source directory yourself, such as an extracted release archive.
bash tools/release/helm-smoke.sh /path/to/previous-release

# Keep the tool cache somewhere else.
bash tools/release/helm-smoke.sh --cache-dir /path/to/cache
```

The first release has no previous tag.  The script then says so, installs only the current chart, and checks readiness and data without the upgrade half.

## What it does

1. Builds the current server and connector images from the repository's `Dockerfile` and loads them into kind with `kind load docker-image`.  Theme assets are optional, as in any build from source.
2. Resolves the previous release's image.  When the old chart points at a public registry it pulls the published image, and when that pull fails or the registry is private it builds the image from the previous source directory instead.  That build gets the same Node heap headroom the current build script sets, since older releases built the server with plain `tsc` and run out of memory.  The previous source itself is never modified.
3. Creates the kind cluster, installs the previous chart with the bundled PostgreSQL enabled, and waits for the server's `/readyz` to answer 200 through a port-forward.  The connector service is checked the same way when that release has one.
4. Writes a marker row through `psql` in the chart's PostgreSQL.
5. Runs `helm upgrade` to the working tree's chart, waits for readiness again, and checks that the marker row is still there.

The upgrade renders the new chart's defaults plus only the values the test sets, never `--reuse-values`, so a value renamed between releases can't carry a stale setting forward.  Waits are bounded, and a timeout reports the pods that aren't ready with their events and logs.  The cluster is always deleted on exit, including on failure.