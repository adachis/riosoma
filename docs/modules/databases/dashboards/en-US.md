---
id: dashboards
title: Summarizing records on a dashboard
summary: Show numbers, charts, pivot tables, lists of records, and notes about your tables on one page that stays current.
area: databases
order: 18
level: simple
related: [views, linked-records, downloading, trash-and-favorites, charts-and-pivot-tables]
anchors: [dashboards.section, dashboards.add, dashboard.designer]
demo: dashboards
sections: [dashboard.designer=adding-a-tile]
routes: [/*/dashboards/*]
---

A dashboard is a page of tiles that sums up a database at a glance: a number, a chart, a pivot table, a short list of records, or a note.  Tiles work out their values from the records every time, so they're never out of date, and they refresh on their own a moment after records change.

## Adding a dashboard

Dashboards are listed under {{ui:dashboards.section}} in a database's sidebar, below the tables.  Choose {{ui:dashboards.add}} to make one.  It starts empty, named "{{ui:dashboards.untitled}}".  Its menu in the sidebar has {{ui:database.sidebar.rename}} and {{ui:dashboards.delete}}.  Drag dashboards into the order you like, or hold Alt and press Up or Down.

People with the {{ui:share.role.creator}} or {{ui:share.role.owner}} role add dashboards and change their tiles.  Everyone else who can open the database sees them without those controls.

## Adding a tile

Choose {{ui:dashboards.addTile}}, then pick its {{ui:dashboards.tile.kind}}:

- {{ui:dashboards.tile.number}} shows one value, such as how many orders are open or the total of an amount.
- {{ui:dashboards.tile.chart}} sorts records into groups and compares them.
- {{ui:dashboards.tile.pivot}} summarizes records by row and column groups in a table.
- {{ui:dashboards.tile.records}} lists records by name, with a few of their fields.
- {{ui:dashboards.tile.text}} shows text you write, such as instructions or useful links.

Give the tile a {{ui:dashboards.tile.title}}, or leave it empty to use its type's name, then choose {{ui:dashboards.tile.save}}.  A dashboard holds up to 50 tiles.

## Choosing the records

Number, chart, pivot, and record tiles each read one {{ui:dashboards.tile.table}}.  Under {{ui:dashboards.tile.view}}, choose a view to use its filter, or {{ui:dashboards.tile.allRecords}}.  A tile that uses a view follows it, so changing the view's filter changes the tile too.  To narrow the records further, add conditions under {{ui:view.toolbar.filter}}, the same way you filter a view.

Choose {{ui:dashboards.filters}} at the top of the dashboard to narrow every tile that reads the same table.  Add conditions for each table, including date conditions such as {{ui:view.filter.op.isWithin}} {{ui:view.filter.range.pastMonth}}.  To choose a fixed date range, combine {{ui:view.filter.op.isOnOrAfter}} and {{ui:view.filter.op.isOnOrBefore}} conditions.  These conditions apply along with each tile's view and filter, and they also apply to the records behind a cell or chart part.  They change only your read of the dashboard, and the address keeps them for reloads, bookmarks, and shared links.

## Numbers

For a {{ui:dashboards.tile.number}} tile, choose a {{ui:dashboards.tile.field}} and the {{ui:dashboards.tile.value}} to work out:

- With {{ui:dashboards.tile.noField}}, the value is the {{ui:dashboards.fn.count}}.
- Any field except an attachment can give its {{ui:dashboards.fn.countUnique}}.
- Fields that hold numbers can also give their {{ui:dashboards.fn.sum}}, {{ui:dashboards.fn.average}}, {{ui:dashboards.fn.min}}, or {{ui:dashboards.fn.max}}.  These are {{ui:field.type.number}}, {{ui:field.type.currency}}, {{ui:field.type.percent}}, {{ui:field.type.duration}}, {{ui:field.type.rating}}, {{ui:field.type.autoNumber}}, and {{ui:field.type.count}} fields, and formulas and rollups that return numbers.

The value appears the way its field shows values, such as an amount in its currency, with the number of records it came from underneath.  A dash means there was nothing to work it out from.

## Charts

For a {{ui:dashboards.tile.chart}} tile:

1. Choose a {{ui:dashboards.tile.chartType}}: {{ui:dashboards.chart.bar}}, {{ui:dashboards.chart.column}}, {{ui:dashboards.chart.line}}, {{ui:dashboards.chart.area}}, {{ui:dashboards.chart.pie}}, {{ui:dashboards.chart.donut}}, or {{ui:dashboards.chart.scatter}}.
2. Under {{ui:dashboards.tile.groupBy}}, choose the field whose values become the chart's categories, such as a status or an owner.  For a date, also set {{ui:dashboards.tile.dateBucket}} to {{ui:dashboards.bucket.day}}, {{ui:dashboards.bucket.week}}, {{ui:dashboards.bucket.month}}, {{ui:dashboards.bucket.quarter}}, or {{ui:dashboards.bucket.year}}.
3. Choose the {{ui:dashboards.tile.field}} and {{ui:dashboards.tile.value}} to measure, as for a number.
4. To divide each category by another field, such as priority, choose that field under {{ui:dashboards.tile.seriesBy}}.  Pie and donut charts can't be divided.  For a divided bar, column, line, or area chart, turn on {{ui:dashboards.tile.stacked}} to pile the parts on top of each other instead of side by side.
5. Choose a {{ui:dashboards.tile.sort}} order: {{ui:dashboards.sort.category}}, {{ui:dashboards.sort.valueDescending}}, or {{ui:dashboards.sort.valueAscending}}.
6. Set {{ui:dashboards.tile.limit}}, up to 100 categories.  The rest are combined as "{{ui:dashboards.tile.other}}", and so are any divisions past the first 25.

Records with no value in the grouping field appear as "{{ui:dashboards.tile.empty}}".  A date with a time counts on the day it falls on in your time zone, or in its field's time zone if the field sets one.  Weeks start on Monday.

To read a chart's numbers as a table, choose the table button at its top ({{ui:dashboards.tile.showTable}}), and {{ui:dashboards.tile.showChart}} to switch back.  This changes only what you see.

## Pivot tables

For a {{ui:dashboards.tile.pivot}} tile, choose a table and an optional view as described above.  The settings and calculations match a pivot view:

1. Choose the first row field, then use the plus button named {{ui:views.pivot.settings.addRow}} to group rows by up to three fields, from the outermost group to the innermost.
2. Choose a field under {{ui:views.pivot.settings.column}}, or {{ui:views.pivot.settings.noColumn}} to summarize rows without column groups.  For date groups, choose a period under {{ui:views.pivot.settings.dateBucket}}.
3. Choose a summary for each value: {{ui:dashboards.fn.count}}, {{ui:dashboards.fn.countUnique}}, {{ui:dashboards.fn.sum}}, {{ui:dashboards.fn.average}}, {{ui:dashboards.fn.min}}, or {{ui:dashboards.fn.max}}.  Choose a field for summaries other than the record count.  Use the plus button named {{ui:views.pivot.settings.addValue}} for up to five values.  Each row or value has a removal icon with its name in a tooltip.
4. Choose {{ui:views.pivot.settings.order}}, and turn on {{ui:views.pivot.settings.rowTotals}} and {{ui:views.pivot.settings.columnTotals}} as needed.  Without column groups, {{ui:views.pivot.settings.grandTotal}} controls the total row.

The pivot is an accessible table with its own scrolling and sticky headers, including on a phone.  Select a cell or total to open its records.  With a keyboard, press Tab to reach a cell's value, then Enter to open the records panel.  A screen reader announces its group names and value.  Escape closes the panel and returns focus to the cell.  Linked row and column groups use their visible record names.

## Records behind a chart or pivot

Select a bar, slice, or point to list the records behind it in a panel at the side of the dashboard.  The panel's title names that part of the chart and counts its records, such as "Status is Done, 12 records".  For a divided chart, it names the category and the division.  Records appear in the view's sort order.  Select a record's name to open it, choose {{ui:dashboards.drill.more}} for the next ones, and choose {{ui:ui.dialog.close}} or press Escape to put the panel away.  On a phone, the panel takes the whole screen.

With a keyboard, choose {{ui:dashboards.tile.showTable}} at the top of the chart, then press Tab to reach its numbers.  Each number is a button that a screen reader announces with its category and value, and Enter lists its records.  When the panel closes, focus goes back to the number you chose.

The link at the foot of the panel opens the same records in a grid view of the table: the tile's own view when that's a grid view, or else the table's first grid view without a filter of its own.  The grid view says it's showing only the records behind part of a chart, and {{ui:views.narrowed.clear}} shows every record again.  The view's own filter doesn't change, for you or anyone else.  When no grid view can show exactly those records, the panel says so instead of linking.

The same panel opens records behind a pivot cell or total, with its row and column groups in the title.  The dashboard's address keeps the part you chose and its dashboard filters, so a bookmark or a shared link opens the same list.  Everyone who opens it sees only the records their own access allows.

### How the records match the chart

The panel writes the part of the chart as a filter on the field the chart groups by, then checks that the filter picks out exactly the records the chart counted before it lists any.  So the list always matches the chart's own grouping:

- "{{ui:dashboards.tile.empty}}" lists the records with no value in the field.  For a select field, a record whose choice was deleted counts as empty too, as it does on the chart.
- "{{ui:dashboards.tile.other}}" lists the records outside every category the chart shows.  This works for select fields and for fields that hold one value per record.  A {{ui:field.type.user}}, {{ui:field.type.link}}, or {{ui:field.type.lookup}} field can hold a shown value and another one at once, so no filter picks out exactly those records, and the panel explains that instead.  Raise the number under {{ui:dashboards.tile.limit}} to see them as categories of their own.
- A text filter ignores capital letters, so when two categories differ only in their capital letters, such as "Done" and "done", the panel says it can't list them exactly.

Records and their values come only from what you can see, the same as the chart.  A tile that groups or filters by a field you can't see stays unavailable.

After opening these records in a view, {{ui:export.csv}}, {{ui:export.xlsx}}, {{ui:export.docx}}, and {{ui:export.pptx}} include only the narrowed records you can read.  Color scales and data bars measure those records too.  Choose {{ui:views.narrowed.clear}} to return to the whole view.

## Record lists

For a {{ui:dashboards.tile.records}} tile, choose up to 10 {{ui:dashboards.tile.fields}} beside each record's name, and set {{ui:dashboards.tile.limit}}, up to 50 records.  Records appear in the view's sort order, or in the order they were added when the tile uses {{ui:dashboards.tile.allRecords}}, and the tile says how many match in all.  Links and attachments can't be shown in a tile.

Select a record's name to open it over the dashboard, where you can read and edit it as usual.  Hold Cmd (Ctrl on Windows and Linux) while you click to open it in a new tab instead.

## Notes

A {{ui:dashboards.tile.text}} tile shows the text you write in its {{ui:dashboards.tile.note}} box.  It understands a little Markdown: `#` for a heading, `**bold**`, `*italics*`, `-` for a list, and `[text](https://example.com)` for a link.  Web and email addresses become links, and anything else stays as you typed it.

## Arranging tiles

Choose {{ui:dashboards.edit}} to move and resize tiles.  Drag a tile to move it, or drag its bottom corner to resize it.  Tiles in the way stay still during the drag and move down after the drop.  Escape cancels a drag, and each completed drop saves as one undo step.  Choose {{ui:dashboards.done}} when you're finished.

Note text stays selectable while {{ui:dashboards.edit}} is active.  Drag the tile's header or padding to move it while keeping its text available to select and copy.

With the keyboard, choose {{ui:dashboards.edit}}, then press Tab to reach a tile's move and resize control.  The arrow keys move the tile, and Shift with the arrow keys resizes it.  The tile's menu also offers {{ui:sortable.menu.up}}, {{ui:sortable.menu.down}}, and {{ui:sortable.menu.to}}.

Tiles sit on a grid 12 columns wide.  On a phone they stack in one column, in reading order.  Press and hold the tile to arrange it with touch, or use its Up and Down arrow keys with a keyboard.  A short swipe scrolls.  Dropping in a gap puts the tile between its neighbors.  Dropping above or below the list puts it first or last.

Each tile's menu has {{ui:dashboards.tile.edit}}, {{ui:dashboards.tile.duplicate}}, and {{ui:dashboards.tile.delete}}.  Changes save as you make them and apply for everyone, and Cmd+Z (Ctrl+Z on Windows and Linux) undoes them.

## What each person sees

Riosoma works out each tile for the person looking at it, with that person's access, so a dashboard never shows anyone records they couldn't open themselves.  When a tile's table, view, or field is deleted, or you don't have access to it, the tile shows a message instead of data: "{{ui:dashboards.tile.unavailable}}"  If a tile can't load, choose {{ui:dashboards.tile.retry}}.

Deleting a dashboard deletes it for everyone, and you can restore it for 30 days, as described in {{doc:trash-and-favorites}}.
