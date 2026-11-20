# Document source protocols

The five HTTP document connectors share the existing source contracts, encrypted secrets, registry, command handlers, sync audit events, API operations, and live AccessScope checks.  No storage table or migration is added.  The existing organization archive catalog already removes transient source fetch state.

DynamoDB uses the existing SigV4 signer with the DynamoDB service name.  Couchbase sends only generated, parameterized SQL++ with `readonly` enabled.  Firestore uses the existing RSA service-account assertion signer.  Cosmos DB signs master-key requests or accepts an Entra data-plane access token.  All server requests use the existing host guard and reject redirects.

A document predicate accompanies live fragments.  It is compiled from field conditions directly, never parsed from SQL.  Saved JSON selectors have native comparison semantics.  Live filters support native number comparisons, true checkboxes, and single-choice equality.  Numeric rules exclude fields converted from exact decimal or long-number text, where rounding could change access.  Mango numeric rules require numeric source values.  Unsupported view conditions are reported as skipped.  Unsupported access conditions fail closed.  Couchbase numeric sorts keep missing values last.  Other sorts are reported as skipped.

Document paths escape literal dots and backslashes in each segment.  Sampling, value extraction, native key names, filters, sorts, and Firestore cursors use the same path encoding.  For example, `access.level` names a nested value, while `access\.level` names one literal field.  Reads reject legacy mappings that could name either field, checking both sampled and returned documents.  Mango refuses paths with literal dots, backslashes, or dollar signs because those paths cannot be pushed down consistently.

Native identities travel separately from display cells.  DynamoDB numeric key parts use canonical exact decimal text regardless of sample types, and key queries still send `N` attributes.  Cosmos partition identity distinguishes null, missing, empty text, numeric values, booleans, and strings that resemble encoded parts.  Ordinary nonempty text retains its identity.  Encoded parts use a NUL prefix and a JSON array containing the native value, or an empty array for missing.  Only key predicates decode these parts.  Missing partitions use `NOT IS_DEFINED` and the `{}` partition routing component, while null partitions use a null comparison and a null routing component.  Displayed cells keep their original values.

CouchDB enables deltas only for unfiltered tables keyed by `_id`.  The snapshot records a sequence before reading, so changes during that read are replayed next time.  Filtered tables and custom keys continue to use snapshots.  Incremental stage rows carry JSON-null tombstones.  The existing apply transaction leaves unstaged records alone, handles overrides, and records audit and broadcast events.  A deletion hold stores pending cursor metadata with the committed fetch state.  Only successful apply advances the committed cursor.

## Local verification

Protocol fixtures run without paid services.  Live suites read `RIOSOMA_TEST_DYNAMODB_SETTINGS`, `RIOSOMA_TEST_COUCHDB_SETTINGS`, `RIOSOMA_TEST_COUCHBASE_SETTINGS`, `RIOSOMA_TEST_FIRESTORE_SETTINGS`, and `RIOSOMA_TEST_COSMOSDB_SETTINGS`.  Each value is JSON with `connection`, `secrets`, and `object` matching the source contracts.  The selected collection must contain test records.  Missing settings skip only the corresponding live suite.

The existing fleet services also have the `sources-nosql` profile.  Use a separate Compose project prefix for this unit and remove its containers and volumes when finished:

```sh
docker compose -p rio-sources-nosql -f ops/test-fleet/compose.yaml --profile sources-nosql up -d dynamodb couchdb couchdb-init firestore couchbase couchbase-init cosmos
RIOSOMA_TEST_COUCHBASE_LOCAL=1 RIOSOMA_TEST_COSMOSDB_LOCAL=1 node ops/test-fleet/nosql-smoke.mjs
docker compose -p rio-sources-nosql -f ops/test-fleet/compose.yaml --profile sources-nosql rm -sf dynamodb couchdb couchdb-init firestore couchbase couchbase-init cosmos
docker volume rm rio-sources-nosql_fleet-dynamodb rio-sources-nosql_fleet-couchdb rio-sources-nosql_fleet-couchbase rio-sources-nosql_fleet-cosmos
```

The smoke runner requires a built connectors package.  It creates temporary documents, generates test signing keys, and reads each local service’s own fixture configuration.  Set `DOCKER_HOST` when the daemon uses a nondefault socket.  Set `RIOSOMA_TEST_NOSQL_PROJECT` to the Compose project prefix when running an isolated fleet.  Cleanup names only this project’s resources because the fleet network may be shared.

The initial unit verification passed all ten live tests locally against DynamoDB Local, CouchDB, Couchbase Server Community, the Firestore emulator, and the Cosmos DB emulator.  This includes keyed live queries, full reads, and null and missing Cosmos partition components.  The Cosmos emulator conflates some typed partition hashes for documents sharing an ID and rejects NUL-containing strings.  Those collision cases use protocol response fixtures, while the emulator uses distinct fixture IDs.  Separate protocol fixtures cover signing, paging, value conversion, ambiguous field mappings, exact numeric identities, and failure handling.  All five phone setup browser specs passed locally.

Merge regression coverage preserves the warehouse source routes and resolves source credentials asynchronously with the transaction's database context.  CouchDB cursors survive renaming and unchanged credentials, and credential rotation clears them.  The merge verification used protocol fixtures because no Docker daemon was available.  All eleven NoSQL and warehouse setup browser specs passed, including phone layouts, deep links, and warehouse help navigation.

The protocol references are the [DynamoDB Scan API](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Scan.html), [CouchDB changes API](https://docs.couchdb.org/en/stable/api/database/changes.html), [Couchbase Query service](https://docs.couchbase.com/server/current/n1ql-rest-query/index.html), [Firestore REST API](https://firebase.google.com/docs/firestore/reference/rest), and [Cosmos DB authorization](https://learn.microsoft.com/en-us/rest/api/cosmos-db/access-control-on-cosmosdb-resources).
