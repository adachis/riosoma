---
id: airtable-api
title: Moving an Airtable integration to Riosoma
summary: Point scripts, integrations, and Airtable's client libraries at Riosoma by changing the address and the token.
area: administration
order: 1
level: advanced
related: [rest-api, airtable-import, formulas, ai-fields, webhooks, undo, trash-and-favorites]
---

Riosoma answers Airtable's Web API at `/v0`, beside its own REST API.  Scripts, integrations, and client libraries written for Airtable keep working when you point them at your server and give them a Riosoma personal access token: the paths, the request and response shapes, the errors, and the paging are Airtable's.  Everything happens as you, so a token never sees or changes more than you can, and fields and records hidden from you never appear.

## Moving a script over

1. Create a personal access token.  Choose {{ui:shell.nav.settings}}, then {{ui:settings.nav.tokens}}, then {{ui:tokens.create}}.  The scopes have Airtable's names, so pick the ones the script had there: {{ui:tokens.scope.recordsRead}} for `data.records:read`, {{ui:tokens.scope.recordsWrite}} for `data.records:write`, {{ui:tokens.scope.schemaRead}} for `schema.bases:read`, and {{ui:tokens.scope.schemaWrite}} for `schema.bases:write`.  See {{doc:rest-api}}.
2. Change the address from `https://api.airtable.com` to your server's address.  The paths stay the same, starting with `/v0/`.
3. Swap Airtable's token for the Riosoma one.
4. Change the base ID.  Each database answers to its own ID, which starts with `db`, and to an Airtable-style alias, which is `app` followed by the same characters.  `GET /v0/meta/bases` lists the aliases.  A database imported from Airtable also answers to the ID of the base it came from, so a script that names tables and fields by name may need no other change.  See {{doc:airtable-import}}.

```
curl "https://riosoma.example.com/v0/appXXXXXXXXXXXXXX/Tasks?maxRecords=3&view=Grid%20view" \
  -H "Authorization: Bearer rio_pat_…"
```

With Airtable's JavaScript client, set `endpointUrl`:

```
const Airtable = require('airtable')
const base = new Airtable({
  apiKey: 'rio_pat_…',
  endpointUrl: 'https://riosoma.example.com',
}).base('appXXXXXXXXXXXXXX')
```

Other client libraries have a setting for the API's address too.

## What works

- Listing records, with `GET /v0/{baseId}/{tableIdOrName}` or with a JSON body at `POST …/listRecords`.  Every parameter works: `fields[]`, `filterByFormula`, `maxRecords`, `pageSize` up to 100, `sort[0][field]` and `sort[0][direction]`, `view`, `cellFormat`, `timeZone`, `userLocale`, `returnFieldsByFieldId`, and `offset` for the next page.
- Reading one record, and creating, updating, replacing, and deleting up to 10 records at a time.  `typecast` turns text into numbers, dates, and checkboxes and adds new select options.  `performUpsert` with `fieldsToMergeOn` updates the record whose fields match, or creates one when none does.
- `GET /v0/meta/bases`, `GET /v0/meta/bases/{baseId}/tables` with `include[]=visibleFieldIds`, and `GET /v0/meta/whoami`.
- Changing a base's schema: `POST /v0/meta/bases/{baseId}/tables` creates a table, `PATCH …/tables/{tableIdOrName}` changes its name and description, `POST …/tables/{tableIdOrName}/fields` creates a field, and `PATCH …/fields/{fieldId}` changes a field's name and description.  Requests and responses have Airtable's shapes, and the field types Airtable can't create, such as formulas and rollups, get `UNSUPPORTED_FIELD_TYPE_FOR_CREATE`.
- Tables, fields, and views by name or ID.
- `filterByFormula` in Airtable's formula language, with its function names.  See {{doc:formulas}}.
- Airtable's errors, such as `INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND` for a base or table your token can't reach, `NOT_FOUND`, `ROW_DOES_NOT_EXIST`, `UNKNOWN_FIELD_NAME`, `INVALID_MULTIPLE_CHOICE_OPTIONS`, and `INVALID_FILTER_BY_FORMULA`.  Too many requests get `429` with a `Retry-After` header, which Airtable's clients wait out on their own.

Writes go through the same checks and history as edits in the app, so they can be undone there, and deleted records go to the trash for 30 days.  A schema change's `x-undo-group-id` header names it for undo.  See {{doc:undo}} and {{doc:trash-and-favorites}}.

## Differences

**IDs.**  Records, tables, fields, and views have Riosoma's IDs, including in a database imported from Airtable, so a script that names records by their Airtable IDs needs the new ones.  Select options' IDs start with `cho`, not `sel`.

