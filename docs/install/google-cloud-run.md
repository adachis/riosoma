# Google Cloud Run with Cloud SQL

Riosoma runs as a Cloud Run service, and its database is a Cloud SQL for PostgreSQL instance with only a private address.  The service reaches it over the VPC through Direct VPC egress, and secrets live in Secret Manager.

## Before you choose Cloud Run

- **Uploads over 32 MB fail.**  Cloud Run caps HTTP/1 request bodies at 32 MiB, and Riosoma serves HTTP/1, so attachments and imports larger than that can't reach it.  If people will upload big files, use one of the other guides.
- **It must stay on.**  Automations, webhooks, scheduled reports, and syncs run inside the server between requests, so the service runs one instance at all times with CPU always allocated (instance-based billing).
- **Live updates reconnect.**  Cloud Run ends every request, WebSocket connections included, at the service's timeout.  This guide sets the longest, 60 minutes, and the app reconnects on its own.

## Prerequisites

- A Google Cloud project with billing, and the `gcloud` CLI signed in to it (`gcloud auth login`, `gcloud config set project PROJECT`)
- Docker, to copy the image into Artifact Registry, since Cloud Run can't pull from `ghcr.io`
- `openssl`
- The commands are for bash

## Install

```bash
PROJECT=$(gcloud config get-value project)
REGION=us-central1
VERSION=0.95.0
REPO=$REGION-docker.pkg.dev/$PROJECT/riosoma
gcloud services enable run.googleapis.com sqladmin.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com servicenetworking.googleapis.com compute.googleapis.com
```

**The images.**  Copy the `linux/amd64` images of Riosoma and its connector service into a repository of your own:

```bash
gcloud artifacts repositories create riosoma --repository-format=docker --location=$REGION
gcloud auth configure-docker $REGION-docker.pkg.dev
for image in riosoma riosoma-connectors; do
  docker pull --platform linux/amd64 ghcr.io/adachis/$image:$VERSION
  docker tag ghcr.io/adachis/$image:$VERSION $REPO/$image:$VERSION
  docker push $REPO/$image:$VERSION
done
```

**Private services access**, once per VPC network, so Cloud SQL can have an address in it.  This uses the `default` network:

```bash
gcloud compute addresses create google-managed-services-default --global \
  --purpose=VPC_PEERING --prefix-length=16 --network=default
gcloud services vpc-peerings connect --service=servicenetworking.googleapis.com \
  --ranges=google-managed-services-default --network=default
```

**The database.**  A private instance that accepts only encrypted connections, with daily backups kept 14 days and point-in-time recovery:

```bash
DB_PASSWORD=$(openssl rand -hex 24)
gcloud sql instances create riosoma --database-version=POSTGRES_16 --edition=ENTERPRISE \
  --tier=db-custom-1-3840 --region=$REGION --network=default --no-assign-ip \
  --ssl-mode=ENCRYPTED_ONLY --backup-start-time=03:00 --retained-backups-count=14 \
  --enable-point-in-time-recovery
gcloud sql databases create riosoma --instance=riosoma
gcloud sql users create riosoma --instance=riosoma --password="$DB_PASSWORD"
DB_IP=$(gcloud sql instances describe riosoma --format='value(ipAddresses[0].ipAddress)')
```

Cloud SQL signs with its own authority, so the URL asks for encryption without checking the certificate (`sslmode=require`), inside your own network.  To verify it too, use a database profile with the instance's certificate authority as `caPem` (see [Connecting the database](database.md)).

**The secrets and the service account.**  Keep a copy of the secret key outside Google Cloud too.  It seals the credentials Riosoma stores, and a restore needs it.

```bash
printf %s "$(openssl rand -base64 32)" | gcloud secrets create riosoma-secret-key --data-file=-
printf %s "postgres://riosoma:$DB_PASSWORD@$DB_IP:5432/riosoma?sslmode=require" \
  | gcloud secrets create riosoma-database-url --data-file=-
printf %s "$(openssl rand -hex 32)" | gcloud secrets create riosoma-connector-token --data-file=-
gcloud iam service-accounts create riosoma --display-name=Riosoma
SA=riosoma@$PROJECT.iam.gserviceaccount.com
for secret in riosoma-secret-key riosoma-database-url riosoma-connector-token; do
  gcloud secrets add-iam-policy-binding $secret \
    --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
done
```

**The service.**  One instance, always on, on the `default` network so it can reach the database.  The connector service, which runs the MySQL, SQL Server, Oracle, Firebird, Snowflake, BigQuery, Databricks, ClickHouse, and MongoDB sources, is a sidecar in the same instance, so Riosoma reaches it at `127.0.0.1:8091`, where nothing outside the instance can, and both read their shared token from Secret Manager.  Flags after each `--container` belong to that container:

