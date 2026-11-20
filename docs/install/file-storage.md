# File storage

Attachments are the files people add to attachment fields, along with the previews Riosoma makes of pictures.  `RIOSOMA_FILES_STORAGE` says where new ones go:

| Storage | Setting | Good for | Backups |
|---|---|---|---|
| PostgreSQL | `postgres` (the default) | Small and medium installs, and one backup for everything | The database backup covers them |
| A folder | `local` | One server with a disk, or a volume every replica shares | Back up `RIOSOMA_FILES_DIR` with the database |
| An S3-compatible bucket | `s3` | AWS S3, Cloudflare R2, Backblaze B2, Google Cloud Storage, and MinIO | The bucket's own versioning or replication |
| An Azure Blob Storage container | `azure-blob` | Azure | The account's soft delete, versioning, or replication |

Whatever the storage, a few things stay the same:

- **Downloads go through Riosoma**, with its own permission checks, unless you turn on [signed download addresses](#signed-download-addresses).
- **Riosoma checks the storage at start.**  It writes a small test file named `riosoma-check-...`, reads it back, and deletes it.  If any step fails, the server stops with a line naming `RIOSOMA_FILES_STORAGE` and the reason, such as `403 SignatureDoesNotMatch` for a wrong secret key, `404 NoSuchBucket`, or `ECONNREFUSED`, and never the key itself.
- **Large files go up in parts.**  In a bucket or container, a file over 16 MB goes up in 16 MB parts, and Riosoma holds at most one part in memory per upload.  An upload that fails partway is aborted, so the store keeps none of it.
- **Each file remembers where it went.**  Changing `RIOSOMA_FILES_STORAGE` sends new files to the new place and leaves earlier ones where they are, still readable, as long as the old storage's settings stay in place.  To bring them along, [move them](#moving-files-between-storages).

Settings marked secret belong in the platform's secret store.  The [settings reference](settings.md#files) lists every one with its default.

Attachment uploads have no size cap by default.  Owners and Security administrators can set an optional cap at `/settings/files`.  See [File uploads](../modules/administration/file-uploads/en-US.md).  The same cap applies to every storage adapter and to uploads resumed after a settings change.

Scanner limits still apply.  The bundled ClamAV profile uses `StreamMaxLength 2048M`, and the engine cannot scan whole files of 2 GiB or more.  Rejected files show “too large to scan” and stay in quarantine by default.  Owners and Security administrators can allow explicitly labeled unscanned downloads at `/settings/files#virus-scanning`.  Changing the upload cap does not change the scanner configuration.

## S3-compatible buckets

| Setting | Needed | Meaning |
|---|---|---|
| `RIOSOMA_FILES_S3_BUCKET` | Yes | The bucket, which must already exist |
| `RIOSOMA_FILES_S3_ACCESS_KEY_ID` | Yes | The access key ID |
| `RIOSOMA_FILES_S3_SECRET_ACCESS_KEY` | Yes, secret | The secret access key |
| `RIOSOMA_FILES_S3_REGION` | For AWS | The bucket's region |
| `RIOSOMA_FILES_S3_ENDPOINT` | For anything but AWS | The service's address, with no bucket in it |
| `RIOSOMA_FILES_S3_PREFIX` | No | A folder in the bucket for everything Riosoma stores |
| `RIOSOMA_FILES_S3_PATH_STYLE` | No | `true` for `endpoint/bucket/key` addresses, which MinIO needs |
| `RIOSOMA_FILES_S3_SSE` | No | `AES256` or `aws:kms`, to ask for server-side encryption |
| `RIOSOMA_FILES_S3_KMS_KEY_ID` | No | The KMS key for `aws:kms` |

The key needs to put, get, and delete objects under the prefix, and to abort multipart uploads.  Riosoma signs its own requests, so it uses these keys and not an instance or task role.

### AWS S3

```bash
RIOSOMA_FILES_STORAGE=s3
RIOSOMA_FILES_S3_REGION=eu-west-1
RIOSOMA_FILES_S3_BUCKET=example-riosoma-files
RIOSOMA_FILES_S3_ACCESS_KEY_ID=AKIA...
RIOSOMA_FILES_S3_SECRET_ACCESS_KEY=...
```

A policy for the IAM user whose key Riosoma uses:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::example-riosoma-files/*"
    }
  ]
}
```

Keep the bucket's Block Public Access settings on.  Riosoma never needs the bucket to be public, not even for signed download addresses.

### Cloudflare R2

Make an R2 API token with Object Read & Write on the bucket, and use its access key ID and secret access key.  The region is `auto`, which Riosoma works out from the endpoint.

```bash
RIOSOMA_FILES_STORAGE=s3
RIOSOMA_FILES_S3_ENDPOINT=https://<account ID>.r2.cloudflarestorage.com
RIOSOMA_FILES_S3_BUCKET=riosoma-files
RIOSOMA_FILES_S3_ACCESS_KEY_ID=...
RIOSOMA_FILES_S3_SECRET_ACCESS_KEY=...
```

### Backblaze B2

Make an application key with read and write access to the bucket.  Its key ID is the access key ID, and the application key is the secret.  The endpoint is on the bucket's details page, and Riosoma reads the region from it.

```bash
RIOSOMA_FILES_STORAGE=s3
RIOSOMA_FILES_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com
RIOSOMA_FILES_S3_BUCKET=riosoma-files
RIOSOMA_FILES_S3_ACCESS_KEY_ID=004...
RIOSOMA_FILES_S3_SECRET_ACCESS_KEY=K004...
```

### Google Cloud Storage

Google Cloud Storage speaks the S3 protocol with HMAC keys.  Give a service account the Storage Object User role on the bucket, then make an HMAC key for it under **Cloud Storage > Settings > Interoperability**.  The access ID is the access key ID, and the secret is the secret access key.

```bash
RIOSOMA_FILES_STORAGE=s3
RIOSOMA_FILES_S3_ENDPOINT=https://storage.googleapis.com
RIOSOMA_FILES_S3_BUCKET=riosoma-files
RIOSOMA_FILES_S3_ACCESS_KEY_ID=GOOG1E...
RIOSOMA_FILES_S3_SECRET_ACCESS_KEY=...
```

### MinIO

```bash
RIOSOMA_FILES_STORAGE=s3
RIOSOMA_FILES_S3_ENDPOINT=http://minio:9000
RIOSOMA_FILES_S3_PATH_STYLE=true
RIOSOMA_FILES_S3_BUCKET=riosoma-files
RIOSOMA_FILES_S3_ACCESS_KEY_ID=riosoma
RIOSOMA_FILES_S3_SECRET_ACCESS_KEY=...
```

Use `https://` wherever the connection crosses a network you don't control.

## Azure Blob Storage

| Setting | Needed | Meaning |
|---|---|---|
| `RIOSOMA_FILES_AZURE_ACCOUNT` | Yes | The storage account's name |
| `RIOSOMA_FILES_AZURE_CONTAINER` | Yes | The container, which must already exist |
| `RIOSOMA_FILES_AZURE_ACCOUNT_KEY` | No, secret | An account key, or leave it out to use a managed identity |
| `RIOSOMA_FILES_AZURE_CLIENT_ID` | No | A user-assigned managed identity's client ID |
| `RIOSOMA_FILES_AZURE_PREFIX` | No | A folder in the container for everything Riosoma stores |
| `RIOSOMA_FILES_AZURE_ENDPOINT` | No | The blob service's address, for a sovereign cloud or Azurite |

### With a managed identity

With no account key, Riosoma signs in as the identity the container runs as, the same way it can [sign in to the database](database.md#azure-database-for-postgresql-with-a-managed-identity).  On Container Apps and App Service it asks the platform's identity endpoint, on virtual machines and AKS nodes the instance metadata endpoint, and with AKS workload identity the federated token the platform mounts.  The identity needs the Storage Blob Data Contributor role on the container:

```bash
az storage account create -g $RG -n riosomafiles --sku Standard_ZRS --min-tls-version TLS1_2 \
  --allow-blob-public-access false
az storage container create --account-name riosomafiles -n attachments --auth-mode login
az containerapp identity assign -g $RG -n riosoma --system-assigned
az role assignment create --role "Storage Blob Data Contributor" \
  --assignee "$(az containerapp show -g $RG -n riosoma --query identity.principalId -o tsv)" \
  --scope "$(az storage account show -g $RG -n riosomafiles --query id -o tsv)/blobServices/default/containers/attachments"
az containerapp update -g $RG -n riosoma --set-env-vars \
  RIOSOMA_FILES_STORAGE=azure-blob RIOSOMA_FILES_AZURE_ACCOUNT=riosomafiles RIOSOMA_FILES_AZURE_CONTAINER=attachments
```

For a user-assigned identity, also set `RIOSOMA_FILES_AZURE_CLIENT_ID` to its client ID.  A new role assignment can take a few minutes to reach the service, and until it does the start check fails with `403 AuthorizationPermissionMismatch`.

### With an account key

```bash
RIOSOMA_FILES_STORAGE=azure-blob
RIOSOMA_FILES_AZURE_ACCOUNT=riosomafiles
RIOSOMA_FILES_AZURE_CONTAINER=attachments
RIOSOMA_FILES_AZURE_ACCOUNT_KEY=...
```

An account key can do anything in the account, so prefer a managed identity where Riosoma runs in Azure.  Signed download addresses need the key, though.

## Signed download addresses

By default, every download passes through Riosoma, which checks the person's permission to see the file and then streams it from the storage.  With a bucket or container, `RIOSOMA_FILES_SIGNED_URL_SECONDS` can hand the transfer to the store instead.  Riosoma still checks permission first, and then answers with a redirect to an address the store signs, which works for that many seconds and answers with the file's type and name as Riosoma would have.

- Whoever holds the address can use it until it expires, and signing out doesn't end it.  Keep it short: `300` suits most files, and long videos may need more, since a player keeps using the same address.
- While it's on, the content security policy lets Riosoma's pages load pictures and media from the bucket's or container's address.
- Azure signs with the account key, so with a managed identity downloads keep going through Riosoma.
- It changes nothing for `postgres` and `local`.

## Moving files between storages

The `storage:move` command copies every file that isn't in the target storage there, reads each copy back to check its size and checksum against what was recorded at upload, and only then switches that file over.  The server can keep running throughout.  A file that fails its check stays where it was, and the command lists it and exits with 1.  Stopping partway is safe: run it again and it carries on, skipping files already moved and copying a half-copied file from the start.

1. Add the new storage's settings, keeping the old storage's settings, and set `RIOSOMA_FILES_STORAGE` to the new kind.  Restart, so new uploads go to the new storage and the start check proves it works.
2. Run the move with the same settings the server has:

   ```bash
   # From a checkout
   pnpm --filter @riosoma/server storage:move --to s3
   # With Docker Compose, from the folder with compose.yaml
   docker compose run --rm riosoma dist/tools/storage-move.js --to s3
   ```

   On Kubernetes, run it in the pod with `kubectl exec deploy/riosoma -- /nodejs/bin/node dist/tools/storage-move.js --to s3`.
3. Check that files open.  The old copies are still where they were.
4. Remove the old copies with `storage:move --remove-old` (or `dist/tools/storage-move.js --remove-old`).  It removes only copies a move left behind, and skips any file that has since moved back.  Then the old storage's settings can go.

A move writes to the target storage once per file and reads each copy back, so moving many large files takes a while and, for a cloud store, costs requests and transfer.

## Trying it out locally

MinIO and Azurite run in one container each:

```bash
docker run -d --name minio -p 9000:9000 -e MINIO_ROOT_USER=riosoma -e MINIO_ROOT_PASSWORD=choose-a-password \
  quay.io/minio/minio server /data
docker run -d --name azurite -p 10000:10000 mcr.microsoft.com/azure-storage/azurite \
  azurite-blob --blobHost 0.0.0.0
```

Make a bucket or container first, then point `RIOSOMA_FILES_S3_ENDPOINT` at `http://localhost:9000` with `RIOSOMA_FILES_S3_PATH_STYLE=true`, or `RIOSOMA_FILES_AZURE_ENDPOINT` at `http://localhost:10000/devstoreaccount1` with Azurite's published development account key.

## Resumable uploads and quarantine

Files over 8 MB use [tus 1.0](https://tus.io/protocols/resumable-upload), with creation and termination.  The browser sends 4 MB chunks, retries connection failures with backoff, and keeps the file and upload address in IndexedDB for up to 24 hours.  Reopening the same attachment panel after a reload resumes from the server's offset.  If browser storage is unavailable or full, keep the page open to retry.  Smaller files keep the single-request upload path.  Both paths use the organization upload cap, which defaults to no cap.

Partial bytes live in PostgreSQL staging tables for all storage kinds.  Completion streams them into the selected store, using multipart uploads for S3 and staged blocks for Azure.  Sessions expire 24 hours after creation, and the hourly cleanup deletes their staging rows.  HEAD and every chunk require the uploader's session and current access to the record and field.  DELETE terminates an upload session.  Completed attachments follow normal attachment removal and cleanup.

Scanning is off by default.  Setup and `/settings/files#virus-scanning` offer detection, an in-memory EICAR test, and on/off controls.  Detection checks only destinations approved by the server operator.  By default, these are the Compose sidecar and common local sockets under `/run/clamav` and `/var/run/clamav`.  Configure `RIOSOMA_CLAMAV_APPROVED_URLS` as a comma-separated list to replace those defaults.  `RIOSOMA_CLAMAV_URL` is also approved.  Restart after changing either setting.  Organization administrators cannot approve additional destinations, and removing approval prevents future transmission even to a saved destination.  Enable scanning there to stream every new attachment through [clamd INSTREAM](https://docs.clamav.net/manual/Usage/ClamdProtocol.html).  Existing attachments remain available.  New files show a checking state and cannot be downloaded, previewed, shared, or exported until they pass.  A detected infection deletes its bytes and leaves a cell entry with the signature, an uploader notification, and an audit event.  Failed scans retry with backoff up to 15 minutes between attempts.  After one hour, administrators receive an in-app alert and an audit event.  Files remain quarantined until a scan passes, even if scanning is later disabled.

For Compose, follow [the sidecar installation instructions](docker-compose.md#virus-scanning), then detect and enable it in setup or admin file settings.  `RIOSOMA_CLAMAV_URL=tcp://clamav:3310` can enable scanning by default for organizations without saved scanner settings.  The profile runs the official `clamav/clamav-debian:1.4.6` image (the Debian build, which runs on both x86 and ARM hosts), persists definitions in its own volume, and keeps port 3310 inside the Compose network.  The included `clamd.conf` replaces the 1 GiB stream and file limits with 2 GiB and flags engine-limit failures.  The client also refuses whole files of 2 GiB or more, the engine's internal ceiling.  Stream-limit errors and `Heuristics.Limits.Exceeded` verdicts become “too large to scan,” never clean or infected.  Those files stay in quarantine by default.  An audited organization setting can allow their downloads while retaining an unscanned status.  Previews, publishing, signatures, and exports remain blocked.  Turning that setting off revokes their availability, including during a scanner outage.  Enabling scanning or changing its active address requires a successful EICAR test.  Policy-only changes and disabling scanning remain available during outages.  Changing scanner addresses requeues those files for a fresh scan.  Metadata-only archive attachments remain permanently unavailable, and every clean scan requires the stored byte count to match the attachment metadata.  External daemons must use `AlertExceedsMax yes` so they report partial scans.  Keep the scanner address private because clamd does not authenticate clients.

For Helm, set `clamav.enabled=true`.  The chart creates a scanner Deployment and internal Service and supplies its URL automatically unless `settings.RIOSOMA_CLAMAV_URL` overrides it.  Definitions download at startup into an ephemeral volume.  Allow outbound access for updates and sufficient startup time.  The default memory request is 2 GiB with a 4 GiB limit.  The same scan limits apply as in Compose.

To run the optional live scanner tests, set `RIOSOMA_TEST_CLAMAV_URL` to a reachable daemon.  The regular tests use a local TCP stand-in that verifies INSTREAM framing and returns clean, infected, and failed results.
