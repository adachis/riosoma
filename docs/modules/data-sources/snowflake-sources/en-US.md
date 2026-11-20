---
id: snowflake-sources
title: Snowflake sources
summary: Connect a Snowflake account with a key-pair service user, and read snapshot copies of its tables.
area: data-sources
order: 18
level: advanced
anchors: [sources]
related: [connections, synced-tables]
---

Open {{ui:settings.nav.sources}} → {{ui:sources.add}}, choose {{ui:sources.kind.snowflake}}, and use {{ui:sources.test}} before saving.  The test reports the first failing step.  Connection settings and secrets stay out of the address.  A source form can be reopened through `/settings/sources?source=new&kind=snowflake`, and a saved source through `/settings/sources?source=` followed by the source ID.

Open {{ui:sources.snowflake.help}} for connection guidance without losing your unsaved settings.  Use {{ui:docs.close}} to return to the form.

## Account identifier

{{ui:sources.field.account}} names your Snowflake account, not its full web address.  The current form is your organization name and account name joined by a hyphen, like `acme-analytics`.  Find it in Snowsight under your account name at the lower left, in Account, where Snowsight shows the organization and account and copies the identifier for you.  The identifier is also the first label in the account URL, as in `acme-analytics.snowflakecomputing.com`.  A legacy account locator, with its region and cloud, works too.  Enter the identifier on its own, without `.snowflakecomputing.com` and without `https://`.

## Key-pair sign-in

Snowflake is reached with a service user that signs in with a key pair, which is the method Snowflake recommends and the default here.  A key pair has no password to rotate on a schedule and is not subject to multi-factor prompts, so an unattended sync keeps working.

Generate an encrypted private key and its public key:

```sh
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -v2 aes-256-cbc -out rsa_key.p8
openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
```

Create a read-only role, a warehouse the sync may use, and the service user, then set the user's public key.  Run this as a role that may administer users, such as `ACCOUNTADMIN` or `SECURITYADMIN`, and paste the public key's body from `rsa_key.pub` without its `BEGIN` and `END` lines:

```sql
CREATE ROLE IF NOT EXISTS riosoma_reader;
CREATE WAREHOUSE IF NOT EXISTS riosoma_wh
  WAREHOUSE_SIZE = XSMALL
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE;
GRANT USAGE ON WAREHOUSE riosoma_wh TO ROLE riosoma_reader;
GRANT USAGE ON DATABASE analytics TO ROLE riosoma_reader;
GRANT USAGE ON SCHEMA analytics.public TO ROLE riosoma_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics.public TO ROLE riosoma_reader;
GRANT SELECT ON FUTURE TABLES IN SCHEMA analytics.public TO ROLE riosoma_reader;
GRANT SELECT ON ALL VIEWS IN SCHEMA analytics.public TO ROLE riosoma_reader;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA analytics.public TO ROLE riosoma_reader;

CREATE USER riosoma_sync
  DEFAULT_ROLE = riosoma_reader
  DEFAULT_WAREHOUSE = riosoma_wh
  TYPE = SERVICE
  RSA_PUBLIC_KEY = 'MIIBIjANBgkq...replace with the body of rsa_key.pub...';
GRANT ROLE riosoma_reader TO USER riosoma_sync;
```

In the form, choose {{ui:sources.auth.keyPair}} under {{ui:sources.field.auth}}, enter `riosoma_sync` as the {{ui:sources.field.user}}, and paste the whole `rsa_key.p8` file, `BEGIN` and `END` lines included, into {{ui:sources.secret.privateKeyPem}}.  When the key is encrypted, enter its {{ui:sources.secret.privateKeyPassphrase}}.  The key is masked as you paste it and is never shown again once saved.  Password sign-in is also available for an account that still allows it, under {{ui:sources.auth.password}}.

## Warehouse, database, schema, and role

{{ui:sources.field.warehouse}} runs the queries that read your tables, and the service user needs `USAGE` on it.  A small warehouse that auto-suspends is enough, since a sync is short and infrequent.

{{ui:sources.field.database}} is the database to read, and {{ui:sources.field.schema}} is an optional schema within it.  Leave the schema empty to list tables and views across the database's schemas in the wizard, or name one to narrow the list.

{{ui:sources.field.role}} is optional.  Leave it empty to use the user's default role, or name a role the user holds to read with exactly that role's grants.  The role decides which tables and views the sync can see, so grant it only what people should be able to copy.

## What is read

Riosoma reads Snowflake as snapshot copies.  Each sync queries the chosen table or view and copies its rows, and your scheduled syncs keep the copy current.  Reading a table live is not available for Snowflake yet, so the {{ui:synced.freshness.live}} choice does not apply to a Snowflake table.

Tables and views come from the database's `INFORMATION_SCHEMA`.  Snowflake has no enforced primary keys, so its informational keys are not offered as verified record keys.  Choose key columns whose values are actually unique.  `NUMBER` values beyond a double's range, `VARIANT`, `OBJECT`, and `ARRAY` values read as JSON text, and `TIMESTAMP_TZ` values read as text that keeps its offset.

## Fixing common errors

**The account could not be found.**  Check {{ui:sources.field.account}} holds only the identifier, with no `.snowflakecomputing.com` and no `https://`.  Use the organization-and-account form, like `acme-analytics`, and confirm the account is not suspended.

**Sign-in was refused.**  Confirm the public key set on the user is the body of `rsa_key.pub` with its `BEGIN` and `END` lines removed, and that it matches the private key pasted into the form.  When the private key is encrypted, enter its {{ui:sources.secret.privateKeyPassphrase}}.  A newly set key can take a moment to take effect.  Snowflake refuses key-pair sign-in for a user whose network policy or type forbids it.

**No active warehouse.**  Name a {{ui:sources.field.warehouse}} the service user may use, grant the role `USAGE` on it, and leave `AUTO_RESUME` on so a suspended warehouse starts for the sync.

**A table or view is missing, or a column cannot be read.**  Grant the role `SELECT` on the tables and views people sync, including `FUTURE` grants for ones made later, and `USAGE` on their database and schema.  A sync that names a {{ui:sources.field.role}} reads with that role's grants only.