```bash
gcloud run deploy riosoma --region=$REGION --service-account=$SA \
  --min-instances=1 --max-instances=1 --no-cpu-throttling --timeout=3600 \
  --network=default --subnet=default --vpc-egress=private-ranges-only --allow-unauthenticated \
  --container=riosoma --image=$REPO/riosoma:$VERSION --port=8080 --cpu=1 --memory=2Gi \
  --startup-probe=httpGet.path=/readyz,httpGet.port=8080,periodSeconds=10,failureThreshold=24,timeoutSeconds=5 \
  --liveness-probe=httpGet.path=/healthz,httpGet.port=8080,periodSeconds=30,timeoutSeconds=5 \
  --set-secrets=RIOSOMA_SECRET_KEY=riosoma-secret-key:latest,RIOSOMA_DATABASE_URL=riosoma-database-url:latest,RIOSOMA_CONNECTOR_SERVICE_TOKEN=riosoma-connector-token:latest \
  --set-env-vars=RIOSOMA_TRUST_PROXY=1,RIOSOMA_CONNECTOR_SERVICE_URL=http://127.0.0.1:8091 \
  --container=connectors --image=$REPO/riosoma-connectors:$VERSION --cpu=1 --memory=1Gi \
  --set-secrets=RIOSOMA_CONNECTOR_SERVICE_TOKEN=riosoma-connector-token:latest \
  --set-env-vars=RIOSOMA_CONNECTOR_SERVICE_HOST=127.0.0.1
URL=$(gcloud run services describe riosoma --region=$REGION --format='value(status.url)')
gcloud run services update riosoma --region=$REGION --container=riosoma --update-env-vars=RIOSOMA_BASE_URL=$URL
```

Cloud Run reserves some paths that end in `z`, so `/healthz` and `/readyz` don't answer from outside.  The probes above call them inside the instance instead, and Cloud Run sends traffic to a new revision only once `/readyz` reports the database reachable.  To check the service, look for a ready revision:

```bash
gcloud run services describe riosoma --region=$REGION --format='value(status.latestReadyRevisionName)'
```

`--allow-unauthenticated` lets anyone reach the sign-in page, which is what a web app needs.  Riosoma handles its own sign-in.  Cloud Run ends TLS in front of the container, which is why `RIOSOMA_TRUST_PROXY` is `1`.

## First-run setup

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="riosoma" AND jsonPayload.msg:"Finish setting up"' \
  --limit=1 --format='value(jsonPayload.msg)'
```

Open the link and create the owner account.  The instance's file system doesn't outlast it, so each new instance makes a new setup token, and the newest link is the one that works.  Check where setup stands at `$URL/api/setup/status`.

For your own domain, map it with a global external Application Load Balancer in front of the service, or with Cloud Run domain mapping where your region offers it, then set `RIOSOMA_BASE_URL` to it.

## Where settings go

- Settings that aren't secret: `gcloud run services update riosoma --region=$REGION --update-env-vars=NAME=value`.
- Secret settings: a Secret Manager secret the service account can read, attached with `--update-secrets=NAME=secret-name:latest`.

Each change deploys a new revision.  Every setting is in the [settings reference](settings.md).  Required here: `RIOSOMA_DATABASE_URL` (or `RIOSOMA_DATABASE_PROFILE`), `RIOSOMA_SECRET_KEY`, `RIOSOMA_BASE_URL`, and `RIOSOMA_TRUST_PROXY`.  The container's `/config` lives in memory, which is fine once those are set: it then holds only the setup token.  To use email, add `RIOSOMA_SMTP_URL` as a secret and `RIOSOMA_MAIL_FROM` as a plain setting.  With a Google Workspace domain, `RIOSOMA_MAIL_TRANSPORT=gmail` sends as one of its mailboxes instead.  See [Email](email.md).

To sign in to Cloud SQL with the service account instead of a password, see [Connecting the database](database.md#cloud-sql-with-iam).

## Backups

Cloud SQL backs up daily and keeps 14 backups, with point-in-time recovery, as created above.  Riosoma keeps attachments in the database by default, so that covers them.  Keep the secret key with your records.

## Upgrades

Back up, copy the new images, and deploy them.  Migrations run when the new revision starts.  See [Upgrades, backups, and rollbacks](upgrades.md).

```bash
VERSION=0.95.0
gcloud sql backups create --instance=riosoma --description="before $VERSION"
for image in riosoma riosoma-connectors; do
  docker pull --platform linux/amd64 ghcr.io/adachis/$image:$VERSION
  docker tag ghcr.io/adachis/$image:$VERSION $REPO/$image:$VERSION
  docker push $REPO/$image:$VERSION
done
gcloud run deploy riosoma --region=$REGION --container=riosoma --image=$REPO/riosoma:$VERSION --port=8080 \
  --container=connectors --image=$REPO/riosoma-connectors:$VERSION
gcloud run services describe riosoma --region=$REGION --format='value(status.latestReadyRevisionName)'
```

Cloud Run keeps the old revision serving until the new one is ready, so both run for a moment during the switch.

**Rolling back:** `gcloud run revisions list --service=riosoma --region=$REGION` lists revisions, and this sends all traffic back to one:

```bash
gcloud run services update-traffic riosoma --region=$REGION --to-revisions=riosoma-00003-abc=100
```

If the upgrade applied migrations, restore the backup you took before it first.  This replaces the instance's data in place:

```bash
gcloud sql backups list --instance=riosoma
gcloud sql backups restore BACKUP_ID --restore-instance=riosoma
```

## Removing it

Delete the service, the Cloud SQL instance (which deletes its backups), the secrets, the service account, and the Artifact Registry repository.
