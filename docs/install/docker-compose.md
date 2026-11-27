# Docker Compose

One machine running Riosoma and its connector service, optionally with its own PostgreSQL, Caddy for automatic HTTPS, and nightly backups.  Everything lives in `deploy/compose/`.

## Prerequisites

- Docker Engine with Compose 2.24.4 or later (`docker compose version`)
- Git and OpenSSL for the commands below
- 2 GB of memory and a few GB of disk for Riosoma and PostgreSQL
- For HTTPS with the `caddy` profile: a domain name whose DNS points at the machine, and ports 80 and 443 open to the internet

## The files

| File | What it is |
|---|---|
| `compose.yaml` | Riosoma, its connector service, and optional PostgreSQL, ClamAV, Gotenberg, SearXNG, Caddy, backup, and updater services |
| `.env.example` | Settings to copy into `.env` |
| `Caddyfile` | Main-domain HTTPS and verified custom-domain certificate requests |
| `backup.sh` | The `backup` service's script, mounted into its container |
| `clamd.conf` | ClamAV's stream and engine limits |
| `search-settings.yml` | SearXNG's private JSON search configuration |

| Profile | Adds |
|---|---|
| none | Riosoma and its connector service, pointed at your own PostgreSQL |
| `clamav` | ClamAV virus scanning, with persistent virus definitions and an internal daemon address |
| `postgres` | PostgreSQL 16 in a container, with its data in the `postgres-data` volume |
| `pdf` | Gotenberg on an internal network for PDF reports, with no published port |
| `search` | SearXNG for web search, with no published port |
| `caddy` | Caddy on ports 80 and 443, with a certificate for `CADDY_DOMAIN` from Let's Encrypt, renewed automatically |
| `backup` | A `pg_dump` every night at `BACKUP_TIME` (03:00 UTC unless set), kept for 14 days in the `backups` volume |
| `updater` | One-click updates from Settings, Updates, with a backup first and a rollback if the new version fails.  Needs `backup` and `RIOSOMA_UPDATER_TOKEN`.  See [Updates and the updater](updater.md). |

## Install

```bash
git clone --depth 1 https://github.com/adachis/riosoma.git
cd riosoma/deploy/compose
```

Copy the example into a private `.env`, then fill in its settings.  This example adds the bundled PostgreSQL, Caddy, and backups.  Replace both occurrences of `riosoma.example.com` with your domain before starting:

```bash
DB_PASSWORD=$(openssl rand -hex 24)
umask 077
cp .env.example .env
cat >> .env <<EOF
COMPOSE_PROFILES=postgres,caddy,backup
RIOSOMA_IMAGE=ghcr.io/adachis/riosoma:0.95.0
CADDY_DOMAIN=riosoma.example.com
RIOSOMA_BASE_URL=https://riosoma.example.com
RIOSOMA_TRUST_PROXY=172.30.52.2
RIOSOMA_TLS_ASK_TOKEN=$(openssl rand -hex 32)
RIOSOMA_SECRET_KEY=$(openssl rand -base64 32)
POSTGRES_PASSWORD=$DB_PASSWORD
RIOSOMA_DATABASE_URL=postgres://riosoma:$DB_PASSWORD@postgres:5432/riosoma?sslmode=disable
EOF
chmod 600 .env
docker compose up -d --wait --wait-timeout 600
```

`COMPOSE_PROFILES` in `.env` turns the profiles on for every `docker compose` command, so you don't repeat `--profile` each time.  Change it to suit:

- **Your own PostgreSQL:** leave `postgres` out of `COMPOSE_PROFILES`, drop `POSTGRES_PASSWORD`, and set `RIOSOMA_DATABASE_URL` to your server, ideally with `sslmode=verify-full`.  See [Connecting the database](database.md).
- **No domain yet:** leave `caddy` out, set `RIOSOMA_BASE_URL=http://localhost:8080`, and drop `CADDY_DOMAIN` and `RIOSOMA_TRUST_PROXY`.  Riosoma listens on `127.0.0.1:8080` only.  To reach it from elsewhere without Caddy, set `RIOSOMA_PUBLISH` (for example `0.0.0.0:8080`) and put your own HTTPS proxy in front.  Then set `RIOSOMA_BASE_URL` to the proxy's public HTTPS URL and `RIOSOMA_TRUST_PROXY` to its actual address or network.

