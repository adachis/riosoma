# Kubernetes with Helm

The chart in `deploy/helm/riosoma` runs Riosoma as a Deployment with a Service, an optional Ingress, a volume for `/config`, and a pod disruption budget, and its connector service as a second Deployment with a Service of its own.  Optional PostgreSQL, ClamAV, and SearXNG deployments are off by default.  PDF rendering requires an external renderer.  Caddy and the Docker updater are Compose services, and the chart uses your ingress controller and Helm upgrades instead.

## Prerequisites

- Kubernetes 1.25 or later, and `kubectl` pointed at it
- Helm 3.8 or later
- Git and OpenSSL for the commands below
- A default StorageClass, or one you name, for the `/config` volume and the optional PostgreSQL volume
- For production, a PostgreSQL 14 or later database the cluster can reach, such as Azure Database for PostgreSQL, Amazon RDS, or Cloud SQL
- For the Ingress, an ingress controller, and for automatic certificates, cert-manager

## Try it out

This runs the chart's own PostgreSQL, which has no backups and no high availability, and reaches Riosoma through a port-forward:

```bash
git clone --depth 1 https://github.com/adachis/riosoma.git
cd riosoma
helm install riosoma ./deploy/helm/riosoma -n riosoma --create-namespace \
  --set postgresql.enabled=true
kubectl -n riosoma rollout status deployment/riosoma --timeout=15m
kubectl -n riosoma port-forward service/riosoma 8080:80
```

Leave the port-forward running.  Then, in another terminal, find the setup link, which starts with `http://localhost:8080`:

```bash
kubectl -n riosoma logs deployment/riosoma | grep "Finish setting up"
```

## Install for production

Create the database and an account for Riosoma first (see [Connecting the database](database.md)).  Then put the secret settings in a Secret you manage.  Its keys are setting names:

```bash
kubectl create namespace riosoma
kubectl -n riosoma create secret generic riosoma-settings \
  --from-literal=RIOSOMA_SECRET_KEY="$(openssl rand -base64 32)" \
  --from-literal=RIOSOMA_DATABASE_URL='postgres://riosoma:PASSWORD@db.example.com:5432/riosoma?sslmode=verify-full'
```

Keep a copy of `RIOSOMA_SECRET_KEY` outside the cluster.  It seals the credentials Riosoma stores, and a restore needs it.  For a profile instead of a URL, add `--from-file=RIOSOMA_DATABASE_PROFILE=profile.json`.  Add `RIOSOMA_SMTP_URL` the same way for email, or the secrets of another transport, which [Email](email.md) lists.

Write `values.yaml`:

```yaml
image:
  tag: '0.95.0-rc.1'
secret:
  existingSecret: riosoma-settings
settings:
  RIOSOMA_MAIL_FROM: Riosoma <riosoma@example.com>
ingress:
  enabled: true
  className: nginx
  host: riosoma.example.com
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
    # ingress-nginx allows 1 MB request bodies by default, and attachments can be bigger.
    nginx.ingress.kubernetes.io/proxy-body-size: 1g
```

With the Ingress on, the chart sets `RIOSOMA_BASE_URL` to `https://` and the host, or `http://` when `ingress.tls.enabled` is false, and `RIOSOMA_TRUST_PROXY` to `1`, unless `settings` names them.  Set the proxy addresses explicitly if the ingress is not the single trusted hop.  Install:

```bash
helm install riosoma ./deploy/helm/riosoma -n riosoma -f values.yaml
kubectl -n riosoma rollout status deployment/riosoma --timeout=15m
```

To let the chart make the Secret instead, leave `existingSecret` empty and put the values under `secret.values`.  The chart generates `RIOSOMA_SECRET_KEY` once when you don't give one, keeps it across upgrades, and leaves the Secret in place when the release is uninstalled.  Tools that render the chart without a cluster, such as `helm template` and some GitOps controllers, can't see the existing key and would make a new one each time, so give the key yourself there.

