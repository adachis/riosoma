---
id: rest-api
title: Using the REST API with a personal access token
summary: Create a token in Settings, then read and write records from scripts and other apps.
area: administration
order: 1
level: advanced
related: [views, fields, undo, trash-and-favorites, webhooks, mcp, airtable-api, javascript-sdk, command-line-tool]
routes: [/settings/tokens, /settings/*/tokens, /admin/*/tokens]
anchors: [settings.tokens]
sections: [settings.tokens=creating-a-token]
---

The REST API lets scripts and other apps read and change records.  Each request carries a personal access token, which acts as you within limits you choose.  A token follows your role in each database, so it never does more than you can, and it stops working if your account is deactivated.

Value errors identify the cell in `params`: `field` is its field name, `fieldId` is its field ID, `recordId` is its record ID, and `recordIndex` is its position in the submitted records, counting from zero.  These details also pass through the compatible API and MCP tools.  For a new record, the error includes the ID allocated for that attempted write.  When a large request is split into commands, the position still counts from the start of your request.

Link field options include `limitToViewId` for a saved destination view, or `filter` for a filter-builder group.  A condition can use `currentFieldId` to compare with a field in the source record.  Choose one limit type.  `displayFieldIds` chooses up to three distinct destination fields for the picker.  Field creation and updates accept these options, and schema reads return them.  Record writes enforce the limits on either side of the link and return a plain refusal when a linked record is outside the allowed choices.

## Creating a token

Choose {{ui:shell.nav.settings}}, then {{ui:settings.nav.tokens}}, then {{ui:tokens.create}}.  Guests don't have this section.

1. Enter a {{ui:tokens.name}} that says what will use the token.
2. Under {{ui:tokens.scopes}}, choose only what it needs.  Listing databases and tables takes {{ui:tokens.scope.schemaRead}}, reading records takes {{ui:tokens.scope.recordsRead}}, writing them takes {{ui:tokens.scope.recordsWrite}}, and changing tables, fields, and views or managing webhooks takes {{ui:tokens.scope.schemaWrite}}.  See {{doc:webhooks}}.
3. Under {{ui:tokens.databases.pick}}, choose {{ui:tokens.databases.allLabel}}, or choose {{ui:tokens.databases.chosen}} and pick them.
4. Under {{ui:tokens.expiry}}, choose when it stops working.  The default is 90 days.
5. Choose {{ui:tokens.create}}, then {{ui:tokens.copy}}.

Riosoma shows the token only this once, so store it somewhere safe, such as a password manager, before you choose {{ui:tokens.done}}.  Anyone who has it can use it as you.  If you lose it, create another.

The list shows when each token was last used.  To revoke one, choose {{ui:tokens.delete}} and confirm.  Anything using it stops working at once.

## Sending requests

Requests go to your server's address followed by `/api/v1`, with the token in an `Authorization` header:

```
curl https://riosoma.example.com/api/v1/databases \
  -H "Authorization: Bearer rio_pat_…"
```

- `GET /api/v1/databases` lists the databases the token can reach.
- `GET /api/v1/databases/db…/tables` lists a database's tables with their fields and views, including the IDs other requests need.
- `GET /api/v1/tables/tbl…/records` reads records, and `GET /api/v1/tables/tbl…/records/rec…` reads one.

Errors return JSON with a `code` and a `message`.  Anything outside the token's reach returns not found.  The full reference is at `/api/v1/openapi.json`, which needs no token.

Scripts and client libraries written for Airtable's Web API can use Riosoma's copy of it at `/v0` with the same token.  See {{doc:airtable-api}}.

## Reading records

These query parameters shape a read:

- `view` applies a view's filter and visible fields, by name or ID.  Its sorts apply after yours.
- `fields` limits the fields returned.  Repeat it for each field, by name or ID.
- `filter` takes a JSON filter group, and `sort` takes a JSON list of sorts.  Both name fields by ID.
- `pageSize` sets how many records come back, up to 100.  For the next page, send the response's `next` as `cursor`, with the other parameters unchanged.
- `shape` picks a response form.  `keyed`, the default, maps record IDs to their fields and lists the IDs in `order`.  `list` returns an array of records with `id` beside their fields.  `airtable` puts each record's `fields` beside its `id` and `createdTime`, and names the next cursor `offset`.
- `fieldKey=id` keys fields by ID instead of name, so renaming a field won't break your script.
- `cellFormat=string` returns values as text, the way the app shows them, formatted for `locale` and `timeZone`.  They default to `en-US` and UTC.

This reads a view's records where a number field is at least 100:

```
curl -G https://riosoma.example.com/api/v1/tables/tbl…/records \
  -H "Authorization: Bearer rio_pat_…" \
  --data-urlencode "view=Open orders" \
  --data-urlencode 'filter={"conjunction": "and", "conditions": [
    {"id": "c1", "fieldId": "fld…", "operator": "gte", "value": 100}]}'
```

