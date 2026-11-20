---
id: airtable-import
title: Importing from Airtable
summary: Bring a whole Airtable base across, with its tables, records, links, files, and views, and see a report of what changed.
area: databases
order: 14
level: simple
related: [importing, linked-records, formulas, views, attachments]
---

Importing from Airtable makes a new database from a whole Airtable base: every table, field, and record, the links between records, attachments, and views.  When it finishes, a report says what came across exactly, what changed, and what was left out.

## Making a token

Riosoma reads the base through Airtable's API with a personal access token, which you make on Airtable.  Give the token these two scopes:

- `data.records:read`, to read records
- `schema.bases:read`, to read tables, fields, and views

Then give it access to the base you want to bring across.  Riosoma uses the token only for the import.  While the import runs, the token is sealed with the server's key, and when the import ends, however it ends, the token is forgotten.  It never appears in logs.  You can delete it on Airtable once the import is done.

## Importing a base

On the home screen, choose {{ui:import.airtable.menu}}, or find it in the palette.  Paste the token into {{ui:import.airtable.token}} and choose {{ui:import.airtable.findBases}}.  Pick the base, check {{ui:import.airtable.name}}, and choose {{ui:import.airtable.start}}.

Use {{ui:ui.picker.filter}} to find any part of a name, with or without accents.  Group buttons show matching counts and hide or show their items.  Your browser remembers collapsed groups for each picker.  Use the arrow keys to move through matches and Enter to choose.  The list scrolls inside the dialog while the title and actions stay visible on phones and larger screens.

Bases are grouped by workspace when Airtable allows the optional `workspacesAndBases:read` lookup.  If access is refused or the workspace lookup cannot finish promptly, all bases are grouped by {{ui:import.airtable.access.creator}}, {{ui:import.airtable.access.editor}}, {{ui:import.airtable.access.commenter}}, and {{ui:import.airtable.access.readOnly}}.  The filter is always available.

The import runs on the server, so you can close the dialog.  Open it again to see how far along it is.  {{ui:import.airtable.stop}} stops it, and what it made so far goes to the trash, where you can restore it.

Airtable lets apps make five requests a second to a base, and the import stays under that.  Large bases take a while, mostly for records and files.

## What comes across

- Tables, fields, and records, with select options in their colors and each field's formatting.
- Rich text, with its bold, lists, links, and other formatting.
- Links between records, both ways.  A link Airtable shows on only one table shows on both tables here.  The new field is hidden in the views that came across.
- Lookups, rollups, and counts.
- Formulas, when every function they use exists here.  Each one is checked against Airtable's own results, and the report says if any record came out differently.
- Attachments, downloaded into Riosoma's own file storage, up to 1 GB a file.  Files from addresses on a private network are left out.
- People, matched to members by email address.  A people field with anyone who isn't a member keeps email addresses as text.  Once they're members, change it to a person field.
- Grid, kanban, gallery, calendar, form, and timeline views.

## What changes

Airtable's API doesn't share everything, so some things are worked out and some are left out.

- A rollup's formula isn't shared.  The import uses the rollup here that gives the same values, and the report says which.
- View filters and sorts aren't shared.  For tables of up to 5,000 records, the import reads which records each view shows, and in what order, and sets up a filter and sort that match when a single condition and one or two sorts explain them.  Check those views.
- Only grid views share which fields they show.  Other views show their table's first few fields.
- A kanban's stacks, a calendar's dates, and a gallery's covers use the first field that fits.
- Grouping, colors, column widths, and row heights are left out.
- Created and last modified times, and who created and last changed each record, become fixed values, since new records here fill in their own.
- Formulas that use a function Riosoma doesn't have are kept as text with Airtable's results, and the report shows the formula so you can rebuild it.

Record comments, revision history, automations, interfaces, and extensions stay in Airtable.

## The report

When the import finishes, choose {{ui:import.airtable.open}}.  The database opens with its report on top, listing what was left out and what changed, each with why, and what came across exactly, table by table.  The report stays with the database.  To see it again, open the database's settings menu and choose {{ui:import.airtable.reportTitle}}.
