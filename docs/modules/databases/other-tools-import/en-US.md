---
id: other-tools-import
title: Importing from another tool
summary: Bring a whole database across from a tool you already run, from your own server or the tool's hosted service, and see a report of what changed.
area: databases
order: 15
level: simple
related: [airtable-import, importing, linked-records, formulas, views, attachments]
---

Importing from another tool makes a new database from a whole NocoDB base, Baserow database, Grist document, Teable base, SeaTable base, ClickUp lists, Asana projects, Notion database, monday.com board, or Smartsheet sheet: every table, field, and record, the links between records, attachments, and the views the tool shares.  It works with a server you run yourself and with each tool's hosted service.  When it finishes, a report says what came across exactly, what changed, and what was left out.

## Before you start

Riosoma reads the tool through its own API, so it needs the tool's address and a way in:

- **NocoDB:** an API token.  Make one in NocoDB under Account settings, Tokens.  The hosted service is at `https://app.nocodb.com`.
- **Baserow:** a database token, or your email address and password.  Make a database token under My settings, Database tokens, with read access to the database.  The hosted service's API is at `https://api.baserow.io`.
- **Grist:** an API key.  Make one in Grist under Profile settings, API.  The hosted service is at `https://docs.getgrist.com`, and a team site has an address of its own.
- **Teable:** a personal access token.  Make one in Teable under your account, Developer, and give it read access to the bases you want.  A token that can list every base shows all of them, and one scoped to some bases lists those, through the spaces they live in.  The hosted service is at `https://app.teable.io`.
- **SeaTable:** an API token for one base.  Make one in SeaTable inside the base, under its Advanced settings, API access, with read permission.  Riosoma exchanges it for the short-lived token SeaTable's own API reads with, so the list holds that base alone.  The hosted service is at `https://cloud.seatable.io`.
- **Notion:** a connection token with read content permission.  [Create a connection](https://www.notion.so/profile/integrations), then share the databases with it.  Use `https://api.notion.com` for {{ui:import.platform.address}}.  Riosoma finds databases shared with the connection and groups them by their parent pages when those pages are accessible.
- **monday.com:** a personal API token.  [Open the developer center](https://monday.com/developers/apps), then choose My access tokens.  Use `https://api.monday.com` for {{ui:import.platform.address}}.  The board picker groups boards by workspace and follows the same filtering and collapse rules as the other platforms.

For a server you run yourself, use the address you open it at, including any path after the host.  Riosoma uses what you give it only for the import.  While the import runs it's sealed with the server's key, and when the import ends, however it ends, it's forgotten.  It never appears in logs.

An address on a private network, like a server in your office, works only once the server's operator sets `RIOSOMA_AUTOMATIONS_ALLOW_PRIVATE_HOSTS=true`, the setting webhooks and automations follow too.  Plain `http` works only for addresses that setting allows, so a token never crosses the internet unencrypted.

## ClickUp and Asana

Choose {{ui:import.platform.tool.clickup}} or {{ui:import.platform.tool.asana}} in {{ui:import.platform.menu}}.  Paste a token and use {{ui:import.platform.makeToken}} to open the service’s token page if you need one.  ClickUp tokens are under Settings, Apps.  Asana personal access tokens are in the developer console.

List what the token can read.  ClickUp lists are grouped by workspace, space, and folder, including folderless lists.  Asana projects are grouped by workspace and team, including teamless and archived projects.  Select several lists or projects to bring them into one database, with one table for each.  Select all the items in a workspace to migrate that workspace’s readable task data.

Choose {{ui:import.platform.preview}} to review {{ui:import.platform.previewTitle}} and the known fidelity differences before creating a database.  The preview reads metadata only.  Record conversion and attachment failures appear in the final report.

Task link fields are created only for referenced tables found during the import.  Empty relations do not create fields.  Preview warns when the selection could exceed the field limit, which includes inverse link fields.  Source fields take priority over task link fields, and the final report lists any fields or links left out because of the limit.

Subtasks become records in their parent’s selected table, with links to the parent.  Nested subtasks are included.  Dependencies and task relationships become links between selected tables, including links within a table.  ClickUp keeps prerequisite and dependent directions in separate fields.  A task in several selected lists or projects becomes a separate record in each table, and later edits are independent.  Asana project memberships remain structured data, and each project’s sections become its own single-select field.  References to tasks outside the selection, deleted tasks, and inaccessible tasks cannot become links.  The report counts those references.

Every exposed custom field type maps to a field.  A structured-data column also keeps all task custom field values, including fields defined only on subtasks or other project memberships.  Computed values, formulas, rollups, progress, voting, and unfamiliar types retain API values with a fidelity note instead of recreating source behavior.  People match members by email where the API provides one.  Otherwise they retain names or IDs as text.  ClickUp tags become a multiple-select field, and Asana tags retain their names as text.  Dates retain API timestamps in UTC, including the source’s date-only conventions.

Attachments use the same guarded download and size limits as other imports.  Asana cloud documents without a download URL are reported as unavailable.  Their permanent web page is never downloaded as a file.  Tokens are never sent to attachment storage hosts.  ClickUp reads at most 100 requests per rolling minute, and Asana uses its free-tier limit of 150.  Both honor retry waits and back off after temporary errors.

Deleted or inaccessible Asana attachments are counted as failed files, and readable task data continues importing.  If dependency access requires a higher Asana plan, accessible dependency pages are kept, and the report notes the missing links.

[ClickUp API field documentation](https://developer.clickup.com/docs/customfields) and [Asana API field documentation](https://developers.asana.com/reference/custom-fields) describe which field values the services expose.

## Baserow and views

A Baserow database token reads tables, fields, records, and files, but Baserow shares views only with people who sign in.  So choose {{ui:import.platform.withToken}} to bring everything but views, or {{ui:import.platform.withPassword}} to bring views too.  Signing in also shows each database by its name.  Riosoma signs in once, keeps only the token Baserow answers with while the import runs, and never keeps your password.

Teable and SeaTable share their views with a token, so there's no second way in for either.

## Smartsheet

Make an [API access token](https://help.smartsheet.com/articles/2482389-generate-API-key) in Smartsheet under Account, Personal settings, API access.  Smartsheet requires a Business or Enterprise plan for API access.  Choose {{ui:import.smartsheet.region}} to match your account: United States, Europe, or Australia.  Riosoma uses the corresponding `https://api.smartsheet.com/2.0`, `https://api.smartsheet.eu/2.0`, or `https://api.smartsheet.au/2.0` API.

Choose {{ui:import.platform.menu}}, then {{ui:import.platform.tool.smartsheet}}.  Paste the token, choose {{ui:import.smartsheet.findSheets}}, and pick a sheet.  Workspace and folder paths group the list.  Sheets shared individually may have no group.  Choose {{ui:import.platform.preview}} to review field mappings, view counts, and known changes in {{ui:import.platform.previewTitle}} before you choose {{ui:import.airtable.start}}.  Each import makes one table from the selected sheet.

Row hierarchy becomes {{ui:import.smartsheet.parent}} links.  Predecessors become record links with a companion {{ui:import.smartsheet.predecessorDetails}} text field preserving dependency types and lag.  Numeric columns become numbers when every nonempty value is numeric.  Mixed text and numbers are preserved as text.  Dates, contacts, dropdowns, multi-value dropdowns, checkboxes, symbols, durations, auto-numbers, and system columns have matching fields or an explicit fidelity note.  Contacts match members by email.  System values stay fixed, and formatted auto-numbers stay as text.

Dropdowns include numeric values as labels and add choices for values observed on every page, even when they were outside the configured options.  Values that cannot fit select choices stay as text with a fidelity note.  Project dates and times with explicit offsets become dates.  If any value has no established time zone or cannot be converted, the column stays as text with a note, preserving every source value.

Durations use the sheet’s workday and workweek to become seconds.  Elapsed durations use calendar days.  Unrecognized duration strings stay as text.  Current-row column formulas become computed fields when Riosoma can express them.  Other column formulas and individual cell formulas keep values with a note.  Cell links and cross-sheet references keep their current values with a note that their connections stay in Smartsheet.

Row attachments use {{ui:import.smartsheet.attachments}}.  Sheet, comment, and proof attachments use a separate table with their source IDs.  Files use guarded downloads from temporary signed URLs without sending the API token.  External service attachment links are reported when they cannot be downloaded.  Shared filters become grid views.  Unsupported filter rules, parent inclusion, scheduling, and other view settings are reported.

Riosoma pages through sheets, rows, and attachment metadata.  Reads stay below Smartsheet’s documented 300 requests per minute, and a rate-limit response pauses requests for at least 60 seconds with increasing retry waits.  Deleted sheets are unavailable.  Sheets still readable by the token can be imported even if they are read-only or used as archives.

API callers must supply `fieldNames` with localized names for {{ui:import.smartsheet.parent}}, {{ui:import.smartsheet.attachments}}, {{ui:import.smartsheet.attachmentName}}, {{ui:import.smartsheet.attachmentParent}}, and {{ui:import.smartsheet.predecessorDetails}} before previewing or importing a sheet.  The import screen supplies these names in the current language.

The offline fixtures were independently written from the [official OpenAPI description](https://developers.smartsheet.com/_bundle/api/smartsheet/openapi.yaml) and the response shapes in [Smartsheet’s Apache-2.0 SDK test suite](https://github.com/smartsheet/smartsheet-sdk-tests).  No upstream mapping files are included.  Live validation is deferred until after merge: set `RIOSOMA_TEST_SMARTSHEET_TOKEN` and optionally `RIOSOMA_TEST_SMARTSHEET_REGION` to `us`, `eu`, or `au`, then run `smartsheet.live.test.ts`.  It only reads sheets within a workspace named exactly "Riosoma tests" and imports into a disposable local database.

## Importing

On the home screen, choose {{ui:import.platform.menu}} and pick the tool, or find it in the palette.  Check {{ui:import.platform.address}}, give the token, and look for what it can see.  Pick the base, database, or document, check {{ui:import.airtable.name}}, and choose {{ui:import.airtable.start}}.

For ClickUp, Asana, Notion, monday.com, and Smartsheet, choose {{ui:import.platform.preview}} first.  {{ui:import.platform.previewTitle}} lists the tables, field types, view counts, and fidelity changes known before reading every record.  The final report also checks record conversions, computed results, links, and file downloads.  Choose {{ui:import.airtable.back}} to change the selection and request a new preview.

Use {{ui:ui.picker.filter}} to find any part of a name, with or without accents.  Group buttons show matching counts and hide or show their items.  Your browser remembers collapsed groups for each picker.  Use the arrow keys to move through matches and Enter to choose.  The list scrolls inside the dialog while the title and actions stay visible on phones and larger screens.

The import runs on the server, so you can close the dialog.  Open it again to see how far along it is.  {{ui:import.airtable.stop}} stops it, and what it made so far goes to the trash, where you can restore it.

## What comes across

- Tables, fields, and records, with select options in their colors and each field's formatting.
- Links between records, both ways.  A link the tool shows on only one table shows on both tables here, and the new field is hidden in the views that came across.
- Lookups, rollups, and counts, with the function each rollup uses.
- Formulas, when every function they use exists here.  Each one is checked against the tool's own results, and the report says if any record came out differently.
- Attachments, downloaded into Riosoma's own file storage, up to 1 GB a file.
- People, matched to members by email address.  A people field with anyone who isn't a member keeps names and email addresses as text.
- Views, with the fields they show, their filters and sorts, and the fields they stack, cover, date, or map by.

## Each tool's differences

- **NocoDB:** a record's ID comes across as a number field, which numbers new records when NocoDB's had no gaps.  Times without a date, barcodes, and QR codes come across as text, and buttons stay in NocoDB.
- **Baserow:** a number shown with a dollar or other currency sign becomes a currency field, and one with a percent sign a percent field.  Other text around a number is left out.  Passwords never come across, since Baserow never shares them.
- **Grist:** formulas are Python.  One that's a single expression over the record's own columns, like `$Price * $Quantity` or `UPPER($Name) if $Active else ""`, becomes a formula here.  One that looks records up through a reference, like `SUM(Tasks.lookupRecords(Project=$id).Hours)`, becomes a rollup, count, or lookup.  The rest keep Grist's values, and the report shows the formula so you can rebuild it.  Each widget on a page becomes a view, and charts and custom widgets stay in Grist.
- **Teable:** a text field Teable shows as a web address, an email address, or a phone number becomes that kind of field here, since Teable keeps all three as text with a look of its own.  A number Teable draws as a bar or a ring in its cell comes across as a plain number.  A field Teable fills in by generating it keeps the values it generated, and the generation stays in Teable.  A lookup or rollup that reads only the linked records a filter picks reads every linked record here, since the filter stays in Teable.  Buttons, plugin views, and links to a base of its own stay in Teable.
- **SeaTable:** a link's records come from SeaTable's link query rather than from the row, since a row's own link column stops at fifty of them.  A link formula that counts, looks up, or rolls up linked records becomes the field here that does the same, and one that picks a single record by its largest or smallest value keeps the values it picked.  A geolocation column that names a country or region rather than a point on a map comes across as text.  Boards, calendars, and galleries are apps of their own in SeaTable rather than views, so they stay there, and a view's grouping and row colors stay there too, since a grid here has neither.  Buttons and drawn signatures stay in SeaTable.
- **Notion:** each data source inside the selected database becomes a table.  Accessible data sources reached through relations are included too.  Pages become records, and relations become links.  Scalar formulas and supported rollups become computed fields.  Other computations preserve their returned values with a fidelity note.  Rich text becomes plain text, statuses become select options, and unique IDs retain their prefix and number as text.  Date ranges remain text so both endpoints and time zones survive.  Places become location fields, with names, addresses, and provider IDs kept together in the location label, as {{ui:import.platform.report.placeDetails}} explains.  Page bodies are separate from table data: {{ui:import.platform.field.body}} is a long text field containing nested text and media references, with a note explaining that page layout and interactive blocks stay in Notion.  Views retain supported filters and sorts, with a note for layout settings that differ.  Requests stay within three per second and respect retry instructions.
- **monday.com:** the selected board and accessible connected boards become tables.  Connected boards become links, mirrors become lookups when they reference one target column through one link, and subitems become linked child tables, including nested subitems.  Groups become {{ui:import.platform.field.group}}, a single-select field.  File assets use signed download addresses and the guarded attachment download.  Formulas are read in batches of five columns.  Unsupported computations keep their values and a fidelity note.  Timelines and weeks become date ranges, locations keep their coordinates and labels, and tracked time becomes a duration, and auto-number columns stay behind because the API does not expose their values.  The importer checks complexity after each GraphQL request and waits for budget resets or rate-limit instructions.

Archived and deleted tables and records are excluded on both platforms.  Links to inaccessible tables retain the values the API exposes and report the missing target.  Neither platform changes anything in the source.

Comments, revision history, automations, webhooks, row colors, and sharing settings stay in the tool.

## The report

When the import finishes, choose {{ui:import.airtable.open}}.  The database opens with its report on top, listing what was left out and what changed, each with why, and what came across exactly, table by table.  The report stays with the database, in its settings menu, where it's named after the tool it came from.

Check the report for cells that could not be converted, links beyond the limit of 10,000 per cell, and attachments beyond the limit of 1,000 per cell.  SeaTable links are read across every page before the cell limit is applied.

Attachment downloads stay within the import’s total file allowance, including downloads running at the same time.  A file is left out and reported if its download changes origin, its platform path leaves the attachment area, or SeaTable cannot provide a download link.  Platform tokens are sent only to the configured platform address.