**Field types Airtable doesn't have.**  They come through as the nearest shape, and the metadata names that shape's type:

- A JSON field is its JSON text, as `multilineText`.  Send JSON text to change it.
- A location is text like `Ferry Building (37.7955, -122.3937)`, as `singleLineText`.  Send the same text to change it.
- A date range is its two ends as `2026-10-01/2026-10-05`, as `singleLineText`.  Send the same text to change it.
- A signature is the time it was signed.  Only a person can sign, so this API reads signatures and never writes them: the metadata describes one as a `lastModifiedTime` field of its own, a type clients know they can't write, a write that names one gets `INVALID_VALUE_FOR_COLUMN`, and a replace leaves it as it is.
- A record ID field is the record's ID, as a formula of `RECORD_ID()`.
- An AI field sends values of its own type, which its model fills in.  The metadata describes it as a formula that reads itself, a type clients know they can't write, with the field's own type as the result.  A write that names one gets `INVALID_VALUE_FOR_COLUMN`, and a replace leaves it as it is, unless the request sends `"overrideAiFields": true`, as the REST API takes it.  See {{doc:ai-fields}}.
- Formulas that give true or false send `true`, and leave the field out when false, as checkboxes do.
- A new currency field's `symbol` picks the currency it stands for, with `$` as US dollars, and a new field's colors become Riosoma's nearest color.
- List views come through as `grid`, Gantt views as `timeline`, and charts, pivot tables, and maps as `block`.  Brown select options come through as `orangeDark1`.

**Attachments.**  Their addresses point at your server and open for people signed in to Riosoma.  They aren't links that anyone can open for a few hours, as Airtable's are, so a script can't download a file from its address alone.  Writing attachments works as it does on Airtable: send `{ "url": …, "filename": … }` for a new file, or the `id` of one the field already has.

**Formulas.**  A formula can name only fields you can see.  A function Riosoma doesn't have, such as `SET_LOCALE`, gets `INVALID_FILTER_BY_FORMULA` with its name.  Most formulas filter in the database, including ones that use `FIND`, `SEARCH`, `LOWER`, `UPPER`, `TRIM`, `LEN`, `ARRAYJOIN`, and `ROUND` with its precision written as a number.  A few functions, such as `REGEX_MATCH`, `DATETIME_FORMAT`, and `MID`, are worked out record by record instead, so they take longer.  Those can filter at most 100,000 records.  Past that, the list gets `INVALID_FILTER_BY_FORMULA` naming the function, so filter with a view first or write the formula another way.

**Paging.**  An `offset` lasts while your server keeps that list's order in memory, which it lets go of when it needs the room or restarts.  After that, the next page gets `LIST_RECORDS_ITERATOR_NOT_AVAILABLE`, as an old offset does on Airtable, and the script starts the list again.

**Upserts.**  `fieldsToMergeOn` can name text, number, date, single select, and checkbox fields, and values match exactly.  An upsert matches only records you can see.

**Limits.**  Each token can make 50 requests a second, and your server's operator can change that with `RIOSOMA_AIRTABLE_API_SECOND_LIMIT`.  Airtable's limit of 5 requests a second for each base doesn't apply.

**What isn't here.**  `recordMetadata` for comment counts is ignored, and `typecast` doesn't find linked records by name, so links take record IDs.  Airtable's routes for views, comments, and webhooks aren't available.  To trash a table or field, or to create and change views, use the REST API.  See {{doc:rest-api}}.  Riosoma's own webhooks tell other apps about changes.  See {{doc:webhooks}}.  Tables that read their source live can't be read through this API.

## Concurrent text edits

Record PATCH and PUT requests, including upserts, accept an optional `baseFields` object on each record (or beside `fields` for a single-record request).  Keys follow `fields`.  Values are what the caller read before editing.  Long text and rich text use their text or Markdown, and JSON uses its JSON value.  Omitted bases retain last-write-wins behavior.

Independent edits merge inside the command bus.  The returned record contains the merged text, and a `textMerges` array in the response body reports the affected cells, values, authors, and timestamps.  An overlap or an invalid merged JSON value returns HTTP 409 with `error.type: "TEXT_CONFLICT"` and `error.conflicts`, including `theirs`, the stored value, and an editable `proposal` with conflicting spans marked.  The conflicting command stores nothing.  Resolve explicitly by resubmitting the chosen text with `theirs` as the new base.  That retry checks for intervening edits again.  Undo restores the version immediately before the save.

For JSON fields, conflict values and merge notices contain JSON text.  Parse it before resubmitting it in `fields` or `baseFields`, or use `typecast: true` to accept JSON text directly.
