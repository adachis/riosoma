---
id: importing
title: Importing files and photos
summary: Read files and photos, correct a preview, and import rows as records.
area: databases
order: 14
level: simple
related: [fields, editing, undo, synced-tables, merging-duplicates]
anchors: [database.tables.add, database.table.menu, database.table.importInto, import.file, import.start, import.dialog]
demo: importing
sections: [import.file=choosing-a-file, import.start=importing-and-undoing, import.dialog=choosing-a-file]
---

Importing turns a CSV file's rows into records.  You can create a table with fields based on the file or map columns to an existing table's fields.  Imports into existing tables append new records, even when a row resembles a record already there.

## Choosing a file

In a database's sidebar, choose {{ui:synced.add.menu}}, then {{ui:import.add.menu}}, to create a new table from a file.  Choose {{ui:import.chooseFile}} or drop the file into the dialog.  A CSV file becomes one table named after the file.  For an Excel file, pick the sheet to import.  To add records to a table you already have, or to update the ones that match, choose {{ui:import.into.menu}} from that table's menu.

Workbook previews are limited to 256 MiB of expanded output, including repeated shared strings and merged cells.  They refuse a worksheet or shared-string part that expands beyond 256 MiB and text cells longer than 1,000,000 characters.  These checks use the expanded contents, even if the file reports a smaller size.  Split oversized sheets or cells before choosing {{ui:import.chooseFile}} again.

Check {{ui:import.header}} if the first row contains column names.  Turn it off if that row contains data.  {{ui:import.previewLabel}} shows the first 20 data rows so you can review them before importing.

## How types are guessed

Riosoma examines up to 1,000 nonempty values per column.  It checks for checkbox values, numbers, dates, email addresses, and URLs.  Dates containing times become date fields with time included.  Long or multiline values suggest long text.  Repeated short values with at most 50 distinct entries suggest a single select field.  Other columns become text.

Dates that work in both month-first and day-first order default to month-first.  Review ambiguous dates carefully.  If necessary, change them in the source file to year-month-day form and select the corrected file again.

## Fixing columns

For a new table, edit {{ui:import.column.name}} and {{ui:import.column.type}}, exclude unwanted columns, and choose {{ui:import.column.primary}}.  The primary field must use a supported type, so an incompatible first column starts as text.

When importing into an existing table, matching column names map automatically, ignoring capitalization.  Use {{ui:import.column.map}} to choose a different destination or {{ui:import.column.skip}} to exclude a column.  Existing field types stay in place, and computed fields cannot receive imported values.

The full file is checked before importing.  Each column reports values that do not fit and would become empty.  Correct the type, mapping, or source file before continuing if those values matter.

## Importing and undoing

Choose {{ui:import.start}} and watch the progress.  {{ui:import.cancel}} stops further batches, but records already imported remain.

Use {{ui:import.undo}} in the completion notification to undo the import as one action, including a new table created in an existing database.  If an import stops after applying some changes, its error notification also offers undo for those changes.  The notification still undoes the original import after you leave that database.  Reopen its {{ui:undo.history.open}} to redo the import.  If nothing can be undone, the notification explains that the import could not be undone.  Creating a brand-new database from a file is separate from the imported record batches, so undoing those batches leaves the database itself in place.


## Photos and messy files

Open [photo and document import](/?new=photo), or choose {{ui:import.document.open}} inside either import dialog.  Upload a PNG, JPEG, WebP, PDF, CSV, TSV, or Excel workbook with {{ui:import.document.file}}.  Use {{ui:libraries.classification}} to describe the file's sensitivity before choosing {{ui:import.document.read}}.  The file’s sensitivity rules, permitted providers, personal access, and monthly budget apply before the file is sent.  When importing into an existing database, its classification rules also apply.  A provider restriction on a destination table or any of its fields blocks the preview.  For a new table in an existing database, provider restrictions anywhere in that database block the preview.

