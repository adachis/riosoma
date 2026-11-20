# Azure Container Apps with Azure Database for PostgreSQL

Riosoma runs as a container app, and its database is an Azure Database for PostgreSQL flexible server on a private network.  Both share one virtual network, so the database has no public address.

## Prerequisites

- An Azure subscription where you can create resource groups, networks, and role assignments
- Azure CLI 2.62 or later, signed in (`az login`) and set to that subscription (`az account set --subscription ...`), with the Container Apps extension: `az extension add --name containerapp --upgrade`
- `openssl` for generating secrets
- The commands are for bash

Register the resource providers once per subscription:

```bash
az provider register --namespace Microsoft.App --wait
az provider register --namespace Microsoft.OperationalInsights --wait
az provider register --namespace Microsoft.DBforPostgreSQL --wait
```

## Install

Choose names.  The database server's name must be unique across Azure.

```bash
RG=riosoma
LOCATION=eastus2
PG=riosoma-db-$RANDOM
ENVIRONMENT=riosoma-env
APP=riosoma
IMAGE=ghcr.io/adachis/riosoma:0.95.0-rc.1
CONNECTORS_IMAGE=ghcr.io/adachis/riosoma-connectors:0.95.0-rc.1
DB_PASSWORD=$(openssl rand -hex 24)
SECRET_KEY=$(openssl rand -base64 32)
CONNECTOR_TOKEN=$(openssl rand -hex 32)
```

Keep `SECRET_KEY` somewhere safe outside Azure too.  It seals the credentials Riosoma stores, and a restore needs it.

**The network.**  One subnet for the Container Apps environment and one for the database, each delegated to its service:

```bash
az group create --name $RG --location $LOCATION
az network vnet create -g $RG -n riosoma-vnet --address-prefixes 10.40.0.0/16
az network vnet subnet create -g $RG --vnet-name riosoma-vnet -n apps \
  --address-prefixes 10.40.0.0/23 --delegations Microsoft.App/environments
az network vnet subnet create -g $RG --vnet-name riosoma-vnet -n db \
  --address-prefixes 10.40.2.0/24 --delegations Microsoft.DBforPostgreSQL/flexibleServers
```

**The database.**  A private server in the `db` subnet.  The CLI makes a private DNS zone for it and links it to the network.  Backups are kept for 14 days with point-in-time restore.

```bash
az postgres flexible-server create -g $RG -n $PG -l $LOCATION \
  --version 16 --tier Burstable --sku-name Standard_B2s --storage-size 32 \
  --admin-user riosoma --admin-password "$DB_PASSWORD" \
  --vnet riosoma-vnet --subnet db --backup-retention 14 --yes
az postgres flexible-server db create -g $RG --server-name $PG --name riosoma
```

Its certificate comes from a public authority, so Riosoma can verify it fully:

```bash
DATABASE_URL="postgres://riosoma:$DB_PASSWORD@$PG.postgres.database.azure.com:5432/riosoma?sslmode=verify-full"
```

**The environment**, in the `apps` subnet.  It sends logs to a new Log Analytics workspace.

```bash
APPS_SUBNET=$(az network vnet subnet show -g $RG --vnet-name riosoma-vnet -n apps --query id -o tsv)
az containerapp env create -g $RG -n $ENVIRONMENT -l $LOCATION \
  --infrastructure-subnet-resource-id "$APPS_SUBNET"
```

**The app.**  One replica, always on, since automations, webhooks, scheduled reports, and syncs run inside the server.  Secrets go in the app's secret store and reach the container through `secretref:`.

```bash
az containerapp create -g $RG -n $APP --environment $ENVIRONMENT \
  --image $IMAGE --target-port 8080 --ingress external \
  --cpu 1 --memory 2Gi --min-replicas 1 --max-replicas 1 \
  --secrets secret-key="$SECRET_KEY" database-url="$DATABASE_URL" connector-token="$CONNECTOR_TOKEN" \
  --env-vars RIOSOMA_SECRET_KEY=secretref:secret-key RIOSOMA_DATABASE_URL=secretref:database-url \
    RIOSOMA_TRUST_PROXY=1 RIOSOMA_CONNECTOR_SERVICE_URL=http://127.0.0.1:8091 \
    RIOSOMA_CONNECTOR_SERVICE_TOKEN=secretref:connector-token
FQDN=$(az containerapp show -g $RG -n $APP --query properties.configuration.ingress.fqdn -o tsv)
az containerapp update -g $RG -n $APP --set-env-vars RIOSOMA_BASE_URL=https://$FQDN
```

The app is now at `https://$FQDN`, with a certificate Azure manages.  Container Apps ends TLS in front of the container, which is why `RIOSOMA_TRUST_PROXY` is `1`.

**The connector service**, a second container in the same app, runs the MySQL, SQL Server, Oracle, Firebird, Snowflake, BigQuery, Databricks, ClickHouse, and MongoDB sources.  Containers in one app share a loopback address, so Riosoma reaches it at `127.0.0.1:8091`, where nothing outside the app can, with the token both read from the app's secrets.  The CLI adds a container from YAML:

```bash
az containerapp show -g $RG -n $APP -o yaml > app.yaml
# Add this to properties.template.containers in app.yaml, beside the riosoma container:
#   - name: connectors
#     image: ghcr.io/adachis/riosoma-connectors:0.95.0-rc.1
#     resources: { cpu: 0.5, memory: 1Gi }
#     env:
#       - { name: RIOSOMA_CONNECTOR_SERVICE_HOST, value: 127.0.0.1 }
#       - { name: RIOSOMA_CONNECTOR_SERVICE_TOKEN, secretRef: connector-token }
az containerapp update -g $RG -n $APP --yaml app.yaml
rm app.yaml
curl -s https://$FQDN/healthz   # reports "connectors":"ok" once it answers
```

`app.yaml` holds the app's secrets, so delete it afterward, as above.  The app's resources grow by the container's, which the environment's workload profile has to allow.

## First-run setup

```bash
az containerapp logs show -g $RG -n $APP --type console --tail 300 | grep "Finish setting up"
```

Open the link and create the owner account.  The container's file system doesn't outlast a restart, so the setup token is new each time the app restarts, and the link in the newest log is the one that works.  Check where setup stands at `https://$FQDN/api/setup/status`.

## Your own domain

Point a CNAME for your domain at `$FQDN` and add the TXT record the first command asks for, then bind a free managed certificate and move the base URL over:

```bash
az containerapp hostname add -g $RG -n $APP --hostname riosoma.example.com
az containerapp hostname bind -g $RG -n $APP --hostname riosoma.example.com \
  --environment $ENVIRONMENT --validation-method CNAME
az containerapp update -g $RG -n $APP --set-env-vars RIOSOMA_BASE_URL=https://riosoma.example.com
```

## Where settings go

- Settings that aren't secret: `az containerapp update -g $RG -n $APP --set-env-vars NAME=value`.
- Secret settings: store the value with `az containerapp secret set -g $RG -n $APP --secrets name=value`, then point the setting at it with `--set-env-vars NAME=secretref:name`.

Each change makes a new revision, which restarts the app.  Every setting is in the [settings reference](settings.md).

Required here: `RIOSOMA_DATABASE_URL` (or `RIOSOMA_DATABASE_PROFILE`), `RIOSOMA_SECRET_KEY`, `RIOSOMA_BASE_URL`, and `RIOSOMA_TRUST_PROXY`.  The container's `/config` isn't persistent, which is fine once those are set: it then holds only the setup token.  To use email, add `RIOSOMA_SMTP_URL` as a secret and `RIOSOMA_MAIL_FROM` as a plain setting.  In Azure, `RIOSOMA_MAIL_TRANSPORT=acs` with `RIOSOMA_ACS_ENDPOINT` and the container's managed identity needs no secret either.  See [Email](email.md).

To sign in to the database with a managed identity instead of a password, see [Connecting the database](database.md#azure-database-for-postgresql-with-a-managed-identity).

## Backups

The flexible server backs itself up daily and keeps 14 days of point-in-time restore, as created above.  Riosoma keeps attachments in the database by default, so that covers them.  Keep `SECRET_KEY` with your records.

## Upgrades

Take an on-demand backup, then change the image.  Migrations run when the new revision starts.  See [Upgrades, backups, and rollbacks](upgrades.md).

```bash
az postgres flexible-server backup create -g $RG --server-name $PG --name before-0-6-0
az containerapp update -g $RG -n $APP --container-name connectors --image ghcr.io/adachis/riosoma-connectors:0.95.0-rc.1
az containerapp update -g $RG -n $APP --container-name riosoma --image ghcr.io/adachis/riosoma:0.95.0-rc.1
az containerapp logs show -g $RG -n $APP --container riosoma --type console --tail 300 | grep -E 'migrations applied|Server listening'
curl -s https://$FQDN/healthz
```

Container Apps keeps the old revision serving until the new one is ready, so both run for a moment during the switch.

**Rolling back:** run the same two `az containerapp update` commands with the previous release.  If the upgrade's log showed `database migrations applied`, restore the database to a moment before the upgrade first.  A restore makes a new server, in the same network, so point the app at it:

```bash
az postgres flexible-server restore -g $RG --name $PG-restored --source-server $PG \
  --restore-time 2026-09-28T02:55:00Z
az containerapp secret set -g $RG -n $APP --secrets \
  database-url="postgres://riosoma:$DB_PASSWORD@$PG-restored.postgres.database.azure.com:5432/riosoma?sslmode=verify-full"
az containerapp update -g $RG -n $APP --container-name riosoma --image ghcr.io/adachis/riosoma:0.95.0-rc.1
```

## Removing it

`az group delete --name $RG` deletes the app, the database, and its backups.  Export anything you need first.