## First-run setup

```bash
kubectl -n riosoma logs deployment/riosoma | grep "Finish setting up"
```

Open the link, which starts with `RIOSOMA_BASE_URL`, and create the owner account.  If the Secret sets `RIOSOMA_SETUP_TOKEN`, no link is printed: open `<base URL>/setup#token=<that token>`.  Generate a fixed token with `openssl rand -hex 32`.  It stops working once the owner exists.  Without a fixed token, the generated token persists on `/config` across restarts.

If neither a database URL nor a profile is set and bundled PostgreSQL is off, the wizard first tests and saves a database connection on `/config`.  `/api/setup/status` reports `database`, `owner`, or `ready`.  After the owner account, the wizard offers optional virus scanning and anonymous usage counts.  You can skip them and return to Settings later.  Usage counts stay off until the owner opts in.  `/healthz` reports that the HTTP server is running.  With a preset database, migrations have finished too, but setup can still need a database or an owner.

`helm test riosoma -n riosoma` checks `/healthz` through the Service from inside the cluster.

## Optional scanner, search, and PDF renderer

Set `clamav.enabled: true` to add the scanner.  The chart supplies `RIOSOMA_CLAMAV_URL=tcp://<release full name>-clamav:3310`, unless `settings` overrides it.  Wait for its Deployment to be ready while it downloads definitions, then detect and enable scanning in the wizard or file settings.  The chart sets an address but does not turn scanning on.  Definitions use an `emptyDir`, so a replacement pod downloads them again.  The scanner requests 2Gi of memory and permits up to 4Gi.  Keep its unauthenticated Service inside the cluster.

For SearXNG, first create its secret:

```bash
kubectl -n riosoma create secret generic riosoma-search \
  --from-literal=secret-key="$(openssl rand -hex 32)"
```

Then set `search.enabled: true` and `search.existingSecret: riosoma-search` in your values.  The chart supplies `RIOSOMA_SEARCH_URL=http://<release full name>-search:8080`, unless `settings` overrides it.  The private settings enable JSON results, and the Service stays inside the cluster.  Allow outbound network access to search engines.  Restart the search Deployment after rotating its Secret, and retain the Secret for reinstalls since Helm does not manage it.

There is no bundled Gotenberg workload.  Deploy a private renderer separately and set `settings.RIOSOMA_PDF_RENDERER_URL` to its reachable HTTP address.  Use the restrictions shown in `deploy/compose/compose.yaml`: disable JavaScript, outside downloads, webhooks, and LibreOffice routes, and isolate it from outside networks.  Apply changed values with `helm upgrade` using the same values file and chart release.

## Where settings go

- Settings that aren't secret: `settings` in `values.yaml`, named exactly as in the [settings reference](settings.md).  Empty values are left out.  The chart puts them in a ConfigMap and restarts the pod when they change.
- Secret settings (`RIOSOMA_SECRET_KEY`, `RIOSOMA_DATABASE_URL`, `RIOSOMA_DATABASE_PROFILE`, `RIOSOMA_SMTP_URL`, and `RIOSOMA_SETUP_TOKEN`): your Secret, named by `secret.existingSecret`, or `secret.values`.  After changing your own Secret, restart with `kubectl -n riosoma rollout restart deployment/riosoma`.
- Anything in Kubernetes form, such as a value from another Secret: `extraEnv`.

Required settings: the database (`RIOSOMA_DATABASE_URL` or `RIOSOMA_DATABASE_PROFILE`, or entered during setup and kept on the `/config` volume), and `RIOSOMA_BASE_URL`, which the Ingress provides.  `RIOSOMA_SECRET_KEY` comes from the chart's Secret unless you use your own, which should include it.

`values.yaml` in the chart lists every option with a comment.  The main ones:

| Value | Default | Meaning |
|---|---|---|
| `image.tag` | the chart's `appVersion` | The release to run |
| `resources` | 250m CPU and 512Mi requested, 1536Mi limit | Raise the memory limit with `RIOSOMA_SNAPSHOT_CACHE_MB` |
| `persistence.size` | `1Gi` | The `/config` volume for stored settings and installed database drivers |
| `persistence.keep` | `true` | Keep the `/config` volume when the release is uninstalled |
| `tmp.sizeLimit` | `3Gi` | Scratch space for previews and file source downloads |
| `serviceAccount.annotations` | none | For cloud identity sign-in to the database |
| `postgresql.enabled` | `false` | The PostgreSQL for trying it out |
| `clamav.enabled` | `false` | ClamAV with temporary virus definitions |
| `search.enabled` | `false` | SearXNG, requiring `search.existingSecret` with a `secret-key` entry |
| `connectors.enabled` | `true` | The connector service, which runs the MySQL, SQL Server, Oracle, Firebird, Snowflake, BigQuery, Databricks, ClickHouse, and MongoDB sources |
| `connectors.image.tag` | `image.tag`, or the chart's `appVersion` | The connector service's release, which should match Riosoma's |
| `connectors.existingSecret` | none | Your own Secret with a `RIOSOMA_CONNECTOR_SERVICE_TOKEN` entry, in place of the generated one |
| `connectors.replicaCount` | `1` | Must be exactly one because live sessions stay in one process.  Upgrades use `Recreate` to stop the old pod before starting its replacement, briefly interrupting connector calls. |
| `connectors.resources` | 100m CPU and 256Mi requested, 1Gi limit | The connector service's share, which grows with the size of the batches it reads |

## What the chart runs

- **The pod** runs as UID 65532 with a read-only root file system, no privilege escalation, every capability dropped, and the runtime's default seccomp profile.  `/config` is the volume and `/tmp` an `emptyDir`.
- **Probes** all ask `/healthz`.  With a preset database, migrations run before the server listens, and unreachable databases get a connection budget of 120 seconds by default (`RIOSOMA_DATABASE_WAIT_SECONDS`, or `0` to disable retries), so the startup probe allows 10 minutes before the liveness probe takes over.
- **The update strategy** is `Recreate`: the old pod stops before the new one starts, so the volume can move between nodes and two releases never share the database.  Expect a short outage on each upgrade.
- **The pod disruption budget** allows one pod down at a time, so a node drain can move the single replica.
- **Service links are off** (`enableServiceLinks: false`).  Kubernetes otherwise gives every pod variables for each Service in the namespace, and a Service named `riosoma` would set `RIOSOMA_PORT=tcp://...`, which Riosoma now ignores with one warning naming the variable and explaining that it is a service link.  Service host and service port variables are also ignored.  Real invalid setting values still stop startup.  Keep service links off in your own manifests to avoid these warnings.
- **The connector service** runs the sources whose drivers live outside Riosoma's image, from `ghcr.io/adachis/riosoma-connectors`, with the same security settings and an `emptyDir` at `/tmp`.  Its Service, `<release>-connectors` on port 8091, is cluster-internal, and a NetworkPolicy lets only Riosoma's pods reach it where the cluster enforces network policies (`connectors.networkPolicy.enabled`).  Its way out to the databases stays open.  The chart points Riosoma at it, and generates the token the two share once, into the `<release>-connectors` Secret, keeping it across upgrades.  Offline renderers can't see the kept token and make a new one each time, which only restarts both.  Its liveness probe asks `/healthz` and its readiness probe `/readyz`.  Riosoma's own `/healthz` and `/readyz` report it as `connectors`, and stay healthy without it, so only those sources fail while it's away.
- **The bundled PostgreSQL**, when on, is a one-pod PostgreSQL 16 StatefulSet with an 8Gi volume and a generated password.  Riosoma waits for it before starting.  Its URL overrides `RIOSOMA_DATABASE_URL` from settings or a Secret, so leave this workload off when connecting an external database.  For offline rendering or GitOps, set `postgresql.password` yourself too: a renderer cannot look up the retained password, and changing it does not change an existing database's password.

