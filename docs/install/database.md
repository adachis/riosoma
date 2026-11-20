# Connecting the database

Riosoma needs PostgreSQL 14 or later and a database of its own.  Tell it where with one of two settings, or leave both unset and enter the database in the browser during setup, which stores it sealed in `/config`.

- `RIOSOMA_DATABASE_URL`: a connection URL, enough for a password over TLS.
- `RIOSOMA_DATABASE_PROFILE`: a JSON profile for everything else, such as a private certificate authority, client certificates, cloud identity sign-in, an SSH tunnel, or custom schema names.  It wins when both are set.

Either way, the setup wizard then skips its database step.  Both are secrets.

## What the database account needs

Riosoma creates three schemas in its database and everything inside them: `rio_app`, `rio_data`, and `rio_audit`.  The account it signs in with needs to be able to do that.

```sql
CREATE ROLE riosoma LOGIN PASSWORD 'choose-a-long-random-password';
CREATE DATABASE riosoma OWNER riosoma;
```

On a managed service, the administrator account you create with the server can do this, or you can grant `CREATE` on the database to a separate account.  Two extensions help when the account may create them: `pg_trgm` makes searching faster, and `vector` turns on meaning-based search.  Riosoma works without either.

## The URL

```
postgres://USER:PASSWORD@HOST:5432/DATABASE?sslmode=verify-full
```

- Percent-encode special characters in the password, or generate one from letters and digits.
- `sslmode` is `disable`, `prefer` (the default: TLS when the server offers it, plain otherwise), `require` (TLS without checking the certificate), `verify-ca` (TLS with the certificate authority checked), or `verify-full` (the authority and the host name checked).  Use `verify-full` for anything that crosses a network you don't control.
- `pooler=transaction` tells Riosoma a transaction pooler such as PgBouncer or RDS Proxy sits in front.  Live updates still need a direct connection, which only a profile can name (`listenHost` below).

With a URL, Riosoma checks certificates against the public authorities Node trusts.  Azure Database for PostgreSQL uses one of those, so `verify-full` works as is.  Amazon RDS and Cloud SQL sign with their own authorities, so a URL can say only `require` for them.  To verify those, use a profile with `caPem`.

## The profile

A JSON object.  Only `host`, `database`, `user`, and `auth` are required.

| Field | Default | Meaning |
|---|---|---|
| `host` | | Server name or address |
| `port` | `5432` | |
| `database` | | Database name |
| `user` | | Account to sign in as |
| `auth` | | How to sign in, below |
| `tls.mode` | `verify-full` | As `sslmode` above |
| `tls.caPem` | | PEM bundle of the certificate authorities to trust, instead of the public ones |
| `tls.clientCertPem`, `tls.clientKeyPem` | | A client certificate and its key |
| `tls.serverName` | | The name to check the certificate against, when `host` is an address |
| `ssh` | | An SSH tunnel: `host`, `port` (22), `user`, `privateKeyPem`, optional `passphrase`, and `hostKey`, the server's pinned key in OpenSSH `type base64` form.  Connections fail when the key doesn't match. |
| `pooler` | `none` | `none`, `transaction`, or `session` |
| `listenHost`, `listenPort` | | A direct connection for live updates when the main one goes through a transaction pooler |
| `schemas.app`, `schemas.data`, `schemas.audit` | `rio_app`, `rio_data`, `rio_audit` | Schema names, lowercase letters, digits, and underscores |
| `pool.max` | `10` | Connections in the pool |
| `pool.idleTimeoutMs` | `30000` | How long an idle connection stays open |
| `applicationName` | `riosoma` | What the server reports to PostgreSQL |

`auth` is one of these:

| `auth.method` | Other fields | Signs in with |
|---|---|---|
| `password` | `password` | A password |
| `azure-entra` | `credential` (`managed-identity`, `workload-identity`, or `service-principal`), and as needed `clientId`, `tenantId`, `clientSecret`, or `certificatePem` | A Microsoft Entra token |
| `aws-rds-iam` | `region` | An RDS IAM token signed with the AWS credentials the server runs with |
| `gcp-cloudsql-iam` | `instanceConnectionName` (`PROJECT:REGION:INSTANCE`) | An access token from the Google credentials the server runs with |
| `client-certificate` | | The TLS client certificate alone |

Cloud tokens are fetched when a connection opens and reused until shortly before they expire.  A token travels the way a password would, so keep TLS on with every cloud identity method.

Build a profile with `jq`, which escapes the line breaks in certificates for you, and store the result as the `RIOSOMA_DATABASE_PROFILE` secret:

```bash
jq -n --arg host db.example.com --arg password "$DB_PASSWORD" --rawfile ca ca.pem '{
  host: $host, database: "riosoma", user: "riosoma",
  auth: {method: "password", password: $password},
  tls: {mode: "verify-full", caPem: $ca}
}' > profile.json
```

## Signing in with a cloud identity

Each of these replaces the password with the identity the Riosoma container already runs as.  Set up the platform's side first, then give Riosoma a profile.

### Azure Database for PostgreSQL with a managed identity

1. Turn on Microsoft Entra sign-in for the server: `az postgres flexible-server update -g $RG -n $PG --microsoft-entra-auth Enabled`.
2. Give the container app an identity.  For a user-assigned one, note its client ID and name.
3. Make that identity a database role.  As a Microsoft Entra administrator of the server, connected to the `postgres` database, run `SELECT * FROM pgaadauth_create_principal('riosoma-identity', false, false);` with the identity's name, then `GRANT CREATE ON DATABASE riosoma TO "riosoma-identity";` in the `riosoma` database.
4. Use this profile:

```json
{
  "host": "riosoma-db.postgres.database.azure.com",
  "database": "riosoma",
  "user": "riosoma-identity",
  "auth": { "method": "azure-entra", "credential": "managed-identity", "clientId": "00000000-0000-0000-0000-000000000000" },
  "tls": { "mode": "verify-full" }
}
```

Leave `clientId` out for a system-assigned identity.  On AKS with workload identity, use `"credential": "workload-identity"` and annotate the chart's service account (`serviceAccount.annotations`).

### Amazon RDS with IAM

1. Turn on IAM sign-in: `aws rds modify-db-instance --db-instance-identifier riosoma --enable-iam-database-authentication --apply-immediately`.
2. As the master user, create the role: `CREATE ROLE riosoma_app LOGIN; GRANT rds_iam TO riosoma_app; GRANT CREATE ON DATABASE riosoma TO riosoma_app;`.
3. Let the ECS task role, or the Kubernetes service account's IAM role, connect: allow `rds-db:connect` on `arn:aws:rds-db:REGION:ACCOUNT:dbuser:DB_RESOURCE_ID/riosoma_app`, where `DB_RESOURCE_ID` is the instance's `DbiResourceId`.
4. Use this profile, with the region's certificate bundle from `https://truststore.pki.rds.amazonaws.com/REGION/REGION-bundle.pem` as `caPem`:

```json
{
  "host": "riosoma.abcdefghijkl.us-east-1.rds.amazonaws.com",
  "database": "riosoma",
  "user": "riosoma_app",
  "auth": { "method": "aws-rds-iam", "region": "us-east-1" },
  "tls": { "mode": "verify-full", "caPem": "-----BEGIN CERTIFICATE-----\n..." }
}
```

### Cloud SQL with IAM

1. Turn on IAM sign-in: `gcloud sql instances patch riosoma --database-flags=cloudsql.iam_authentication=on`.  This replaces any other flags you set, so list them all.
2. Add the service account as a database user: `gcloud sql users create riosoma@PROJECT.iam --instance=riosoma --type=cloud_iam_service_account`.
3. Grant it `roles/cloudsql.instanceUser` and `roles/cloudsql.client` on the project, and, as the built-in user, `GRANT CREATE ON DATABASE riosoma TO "riosoma@PROJECT.iam";`.
4. Use this profile.  The user is the service account's email without `.gserviceaccount.com`:

```json
{
  "host": "10.20.0.3",
  "database": "riosoma",
  "user": "riosoma@PROJECT.iam",
  "auth": { "method": "gcp-cloudsql-iam", "instanceConnectionName": "PROJECT:us-central1:riosoma" },
  "tls": { "mode": "require" }
}
```

Riosoma connects to the instance's address directly, so it needs a network path to it, such as the private address over a VPC.

## When the connection fails

The server stops at start with a JSON line on standard error.  `configuration_invalid` names the setting that's wrong.  `startup_failed` carries a PostgreSQL error code (`sqlstate`) when the server gave one, such as `28P01` for a wrong password or `3D000` for a missing database.  Migration failures are logged at error level (`level: 50`) with `migrationId` and a `messageKey`: `server.startup.migrationChanged` means a shipped migration changed after it was applied, `server.startup.databaseNewer` means this build does not know an applied migration, and `server.startup.migrationStatementFailed` means a migration statement failed.  These diagnostics contain no SQL, query values, or connection details.  To see each layer checked in turn (name lookup, network, TLS, sign-in, permissions, and version), leave the database settings out and enter the same details in the setup wizard, which reports on each one.