Rio proposes column names, types, and rows.  Cells labeled {{ui:import.document.uncertain}} need a closer look.  Edit readings directly, correct names and types, and review every row.  Confidence is a model estimate, so an unmarked cell can still be wrong.  Choose {{ui:import.document.use}} to continue into the ordinary import preview.  For an existing table, map columns to its fields.  Its existing types remain in place.  No table or record changes until you choose {{ui:import.start}}.

An administrator can set {{ui:import.document.uploadLimit}}, {{ui:import.document.pageLimit}}, and the document models under [AI settings](/settings/ai).  The defaults are 5 MiB and 10 PDF pages or workbook sheets.  Extraction accepts at most 500 rows, 50 columns, and 100,000 value characters.  Split larger documents into separate files.  Photos are resized to fit within 2048 pixels per side.  Extremely narrow images and encoded images over 5 MB are refused.  Files and extracted drafts are not saved by the preview service.  Closing or reloading the dialog discards the draft.

A configured local vision model takes precedence and never falls back to a hosted provider.  It reads images and spreadsheets.  For scanned PDFs with a local model, upload each page as an image.  Hosted vision adapters can receive PDFs directly.  Restricted files are blocked by default, and confidential files require local processing by default.

Calls count toward Rio’s cost, energy, and carbon totals, including calls whose output could not be used.  A call the provider refuses, or one that can’t reach the provider, isn’t counted.  If a call ends after the provider received the file but before it reported usage, Rio estimates the tokens from the image size, the PDF page count, or the text length, plus any partial output.  The estimate is priced when the model’s rates are known and is marked as an estimate in the AI footprint CSV file.  Local footprint estimates use the configured power per request and the call’s duration.  Unknown estimates remain unknown.

The server reads at most two files at once, and each person one at a time.  Other files wait their turn, and when another organization is waiting, it gets the next free slot.  A file still waiting after a minute returns a busy message, so try it again shortly.  Once its turn starts, the upload must finish within 30 seconds and the reading within two minutes.  Closing the dialog cancels a file that is waiting or being read.

The new-table dialog can be opened at `/<databaseId>?import=new`.  The existing-table dialog can be opened at `/<databaseId>/<tableId>?import=<tableId>`.  The keyboard reaches every control, and the preview scrolls horizontally on a phone.  File contents stay out of deep links.

The API exposes `POST /api/v1/imports/document`, and MCP exposes `preview_document_import`.  In chat, Rio links to [photo and document import](/?new=photo) so you can upload and classify the file yourself.  Both return drafts under the same access and classification rules.  Review the draft, then use ordinary table and record commands to save it.  The draft response does not authorize any command.

## Unknown files in CDI Mode

A live table in Chaotic Data Ingest Mode studies an unfamiliar file before reading it.  It asks about a nearby known format, unplaced headings, ambiguous values, and required fields with no source.  Existing rules and clear file evidence become assumptions you can confirm or change.  No records from an unknown file are written while its reading questions remain open.  Every question offers a choice to flag uncertainty or skip the file.

Changing an assumption corrects the affected records through the usual record writer and preserves hand-edited cells.  If a correction is rejected, its records and saved assumption stay as they were.  Mapping corrections use the original file's evidence, including when you change the same mapping again.  Flagging an assumption adds its question reason to the affected records.  Choosing a new field creates it when you have schema rights, or records a request when you do not.  Skipping a file removes its contributions through the same writer.

You can keep reading rules for this file, files laid out like it, or unknown files from its sender.  Saving a format requires schema rights.  An editor can finish the current file while schema approval waits.  A saved format starts on probation, and each file needs an explicit pass.  Passing saves the records as they now stand as an example.  The organization's probation setting determines how many passed files make the format live.

Changed rules run against the saved examples, including their reading checks and answered date conventions.  A failing example holds later files with the finding.  For a known format's new heading, other columns are read while one shared question waits.  Its answer corrects every affected file and is remembered for later arrivals.  Remembered headings use the field's cleaning rules.  A flag answer keeps the uncertainty visible on every affected file, including later arrivals.

When a study cannot run, the file waits with a direct question and the reason.  You can skip it immediately or retry after the restriction or service failure clears.
