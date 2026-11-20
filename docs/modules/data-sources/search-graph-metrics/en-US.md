---
id: search-graph-metrics
title: Search, graph, and metrics sources
summary: Connect search indexes, graph labels, and time series queries.
area: data-sources
order: 18
level: advanced
anchors: [sources]
related: [connections]
---

Open {{ui:settings.nav.sources}} → {{ui:sources.add}}, and choose a source kind.  Enter its {{ui:sources.engines.endpoint}}, select {{ui:sources.field.auth}}, and use {{ui:sources.test}} before saving.  The diagnostic ladder checks name resolution, the connection, certificates, authentication, and a read.  Use credentials with read access only.  Secrets are stored separately from connection settings.

Use {{ui:sources.engines.help}} to open this guide without losing the form.  {{ui:docs.close}} returns to it.  Setup links use `/settings/sources?source=new&kind=elasticsearch`, with `opensearch`, `meilisearch`, `typesense`, `neo4j`, `influxdb`, or `prometheus` for the other kinds.  Saved source links use `/settings/sources?source=` followed by the source ID.  These forms support phone layouts, keyboard navigation, and labeled controls for screen readers.

## Elasticsearch and OpenSearch

Choose {{ui:sources.kind.elasticsearch}} or {{ui:sources.kind.opensearch}}.  API keys and basic authentication are supported.  Amazon OpenSearch also supports {{ui:sources.engines.auth.aws}} with a region, access key ID, secret access key, and an optional session token.  Choose a managed domain or serverless collection to select the signing service.

Indexes and aliases appear in the object picker.  Mappings supply field types.  Keyword and text fields become text, numeric fields become numbers, dates become date fields, geo points become locations, and nested or object fields become JSON.  Fields with arrays in the first 1,000 sampled documents become JSON and do not use scalar filters or sorts.  Arrays found after sampling remain JSON text in JSON and text fields.  An incompatible scalar cell shows an error explaining how to keep multiple values, while the rest of the sync completes.  A single geo point written as two coordinates remains a location.  The `_index` and `_id` columns together identify a document even when an alias spans indexes.  Point-in-time reads use search-after paging and release their handles after completion or cancellation.  Each page is tied off by the point in time’s own position, so no field needs doc values for the read to page.

Admins can enter a JSON query DSL object in {{ui:synced.wizard.filter}}.  Only the query types that compare stored values are read, so scripts, script scores, runtime mappings, wrapper queries, percolate queries, and terms sets are refused, along with a script hidden under any other key.  Inner hits and highlights are refused wherever they appear, since Riosoma never reads them and they can carry queries of their own.  A snapshot fails when a shard fails or paging cannot finish, so an incomplete result cannot remove records during a sync.

## Meilisearch and Typesense

Choose {{ui:sources.kind.meilisearch}} or {{ui:sources.kind.typesense}}, and supply a read API key.  Meilisearch lists indexes and uses the index’s primary key.  Typesense lists collections and uses each document’s `id`.  Snapshots page through documents.  These engines do not provide a point-in-time view, so concurrent changes can affect paging.

{{ui:synced.wizard.filter}} accepts the engine’s native filter syntax.  Fields used for filtering or sorting must be configured for those operations in the engine.  Meilisearch live sorts also follow its maximum search-hit setting.  Raise that limit or narrow the filter if a read reaches it.

A Meilisearch filter travels as one entry in the engine’s filter array, and a view’s filters and record rules travel as another, so the engine ANDs them with each parsed on its own.  A filter that closes a group it never opened is refused when the table is saved, because Meilisearch binds AND tighter than OR and such a filter would end the group the record rules sit in.  So is a filter that leaves a group or a quoted value open, which would fail every read.  Meilisearch quotes values with single or double quotes only.  A Typesense filter shares one filter string with a view’s filters and record rules, each in its own parentheses, and Typesense quotes values only with backticks.  A Typesense filter whose parentheses outside backticks don’t pair up, or that leaves a backtick open, is refused when the table is saved and again when it is read.  Meilisearch documents carry no schema, so fields are described from a sample of 1,000 documents, and an array that arrives after that sample stays JSON text in a JSON or text field and shows a per-cell error in a scalar one.  A Typesense document id holding a backtick or a backslash has no form its filter grammar can compare, so those ids are fetched one at a time and still narrowed by the source filter and the record rules.

All four search kinds support {{ui:synced.freshness.live}}.  Numeric comparisons, Elasticsearch and OpenSearch date filters, supported empty-value checks, Boolean checks, and compatible sorts are pushed to the source.  Unsupported view conditions are identified in the live view.  Unsupported record-access rules match no records.  Text comparisons whose engine semantics differ from Riosoma are not used to authorize access.

## Neo4j

