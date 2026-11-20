---
id: warehouse-sources
title: Redshift, Athena, and DuckDB file sources
summary: Connect AWS warehouses or read DuckDB, Parquet, and CSV files.
area: data-sources
order: 17
level: advanced
anchors: [sources]
related: [connections]
---

Open {{ui:settings.nav.sources}} → {{ui:sources.add}}, choose a source, and use {{ui:sources.test}} before saving.  The test reports the first failing step.  Connection settings and secrets stay out of the address.  A source form can be reopened through `/settings/sources?source=new&kind=redshift`, `kind=athena`, or `kind=duckdb-file`.  Saved sources use `/settings/sources?source=` followed by the source ID.

Open {{ui:sources.warehouses.help}} for connection guidance without losing your unsaved settings.  Use {{ui:docs.close}} to return to the form.

## Redshift

Choose {{ui:sources.kind.redshift}}.  Enter the endpoint, port, database, and region.  Both provisioned clusters and serverless workgroups use the PostgreSQL wire protocol.  TLS always verifies the endpoint name and the certificate chain with the current Amazon CA bundle.

For {{ui:sources.redshift.iam}}, enter an access key ID, secret access key, and session token when using temporary AWS credentials.  A provisioned cluster also needs its cluster identifier and database user.  A serverless deployment needs its workgroup.  Riosoma requests fresh temporary database credentials when opening a connection through GetClusterCredentials or GetCredentials.  It never creates a database user.  Password authentication is also available.

Use a database user with read privileges.  Tables, views, and external tables come from Redshift’s catalogs.  SUPER values read as JSON text, TIMETZ values read as text, and GEOMETRY values read as extended well-known text with their spatial reference IDs.  Redshift refuses serialized values larger than its 64 KB text limit.  Redshift’s informational primary and unique constraints are not offered as verified record keys.  Choose columns whose values are actually unique.

Snapshot and live tables are supported.  Live tables push supported filters, sorts, and record rules down to Redshift, with the existing query timeout and record limit.

## Athena

Choose {{ui:sources.kind.athena}}.  Enter the region, Glue catalog, database, workgroup, {{ui:sources.athena.resultsLocation}}, and {{ui:sources.athena.maxScannedBytes}}.  The results location is an S3 address ending in a slash.  Supply the access key ID, secret access key, and session token when needed.

The AWS identity needs Athena query and workgroup reads, query cancellation, Glue metadata reads, and access to the S3 data and results locations.  Configure the workgroup’s BytesScannedCutoffPerQuery at or below the source’s limit.  Riosoma refuses to start queries without that guard, checks scanned bytes while polling, and cancels queries that exceed the limit or run out of time.  Athena can cross its threshold before cancellation takes effect, so this is a query guard rather than a billing guarantee.  Workgroup settings can override the supplied results location.

Both snapshot and live tables use StartQueryExecution, polling, and all GetQueryResults pages.  Glue supplies table and partition columns.  Every live refresh can scan data and incur a charge.  Use partition filters and a suitable workgroup limit.

## DuckDB files

Choose {{ui:sources.kind.duckdb-file}} and a {{ui:sources.duckdb.storage}}.  Use an uploaded file’s reachable web address, an S3 bucket and prefix, or a local path inside an operator-approved directory.  Request headers can authenticate a web address.  S3 uses the same access key fields as Athena.  Temporary download links must remain valid when the source syncs again.

A DuckDB source opens one `.duckdb` database, or combines a folder’s Parquet or CSV files into a `data` table.  Local folders read their immediate files.  Bucket prefixes include matching files below the prefix.  Column names are matched across files, with missing values left empty.  Checkpoint and close a DuckDB database before supplying it.  Files with a pending write-ahead log are refused.

The server operator sets `RIOSOMA_SOURCE_DUCKDB_ROOTS` to a comma-separated list of absolute source-data directories.  An empty setting disables local files.  Symlinks are resolved before the allowlist is checked.  Do not allow directories containing application secrets or unrelated files.

Each read stages files in a private temporary directory, opens the database read-only, and removes the staged files afterward.  The engine cannot reach the network, load extensions, or read other server files.  `RIOSOMA_SOURCE_FILE_MAX_MB` limits the total staged bytes.  DuckDB file sources use snapshot mode.

## Optional live tests

Run `pnpm --filter @riosoma/connectors exec vitest run src/warehouses/aws-warehouses.live.test.ts --maxWorkers=3`.  Tests skip unless the required settings for that warehouse are present.  They read existing tables and do not create warehouse resources.

For Redshift, set `RIOSOMA_TEST_REDSHIFT_HOST`, `RIOSOMA_TEST_REDSHIFT_DATABASE`, `RIOSOMA_TEST_REDSHIFT_REGION`, `RIOSOMA_TEST_REDSHIFT_TABLE`, and `RIOSOMA_TEST_REDSHIFT_KEY_COLUMN`.  Set `RIOSOMA_TEST_REDSHIFT_ACCESS_KEY_ID` and `RIOSOMA_TEST_REDSHIFT_SECRET_ACCESS_KEY`, plus `RIOSOMA_TEST_REDSHIFT_SESSION_TOKEN` when needed.  Provisioned IAM uses `RIOSOMA_TEST_REDSHIFT_CLUSTER_IDENTIFIER` and `RIOSOMA_TEST_REDSHIFT_USER`.  Serverless IAM uses `RIOSOMA_TEST_REDSHIFT_WORKGROUP`.  Alternatively, set `RIOSOMA_TEST_REDSHIFT_USER` and `RIOSOMA_TEST_REDSHIFT_PASSWORD`.  Optional `RIOSOMA_TEST_REDSHIFT_PORT` defaults to 5439, and `RIOSOMA_TEST_REDSHIFT_SCHEMA` defaults to public.

For Athena, set `RIOSOMA_TEST_ATHENA_REGION`, `RIOSOMA_TEST_ATHENA_DATABASE`, `RIOSOMA_TEST_ATHENA_WORKGROUP`, `RIOSOMA_TEST_ATHENA_RESULTS_LOCATION`, `RIOSOMA_TEST_ATHENA_ACCESS_KEY_ID`, `RIOSOMA_TEST_ATHENA_SECRET_ACCESS_KEY`, `RIOSOMA_TEST_ATHENA_TABLE`, and `RIOSOMA_TEST_ATHENA_KEY_COLUMN`.  Optional settings are `RIOSOMA_TEST_ATHENA_SESSION_TOKEN`, `RIOSOMA_TEST_ATHENA_CATALOG`, and `RIOSOMA_TEST_ATHENA_MAX_SCANNED_BYTES`.  The catalog defaults to AwsDataCatalog, and the scan limit defaults to 1,000,000,000 bytes.  Configure the workgroup guard before running the test.