## First-run setup

```bash
docker compose logs riosoma | grep "Finish setting up"
```

Open the link and create the owner account.  If `.env` sets `RIOSOMA_SETUP_TOKEN`, no link is printed: open `<RIOSOMA_BASE_URL>/setup#token=<that token>`.  Generate a fixed token with `openssl rand -hex 32`.  The token stops working once the owner exists, including when it remains in `.env`.  Otherwise, the generated token persists in `/config` across restarts.

If you left `RIOSOMA_DATABASE_URL` and `RIOSOMA_DATABASE_PROFILE` out, setup asks for the database first and saves the connection on the `/config` volume.  The `postgres` profile alone does not configure Riosoma's connection: use the URL above, or enter host `postgres`, port `5432`, database and user `riosoma`, the generated PostgreSQL password, and disabled TLS in the wizard.  Check where setup stands with `curl --fail http://127.0.0.1:8080/api/setup/status`: `database`, `owner`, or `ready`.  Adjust that address if you changed `RIOSOMA_PUBLISH`.

After creating the owner, the wizard offers optional virus scanning and anonymous usage counts.  Scanning stays off until enabled, and usage counts stay off until the owner opts in.  You can skip these steps and return to Settings later.  With a preset database, `/healthz` answers after migrations finish.  It also answers when setup still needs a database or an owner, so a healthy container does not mean setup is complete.

## The connector service

The `connectors` service runs the sources whose database drivers live outside Riosoma's own image: MySQL, SQL Server, Oracle, Firebird, Snowflake, BigQuery, Databricks, ClickHouse, and MongoDB.  It starts with `docker compose up` like Riosoma does, from the `ghcr.io/adachis/riosoma-connectors` image of the same release, and needs no settings of its own.  Every other kind of source runs inside Riosoma.

It publishes no port.  Riosoma calls it on the internal `connectors` network, which nothing else joins, at `http://connector-service:8091`.  It also sits on the default network, so it reaches databases exactly as Riosoma would, including other containers on that network.  The two share a token that Riosoma generates on its first start and writes to the `connector-token` volume, which the connector service mounts read-only.  To choose the token yourself, set `RIOSOMA_CONNECTOR_SERVICE_TOKEN` in `.env`, and Compose hands it to both.  Source settings and secrets travel to the service only in the body of each call, and it never logs them.

`/healthz` and `/readyz` report it as `connectors`: `ok`, `unavailable` when it doesn't answer, or `refused` when it doesn't accept the token.  Riosoma stays up without it, and only those sources fail, with a message saying the connector service isn't answering.  Check its own log with `docker compose logs connectors`.

## PDF reports and web search

Add `pdf` to your existing `COMPOSE_PROFILES` and set `RIOSOMA_PDF_RENDERER_URL=http://gotenberg:3000`.  Add `search` for SearXNG, set `RIOSOMA_SEARCH_URL=http://search:8080`, and generate `SEARXNG_SECRET` with `openssl rand -hex 32`.  Apply the changes with `docker compose up -d --wait --wait-timeout 600`.  Preserve the other profiles when adding either one.

Gotenberg is isolated on the internal `pdf` network, disables JavaScript, and refuses outside downloads.  SearXNG uses the default network so it can reach search engines.  Neither service publishes a host port.  Merely enabling either profile does not set the corresponding Riosoma URL.  To use your own services instead, leave those profiles out and set the URLs to addresses reachable from the Riosoma container.

For one-click updates, add `updater` and `backup` to the existing profiles, generate `RIOSOMA_UPDATER_TOKEN` with `openssl rand -hex 32`, and restart with `docker compose up -d`.  The updater mounts the Docker socket and the Compose folder, runs as root, and can replace containers.  Enable it only on a host where you trust that access.  It keeps state in `updater-state` and shares an internal network only with Riosoma.  [Updates and the updater](updater.md) describes its backup and rollback checks.

## Virus scanning

