---
id: snapshot-tables
title: Copy tables from a data source
summary: Follow the first copy, sync again, and retry a failed copy.
area: data-sources
order: 12
level: simple
anchors: [database.table.menu]
related: [joined-tables]
---

Choose {{ui:synced.wizard.title}} when adding a table.  Select a source, preview its fields, choose stable key columns, and choose {{ui:synced.wizard.create}}.  The first copy starts immediately after the table is saved.

The table shows that copying has started, the number of rows the source has reported, and the elapsed time.  The count does not estimate a total.  Records appear automatically when the complete copy is ready.  You can leave the table and return through its address while copying continues.

If copying fails, the table shows the reason.  Correct the source connection or its data, and choose {{ui:synced.tryAgain}}.  A retry starts immediately.  Existing records stay available when a later copy fails.

{{ui:synced.syncNow}} starts another copy immediately.  {{ui:synced.settings}} changes its schedule.  A shorter schedule starts a copy immediately if the last successful copy is already overdue.  Each table runs one copy at a time, including when a scheduled copy and a manual request arrive together.

{{ui:joins.find}} compares matching values across tables.  If a first copy finishes while the suggestions are open, the suggestions update automatically.