Choose {{ui:sources.kind.neo4j}} and the database.  The connection uses the HTTP Query API with read access mode.  Choose a node label or use {{ui:synced.wizard.query}} to write read-only Cypher.  Procedures, mutations, and external reads are refused.  Give custom queries a stable order and return a unique key column.  Label reads provide `_id` from the node’s element ID and sample properties to suggest fields.  Nested properties remain JSON.

Outgoing relationships appear as JSON arrays named `_links.relationshipType.TargetLabel`.  Sync both labels, retaining the target label’s `_id` as a text field.  Add a link field with {{ui:field.link.match}}, choosing the relationship array on the source table and `_id` on the target table.  Every string in the array links to the matching node.  Updates, removals, undo, audit events, and broadcasts use the existing matched-link workflow.  Empty arrays and JSON objects match no nodes.

Neo4j uses scheduled snapshots.  Element IDs identify nodes in the current database and should not be treated as portable business identifiers after a database restore or rebuild.

## InfluxDB

Choose {{ui:sources.kind.influxdb}} and {{ui:sources.engines.version}}.  Version 2 needs a bucket, an organization, and a token.  Version 3 needs a database, and a token when its HTTP API asks for one.  Choose a measurement, or write Flux for version 2 and SQL for version 3.  Flux accepts pure read pipelines and refuses imports, writes, and external requests.  A Flux query names its own range, since Flux requires one, and no second window is added over it.  SQL runs as a read query inside the source’s time bounds, so it keeps a `time` column.  A Flux query keeps `_time`.

{{ui:sources.engines.windowMinutes}} sets the rolling window a measurement read uses.  Optional {{ui:sources.engines.start}} and {{ui:sources.engines.end}} use timestamps with a time zone instead.  Each read holds its time bounds fixed for its whole pass.  A measurement with no points inside the window still reads, as no rows, since the name is checked against the catalog rather than against the measurements the window holds.  The object picker still lists only what the window holds.  Bucket and measurement names are written into Flux as literals, so a name holding a dollar sign, a quote, or a backslash reads as it stands and can never start an interpolation.  Time becomes a date field.  Choose `_timeKey` and the identifying tags as the row key.  `_timeKey` preserves the source timestamp’s full precision while the date field displays milliseconds.  InfluxDB uses scheduled snapshots.

## Prometheus

Choose {{ui:sources.kind.prometheus}}, enter a {{ui:sources.engines.promql}}, and set {{ui:sources.engines.step}} and the time window.  Each numeric sample becomes a row.  Labels become fields prefixed with `label.` so a label cannot replace `time` or `value`.  `_series` and `time` identify each sample.  Nonfinite values become empty cells.  Queries returning native histograms need an expression that produces numeric samples instead.

Prometheus uses scheduled snapshots.  Automatic time bounds round down to multiples of {{ui:sources.engines.step}} so overlapping reads keep the same sample keys.  Explicit start and end times stay as entered.  A rolling window can remove older rows when they leave it.  Adjust the synced table’s removal settings if older samples should remain.

## Fleet checks

Every engine runs in `ops/test-fleet/compose.yaml`, and all eight services share the `sources-search-graph` profile.  Start them under a project name of your own, seed them, run the live suite, and remove that project’s containers and volumes:

```sh
docker compose -p rio-sources-search-graph -f ops/test-fleet/compose.yaml --profile sources-search-graph up -d --wait
node ops/test-fleet/search-graph-smoke.mjs
docker compose -p rio-sources-search-graph -f ops/test-fleet/compose.yaml --profile sources-search-graph down -v
```

The smoke runner reads each engine’s credentials from its own container, makes the one database InfluxDB 3 starts without, and sets `RIOSOMA_TEST_ELASTICSEARCH_SETTINGS`, `RIOSOMA_TEST_OPENSEARCH_SETTINGS`, `RIOSOMA_TEST_MEILISEARCH_SETTINGS`, `RIOSOMA_TEST_TYPESENSE_SETTINGS`, `RIOSOMA_TEST_NEO4J_SETTINGS`, `RIOSOMA_TEST_INFLUXDB_SETTINGS` for version 2, `RIOSOMA_TEST_INFLUXDB3_SETTINGS` for version 3, and `RIOSOMA_TEST_PROMETHEUS_SETTINGS`.  Each value is JSON with a `connection` and its `secrets`.  An engine with no settings is skipped on its own, so one running engine is enough.  Every run makes fixtures named `sources-search-graph` followed by random digits, and removes them when it finishes.

The rest of the suite runs without containers, on recorded responses: signing, headers, paging, filters, sorting, field types, value conversion, and each refusal.  Browser specs cover setup, diagnostics, help, deep links, and the phone layout without an engine.
