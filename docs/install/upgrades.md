# Upgrades, backups, and rollbacks

An upgrade is a new image tag, for Riosoma and its connector service alike, which always run the same release.  There's no separate migration step: the server brings the database up to date itself when it starts.  The connector service keeps no data, so it changes over with no migration or backup of its own.

The owner and admins see a notice in the app when a new release is out, with its notes and the steps for your kind of install.  With Docker Compose and the updater, the owner updates in one click, with a backup first and a rollback if the new version fails.  See [Updates and the updater](updater.md).

## What happens when a new release starts

1. The server waits for an unreachable database with exponential backoff, starting at 1 second, within a 120-second connection budget by default.  `RIOSOMA_DATABASE_WAIT_SECONDS` changes the budget, and `0` disables retries.  Authentication and configuration errors stop immediately.  The server then connects to the database and runs every migration it has that the database doesn't, in order, before it starts listening.  Until they finish, `/healthz` doesn't answer, so readiness checks hold traffic back.
2. Each migration runs in its own transaction under an advisory lock, so a failure rolls that migration back cleanly and two replicas starting at once never apply the same one twice.  Each has up to 10 minutes.
3. If any ran, the log says so, with their names: `"msg":"database migrations applied"` and an `applied` list.  No such line means the release changed nothing in the database.
4. `/healthz` then reports the new version.

Migrations only go forward.  A release never undoes one, and the server refuses to start if the database contains migrations it does not know.  The error explains that a newer Riosoma upgraded the database and asks you to run that version or restore the backup taken before upgrading.  Keep a backup before every upgrade.

You can skip releases.  Every migration in between runs, in order.

## Before every upgrade

1. **Back up the database**, and note which backup it is.  Each guide shows its platform's way: a snapshot, an on-demand backup, or `pg_dump`.
2. **Keep the secret key.**  If `RIOSOMA_SECRET_KEY` isn't set, it lives in `/config/riosoma.config.json`, so make sure that volume is backed up too.
3. **Read the release notes** for anything the release asks of you.

## Upgrading

Change the image tag and restart, the way each guide shows, for the connector service's image too.  Upgrading from a release before the connector service, take that release's Compose file, Helm chart, or task definition as well, since the older ones don't run the service, and the MySQL, SQL Server, Oracle, Firebird, Snowflake, BigQuery, Databricks, ClickHouse, and MongoDB sources need it.  Where the platform allows, stop the old release before the new one starts, so two releases never run against the same database: the Helm chart's `Recreate` strategy, Compose's `up -d`, and ECS with a minimum healthy percent of 0 all do.  Container Apps and Cloud Run switch revisions without a gap, so there the old release keeps serving for a moment after the new one's migrations run.  Then check the log for the migrations line and `/healthz` for the version.

## Rolling back

Which rollback you need depends on whether the upgrade changed the database.

**No migrations ran** (no `database migrations applied` line when the new release started): point back at the previous image tag and restart.  Nothing else changes.

**Migrations ran**: a server with the migration guard refuses the newer database before serving traffic.  Run the version that upgraded it, or restore before starting the older image.  Releases from before this guard still need the same restore procedure.

1. Stop Riosoma, so nothing writes to the database.
2. Restore the backup you took before the upgrade.  Anything people changed since then is lost, so export anything you need first.
3. Start the previous image tag.

Restoring into the same database with `pg_restore` works when you first drop Riosoma's schemas (`rio_app`, `rio_data`, and `rio_audit` unless you renamed them in a database profile), so tables a newer release added don't outlive the restore.  The Compose backup profile's `restore` command does exactly that.  A managed database's point-in-time restore or snapshot restore usually makes a new server instead, so point `RIOSOMA_DATABASE_URL` or `RIOSOMA_DATABASE_PROFILE` at it afterward.

| Where | Back up | Go back to an image | Restore |
|---|---|---|---|
| [Docker Compose](docker-compose.md#upgrades) | `docker compose run --rm backup once` | `RIOSOMA_IMAGE` and `RIOSOMA_CONNECTORS_IMAGE` in `.env` | `docker compose run --rm backup restore FILE` |
| [Kubernetes](kubernetes.md#upgrades) | Your database's snapshots, or `pg_dump` | `helm rollback` | Your database's restore, or `pg_restore` |
| [Container Apps](azure-container-apps.md#upgrades) | Note the time for point-in-time restore | `az containerapp update --image` | `az postgres flexible-server restore` |
| [ECS on Fargate](aws-ecs-fargate.md#upgrades) | `aws rds create-db-snapshot` | `aws ecs update-service --task-definition` | `aws rds restore-db-instance-from-db-snapshot` |
| [Cloud Run](google-cloud-run.md#upgrades) | `gcloud sql backups create` | `gcloud run services update-traffic` | `gcloud sql backups restore` |
| [From source](from-source.md#upgrades) | `pg_dump` | `git checkout` the previous tag and rebuild | `pg_restore` |

## Backups in general

- With `RIOSOMA_FILES_STORAGE` at its default of `postgres`, attachments are in the database, so a database backup is complete.  With `local`, back up `RIOSOMA_FILES_DIR` at the same time.  With `s3` or `azure-blob`, turn on the bucket's or container's versioning or soft delete, so a restored database finds the files it names.
- A backup is only as good as the secret key that goes with it.  Keep `RIOSOMA_SECRET_KEY`, or `/config`, somewhere other than the server.
- `pg_dump` from PostgreSQL 18 can dump every supported server (14 and later).  Restore with the same or a newer `pg_restore`.
