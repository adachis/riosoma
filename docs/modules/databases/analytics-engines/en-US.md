---
id: analytics-engines
title: Syncing from ClickHouse, Trino, and Druid
summary: Connect ClickHouse, Trino, or Apache Druid as a data source, and see how each one's columns come across.
area: databases
order: 16
level: standard
related: [synced-tables, fields]
---

A data source can also be one of three open-source analytics engines: ClickHouse, including ClickHouse Cloud, Trino and services built on it, and Apache Druid.  Their tables sync like any other source's, so everything in {{doc:synced-tables}} applies to them too.  Data Sources admins set them up in {{ui:shell.nav.settings}} with {{ui:sources.add}}.

All three answer over HTTP, which is HTTPS unless you turn off {{ui:sources.https.use}}.  Leave it on unless the server sits on a trusted private network.  Riosoma always checks the server's certificate and the name on it.  Turning HTTPS off or on moves a {{ui:sources.field.port}} you haven't changed to the engine's usual one.  Pasting a whole address, like one a console shows, into {{ui:sources.field.host}} fills in the port and HTTPS too.  When you type instead, type the host alone.

A server on a private network, like one in your office or `localhost`, works only once the server's operator sets `RIOSOMA_AUTOMATIONS_ALLOW_PRIVATE_HOSTS=true`, the setting webhooks, file sources, and API sources follow too.  Riosoma checks every address a host's name leads to, so a public name that points somewhere private is refused as well.

Before you save, choose {{ui:sources.test}}.  It stops at the first step that fails and says what usually fixes it: finding the host, reaching the port, securing the connection, signing in, or running a first query.  A user who signs in but may not read anything gets past signing in and stops at {{ui:sources.step.query}}.

None of the three declares keys that are unique, so under {{ui:synced.wizard.key}} in the sync wizard, choose the columns that identify each row yourself, such as an ID.  These sources sync as copies.  {{ui:synced.freshness.live}} is only for PostgreSQL, MySQL, and SQL Server.

## ClickHouse

1. Choose {{ui:sources.kind.clickhouse}}.
2. Under {{ui:sources.field.host}}, type the server's host, or paste the address ClickHouse Cloud shows under Connect, like `https://abc123.us-east-1.aws.clickhouse.cloud:8443`.
3. Keep the {{ui:sources.field.port}} at 8443 for HTTPS, or 8123 without it.  These are the ports of ClickHouse's HTTP interface, not its native 9000 and 9440.
4. Set the {{ui:sources.field.database}}, `default` unless yours is another.  Its tables are listed first, and a query's table names that don't say their database read from it.
5. Enter the {{ui:sources.field.user}} and its {{ui:sources.secret.password}}.
6. For a server whose certificate comes from a private authority, open {{ui:sources.advanced}} and paste the authority's certificate into {{ui:sources.tls.caPem}}.

A read-only user works, even one that may change no settings at all.  Grant it `SELECT` on the tables people should sync, and `SHOW` so they're listed.  Riosoma lists the tables and views in every database the user can see, except ClickHouse's own and tables that read from a stream, like Kafka, RabbitMQ, NATS, file log, and queue tables, since reading one takes its messages from everyone else.

A sync reads a big table in pages of 50,000 rows.  When no key column can be empty, and each holds whole numbers, decimals, text, dates, dates and times, UUIDs, or IP addresses, each page picks up after the last row the one before it read, in the order of the table's sorting key and then the key.  Rows added while a sync runs then can't push a row onto two pages.  Otherwise, pages count their way through one fixed order, and rows added during a busy sync can make it stop with a repeated key and try again later.

Tables whose engine replaces, collapses, sums, or aggregates rows as ClickHouse merges them read with `FINAL`: the `ReplacingMergeTree`, `CollapsingMergeTree`, `VersionedCollapsingMergeTree`, `SummingMergeTree`, and `AggregatingMergeTree` families, replicated or in ClickHouse Cloud.  Until a merge, such a table holds every version of a row, and `FINAL` reads each row once, as the merge will leave it, so a sync doesn't find a key twice.  It takes more work on ClickHouse's side for a big table.  A `Distributed` table or a materialized view over one of these reads without `FINAL`, so sync the table itself, or a query that says `FINAL`.

### How ClickHouse columns come across

| ClickHouse type | Field type |
|---|---|
| `Int8` through `Int256`, `UInt8` through `UInt256` | Number with no decimal places |
| `Decimal`, `Decimal32` through `Decimal256` | Number with the type's decimal places, up to 8 |
| `Float32`, `Float64`, `BFloat16` | Number |
| `Bool` | Checkbox |
| `String`, `FixedString`, `UUID`, `IPv4`, `IPv6` | Single line text, or long text for a `FixedString` longer than 1,000 characters |
| `Enum8`, `Enum16` | Single select, with the enumeration's values as its choices |
| `Date`, `Date32` | Date |
| `DateTime`, `DateTime64`, with or without a time zone | Date with time, in UTC |
| `Time`, `Time64` | Single line text |
| `Array`, `Map`, `Tuple`, `Nested`, `JSON`, `Dynamic`, `Variant`, and geometry | Long text holding JSON |
| `AggregateFunction`, intervals, and `Nothing` | Left out |