## Writing records

Send JSON with up to 1,000 `records` per request.  Each record's `fields` are keyed by name, or by ID with `"fieldKey": "id"`.

- `POST` creates records.
- `PATCH` changes only the fields you send, for records identified by `id`.
- `PUT` replaces records identified by `id`, clearing any field you leave out.
- `DELETE` with `?records=rec…&records=rec…` moves records to the trash for 30 days.  See {{doc:trash-and-favorites}}.

A write needs your permission only for the fields whose values it changes.  So a replace goes through when it leaves a field that's locked to you as it is, whether that field is already empty or you send back the value it has, and it's refused when it would clear or change that field.

Values use readable forms: select options by name, people by ID or email, linked records by ID, files by ID or by address, percentages as fractions, and durations in seconds.  Dates look like `2026-10-15`, or `2026-10-15T14:30:00Z` for fields that include a time.  With `"typecast": true`, text becomes numbers, checkboxes, and dates, and unknown select options are added.  Adding options takes the {{ui:share.role.creator}} or {{ui:share.role.owner}} role.

This creates a record and adds "To do" as a status option if it's new:

```
curl -X POST https://riosoma.example.com/api/v1/tables/tbl…/records \
  -H "Authorization: Bearer rio_pat_…" \
  -H "Content-Type: application/json" \
  -d '{"typecast": true, "records": [
    {"fields": {"Name": "Order paper", "Status": "To do"}}]}'
```

Writing takes the {{ui:share.role.editor}}, {{ui:share.role.creator}}, or {{ui:share.role.owner}} role.  Changes follow the same rules as edits in the app and appear right away for anyone with the database open.  The response returns the records as they now stand.

## Changing tables, fields, and views

A token with {{ui:tokens.scope.schemaWrite}} can create, rename, reorder, and trash tables, fields, and views.  This takes the {{ui:share.role.creator}} or {{ui:share.role.owner}} role.  Each change passes the same checks as the app and appears right away for anyone with the database open.  The response returns what changed, and its `undoGroupId`, also sent as the `x-undo-group-id` header, names the change so you can undo it in the app.  See {{doc:undo}}.

- `POST /api/v1/databases/{databaseId}/tables` creates a table from a `name`, a `description`, and its `fields`.  The first field is the primary field.  The table starts with a grid view named by `viewName`, or "Grid view".
- `PATCH /api/v1/tables/{tableId}` changes its `name` or `description`, and `index` moves it to that place in the sidebar, counting from 0.
- `POST /api/v1/tables/{tableId}/fields` adds a field from a `name`, a `type`, and its `options`.  Options take the same settings as the field dialog and pass the same checks.
- `PATCH /api/v1/fields/{fieldId}` changes its `name`, `description`, or `options`, which replace the ones it has.  A new `type` converts the field as the field dialog does.
- `POST /api/v1/tables/{tableId}/views` adds a view from a `name` and a `type`, which is `grid` unless you choose another.
- `PATCH /api/v1/views/{viewId}` changes its `name`, moves it with `index`, and puts the fields listed in `fieldOrder` first, by ID.
- `DELETE` on a table, field, or view moves it to the trash for 30 days.  See {{doc:trash-and-favorites}}.

The SDK exposes these endpoints as `client.tables.create/update/trash`, `client.fields.create/update/trash`, and `client.views.create/update/trash`.  Each takes the target ID and, for creates and updates, the request body, and returns the same result with `undoGroupId`.  See {{doc:javascript-sdk}}.

MCP clients use `create_table`, `update_table`, `trash_table`, `create_field`, `update_field`, `trash_field`, `create_view`, `update_view`, and `trash_view`.  Create and update tools take the REST request body in `input` alongside the target ID.  They require the same schema write scope and database role, return the same undo group, and are marked as changes for client confirmation.  See {{doc:mcp}}.

Select choices need only a `name`, and a `color` if you like.  A choice named like one the field already has keeps that choice, so the cells holding it keep their values.  Choices you leave out are removed, and their cells are emptied, as in the field dialog.

Each schema request commits all its changes together.  If any check fails, the schema, cell values, and history keep their previous state.  Changing a select’s source table converts its values even when you send only `options`.  A link’s target table cannot change through this API.  Create a new link field to choose a different target.

This adds a status field with two choices:

```
curl -X POST https://riosoma.example.com/api/v1/tables/tbl…/fields \
  -H "Authorization: Bearer rio_pat_…" \
  -H "Content-Type: application/json" \
  -d '{"name": "Status", "type": "singleSelect",
    "options": {"choices": [{"name": "To do"}, {"name": "Done"}]}}'
```

## Arranging records in a view