Add `clamav` to `COMPOSE_PROFILES` in `.env`, preserving your other profiles, then run `docker compose up -d`.  Or start just the optional sidecar with `docker compose --profile clamav up -d clamav`.  The scanner downloads virus definitions at startup, which can take several minutes.  Definitions persist in `clamav-data`, and port 3310 stays inside the Compose network.  Allow at least 2 GiB of additional memory for the scanner.

In setup, or later at `/settings/files#virus-scanning`, choose Detect scanner.  Riosoma checks `tcp://clamav:3310`, a configured address, and common local sockets.  The harmless EICAR test signature is sent directly from memory over INSTREAM; Riosoma never uploads or saves a test file.  Choose Turn scanning on after the test passes.  You can skip this step and return later.  Owners and organization Security administrators can change the controls, and changes and tests are audited.

New uploads then remain in quarantine until a complete scan passes.  Turning scanning off leaves pending uploads in quarantine.  The bundled stream limit is 2 GiB, replacing the former 1 GiB limit; ClamAV also has an internal limit below 2 GiB.  Files rejected by a stream or engine limit show “too large to scan.”  The default keeps them in quarantine.  The admin setting can allow their downloads, with an explicit unscanned status, without calling them clean.  Riosoma does not split files into independent scans because that would miss signatures and container contents across boundaries.  See [File storage](file-storage.md#resumable-uploads-and-quarantine).

For an existing daemon, the server operator must first approve its `tcp://host:3310` or absolute socket address through `RIOSOMA_CLAMAV_APPROVED_URLS`, a comma-separated list, or `RIOSOMA_CLAMAV_URL`.  Restart the server after changing this configuration, then enter the approved address in file settings.  The Compose sidecar and common sockets under `/run/clamav` and `/var/run/clamav` are approved by default.  An explicit list replaces those defaults, and `RIOSOMA_CLAMAV_URL` is always approved.  A local socket must be mounted where Riosoma can reach it.  Enable `AlertExceedsMax yes` on the daemon so engine-limit failures are reported instead of silently skipped.  Keep its address private because clamd has no client authentication.  `RIOSOMA_CLAMAV_URL` also accepts either address and remains the default until an organization saves its own scanner settings.

## Where settings go

In `.env`.  Runtime settings in the [settings reference](settings.md) pass through to the container when `.env` sets them, including every [email transport](email.md), credential vault controls, `RIOSOMA_ARCHIVE_WORK_DIR`, and `RIOSOMA_HUB_URL`.  For a relay, set `RIOSOMA_MAIL_TRANSPORT=relay`, `RIOSOMA_MAIL_FROM`, `RIOSOMA_MAIL_RELAY_URL`, and `RIOSOMA_MAIL_RELAY_SECRET`.  Keep multiline JSON settings, such as a Gmail service account key, in a single-quoted `.env` value with its newlines preserved.

The listening address, port, version, production mode, config directory, web directory, and theme directory stay at the image's defaults.  Compose also leaves out `RIOSOMA_SMOKE_PROFILE`, which belongs to the standalone cloud database test utility, and `RIOSOMA_UPDATE_FEED_KEYS_FILE`, which replaces trusted release keys for testing only.  Empty or whitespace-only runtime settings use the server defaults or stored values.  Apply changes with `docker compose up -d`, which recreates the containers whose settings changed.  Paths in settings name locations inside the container, so mount any files or directories the server must read through a local `compose.override.yaml`.

`.env` also holds Compose's own variables, which the app never sees:

| Variable | Default | Meaning |
|---|---|---|
| `COMPOSE_PROFILES` | none | Profiles to run, comma-separated |
| `RIOSOMA_IMAGE` | `ghcr.io/adachis/riosoma:0.95.0` | The image.  Pin a release. |
| `RIOSOMA_CONNECTORS_IMAGE` | `ghcr.io/adachis/riosoma-connectors:0.95.0` | The connector service's image.  Pin the same release as `RIOSOMA_IMAGE`. |
| `RIOSOMA_PUBLISH` | `127.0.0.1:8080` | The host address and port for Riosoma |
| `POSTGRES_PASSWORD` | none | The bundled PostgreSQL's password, required with the `postgres` profile |
| `CADDY_DOMAIN` | none | The domain Caddy serves, required with the `caddy` profile |
| `BACKUP_DATABASE_URL` | `RIOSOMA_DATABASE_URL` | What the backups dump.  Set it when that URL carries `pooler=`, which `pg_dump` doesn't know. |
| `BACKUP_TIME` | `03:00` | When the nightly backup runs, in UTC |
| `BACKUP_KEEP_DAYS` | `14` | How many days of backups to keep |
| `SEARXNG_SECRET` | empty | Generate a random secret before enabling `search` |
| `UPDATER_HEALTH_SECONDS` | `600` | How long a new version has to answer `/healthz` before the updater rolls it back |

The `riosoma-config` volume mounts at `/config` and keeps the generated encryption key, setup token, wizard database connection, and installed database drivers.  The `connector-token` volume keeps only the token Riosoma shares with its connector service, which Riosoma writes again if the volume is ever lost.  Attachments use PostgreSQL by default.  If you choose local file storage, add a volume for `RIOSOMA_FILES_DIR` in a `compose.override.yaml` next to `compose.yaml`, and back it up too.  Compose merges this file automatically, and upgrades that replace `compose.yaml` leave it alone.

Caddy and Riosoma use fixed addresses on `172.30.52.0/29`.  That subnet must be free on the Docker host.  To run another installation there, override the subnet and both service addresses together, and match `RIOSOMA_TRUST_PROXY` and `RIOSOMA_TLS_ASK_ADDRESSES` to the new Caddy address.  Changing only the project name does not avoid a subnet collision.

Required settings: `RIOSOMA_BASE_URL`, and the database, either `RIOSOMA_DATABASE_URL` (or `RIOSOMA_DATABASE_PROFILE`) or entered during setup.  With Caddy, also `RIOSOMA_TRUST_PROXY=172.30.52.2`.  `RIOSOMA_SECRET_KEY` is optional here, since the `riosoma-config` volume keeps a generated key.  Setting it in `.env` keeps the key needed to decrypt restored credentials with the other environment settings.  Set it only on a new install, since changing it later makes stored credentials unreadable.

## Backups

With the `backup` profile, a dump runs every night and each is kept for 14 days.  The service needs a PostgreSQL connection URL.  If you configured the database through the wizard or `RIOSOMA_DATABASE_PROFILE`, set `BACKUP_DATABASE_URL` explicitly in `.env`: the backup container cannot read Riosoma's stored profile or cloud identity credentials.  Use your database provider's backup tools when a standalone client cannot authenticate.  To back up right now, and to list what's there:

```bash
docker compose run --rm backup once
docker compose run --rm --entrypoint ls backup -l /backups
```

Each file is a `pg_dump` custom-format archive of the whole database, named like `riosoma-20260928T030000Z.dump`.  Copy them off the machine regularly, for example with `docker compose cp backup:/backups ./riosoma-backups` while the backup service is running.  Keep `.env` and the `riosoma-config` volume with them, especially when setup stored the database connection or the server generated its encryption key.  Back up local attachments separately, and enable versioning or soft delete for object storage.

To restore one, stop Riosoma first.  The restore refuses to run while Riosoma is still connected.  It drops the schemas in the dump before loading the archive in one transaction.  Schema deletion happens outside that transaction, so a failed load leaves those schemas deleted.  Keep the dump and the original secret key available until restoration succeeds.

```bash
docker compose stop riosoma
docker compose run --rm backup restore riosoma-20260928T030000Z.dump
docker compose start riosoma
```

Without the `backup` profile, back up your own PostgreSQL the way you already do.

## Upgrades

Riosoma tells the owner and admins when a new release is out.  With the `updater` profile, the owner updates from Settings, Updates in one click, and the updater backs up first and rolls back if the new version fails.  See [Updates and the updater](updater.md).  To update by hand instead:

Migrations run when the new release starts, so back up first.  See [Upgrades, backups, and rollbacks](upgrades.md) for what happens.

```bash
docker compose run --rm backup once
sed -i.bak -e 's|^RIOSOMA_IMAGE=.*|RIOSOMA_IMAGE=ghcr.io/adachis/riosoma:0.95.0|' \
  -e 's|^RIOSOMA_CONNECTORS_IMAGE=.*|RIOSOMA_CONNECTORS_IMAGE=ghcr.io/adachis/riosoma-connectors:0.95.0|' .env
docker compose pull riosoma connectors
docker compose up -d --wait --wait-timeout 600
docker compose logs riosoma | grep -E 'migrations applied|Server listening'
curl --fail http://127.0.0.1:8080/healthz
```

The `0.6.0` tag above is an example: choose an available release and confirm `/healthz` reports that version.  If you do not use the backup service, take your database provider's backup before updating.  Adjust the health-check address if you changed the published port.  To update the Compose files themselves, `git pull` in the checkout, then use the files from the same release as the image.  Your `.env` and `compose.override.yaml` aren't tracked, so they stay.  Updating from a release before the connector service, update the Compose files first: the older `compose.yaml` has no `connectors` service, so without the new one those sources stop connecting, and the one-click updater refuses the update until it's there.

**Rolling back:** set `RIOSOMA_IMAGE` and `RIOSOMA_CONNECTORS_IMAGE` back to the previous tag.  If the upgrade's log showed `database migrations applied`, restore the backup you took before it, then start the old release:

```bash
docker compose stop riosoma
docker compose run --rm backup restore riosoma-20260928T030000Z.dump
docker compose up -d
```

## Removing it

`docker compose down` stops and removes the containers and keeps the volumes.  `docker compose down --volumes` deletes the volumes too, including the database and its backups, so copy the backups off first.

## Smoke test from a checkout

On a machine with Docker, Bash, and OpenSSL, prepare the theme assets described in [Building from source](from-source.md), then build both local images from the repository root:

```bash
docker build --build-arg RIOSOMA_VERSION=0.0.0-dev -t riosoma:dev .
docker build --build-arg RIOSOMA_VERSION=0.0.0-dev --target connectors -t riosoma-connectors:dev .
tools/install-smoke.sh
```

`RIOSOMA_IMAGE` and `RIOSOMA_CONNECTORS_IMAGE` can name other locally built images, and default to `riosoma:dev` and `riosoma-connectors:dev`.  The script requires both to exist locally, reads the expected version from the Riosoma image's configuration, and refuses a connector service image of another version.  `INSTALL_SMOKE_TIMEOUT_SECONDS` changes the 600-second startup limit.  Docker must be able to pull the bundled PostgreSQL image.  The host needs no JavaScript runtime: the HTTP helper uses the Riosoma image's runtime.

The script copies `deploy/compose` into a private temporary directory, copies `.env.example`, and appends generated database, encryption, and setup secrets.  It starts only Riosoma, its connector service, and PostgreSQL, publishes an ephemeral loopback port, and uses only the automatically allocated default network and the internal `connectors` network to avoid Caddy's fixed-subnet collision.  Every container, network, and volume belongs to a random `riosoma-smoke-` project.  Exit and signal traps stop the stack, remove its volumes, and delete the temporary directory, including after a failed HTTP step.  A cleanup failure reports the project name for recovery.  The locally built image remains.

Progress and failures are printed as `installSmoke.*` message keys, one line per step, without credentials.  The HTTP calls run inside the Riosoma container against its configured base URL.  The flow checks `GET /api/setup/status`, token-authenticated `POST /api/setup/unlock` and `POST /api/setup/owner`, password `POST /api/auth/sign-in`, and `GET /api/auth/session`.  It keeps the returned session cookie and sends `x-csrf-token` with writes.  `POST /api/databases` creates a database with its first table and text field, a `record.create` batch at `POST /api/databases/:databaseId/commands` must report `applied`, and `GET /api/tables/:tableId/records/:recordId` must return the written value.  Finally, `GET /healthz` must report the image's expected version and a connector service that answers.

When Docker is unavailable, build the workspace and run `pnpm --filter @riosoma/server test src/setup/install-smoke.test.ts --maxWorkers=3`.  That test runs the same helper against real HTTP routes and a fresh PostgreSQL database, and checks that a rejected setup token stops the flow before any owner or data is created.  It verifies payloads, cookies, CSRF, setup completion, command results, record readback, and version checks.  It does not validate the image, volumes, published port, or Compose startup.  Those need the live script run above.

## Custom public domains

See [Custom domains](custom-domains.md) for DNS verification, certificate issuance, proxy isolation, and removal.  Keep the main app on `RIOSOMA_BASE_URL`.