## Running several replicas

One replica handles most organizations.  For more, all of these must hold:

- One `RIOSOMA_SECRET_KEY` for every replica, which the chart's Secret provides.
- The database in settings, not entered in the setup wizard, which writes it to one pod's `/config`.
- `RIOSOMA_SETUP_TOKEN` set, or setup finished with one replica first, since each pod otherwise makes its own token.
- `persistence.accessMode: ReadWriteMany`, or `persistence.enabled: false` once the above are set.
- `strategy.type: RollingUpdate`, and `podDisruptionBudget.minAvailable: 1` in place of `maxUnavailable`.
- `RIOSOMA_FILES_STORAGE` left at `postgres`, set to `s3` or `azure-blob` (see [File storage](file-storage.md)), or `RIOSOMA_FILES_DIR` on a volume every replica shares.

Migrations are safe with several replicas starting at once.  Shared view rate limits and the view cache are kept per replica.

## Backups

Back up the database the way its service does: snapshots and point-in-time recovery on a managed database.  For a `pg_dump` from inside the cluster, run a one-off pod that reads the database settings from your Secret and streams the dump back:

The following command requires `RIOSOMA_DATABASE_URL` in `riosoma-settings`, with a URL PostgreSQL's client understands.  It cannot use a wizard-stored connection, a JSON database profile, Riosoma's `pooler=` option, or the server's cloud identity authentication.  Use a direct client URL or the provider's backup tools for those configurations.  Protect the dump with `umask 077`.

```bash
umask 077
kubectl -n riosoma run riosoma-dump --rm -i --quiet --restart=Never --image=postgres:18.6-alpine \
  --overrides='{"spec":{"containers":[{"name":"riosoma-dump","image":"postgres:18.6-alpine","stdin":true,"command":["sh","-c","pg_dump --format=custom --dbname=\"$RIOSOMA_DATABASE_URL\""],"envFrom":[{"secretRef":{"name":"riosoma-settings"}}]}]}}' \
  > riosoma-$(date -u +%Y%m%dT%H%M%SZ).dump
```

With the bundled PostgreSQL:

```bash
kubectl -n riosoma exec riosoma-postgresql-0 -- pg_dump -U riosoma --format=custom riosoma \
  > riosoma-$(date -u +%Y%m%dT%H%M%SZ).dump
```

Keep `RIOSOMA_SECRET_KEY` with the backups.  With the chart-managed Secret, the generated key is in Secret `riosoma`, not in the values file.  To save it privately for the default release name:

```bash
umask 077
kubectl -n riosoma get secret riosoma -o jsonpath='{.data.RIOSOMA_SECRET_KEY}' \
  | openssl base64 -d -A > riosoma-secret-key.txt
```

If your own Secret omits the key, the server stores it in `/config/riosoma.config.json` instead.  Keep `/config` too when the wizard stored the connection, and back up local attachments separately.  With object storage, turn on versioning or soft delete.  Adjust resource names and Secret references when using a different release name or `fullnameOverride`.

## Upgrades

Back up the database, then upgrade.  Migrations run when the new pod starts.  See [Upgrades, backups, and rollbacks](upgrades.md).

```bash
helm upgrade riosoma ./deploy/helm/riosoma -n riosoma -f values.yaml --set image.tag=0.95.0-rc.1
kubectl -n riosoma rollout status deployment/riosoma --timeout=15m
kubectl -n riosoma rollout status deployment/riosoma-connectors --timeout=5m
kubectl -n riosoma logs deployment/riosoma | grep -E 'migrations applied|Server listening'
helm test riosoma -n riosoma
```

