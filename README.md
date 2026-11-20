# Riosoma

Riosoma is a self-hosted database platform in the spirit of Airtable, with spreadsheet-like tables on your own PostgreSQL, views, formulas, automations, interfaces, and an AI assistant named Rio.  Data Source syncs and joins data from other systems, with local overrides that let you keep your own values without changing the source.

![Riosoma home screen](docs/media/home.png)

The screenshot is a placeholder.

## Try it in five minutes

You need Git, Docker Engine with Compose 2.24 or newer, about 2 GB of memory, and a few GB of free disk space.  The first image download may take longer on a slow connection.

1. Get the repository and open the Compose directory:

   ```sh
   git clone https://github.com/adachis/riosoma.git
   cd riosoma/deploy/compose
   ```

2. Create local settings.  This starts Riosoma and its own PostgreSQL on your machine:

   ```sh
   DB_PASSWORD=$(openssl rand -hex 24)
   cat > .env <<EOF
   COMPOSE_PROFILES=postgres
   RIOSOMA_BASE_URL=http://localhost:8080
   POSTGRES_PASSWORD=$DB_PASSWORD
   RIOSOMA_DATABASE_URL=postgres://riosoma:$DB_PASSWORD@postgres:5432/riosoma?sslmode=disable
   EOF
   chmod 600 .env
   docker compose up -d
   docker compose logs riosoma
   ```

3. Open the setup link printed in the log, create the owner account, and make your first database.  Riosoma is then available at <http://localhost:8080>.

The [Docker Compose guide](docs/install/docker-compose.md) covers pinning a published image, using an existing PostgreSQL server, HTTPS, backups, and upgrades.  Before exposing an instance to other people, follow its HTTPS and backup steps.  Keep the database and the config volume together in your backups.

## What you can do

### Organize and explore data

- Create tables with typed fields, attachments, linked records, lookups, rollups, and formulas.  Reuse formulas with named functions.
- Read the same records in grid, list, Kanban, gallery, calendar, timeline, Gantt, map, chart, pivot, and organization chart views.  Filter, sort, group, and apply conditional colors where the view supports them.
- Import existing data, download records, inspect change history, and undo edits.  Copy databases or keep snapshots.

See the [table guide](docs/modules/databases/databases-and-tables/en-US.md), [views](docs/modules/databases/views/en-US.md), and [formulas](docs/modules/databases/formulas/en-US.md).

### Bring other systems together

- Connect Data Source to SQL databases, warehouses, document databases, spreadsheets, files, APIs, and feeds.  Some connectors require credentials or separately installed drivers.
- Sync records into tables, or read supported sources live.  Join tables with inner, left, or full joins.
- Pin a local override while keeping the source value and sync history available.  Clear the override to follow the source again.

Start with [connections](docs/modules/data-sources/connections/en-US.md), [synced tables](docs/modules/databases/synced-tables/en-US.md), and [joined tables](docs/modules/data-sources/joined-tables/en-US.md).

### Build workflows and useful screens

- Collect records with forms, and arrange interfaces and dashboards for the people using your data.
- Create automations with record, schedule, webhook, or button triggers.  Test a draft before publishing it.
- Schedule reports, send webhooks, and connect through the REST API, JavaScript SDK, or command-line tool.

Read about [interfaces](docs/modules/databases/interfaces/en-US.md), [automations](docs/modules/databases/automations/en-US.md), and the [REST API](docs/modules/administration/rest-api/en-US.md).

### Work with Rio

- Ask questions about records, find and count data, and propose tables, views, dashboards, interfaces, and automation drafts.
- Review proposed changes, apply them with your permissions, and undo supported changes from their receipts.
- Add knowledge libraries and use AI fields when your organization enables AI and configures a provider.

Rio requires a configured AI provider.  Provider charges and data handling depend on that configuration.  The [Rio guide](docs/modules/rio/asking-rio/en-US.md) explains permissions and approvals.

### Share and administer

- Share databases with roles, field and record permissions, and public view links.
- Use passkeys, two-step sign-in, OIDC or SAML single sign-on, and SCIM provisioning.
- Manage organization units, audit history, retention, file storage, and server settings.

See [sharing](docs/modules/databases/sharing/en-US.md) and [administration](docs/modules/administration/admin-roles-and-audit/en-US.md).

## About v0.95

v0.95 is the feature-complete preview before 1.0.  It is the first public build, and behavior may still change as people try it and report problems.  It is English only for now.  Translation catalogs are present, but translations are incomplete.

Use the [changelog](CHANGELOG.md) to see what 0.95.0 contains, and read the [upgrade guide](docs/install/upgrades.md) before changing versions.

## Install and learn

Riosoma needs PostgreSQL 14 or newer.  A source build also needs Node 24 or newer, pnpm 11.22, and about 4 GB of memory for the build.  Plan storage and backups around your records and attachments.

- [All install guides](docs/install/README.md), including [Docker Compose](docs/install/docker-compose.md), [Kubernetes](docs/install/kubernetes.md), and [running from source](docs/install/from-source.md)
- [Getting started](docs/modules/getting-started/welcome/en-US.md) and the [in-app help topics](docs/modules/)
- [Server settings](docs/install/settings.md) and [database connections](docs/install/database.md)
- [Contributing](CONTRIBUTING.md), [security policy](SECURITY.md), and [third-party notices](THIRD_PARTY_NOTICES.md)

Report bugs in [GitHub Issues](https://github.com/adachis/riosoma/issues).  Include the version, install method, steps to reproduce, expected behavior, and actual behavior.  Remove credentials and private data from logs and screenshots.  Report vulnerabilities privately using the [security policy](SECURITY.md).

## License

Riosoma is source-available under the [Nice People License 1.0](LICENSE).  Eligible users may self-host it, modify it, create new versions, and share modified or unmodified copies with anyone, free of charge, with the license and copyright notices.  A modified version must say it was changed and use its own name and branding.  Nobody may sell Riosoma or a modified version, charge for access to it or use of it, or host it for others.  The license also restricts substantial code reuse in other products, harmful conduct, and political use.  What you create with Riosoma remains yours, subject to existing rights in incorporated code and third-party material.  Read the license for the full terms and the separate MPL-2.0 terms for the EcoLogits port.