`Nullable` and `LowCardinality` columns come across as the type inside them.  A date and time keeps the instant it names, whatever time zone the column declares, so `2026-02-03 04:05:06` in `America/New_York` arrives as 9:05:06 UTC.  64-bit and wider integers and decimals keep their exact digits in a key, a fixed string loses the zero bytes that pad it, and a named tuple becomes a JSON object.

## Trino

1. Choose {{ui:sources.kind.trino}}.
2. Under {{ui:sources.field.host}}, type the coordinator's host, or paste its whole address.  The {{ui:sources.field.port}} is usually 443 or 8443 over HTTPS, and 8080 without it.
3. Set the {{ui:sources.field.catalog}}, such as `hive`, `iceberg`, or `postgresql`.  Its schemas and tables are what people can sync.  A {{ui:sources.field.schema}} is optional.  Its tables are listed first, and a query's table names that don't say their schema read from it.
4. Under {{ui:sources.field.auth}}, choose one:
   - **{{ui:sources.auth.password}}** signs in as the {{ui:sources.field.user}} with its {{ui:sources.secret.password}}.
   - **{{ui:sources.trino.auth.token}}** sends an {{ui:sources.secret.token}}, a JWT or OAuth 2.0 token, as a bearer token.  Leave the user empty to go by the token's own user.
   - **{{ui:sources.trino.auth.none}}** only says who's asking, for a cluster that signs nobody in.
5. For a coordinator whose certificate comes from a private authority, open {{ui:sources.advanced}} and paste the authority's certificate into {{ui:sources.tls.caPem}}.

Trino takes a password or a token only over HTTPS, so Riosoma never sends either without it.  The test's first query also checks that the catalog, and the schema when you set one, exist and that the user can see them.  A sync runs one query and follows Trino's pages of results to the end, so a long read keeps one consistent plan.  A query that stops early, because a sync was canceled or ran out of time, is canceled on the cluster too, even while Trino is still planning it.  Each page has to come from the coordinator's own address, so a coordinator behind a proxy that ends HTTPS needs `http-server.process-forwarded=true`.

### How Trino columns come across

| Trino type | Field type |
|---|---|
| `tinyint`, `smallint`, `integer`, `bigint` | Number with no decimal places |
| `decimal(p, s)` | Number with `s` decimal places, up to 8 |
| `real`, `double` | Number |
| `boolean` | Checkbox |
| `varchar`, `char`, `uuid`, `ipaddress` | Single line text, or long text for a `varchar` longer than 1,000 characters |
| `date` | Date |
| `timestamp(p)` and `timestamp(p) with time zone` | Date with time, in UTC |
| `time(p)`, with or without a time zone | Single line text |
| `json`, `array`, `map`, `row` | Long text holding JSON |
| `varbinary`, intervals, sketches, and geometry | Left out |

A `timestamp` without a time zone reads as UTC.  One with a time zone keeps the instant it names.  A `bigint` keeps its exact digits in a key, and a `row` becomes a JSON object with its fields' names.

## Apache Druid

1. Choose {{ui:sources.kind.druid}}.
2. Under {{ui:sources.field.host}}, type the router's host, or paste its whole address.  The {{ui:sources.field.port}} is 9088 over HTTPS, or 8888 without it, unless your cluster changed them.
3. When the cluster signs people in with Druid's basic security, enter a {{ui:sources.field.user}} and its {{ui:sources.secret.password}}.  Leave the user empty for a cluster that doesn't.

The user needs to read the datasources people should sync.  Druid lists only the datasources a user may read, so when the test finds none, it passes and says so: the cluster has nothing ingested yet, or this user may not read what it has.  Riosoma checks a secure router's certificate against the trusted authorities of the server Riosoma runs on.  For a private authority, whoever runs that server adds it there, for example with Node's `NODE_EXTRA_CA_CERTS` setting.

Each datasource is a table, and its `__time` column is a date with time.  Row counts come from Druid's segment table when the user may read it.  A sync reads in pages of 50,000 rows in order of `__time`, the one order Druid sorts a datasource by, and each page picks up after the last `__time` the one before it reached.  Druid keeps no order among rows that share a `__time`, so when a page ends at one, Riosoma reads every row at that moment in a single request before it moves on.  No row is read twice or missed, however Druid orders them.  A datasource with more than 1,000,000 rows at a single `__time`, which a coarse query granularity can make, stops the sync with a message that says so.  Sync it through a query that leaves `__time` out, which reads in one request.  Streaming ingestion usually adds new moments at the end, where it doesn't disturb a sync, but a batch ingestion that replaces segments while a sync reads them can.  Schedule syncs between batch ingestions when you can.

### How Druid columns come across

| Druid SQL type | Field type |
|---|---|
| `TIMESTAMP`, including `__time` | Date with time, in UTC |
| `DATE` | Date |
| `BIGINT`, `INTEGER`, `SMALLINT`, `TINYINT` | Number with no decimal places |
| `DOUBLE`, `FLOAT`, `REAL`, `DECIMAL` | Number |
| `BOOLEAN` | Checkbox |
| `VARCHAR`, `CHAR` | Single line text |
| Arrays and `COMPLEX<json>` | Long text holding JSON |
| Sketches and other complex columns | Left out |

A `BIGINT` keeps its exact digits in a key.  Druid keeps no exact decimals, so a `DECIMAL` arrives as the number Druid stores.
