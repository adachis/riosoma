# Duplicate actions

Record, field, and table duplication use the database command bus.  Each command receives an `id` and a `groupId`.  Retries of the same command are idempotent.  All mutations in the command share one audit and live-change sequence stream and one undo group.

- `record.duplicate`: `tableId`, `recordIds`, optional `viewId` and `timeZone`.  Copies editable values, retains attachment IDs, creates new line-item records, and recomputes calculated values.  An unsorted view places each copy immediately after its source.  Unwritable fields receive creation defaults.  A copy outside the person's record rules is refused atomically.
- `field.duplicate`: `fieldId`, `newFieldId`, `name`, and `withValues`.  Copies the definition, permissions, and conditional formatting for the field.  Views place the field after its source and preserve visibility.  Paired links receive new inverse fields.  One-way links remain one-way.
- `table.duplicate`: `tableId`, `newTableId`, `name`, and `withRecords`.  Copies fields, views, forms, settings, and permissions.  Internal links use the new table and record identities.  External links keep their destinations.  Synced and joined tables become ordinary tables containing their stored snapshot.  Live source records and owned line-item tables cannot be copied independently.

REST v1 exposes POST `/api/v1/tables/:tableId/records/duplicate`, `/api/v1/fields/:fieldId/duplicate`, and `/api/v1/tables/:tableId/duplicate`.  The response includes new object IDs and `undoGroupId`, also returned as `x-undo-group-id`.  REST and MCP generate new field and table IDs for callers.

MCP exposes `duplicate_records`, `duplicate_field`, and `duplicate_table`, plus `get_duplicate_job` and `cancel_duplicate_job`.  REST offers matching GET `/api/v1/duplicate-jobs/:jobId` and POST `/api/v1/duplicate-jobs/:jobId/cancel`.  Rio's matching tools always create an approval preview before applying a copy.

Tables with more than 1,000 records run in the background, with at most two workers per server.  Rio previews show up to 25 copied records before approval.  Approved large table copies use the same job ledger and progress controls.  The returned `jobId` identifies progress and cancellation.  Cancellation rolls back the entire transaction.  Progress survives a disconnected browser, and unfinished work from a stopped server is marked failed.

Migration 0109 permits attachment metadata to share stored bytes and creates the table-copy job ledger.  Purging an attachment retains its bytes while another attachment references them.

## Use duplicate actions

Choose {{ui:duplicate.record.title}} from a grid row's context menu or the record's menu.  Copies appear after the originals in a manually ordered view, or in their sorted positions.  Reversing a copy leaves it and its line items in place if either has been edited afterward.  An unchanged copy can be reversed even when its copied values match the table's conditional lock policy.  Later manual locks and changes to your access still apply.

Choose {{ui:duplicate.field.title}} from a field header or its edit dialog.  Enter a name, and select {{ui:duplicate.field.values}} to include stored values.  Reversing the copy removes its column placement and formatting while preserving later changes to other view settings.

Choose {{ui:duplicate.table.title}} from the table's sidebar menu, and select {{ui:duplicate.table.records}} to include records.  Each copied view keeps its manual order.  Internal links that limit choices to a view use the corresponding copied view.
