---
id: nosql
title: Document database sources
summary: Connect DynamoDB, CouchDB, Couchbase, Firestore, and Cosmos DB.
area: data-sources
order: 17
level: advanced
anchors: [sources]
related: [connections]
---

Open {{ui:settings.nav.sources}}, choose {{ui:sources.add}}, and choose a source.  {{ui:sources.test}} checks resolution, connection, encryption, sign-in, collection listing, and a document read.  Use a read-only account.  Private service addresses follow the server’s private-network setting.  HTTP is available for local test services.

## DynamoDB

Choose {{ui:sources.kind.dynamodb}} and enter the region, access key ID, and secret access key.  A temporary credential also needs its session token in {{ui:sources.secret.token}}.  {{ui:sources.nosql.endpoint}} is optional for the hosted service and required for DynamoDB Local.  {{ui:sources.nosql.segments}} controls parallel snapshot scans.

Tables supply their partition and sort keys as record keys.  A saved JSON filter with an exact partition key uses Query when its comparisons match the key schema.  Other reads use Scan.  Sets become sorted lists, maps become nested fields, and long numbers keep their exact text.  Binary values are offered as unsupported fields.

Numeric record keys keep their exact value even when sampled fields change type or later records contain larger numbers.

[Add DynamoDB](/settings/sources?source=new&kind=dynamodb)

## CouchDB

Choose {{ui:sources.kind.couchdb}}, enter the service address, user, and password, and test the connection.  Databases are offered as collections, and `_id` identifies each document.  Full snapshots use `_all_docs`.  Unfiltered copied tables keyed by `_id` use `_changes` after the first successful sync.  Only explicit deletions remove records during an incremental sync.  A held sync retains its pending cursor until confirmation.  Filtered tables and custom keys use complete snapshots, so documents leaving a filter are removed correctly.

Live reads use Mango selectors.  Indexes may be needed for source queries.  Design documents are excluded from snapshots and change feeds.

[Add CouchDB](/settings/sources?source=new&kind=couchdb)

## Couchbase

Choose {{ui:sources.kind.couchbase}} and enter the Query service address, user, and password.  Bucket, scope, and collection names come from the Query service catalog.  Queries are read-only SQL++ with parameters.  Numeric filters and sorts run in the source.  Collection indexes must support the query.

[Add Couchbase](/settings/sources?source=new&kind=couchbase)

## Firestore

Choose {{ui:sources.kind.firestore}}, enter {{ui:sources.nosql.project}}, and paste the service account key.  Leave the database empty for the default database.  The service account needs permission to list and read documents.  Its key signs a short-lived token request and remains in secret storage.

Top-level collections are listed automatically.  Add IDs under {{ui:sources.nosql.groups}} to read a collection group across parent documents.  The full document name identifies a record, including its parents.  For the local test service, enable {{ui:sources.nosql.emulator}} and supply its address.  The emulator does not require a service account key.

[Add Firestore](/settings/sources?source=new&kind=firestore)

## Cosmos DB

Choose {{ui:sources.kind.cosmosdb}}, enter the NoSQL API address and database, and select {{ui:sources.nosql.auth}}.  A master key goes in {{ui:sources.secret.secretAccessKey}}.  An Entra token goes in {{ui:sources.secret.token}} and must be replaced when it expires.  It needs data-plane read access to the database.

Container partition paths and `id` form the record key.  Exact partition comparisons send the partition key with the request.  Other queries enable cross-partition reads.  Every continuation token is followed, including pages with no documents.

Null and missing partition values are supported and remain distinct.  Documents with the same `id` in different partitions keep separate identities.

[Add Cosmos DB](/settings/sources?source=new&kind=cosmosdb)

## Fields and filters

{{ui:sources.nosql.depth}} controls how deeply maps become dotted field names.  Deeper values remain JSON.  {{ui:sources.nosql.arrays}} keeps lists as JSON instead of comma-separated text.  Schema sampling examines up to 1,000 documents.  New fields outside the sample need a refreshed setup.

A backslash escapes a literal dot or backslash in a field name.  For example, `access.level` selects a nested value, while `access\.level` selects a field whose name contains a dot.  In a JSON filter, write that literal field as `"access\\.level"`.  Ambiguous older mappings are refused during live reads.  Refresh the setup to select the escaped literal field.  If the intended nested path also matches a literal field name, rename the conflicting source field before using it in a live rule.  CouchDB live rules cannot use fields whose names contain literal dots, backslashes, or dollar signs.

Saved filters support field equality, `$eq`, `$ne`, `$lt`, `$lte`, `$gt`, `$gte`, `$in`, `$and`, and `$or`.  Comparisons use the source’s native types and case sensitivity.  Live view comparisons are pushed down only when they preserve field behavior.  Unsupported text comparisons, missing-value comparisons, and sorts appear in the live view’s skipped conditions.  Record rules that cannot translate are refused or match no records.  Credentials, setup, and syncs use the existing source permissions and change history.
