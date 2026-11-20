# Running from source

Riosoma runs straight from a checkout with Node, no container needed: for development, or on a host where containers aren't an option.  The server serves the built web app itself, on one port.

## Prerequisites

- Node 24 or later
- pnpm 11.22 (`npm install -g pnpm@11.22.0`)
- git
- PostgreSQL 14 or later, on this host or reachable from it
- About 4 GB of memory for the build, and 1 GB to run

## Build

Check out a release tag, not a branch, so you know what you're running:

```bash
git clone https://github.com/adachis/riosoma.git
cd riosoma
git checkout v0.95.0-rc.1
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@riosoma/server... --filter=@riosoma/web
```

That builds the server, the packages it uses, its connector service, and the web app into `apps/server/dist`, `apps/connector-service/dist`, and `apps/web/dist`. Theme fonts and textures aren't in git. Without them the themes fall back to system fonts. `node tools/release/fetch-theme-assets.mjs 0.95.0-rc.1` downloads and verifies the optional asset bundle for this release.

## The database

Create an account and a database for Riosoma, as a PostgreSQL superuser:

```bash
sudo -u postgres createuser --pwprompt riosoma
sudo -u postgres createdb --owner riosoma riosoma
```

See [Connecting the database](database.md) for TLS, remote servers, and profiles.

## Run it

`RIOSOMA_CONFIG_DIR` defaults to `/config`, which a normal account can't write, so point it at a directory of Riosoma's own:

```bash
mkdir -p -m 700 "$HOME/.local/share/riosoma"
export RIOSOMA_CONFIG_DIR="$HOME/.local/share/riosoma"
export RIOSOMA_DATABASE_URL='postgres://riosoma:PASSWORD@localhost:5432/riosoma?sslmode=disable'
export RIOSOMA_BASE_URL=http://localhost:8080
node apps/server/dist/main.js
```

The server starts its connector service itself, as a process of its own, which runs the MySQL, SQL Server, Oracle, Firebird, Snowflake, BigQuery, Databricks, ClickHouse, and MongoDB sources.  It listens on a port of this machine the system picks, with a token made for each run, and stops when the server does.  If it stops on its own, the next source that needs it starts it again.  To run it apart instead, start `node apps/connector-service/dist/main.js` with `RIOSOMA_CONNECTOR_SERVICE_TOKEN` set, and give the server `RIOSOMA_CONNECTOR_SERVICE_URL` (`http://127.0.0.1:8091` unless you set `RIOSOMA_CONNECTOR_SERVICE_PORT`) and the same token.

The server listens on port 8080 on all addresses.  Set `RIOSOMA_PORT` and `RIOSOMA_HOST` to change that, for example `RIOSOMA_HOST=127.0.0.1` behind a proxy on the same machine.  Logs are JSON lines on standard output.

## First-run setup

The server prints the setup link when it starts:

```
{"level":40,...,"msg":"Finish setting up Riosoma at http://localhost:8080/setup#token=..."}
```

Open it and create the owner account.  With `RIOSOMA_DATABASE_URL` left out, setup asks for the database first.  `curl -s http://localhost:8080/api/setup/status` reports where setup stands.

## Running it as a service

On Linux with systemd, run it as its own account.  Put the checkout in `/opt/riosoma`, owned by root and readable by all, and the settings in an environment file:

```bash
sudo useradd --system --home-dir /var/lib/riosoma --shell /usr/sbin/nologin riosoma
sudo install -d -m 700 /etc/riosoma
sudo tee /etc/riosoma/riosoma.env >/dev/null <<'EOF'
RIOSOMA_CONFIG_DIR=/var/lib/riosoma
RIOSOMA_HOST=127.0.0.1
RIOSOMA_BASE_URL=https://riosoma.example.com
RIOSOMA_TRUST_PROXY=loopback
RIOSOMA_DATABASE_URL=postgres://riosoma:PASSWORD@localhost:5432/riosoma?sslmode=disable
EOF
sudo chmod 600 /etc/riosoma/riosoma.env
```

`/etc/systemd/system/riosoma.service`, with `ExecStart` pointing at your Node (`command -v node`):

```ini
[Unit]
Description=Riosoma
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=riosoma
Group=riosoma
WorkingDirectory=/opt/riosoma
EnvironmentFile=/etc/riosoma/riosoma.env
ExecStart=/usr/bin/node apps/server/dist/main.js
Restart=on-failure
StateDirectory=riosoma
StateDirectoryMode=0700
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now riosoma
journalctl -u riosoma | grep "Finish setting up"
```

Put a proxy that handles HTTPS in front of `127.0.0.1:8080`, such as Caddy (`caddy reverse-proxy --from riosoma.example.com --to 127.0.0.1:8080`) or nginx.  `RIOSOMA_TRUST_PROXY=loopback` trusts it because it connects from the same machine.

## Where settings go

Environment variables: the shell's, or `/etc/riosoma/riosoma.env` for the service, then restart.  Every setting is in the [settings reference](settings.md).  Required: `RIOSOMA_CONFIG_DIR`, since the default isn't writable outside a container, and `RIOSOMA_BASE_URL`.  The database comes from `RIOSOMA_DATABASE_URL` (or `RIOSOMA_DATABASE_PROFILE`), or from setup, which stores it in the config directory.  `RIOSOMA_TRUST_PROXY` is required behind a proxy.

The config directory holds the generated `RIOSOMA_SECRET_KEY`, so it must survive restarts and be backed up.  Or set `RIOSOMA_SECRET_KEY` yourself on a new install.

## Backups

Dump the database with `pg_dump` 14 or later, from a timer or cron:

```bash
pg_dump --format=custom --dbname="$RIOSOMA_DATABASE_URL" --file=riosoma-$(date -u +%Y%m%dT%H%M%SZ).dump
```

Back up the config directory (or keep `RIOSOMA_SECRET_KEY`) with it.

## Upgrades

Back up, then check out the new tag, rebuild, and restart.  Migrations run when the server starts.  See [Upgrades, backups, and rollbacks](upgrades.md).

```bash
pg_dump --format=custom --dbname="$RIOSOMA_DATABASE_URL" --file=riosoma-before-0.95.0-rc.1.dump
git fetch --tags && git checkout v0.95.0-rc.1
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@riosoma/server... --filter=@riosoma/web
sudo systemctl restart riosoma
journalctl -u riosoma --since '5 minutes ago' | grep -E 'migrations applied|Server listening'
```

**Rolling back:** check out the previous tag, rebuild, and restart.  If the upgrade's log showed `database migrations applied`, stop the service and restore the dump first, after dropping Riosoma's schemas so tables the newer release added don't linger:

```bash
sudo systemctl stop riosoma
psql "$RIOSOMA_DATABASE_URL" -c 'DROP SCHEMA IF EXISTS rio_app, rio_data, rio_audit CASCADE'
pg_restore --clean --if-exists --no-owner --dbname="$RIOSOMA_DATABASE_URL" riosoma-before-0.95.0-rc.1.dump
```
