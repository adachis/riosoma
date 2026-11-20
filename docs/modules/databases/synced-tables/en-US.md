---
id: synced-tables
title: Syncing a table from a data source
summary: Copy records from another database, like Oracle or Firebird, or from MongoDB, files, an API, Google Sheets, Airtable, a feed, or a webhook, and correct values here without changing the source.
area: databases
order: 16
level: standard
related: [importing, fields, linked-records, undo, suggested-links, feeds, incoming-webhooks, analytics-engines, microsoft-365, snowflake-sources]
anchors: [shell.settings, database.tables.add, database.tables, grid, sources, synced.source, synced.object, synced.fields, synced.schedule, sources.connection, settings.sources]
demo: synced-tables
sections: [sources=connecting-a-data-source, synced.source=choose-a-source, synced.object=choose-a-table-or-query, synced.fields=choose-fields-and-keys, synced.schedule=set-the-sync-schedule, sources.connection=connecting-a-data-source, settings.sources=connecting-a-data-source]
routes: [/admin/data/sources, /settings/sources]
---

A synced table copies its records from a data source, such as a table in another database, and keeps them current.  Its source fields hold the source's columns, and you can add fields of your own beside them.  Nothing you do here changes the source.

Data Sources admins connect sources for the whole organization in {{ui:shell.nav.settings}}.  After that, people with the {{ui:share.role.creator}} or {{ui:share.role.owner}} role in a database can sync tables into it.

For an outside PostgreSQL database, {{ui:sources.test}} distinguishes a missing database from refused credentials.  Check the database name before replacing the password when the database cannot be found.

Some sources have help of their own: Snowflake, in {{doc:snowflake-sources}}, the analytics engines ClickHouse, Trino, and Apache Druid, in {{doc:analytics-engines}}, SharePoint lists, Excel workbooks, Dataverse tables, and Fabric warehouses, in {{doc:microsoft-365}}, an RSS, Atom, or JSON feed, in {{doc:feeds}}, and an incoming webhook, which other systems post records to, in {{doc:incoming-webhooks}}.

## Connecting a data source

Open {{ui:settings.nav.sources}} and choose {{ui:sources.add}}.  Choose a source kind, enter its connection and secrets, and use {{ui:sources.test}} before saving.  Set who may use the connection.

## Choose a source

In {{ui:synced.wizard.source}}, choose an available source.  The next step lists its tables, files, or endpoints.

## Choose a table or query

Under {{ui:synced.wizard.object}}, choose the source object.  Data Sources admins can enter a query with {{ui:synced.wizard.query}}.

## Choose fields and keys

Under {{ui:synced.wizard.fields}}, select columns, review their names and types, and confirm {{ui:synced.wizard.key}}.  Each key must identify a record consistently between syncs.

## Set the sync schedule

Set {{ui:synced.wizard.name}}, {{ui:synced.freshness}}, and {{ui:synced.wizard.every}}.  Choose whether people can pin local corrections with {{ui:synced.wizard.overrides}}.

## Starting a synced table

In a database's sidebar, choose {{ui:synced.add.menu}}, then {{ui:synced.add.sync}}.  This choice appears once a data source is available to you.

