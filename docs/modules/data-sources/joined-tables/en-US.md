---
id: joined-tables
title: Joined tables, value pins, and sync history
summary: Combine matching rows, keep a local value, and see what a source changed.
area: data-sources
order: 18
level: advanced
anchors: [sync.history, grid, grid.record.expand, joined.setup, overrides.settings]
related: [comments-and-history, undo]
sections: [sync.history=read-sync-history, joined.setup=joining-tables, overrides.settings=pin-computed-values]
---

## Joining tables

Open a table and choose {{ui:joined.create}}.  Choose another table, then choose a suggested match or pick the two key fields yourself.  {{ui:joined.addStep}} includes more tables from the same database.  Choose up to 500 fields under {{ui:joined.fields}} and give the result a name.

{{ui:joined.inner}} keeps matching pairs.  {{ui:joined.left}} also keeps earlier rows without matches.  {{ui:joined.full}} keeps unmatched rows from both sides.  Empty keys do not match.  Duplicate keys produce a row for every matching pair.  Each additional join applies to the result of the earlier joins.

Joined rows follow changes to their inputs.  Live inputs are read before the joined table opens.  A failed source read reports a failure.  Fields and record rules on the input tables also apply to the joined result.  You can open, filter, sort, and share a joined table’s address like another table.

Restrictions follow joined fields through later joins, formulas, lookups, and rollups.  Public links exclude fields derived from restricted inputs.  A joined copy of a link field is hidden when record rules limit which linked records you can read.  Live updates and pin tooltips follow your access to the source values.

You cannot add or delete joined rows by hand.  Editing a joined value pins it locally.  The source value remains available in the tooltip and record panel.  Choose {{ui:synced.override.clear}} to return to it.  A pin clears when its source agrees with it.

A snapshot, copy, or template of the database keeps a joined table's definition, its rows, and the input records each row joins, under the copy's own identifiers.

## Map corresponding columns

In the joined-table setup, open {{ui:joined.mapping.title}}.  Suggestions compare normalized names, compatible types, and values on matching joined rows.  Join keys are always proposed.  Each proposal includes confidence and a reason, such as agreeing values in 98% of matching rows.  Complementary values on unmatched full-join rows can also support a suggestion.

Choose {{ui:joined.mapping.acceptAll}} to accept the proposals, or accept and reject them individually.  To add a mapping yourself, choose {{ui:joined.mapping.firstColumn}} and {{ui:joined.mapping.secondColumn}}, then choose {{ui:joined.mapping.add}}.  Change {{ui:joined.mapping.outputName}} to name the result.  Move sources up and down to change which value wins.  Split a mapping to return its sources to separate columns.  A conversion that would lose information is refused with a reason.

For example, Orders has `cust_name` and `sku`, while Customers has `customer_name` and `product_code`.  Their joined rows contain the same customer names and product codes.  Accept both mappings to get one customer-name column and one product-code column.  Orders comes first by default.  If an Orders value is empty, the Customers value supplies it.  In a full join, unmatched Customers rows still populate those columns.  You can move Customers first for either column.

On an existing joined table, choose {{ui:joined.mapping.title}}.  The address preserves this panel with `dataPanel=mapping`.  Column headers and field details list the readable sources in precedence order.  Each reader gets values only from permitted source columns, and hidden sources never appear in the source list.  Filters, sorts, groups, formulas, lookups, dashboards, exports, and tools use that same value.  Source edits, source pins, and syncs refresh the result.  Existing joined tables keep their separate columns until you change their mappings.

## Pin computed values

A database owner can open {{ui:overrides.settings}} and turn on {{ui:overrides.enableComputed}}.  Open a record and enter a value beside its formula, lookup, or rollup, then choose {{ui:overrides.pin}}.  Other fields remain ordinary edits.  Pins respect field locks and record rules, appear in record history, and can be undone.

## Read sync history

Choose {{ui:syncHistory.title}} on a synced or joined table to see run outcomes, start and end times, and counts.  A joined table records a run each time a refresh of its inputs changes it, and counts the pins that refresh cleared.  {{ui:syncHistory.more}} opens older runs.  The address preserves the selected history page.

Open a record’s {{ui:record.tab.history}} tab to see the source values before and after each change.  Source changes are recorded even while a pin keeps the displayed value unchanged.  History keeps 90 days by default.  An owner can change {{ui:syncHistory.retention}} under {{ui:overrides.settings}}.  Expired runs and their source value changes are removed together.

## API and tools

The API exposes joined table creation at `POST /api/v1/databases/:databaseId/joined-tables`, override settings at `PATCH /api/v1/tables/:tableId/overrides`, and clearing pins at `POST /api/v1/tables/:tableId/clear-overrides`.  Record updates can pin enabled computed values.  Creation takes the ordinary table definition plus `joined`, with a base table, ordered join steps, and selected field mappings.

Read runs at `GET /api/v1/tables/:tableId/sync-history` and record changes at `GET /api/v1/tables/:tableId/records/:recordId/history`.  Both return a `next` cursor for older entries.  MCP exposes `create_joined_table`, `configure_overrides`, `clear_overrides`, `get_sync_history`, and `get_record_history`.  Rio can read both histories and propose joined table and pin changes through the same commands.


Propose mappings at `POST /api/v1/databases/:databaseId/column-suggestions` with `baseTableId` and `steps`.  Each suggestion returns ordered `sources`, `confidence`, `matchingRows`, `agreement`, and an explanation key with parameters.  In a joined table's `fields`, keep `tableId`, `fieldId`, and `outputFieldId`, and add `sources: [{ tableId, fieldId }, ...]` for a mapped output.  The first nonempty readable source wins.  Change existing mappings at `PATCH /api/v1/tables/:tableId/joined-columns`, including optional `joinedFields` output definitions alongside `baseTableId`, `steps`, and `fields` to split or widen outputs.  You can also use `table.update` with `joined` and `joinedFields` to add, rename, and split outputs atomically.  MCP exposes `suggest_joined_columns` and `configure_joined_columns`, which accepts `tableId`, `joined`, and optional `joinedFields` output definitions.  Rio can request mapping suggestions with `get_schema`, explain the proposal, and apply ordered mappings through its usual change preview.
