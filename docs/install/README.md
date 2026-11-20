# Installing Riosoma

Riosoma ships as two container images from the same release: one that serves the web app and the API on port 8080, and its connector service, which runs the sources that need database drivers of their own.  Riosoma keeps a small settings file in `/config` and everything else in PostgreSQL 14 or later.  Every guide starts both.  Pick the guide for where it will run:

| Guide | Good for | Database |
|---|---|---|
| [Docker Compose](docker-compose.md) | One server or VM, or trying it out | Your own PostgreSQL, or the bundled container |
| [Kubernetes with Helm](kubernetes.md) | A cluster you already run | A managed database, or the chart's PostgreSQL for trying it out |
| [Azure Container Apps](azure-container-apps.md) | Azure | Azure Database for PostgreSQL flexible server |
| [AWS ECS on Fargate](aws-ecs-fargate.md) | AWS | Amazon RDS for PostgreSQL |
| [Google Cloud Run](google-cloud-run.md) | Google Cloud | Cloud SQL for PostgreSQL |
| [From source](from-source.md) | Development, or a host without containers | Any PostgreSQL 14 or later |

Seven pages apply to every guide:

- [Settings reference](settings.md): every setting, its default, and which ones are secret.  It's generated from the server's own settings schema.
- [Connecting the database](database.md): connection URLs, TLS, poolers, and signing in with a cloud identity instead of a password.
- [Email](email.md): the transports email goes out through, from an SMTP server to Amazon SES, Azure Communication Services, Microsoft Graph, Gmail, or a relay of your own.
- [File storage](file-storage.md): keeping attachments in the database, a folder, an S3-compatible bucket, or Azure Blob Storage, and moving them from one to another.
- [Upgrades, backups, and rollbacks](upgrades.md): what happens on upgrade and how to go back.
- [Updates and the updater](updater.md): the in-app update notice, its signed feed, one-click updates with Docker Compose, and anonymous usage counts, which stay off unless the owner turns them on.
- [Cloud drives](cloud-drives.md): registering the Dropbox, Box, and Google apps for attachments, and the GitHub app for syncing app sources.
- [Microsoft 365](microsoft-365.md): the Entra app registration behind email through Microsoft Graph, SharePoint, Excel, and Dataverse sources, and Fabric warehouses, with the least each one needs, and Teams webhooks.

## The image

The image is `ghcr.io/adachis/riosoma`, tagged by release, such as `ghcr.io/adachis/riosoma:0.95.0-rc.1`.  Pin a release tag rather than `latest`, so an upgrade happens only when you choose it.

The runtime is distroless: Node and the app, with no shell and no package manager.  It runs as the unprivileged `nonroot` user (UID 65532), writes only to `/config` and `/tmp`, and works with a read-only root file system.  `GET /healthz` answers `{"status":"ok","version":"0.95.0-rc.1","connectors":"ok"}` once the server is listening, where `connectors` says whether the connector service answers: `ok`, `unavailable`, or `refused` when it doesn't accept the token.

## The connector service

The connector service runs the MySQL, SQL Server, Oracle, Firebird, Snowflake, BigQuery, Databricks, ClickHouse, and MongoDB sources, whose drivers bring more packages than the rest of Riosoma together.  Keeping them in an image of their own, `ghcr.io/adachis/riosoma-connectors` with the same release tag, keeps Riosoma's image smaller and its security advisories fewer, and loses no kind of source.  It's built the same way, distroless and unprivileged, keeps no data, and publishes no port: only Riosoma calls it, with a token the two share.

Compose and the Helm chart run it, point Riosoma at it, and generate the token, so neither needs a setting for it.  The cloud guides run it as a second container beside Riosoma, which reaches it on the shared loopback address with a token from the platform's secret store.  From source, the server starts it itself.  [Settings](settings.md) has `RIOSOMA_CONNECTOR_SERVICE_URL` and `RIOSOMA_CONNECTOR_SERVICE_TOKEN` for running it anywhere else.  Without it, Riosoma keeps working, and only those sources fail, with a message saying the connector service isn't answering.

To build your own, for example for a private registry, run this from a checkout.  The cloud platforms here run `linux/amd64`.

```bash
docker buildx build --platform linux/amd64 --build-arg RIOSOMA_VERSION=0.95.0-rc.1 \
  -t registry.example.com/riosoma:0.95.0-rc.1 --push .
docker buildx build --platform linux/amd64 --build-arg RIOSOMA_VERSION=0.95.0-rc.1 --target connectors \
  -t registry.example.com/riosoma-connectors:0.95.0-rc.1 --push .
```

Theme fonts and textures aren't in git. Fetch them into `themes/` first with `node tools/release/fetch-theme-assets.mjs 0.95.0-rc.1`, or build without them and the themes fall back to system fonts. The fetch verifies the release bundle against its checked-in SHA-256 before unpacking it.

## First-run setup

Setup works the same way everywhere:

1. Start Riosoma.  With a database in its settings, it connects and runs its migrations.  Without one, it starts in setup mode.
2. The server writes a link to its log, once per start, until setup is done: `Finish setting up Riosoma at https://riosoma.example.com/setup#token=...`.  Each guide shows how to find it.  The token rides in the part of the link after `#`, which browsers never send to a server or proxy.
3. Open the link.  If the database wasn't in the settings, enter it in the browser and Riosoma checks it one layer at a time.  Then create the owner account.  The token stops working as soon as the owner exists.

The link starts with `RIOSOMA_BASE_URL`, or `http://localhost:8080` when that's unset.  With `RIOSOMA_SETUP_TOKEN` set, the server prints no link, so open `<base URL>/setup#token=<that token>` yourself.  `GET /api/setup/status` reports where setup stands: `database`, `owner`, or `ready`.

## What every production install needs

- **HTTPS in front.**  In production mode, Riosoma marks its single sign-on and two-factor cookies secure, so browsers keep them only over HTTPS, apart from `localhost`.  Behind the proxy or load balancer that ends TLS, set `RIOSOMA_TRUST_PROXY` (usually `1`) so Riosoma sees the real scheme and client address.
- **`RIOSOMA_BASE_URL`** set to the address people use, since emailed links and the live-update connection check use it.
- **A secret key that lasts.**  `RIOSOMA_SECRET_KEY` seals the credentials Riosoma stores.  Either keep `/config` on a persistent volume, where the server keeps a generated key, or set the key yourself, which the cloud guides do.  Losing it makes those credentials unreadable.
- **Backups of the database**, plus `RIOSOMA_SECRET_KEY` or `/config` kept somewhere safe.  With `RIOSOMA_FILES_STORAGE` at its default, attachments live in the database too.  With a bucket or container, see [File storage](file-storage.md).
- **One replica**, unless you've read the replica notes in the [Kubernetes guide](kubernetes.md#running-several-replicas).  Background work (automations, webhooks, scheduled reports, syncs) runs inside the server, so on serverless platforms keep one instance running at all times.

## Moving between servers

Use an organization archive to move records, files, settings, and permissions to an empty destination.  See [Moving an organization to another server](moving-a-server.md).