POST to `/api/v1/tables/{tableId}/records/move` with `viewId`, `recordIds`, and `place`, containing either a `before` or an `after` record ID.  This saves manual order in a list, gallery, or kanban view with no {{ui:view.toolbar.sort}}.  Other views keep their own orders.  The response includes `undoGroupId` and the `x-undo-group-id` header for the one undo action.

The `move_records` MCP tool takes the same input with `tableId`.  Rio can propose the same `record.move` command.  All paths check edit access, visible records, record locks, and view locks.  Update a kanban grouping field, calendar dates, or Gantt dependency links with the existing record update operation.

## Attaching files by address

An attachment field takes a list.  Each item is the ID of a file already in that field, or an object with a `url` and, if you like, a `filename`, the way Airtable's API takes them.  Riosoma downloads each address, stores the file the way it stores an upload, and keeps the file's ID.  Without a `filename`, the file is named after the last part of the address.  Attachments a read returned can go back as they are, since their `id` keeps the file.

This keeps one file and adds another from an address:

```
curl -X PATCH https://riosoma.example.com/api/v1/tables/tbl…/records \
  -H "Authorization: Bearer rio_pat_…" \
  -H "Content-Type: application/json" \
  -d '{"records": [{"id": "rec…", "fields": {"Files": [
    {"id": "att…"},
    {"url": "https://files.example.com/plan.pdf", "filename": "Plan.pdf"}]}}]}'
```

- Addresses must use `https`, and neither they nor any redirect may lead to a private network, unless the server's operator sets `RIOSOMA_AUTOMATIONS_ALLOW_PRIVATE_HOSTS=true`.
- Each file can be as large as an upload, up to 1 GB.
- A request can name up to 50 addresses, and one record up to 10.
- The field has to be one you can change.  Riosoma checks that, and that you can see the records you're changing, before it downloads anything.
- Every download finishes before anything is written, and the downloads have two minutes together.  If one fails, nothing is written, and the error's `messageKey` says why: `api.file.blocked` for an address that isn't allowed, `api.file.tooLarge`, `api.file.notFound`, `api.file.timedOut`, or `api.file.failed` for anything else.  Its `params` name the `field`, `fieldId`, `recordId`, and original `recordIndex`, along with the `record` and `item` positions, counting from 0, and the `address` without its query.

## Upload a local attachment

POST raw bytes to `/api/v1/tables/{tableId}/fields/{fieldId}/files` with a bearer token holding {{ui:tokens.scope.recordsWrite}}.  Put the percent-encoded filename in `x-file-name`.  The attachment field must be visible and editable.  The response is the uploaded file's metadata, including its ID and scan state.  This stages the file without changing a record.  Include its ID in an attachment field in a subsequent record create or update.  File scanning, upload limits, and cleanup follow the same rules as uploads in the app.

## Concurrent text edits

When updating long text, rich text (Markdown), or JSON, send `baseFields` beside each record's `fields`.  Use the same field names or IDs and the values returned by the read that started the edit, including `null` for an empty cell.  JSON bases use JSON values, just like JSON writes.  With `typecast`, JSON text is accepted too.

```json
{
  "records": [{
    "id": "rec00000000000001",
    "fields": { "Notes": "First paragraph.  Revised ending." },
    "baseFields": { "Notes": "First paragraph.  Original ending." }
  }]
}
```

The server compares and merges inside the write transaction.  Independent prose edits merge by word.  JSON merges by line after formatting and must still parse.  A clean merge returns the stored result and a `textMerges` array in the response body containing each merged cell, its value, and the other change's author and time.  Conflicts return HTTP 409 with `error.conflicts`: the table, record, and field IDs, `base`, `ours`, `theirs`, `updatedBy`, `updatedAt`, `name`, and an editable `proposal` whose conflicting spans have `<<<<<<<`, `=======`, and `>>>>>>>` markers.  A conflicting command stores nothing.  Remove markers before submitting an edited proposal.

Resolve against the returned `theirs` value as the new base.  Keeping your version sends your original text with that base.  Using the other version sends `theirs` with that base.  A newer change is checked again.  Omitted bases retain last-write-wins behavior.  No version column or migration is required.  Undo restores the value immediately before the merged save.

JSON conflict values and merge notices contain the stored JSON text.  Parse that text before resubmitting it in `fields` or `baseFields`, or send `typecast: true` to accept JSON text directly.

The app command bus accepts `baseValues` keyed by field ID in each `record.update` row and reports clean merges in `output.textMerges`.  The MCP `update_records` and `propose_record_update` tools accept `baseFields` and return merges or conflicts in structured results.  Rio proposals retain observed text bases through approval.  Automation `updateRecord` steps accept optional `baseValues` templates keyed by field ID.  Upsert imports retain text bases from their review.  Public form edit requests accept `baseValues`, return conflicts in the same error shape, and include `textMerges` on a merged response.  Permissions, validation, locks, record rules, audit, and cell history still apply.