1. In {{ui:synced.wizard.source}}, pick the source, then choose {{ui:synced.wizard.next}}.
2. Under {{ui:synced.wizard.object}}, pick a table or view, then choose {{ui:synced.wizard.next}}.  {{ui:synced.wizard.search}} narrows a long list, and Data Sources admins can also choose {{ui:synced.wizard.query}}.
3. Under {{ui:synced.wizard.fields}}, look over the sample rows and include the columns you want, up to 500.  Use {{ui:synced.wizard.searchFields}} to find columns by their source or field names.  {{ui:synced.wizard.selectAll}} selects every supported column, {{ui:synced.wizard.selectNone}} clears every selection, and {{ui:synced.wizard.selectByType}} selects only columns with the chosen field type.  These choices apply to all columns, including those hidden by the search.  The count shows how many fields are selected.  Set each {{ui:synced.wizard.fieldName}}, and keep Riosoma's suggested {{ui:synced.wizard.fieldType}} or pick another the column converts to cleanly.  A column of numbers from a SQL database or a warehouse can be a {{ui:field.type.currency}} or {{ui:field.type.percent}} field instead, which holds the same values and shows them as money or as a percentage.  Columns of a type Riosoma can't hold stay out.
4. Under {{ui:synced.wizard.key}}, confirm the columns that identify each record from one sync to the next.  Riosoma starts with the source's own key when it has one.  Every row needs a value in each key column, and no two rows can share the same combination.
5. Choose the {{ui:synced.wizard.primary}}, which names each record.
6. Choose {{ui:synced.wizard.next}}, and set the {{ui:synced.wizard.name}}.  Under {{ui:synced.freshness}}, keep {{ui:synced.freshness.copy}}, or choose {{ui:synced.freshness.live}} for a table too big or too busy to copy (see [Reading a table live](#reading-a-table-live)).  Under {{ui:synced.wizard.every}}, choose how often to sync, from {{ui:synced.every.15}} to {{ui:synced.every.1440}}, or {{ui:synced.every.manual}}.  Turn off {{ui:synced.wizard.overrides}} to keep source values read-only.
7. Choose {{ui:synced.wizard.create}}.

A copied table starts empty, and its first sync is queued when you create it.  Afterward, only the freshness, schedule, overrides, and removal limit can change, so start another synced table to sync different columns or keys.

If a wide source starts with more than 500 fields selected, the field step explains the limit.  Clear the selections you do not need before choosing {{ui:synced.wizard.next}}.  The preview scrolls sideways so you can review columns on a phone or with the keyboard.  After creation, an empty records area stays reachable with Tab, so you can scroll sideways with the arrow keys.

## Syncing from files

A data source can also be files: {{ui:sources.kind.fileUrl}} reads one file at an https address, and {{ui:sources.kind.bucket}} reads files in an S3-compatible bucket, such as AWS S3, Cloudflare R2, Backblaze B2, Google Cloud Storage with interoperability keys, or MinIO.  Riosoma reads CSV, TSV, JSON (an array of objects, or one object per line), NDJSON, Parquet, and Excel workbooks, and each file's extension says which it is.  Data Sources admins can choose a {{ui:sources.field.format}} for files whose names don't say, and a {{ui:sources.field.sheet}} when a workbook's first sheet isn't the one to read.

- **A file at a web address** can send {{ui:sources.secret.headers}}, one per line as `Name: value`, such as an `Authorization` header with a token.  Headers are stored like any other secret.  Put a token in a header rather than in the address, since the address is shown to Data Sources admins.
- **A bucket** takes its service's {{ui:sources.field.endpoint}} (leave it empty for AWS S3), the {{ui:sources.field.bucket}}, and an {{ui:sources.secret.accessKeyId}} and {{ui:sources.secret.secretAccessKey}} that may list and read it.  Under {{ui:sources.field.prefix}}, name one file, or a folder like `exports/` to offer every file in it.  MinIO usually needs {{ui:sources.bucket.pathStyle}}.

In the wizard, the files take the place of tables.  A folder offers each file on its own, plus one choice, like `exports/*.csv`, that reads every file of that format together as one table.  Files read together need the same columns, in any order.

CSV, TSV, and workbook columns get the types an import would give them: numbers, checkboxes for words like yes and no, dates written like 9/27/2026 or 2026-09-27, and dates with times.  A time with no zone reads as UTC.  A value that doesn't fit its column's type, like n/a in a column of numbers, arrives empty.  To keep values exactly as they're written, choose a text {{ui:synced.wizard.fieldType}} for the column.  JSON and Parquet files keep the types they declare.

Files have no keys of their own, so Riosoma suggests columns whose values are all present and all different.  Each sync reads the whole file again.  A file larger than the server allows, 2 GB unless an administrator changes it, doesn't sync, and neither does a workbook over 50 MB.

## Syncing from an API

A data source can also be a web API that answers in JSON.  Data Sources admins choose {{ui:sources.kind.rest}}, give its {{ui:sources.api.baseUrl}}, such as `https://api.example.com/v2`, and choose how it signs in under {{ui:sources.api.auth}}:

- **{{ui:sources.api.auth.none}}** for open APIs.
- **{{ui:sources.api.auth.bearer}}** sends an {{ui:sources.secret.token}} in an `Authorization` header.
- **{{ui:sources.api.auth.header}}** and **{{ui:sources.api.auth.query}}** send an {{ui:sources.secret.apiKey}} under the name the API expects, like `X-Api-Key` or `api_key`.
- **{{ui:sources.api.auth.basic}}** signs in with a user name and a {{ui:sources.secret.password}}.
- **{{ui:sources.api.auth.oauthClient}}** asks the {{ui:sources.api.tokenUrl}} for a token with a {{ui:sources.field.clientId}}, a {{ui:sources.secret.clientSecret}}, and an optional {{ui:sources.api.scope}}.  Riosoma keeps the token until it expires, and asks for a new one when the API turns it down.

Secrets are stored like any other source's, and never sent anywhere but the API and its token address.

Each API offers one or more endpoints, and each endpoint becomes something to sync, the way a table does.  Choose {{ui:sources.api.endpoint.add}} and fill in:

- **{{ui:sources.api.endpointName}}**, which people see in the wizard.
- **{{ui:sources.api.path}}** under the base address, like `/orders`, and any {{ui:sources.api.query}}, one per line as `name=value`.
- **{{ui:sources.api.records}}**, where each answer keeps its list, like `data.items`.  Leave it empty when the answer is the list itself.
- **{{ui:sources.api.paging}}**, the way the API hands over more records: {{ui:sources.api.paging.page}}, {{ui:sources.api.paging.offset}}, a {{ui:sources.api.paging.cursor}}, a {{ui:sources.api.paging.nextUrl}}, or the {{ui:sources.api.paging.linkHeader}}.

While you set one up, {{ui:sources.api.preview}} shows the records on the first page, with the type each column would get, so you can check the path and the paging against what the API really sends.

Nested objects become columns with dotted names, like `customer.name`.  Under {{ui:sources.advanced}}, {{ui:sources.api.flattenDepth}} goes up to three levels, and anything deeper arrives as JSON in a long text field.  Lists of plain values, like tags, arrive as text joined with commas, or as JSON if you choose it under {{ui:sources.api.arrays}}.  Columns get their types the way file columns do.  Riosoma suggests key columns whose values are all present and all different, and `id` first when it qualifies.

To be a good neighbor, Riosoma asks an API for at most five requests a second, which admins can change under {{ui:sources.advanced}}, and waits when the API says it's busy.  A sync that finds more pages than the endpoint's {{ui:sources.api.maxPages}}, 10,000 unless you change it, or more records than its {{ui:sources.api.maxRecords}}, stops and says so instead of removing anything.

## Syncing from MongoDB

A data source can also be a MongoDB database, including MongoDB Atlas and services compatible with it.  Data Sources admins choose {{ui:sources.kind.mongodb}}, then connect with {{ui:sources.mongodb.address.uri}}, like the `mongodb+srv://` address Atlas shows under Connect.  Riosoma stores the {{ui:sources.secret.connectionString}} like any other secret, since it can hold a password.  They can connect with {{ui:sources.mongodb.address.host}} instead, with an optional {{ui:sources.field.user}} and {{ui:sources.secret.password}}, and turn on {{ui:sources.mongodb.useSrv}} for a cluster whose address starts with `mongodb+srv`.  Either way, the {{ui:sources.field.database}} names the database whose collections and views people can sync.  A connection string may carry the options that say how to talk to the servers it names, like `replicaSet`, `authSource`, `tls`, `readPreference`, `retryWrites`, and the timeouts.  Riosoma refuses one with any other option, such as a proxy, a certificate or key file, or a sign-in mechanism other than a user and password.  Write each host as a name or an IP address on its own.  A full name can end in a dot, and a name with characters outside ASCII goes in its ASCII form, the one that starts with `xn--`.

Under {{ui:sources.advanced}}, {{ui:sources.tls.mode}} starts at {{ui:sources.mongodb.tls.auto}}, which encrypts `mongodb+srv` addresses and any connection the string asks to encrypt.  Add {{ui:sources.tls.caPem}} for a server whose certificate comes from a private authority, and an {{ui:sources.mongodb.authSource}} when the user isn't defined in `admin`.  A server on a private network can sit behind an SSH tunnel, which reaches one server, so the connection string names a single host.

In the wizard, collections and views take the place of tables.  Riosoma samples up to 1,000 documents to decide each column's type:

- Embedded documents become columns with dotted names, like `address.city`, one level down unless {{ui:sources.api.flattenDepth}} says otherwise, up to three.  Anything deeper arrives as JSON in a long text field.
- Lists of plain values, like tags, arrive as text joined with commas, or as JSON if you choose it under {{ui:sources.api.arrays}}.
- An `ObjectId` reads as its hex text, and a date as a date and time in UTC.
- `Decimal128` values and long whole numbers arrive as their exact digits in a text field.  Choose a number {{ui:synced.wizard.fieldType}} instead if a little rounding is fine.
- Binary data can't be synced, so it stays out.

Documents don't have to agree about their fields.  When a document doesn't have a column, that field is empty in its record.  Every collection offers `_id` as its key.

Data Sources admins can also give a collection a {{ui:synced.wizard.filter}}, a JSON query document like `{"status": "active"}`, so the table holds only the documents that match it.  Extended JSON works too, like `{"_id": {"$oid": "…"}}`.  A filter only ever runs as a query, so operators that run JavaScript, like `$where` and `$function`, aren't allowed.

## Syncing from Google Sheets

A data source can also be the sheets of one or more Google spreadsheets.  Riosoma reads them as a Google Cloud service account, an account for software that can open only what people share with it.  A Google Cloud administrator sets one up once:

1. In the Google Cloud console, pick or create a project, then turn on the Google Sheets API under APIs and Services.
2. Under IAM and Admin, choose Service Accounts, and create one.  It needs no roles.
3. Open the new service account, choose Keys, then Add key and Create new key, and choose JSON.  A file downloads, and it's the only copy of the key, so keep it safe.

Data Sources admins then choose {{ui:sources.kind.googleSheets}}, paste each spreadsheet's address from the browser under {{ui:sources.google.spreadsheets}}, one per line, and paste the whole key file into {{ui:sources.secret.serviceAccountJson}}.  Riosoma stores the key like any other secret and only ever sends it to Google.

### Sharing a spreadsheet with the service account

Once the key is in, {{ui:sources.google.shareWith}} shows the service account's address, and {{ui:sources.google.copy}} copies it.  For each spreadsheet:

1. Open it in Google Sheets and choose Share.
2. Paste the address, and choose Viewer, since Riosoma only reads.
3. Turn off Notify people, since nobody reads that address's mail, and choose Share.

A spreadsheet that isn't shared makes {{ui:sources.test}} stop at {{ui:sources.step.sheets}} and say so.  An Excel file kept in Google Drive isn't a Google spreadsheet until someone opens it and saves it as Google Sheets.

### How sheets come across

In the wizard, each spreadsheet's sheets take the place of tables, under the spreadsheet's name.  Riosoma keeps track of a sheet and its spreadsheet by their IDs, so renaming either one doesn't stop its synced table.

- The first row names the columns.  When the names are further down, set {{ui:sources.google.headerRow}} under {{ui:sources.advanced}}, and the rows above it are left out.
- A column without a name is named for its place, like `column2`, and a repeated name gets a number, like `Total_1`.
- Empty rows are skipped, and every other row below the header is a record.
- Columns get the types a file's columns do: numbers, checkboxes, dates written the way the sheet shows them, email addresses, and web addresses.  An error value, like `#N/A`, arrives empty.

Riosoma suggests key columns whose values are all present and all different.  It also offers `Row number`, each row's number in the sheet, but it's a poor key: when someone sorts the sheet or adds a row in the middle, records trade their own fields and overrides, and the wizard says so when you choose it.  An ID or code column is the better choice.

When a column the table reads is renamed or removed in the sheet, the next sync stops and says which column, rather than emptying the field.  Put the column back, or start a new synced table.  Riosoma asks Google for one request a second for each service account, which is Google's own limit for reading, and waits whenever Google asks it to slow down.

## Syncing from Airtable

A data source can also be Airtable.  Data Sources admins choose {{ui:sources.kind.airtable}} and paste an {{ui:sources.secret.token}}: a personal access token from Airtable's builder hub, at airtable.com/create/tokens.  Give the token the `data.records:read` and `schema.bases:read` scopes, and add the bases people should sync.  Riosoma never writes to Airtable, so the token needs no other scopes.

A token often reaches many more bases than anyone means to sync, so under {{ui:sources.airtable.bases}}, choose {{ui:sources.airtable.bases.list}}, then choose each base whose tables people may sync.  {{ui:sources.airtable.bases.search}} is always available and matches any part of a name, with or without accents.  Filtering keeps bases you already chose visible.  Long lists scroll and include group buttons with counts.  A source needs at least one base, and it offers those bases' tables and no others.  To offer another base later, edit the source and list the bases again.  The first base you choose is the one {{ui:sources.test}} reads.  See {{doc:choosing-items}} for keyboard controls.

In the wizard, each chosen base's tables take the place of a database's tables, under the base's name.  Riosoma keeps track of a table by its ID, so renaming it in Airtable doesn't stop its synced table.

Fields come across the way an Airtable import brings them, with a few differences, since the rest of the base may not be synced:

- A link to other records holds the linked records' names as text.
- Attachments hold the files' names, and the files stay in Airtable.
- Formulas, rollups, lookups, and counts hold the values Airtable works out, typed by their result where that's a single value, like a number or a date.
- People fields hold email addresses.
- Fields Riosoma has nothing like stay out.

The wizard says under each column how it comes across.  Every table also offers `Record ID`, Airtable's own ID for each record, which never changes.  It's the key, and it isn't a field unless you include it.

Airtable allows five requests a second for each base, so Riosoma keeps to four, and syncs, previews, and imports of the same base share them.  When Airtable asks Riosoma to slow down, it holds off that base for as long as Airtable asks, usually 30 seconds.  A sync waits it out.  A preview or a test says Airtable asked to slow down instead of making you wait, and a sync that runs out of time says the same and tries again on its own.  Other apps or scripts reading the same base count toward Airtable's limit too.  When a field the table reads is renamed or removed in Airtable, the next sync stops and says which one, rather than emptying the field.

## Syncing from Oracle

A data source can also be Oracle Database 12.1 or later, including Oracle Autonomous Database.  Riosoma speaks Oracle's protocol itself, so nothing from Oracle has to be installed on the server.  Data Sources admins choose {{ui:sources.kind.oracle}}, then pick one of two ways under {{ui:sources.oracle.address}}:

- **{{ui:sources.oracle.address.host}}**: the {{ui:sources.field.host}}, the {{ui:sources.field.port}} (1521 unless yours listens elsewhere), and the {{ui:sources.oracle.serviceName}}, like `FREEPDB1` or `sales.example.com`.  A SID doesn't work here, only a service name.  The host is one name or address, never a list.
- **{{ui:sources.oracle.address.easyConnect}}**: one line like `db.example.com:1521/sales.example.com`, or `tcps://db.example.com:2484/sales` for TLS.  It names one host and a service, with an optional server type and instance.  Aliases from `tnsnames.ora`, connect descriptors, lists of hosts, and parameters after a `?` aren't taken.

Either way, a source reaches only the host it shows.  When a listener answers by redirecting the connection to another address, as a RAC SCAN listener or Connection Manager does, Riosoma refuses it and {{ui:sources.test}} says so, so connect to the listener of the instance itself.

Then enter the {{ui:sources.field.user}} and its {{ui:sources.secret.password}}.  Give Riosoma a user of its own with only `CREATE SESSION` and `SELECT` on the tables and views people should sync (see below for why).  Riosoma lists the ones it can read, leaving out Oracle's own schemas, and a key comes from each table's primary key and unique constraints.

Oracle listens for TLS (TCPS) on a port of its own, often 2484 or 1522, so {{ui:sources.tls.mode}} under {{ui:sources.advanced}} starts at {{ui:sources.tls.disable}}.  For a TLS port, choose {{ui:sources.tls.verifyFull}}, or start an Easy Connect string with `tcps://`, which turns it on by itself.  Riosoma always checks the server's certificate against a trusted authority, so there's no TLS without that check.  {{ui:sources.tls.verifyCa}} skips only the name, so it needs an authority of your own, in {{ui:sources.tls.caPem}} or a wallet: with only the platform's authorities, any certificate they sign for any name would pass.  Add {{ui:sources.tls.caPem}} for a server whose certificate comes from a private authority, or is self-signed, and {{ui:sources.tls.serverName}} when the certificate names another host than the one you connect to, as it does through an SSH tunnel or by address.  For a wallet, like the one Autonomous Database hands out, paste its `ewallet.pem` into {{ui:sources.secret.wallet}}, with the {{ui:sources.secret.walletPassword}} when its key is encrypted.  Riosoma trusts the certificates in it, and uses its client certificate and key when the server asks for one.  Only the PEM file works, not `cwallet.sso` or `ewallet.p12`.

Every preview and sync runs in a read-only transaction, which refuses any change the session itself tries to make, and each request to the server stops after the source's time limit.  It can't stop a function that runs an autonomous transaction, which commits on its own, or one that writes through a database link, and a query can call any function the user may run.  That's why the user should have only `CREATE SESSION` and `SELECT`: then there's nothing it can call that writes.

### How Oracle columns come across

| Oracle type | Field type |
|---|---|
| `NUMBER(p)`, `INTEGER` | Number with no decimal places |
| `NUMBER(p, s)` | Number with `s` decimal places, up to 8 |
| `NUMBER` without a precision, `FLOAT`, `BINARY_FLOAT`, `BINARY_DOUBLE` | Number |
| `DATE` | Date with time, in UTC, since an Oracle date carries a time of day |
| `TIMESTAMP`, with or without a time zone | Date with time, in UTC |
| `VARCHAR2`, `NVARCHAR2`, `CHAR`, `NCHAR` | Single line text, or long text for one longer than 1,000 characters |
| `CLOB`, `NCLOB` | Long text |
| `JSON` | Long text holding JSON |
| `BOOLEAN` (Oracle Database 23ai) | Checkbox |
| `RAW`, `BLOB`, `BFILE`, intervals, and object types | Left out |

A `DATE` or a `TIMESTAMP` without a zone reads as UTC.  Long whole numbers, like IDs in a `NUMBER` column, stay exact as keys, and a `NUMBER(p, s)` key keeps all its decimal places.  `CLOB` values arrive one row at a time, so a big table never has to fit in memory.

## Syncing from Firebird

A data source can also be Firebird 3, 4, or 5.  Data Sources admins choose {{ui:sources.kind.firebird}} and fill in the {{ui:sources.field.host}}, the {{ui:sources.field.port}} (3050 unless yours listens elsewhere), and the {{ui:sources.field.database}}: the database file's path on the server, like `/var/lib/firebird/data/sales.fdb`, or its alias from the server's `databases.conf`.  Then enter the {{ui:sources.field.user}} and its {{ui:sources.secret.password}}.  A user that reads tables through a role takes it on with {{ui:sources.firebird.role}} under {{ui:sources.advanced}}.

Firebird 3 and later encrypt the connection themselves, with a key that comes from signing in with SRP, and require it unless someone turned it off.  With {{ui:sources.firebird.wireCrypt}} at {{ui:sources.firebird.wireCrypt.required}}, the default, Riosoma signs in only with SRP, which never sends the password or anything it can be read from, and sends nothing more until the connection is encrypted.  It refuses a server that asks for Legacy_Auth or an older protocol, and {{ui:sources.test}} stops at {{ui:sources.step.tls}} or {{ui:sources.step.authenticate}} and says why.  For a server whose `WireCrypt` setting is `Disabled`, or a user who has only a Legacy_Auth password, choose {{ui:sources.firebird.wireCrypt.enabled}}.  Then Riosoma signs in the way the server asks, which for Legacy_Auth sends a hash of the password unencrypted, so use it only on a network you trust.

Firebird has no schemas, so the wizard lists tables and views by name, and a key comes from each table's primary key and unique constraints.  Every preview and sync reads one read-only snapshot, and a sync sees the whole table as it was at one moment.  The snapshot refuses any change the session tries to make, even from a procedure's autonomous transaction, which Firebird starts read-only too.  Still give Riosoma a user that may only read, since a query can call any procedure the user may run.

### How Firebird columns come across

| Firebird type | Field type |
|---|---|
| `SMALLINT`, `INTEGER`, `BIGINT`, `INT128` | Number with no decimal places |
| `NUMERIC(p, s)`, `DECIMAL(p, s)` | Number with `s` decimal places, up to 8 |
| `FLOAT`, `DOUBLE PRECISION`, `DECFLOAT` | Number |
| `BOOLEAN` | Checkbox |
| `DATE` | Date |
| `TIMESTAMP`, with or without a time zone | Date with time, in UTC |
| `TIME`, with or without a time zone | Single line text, like `12:34:56.0000 +02:00` |
| `CHAR`, `VARCHAR` | Single line text, or long text for one longer than 1,000 characters |
| `BLOB SUB_TYPE TEXT` | Long text |
| `BINARY`, `VARBINARY`, other `BLOB`s, and arrays | Left out |

`INT128`, `DECFLOAT`, and the types with a time zone come with Firebird 4.  A `TIMESTAMP` without a zone reads as UTC.  Long whole numbers stay exact as keys.  A number field keeps about 16 significant digits, so choose a text {{ui:synced.wizard.fieldType}} to keep every digit of an `INT128` or a `DECFLOAT`.

Oracle and Firebird tables sync as copies.  {{ui:synced.freshness.live}} is only for PostgreSQL, MySQL, and SQL Server.

## Reading a table live

Some tables are too big to copy, or change too often for a copy to keep up.  A synced table from PostgreSQL, MySQL, or SQL Server can read its source live instead.  Choose {{ui:synced.freshness.live}} under {{ui:synced.freshness}} when you start the table, or later in {{ui:synced.settings}}.

A live table keeps no copy.  Each time someone opens a view or scrolls, Riosoma asks the source for the records in the view's order, then reads just the ones on screen.  The view's filters and sorts run in the source, and so do record rules, so the source only ever sends the records each person may see.  The bar above the records says the table is live, and {{ui:synced.readAgain}} asks the source again.  Overrides, your own fields, comments, and history stay in Riosoma, each matched to its source row by the row's key.

Choose it when:

- The table has more rows than you'd want to copy, often millions.
- People need what the source says right now, not what it said at the last sync.
- The source can take the extra reads.  Every view someone opens runs a query there, so an index on the columns people filter and sort by helps.

What a live table can't do:

- Links, lookups, rollups, counts, and formulas need every record at hand, so a live table can't have them, and other tables can't link to it.
- Views list records in the order of the source's key unless they sort or group.  Grid grouping and its group summaries work with live records.  Kanban, calendar, and timeline views, the summary footer, dashboards, finding text in a view, duplicate checks, and the API work only with copied tables.  CSV and Excel downloads work.
- A filter or sort the source can't apply exactly is left out, and a note above the records names it.  That includes conditions on your own fields, on source fields some record overrides, and on multiple-choice fields.  Leaving a condition out shows more records, never fewer.
- Text sorts follow the source's own alphabetical order, which can differ from Riosoma's, and matching ignores the case of accented letters only as far as the source's settings do.
- A view lists at most 250,000 records.  Add a filter to reach the rest.
- A record rule on a live table can read only source fields, and nobody can override those fields, so the source applies the rule exactly.  Riosoma won't save a rule the source can't apply.
- Each read gets 15 seconds.  When the source is down or too slow, the view says so instead of showing old records, and {{ui:synced.tryAgain}} reads it again.

Switching from {{ui:synced.freshness.copy}} to {{ui:synced.freshness.live}} keeps every override and the values in your own fields.  Switching back starts a first sync, and the table keeps reading live until that sync has copied every record.

## Keeping an eye on syncs

A bar above the records shows when the table last synced.  People with the {{ui:share.role.creator}} or {{ui:share.role.owner}} role can choose {{ui:synced.syncNow}} at any time, or {{ui:synced.settings}} to change the schedule, overrides, and removal limit.  Syncs aren't part of anyone's undo history.

If a sync fails, the bar explains why, such as a missing column or two rows sharing a key.  Riosoma tries again on its own, waiting longer after each failure.  Once you've fixed the cause, choose {{ui:synced.tryAgain}}.

A missing table or column is named in the sync bar, alongside any available error details.  The last successful copy stays available while you fix the source.  {{ui:syncHistory.title}} keeps the failed run, with a complete explanation even when the run does not retain the missing name.

If your access limits fields or records, duplicate-key explanations withhold the key’s value.  Missing-column explanations also withhold names when fields are hidden.  Notifications and live-read errors follow your current access, even when a notification was saved before that access changed.

A sync that would remove many records waits for a person instead, because a broken source can look empty.  By default, that means more than half the records of a table with 20 or more.  Choose {{ui:synced.removeThem}} if they really left the source, or {{ui:synced.keepThem}} while you check.  A held table doesn't sync on schedule until someone syncs it again.  To change the limit, use {{ui:synced.settings.hold}} in {{ui:synced.settings}}.

## Working in a synced table

Records come only from the source, so you can't add or delete them here.  A source field's header has a small database mark, and hovering over it names the source and column.  The field keeps the type its source gives it, but you can rename, format, hide, filter, and sort it as usual.

When a record leaves the source, it disappears from the table.  If it returns within 30 days, it comes back as the same record, with its overrides and the values in your own fields.

## Overriding source values

When the table allows it, anyone who can edit records can change a source value by editing its cell.  The new value replaces the source's everywhere in Riosoma, including filters, formulas, and the API.

An overridden cell has a small mark in its top corner.  Hover over it or select it to see what the source says.  Later syncs keep your value and update the source's value behind it.

To go back, right-click the cell, or press Shift+F10, and choose {{ui:synced.override.clear}}.  With several cells selected, choose {{ui:synced.override.clearMany}}.  In an expanded record, the same choice appears under the field.  Entering the source's value again works too, and an override clears itself when a sync brings a matching value.

When the table doesn't allow overrides, source cells can't be edited, and hovering over one says "{{ui:synced.override.off}}"

## Adding your own fields

Use {{ui:grid.field.add}} to add fields beside the source fields, such as notes, links, formulas, or attachments.  They work like any other field, and their values stay with each record from sync to sync.