The `0.6.0` tag is an example: choose an available release.  Check `/healthz` through the ingress or port-forward and confirm it reports the intended version, since `helm test` checks availability only.  Pull the chart from the same release as the image, since a chart change can come with an app change.  The connector service follows `image.tag` unless `connectors.image.tag` says otherwise.

**Rolling back:** `helm history riosoma -n riosoma` lists revisions, and `helm rollback riosoma REVISION -n riosoma` returns to one.  If the upgrade's log showed `database migrations applied`, scale down first, restore the database from the backup you took before the upgrade, then roll back:

```bash
kubectl -n riosoma scale deployment/riosoma --replicas=0
# restore the database here
helm rollback riosoma REVISION -n riosoma
```

For the bundled PostgreSQL and a dump made with the bundled `pg_dump`, run these restore commands between scaling down and rolling back.  Replace the dump name with your backup.  The schema names below are Riosoma's defaults, so substitute your profile's names if you changed them:

```bash
kubectl -n riosoma exec riosoma-postgresql-0 -- psql -U riosoma -d riosoma -v ON_ERROR_STOP=1 \
  -c 'DROP SCHEMA IF EXISTS rio_app, rio_data, rio_audit CASCADE'
kubectl -n riosoma exec -i riosoma-postgresql-0 -- pg_restore \
  --clean --if-exists --no-owner --single-transaction -U riosoma -d riosoma \
  < riosoma-20260928T030000Z.dump
```

Dropping the schemas removes objects added by the newer release, and happens before the restore transaction, so a failed restore leaves the schemas deleted.  Keep the backup until the old release is healthy.  Use the same or a newer `pg_restore` client than the one that wrote the dump.

For a managed database, use its restore tools instead.  If the restore creates a new server, update your external database Secret to the new endpoint before starting the old release.  If the chart manages that connection Secret, use `helm upgrade` with the old image and updated connection values instead of `helm rollback`, which would restore the previous endpoint too.

## Removing it

`helm uninstall riosoma -n riosoma` removes the release but keeps, on purpose, the chart's Secret with `RIOSOMA_SECRET_KEY`, the `/config` volume claim, and the bundled PostgreSQL's password and volume, so a reinstall picks up where it left off.  To remove everything, delete those too:

```bash
kubectl -n riosoma delete secret,pvc -l app.kubernetes.io/instance=riosoma
```

The command above selects this release's labeled resources.  Secrets you manage, such as `riosoma-settings` and `riosoma-search`, and existing claims named through `persistence.existingClaim` are not managed or labeled by the chart.  Delete them separately only after checking that nothing else needs them and copying their contents and backups off the cluster.

## Review the chart without a cluster

From the repository root:

```bash
helm lint deploy/helm/riosoma
helm template riosoma deploy/helm/riosoma > /tmp/riosoma-default.yaml
helm lint deploy/helm/riosoma -f deploy/helm/riosoma/ci/full-values.yaml
helm template riosoma deploy/helm/riosoma -f deploy/helm/riosoma/ci/full-values.yaml > /tmp/riosoma-full.yaml
helm template riosoma deploy/helm/riosoma \
  --set secret.existingSecret=riosoma-settings \
  --set ingress.enabled=true --set ingress.tls.enabled=false \
  --set persistence.enabled=false --set service.port=8081 > /tmp/riosoma-external.yaml
```

The CI values exercise non-default options, including PostgreSQL, the scanner, search, an ingress, shared storage, and several replicas.  Their example credentials and referenced resources are for rendering only.  Do not install those values.  Linting and rendering do not test cluster scheduling, image startup, database connectivity, or certificates, so validate those during installation.  For an automated install and upgrade check against a throwaway kind cluster, see the [Helm smoke test](../developer/helm-smoke.md).

## Custom public domains

See [Custom domains](custom-domains.md) for DNS verification, certificate issuance, proxy isolation, and removal.  Keep the main app on `RIOSOMA_BASE_URL`.
