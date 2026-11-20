---
id: charts-and-pivot-tables
title: Summing up records in a chart or pivot table
summary: Group a table's records by a field and count, total, or average them, drawn as a chart or laid out in rows and columns.
area: databases
order: 24
level: simple
related: [views, dashboards, fields, downloading]
anchors: [view.settings.chart, view.settings.pivot]
sections: [view.settings.chart=charts, view.settings.pivot=pivot-tables]
---

A chart view and a pivot table view sum up a table instead of listing it.  Both sort the records into groups by a field, such as a status, an owner, or a month, and work out a number for each group, such as how many records it holds or the total of an amount.  Riosoma works the numbers out on the server, so they cover every record, however many there are, and they refresh on their own a moment after records change.

Choose {{ui:database.views.add}}, then {{ui:views.chart.name}} or {{ui:views.pivot.name}}.  People with the {{ui:share.role.creator}} or {{ui:share.role.owner}} role change the settings, which apply for everyone.  Everyone who can open the database can read the numbers and look at the records behind them.

## Choosing the records

{{ui:views.chart.filter}}, at the start of the view's toolbar, narrows the records the same way any view's filter does, as described in {{doc:views}}.  Sorting and hiding fields don't change a chart or a pivot table, so those controls don't appear.

Numbers come only from the records and fields you can see.  If a field the view uses is deleted, or you can't see it, the view says so instead of showing numbers, and a creator or owner can choose another field.

## Charts

1. Choose a {{ui:views.chart.settings.kind}}: {{ui:views.chart.kind.bar}}, {{ui:views.chart.kind.column}}, {{ui:views.chart.kind.line}}, {{ui:views.chart.kind.area}}, {{ui:views.chart.kind.pie}}, {{ui:views.chart.kind.donut}}, or {{ui:views.chart.kind.scatter}}.
2. Under {{ui:views.chart.settings.groupBy}}, choose the field whose values become the chart's categories.  For a date, also choose {{ui:views.chart.settings.dateBucket}}: {{ui:views.chart.bucket.day}}, {{ui:views.chart.bucket.week}}, {{ui:views.chart.bucket.month}}, {{ui:views.chart.bucket.quarter}}, or {{ui:views.chart.bucket.year}}.  Dates start out by month, since days make too many categories to read.
3. Choose the {{ui:views.chart.settings.value}} to work out: {{ui:views.chart.fn.count}}, {{ui:views.chart.fn.countUnique}}, {{ui:views.chart.fn.sum}}, {{ui:views.chart.fn.average}}, {{ui:views.chart.fn.min}}, or {{ui:views.chart.fn.max}}.  For anything but a count of records, choose the field under {{ui:views.chart.settings.valueField}}.
4. {{ui:views.chart.settings.options}} holds the rest.  {{ui:views.chart.settings.seriesBy}} divides each category by another field, such as priority, into parts in their own colors.  Pie and donut charts can't be split.  For a split bar, column, line, or area chart, {{ui:views.chart.settings.stacked}} piles the parts on top of each other instead of side by side.  {{ui:views.chart.settings.sort}} puts the categories {{ui:views.chart.sort.category}}, {{ui:views.chart.sort.valueDescending}}, or {{ui:views.chart.sort.valueAscending}}.

A new chart starts as columns grouped by the table's first single select field, or failing that by a date.

Select a bar, slice, or point to list the records behind it beside the chart.  Select a record in the list to open it, and choose {{ui:views.chart.records.close}} when you're done.

{{ui:views.chart.showTable}} shows the same numbers as a table, which is easier to read closely and with a screen reader, and {{ui:views.chart.showChart}} switches back.  This changes only what you see.  In the table, select a number to list its records.

A chart draws up to 1,000 categories and 100 parts, and says so when it leaves some out.

## Pivot tables

A pivot table lays groups down the side and, if you like, across the top, with numbers where they meet, as a spreadsheet's pivot table does.

- {{ui:views.pivot.settings.rows}} holds up to three fields.  The first makes the outer groups, and each one after it divides those further.  Choose {{ui:views.pivot.settings.addRow}} to add one, and the X beside a field to remove it.  There's always at least one.
- {{ui:views.pivot.settings.column}} spreads one more field across the top.  Choose {{ui:views.pivot.settings.noColumn}} to leave the columns out.
- {{ui:views.pivot.settings.values}} holds up to five numbers for every cell, each a calculation and a field, as for a chart.  Choose {{ui:views.pivot.settings.addValue}} to add one.  A count of records is headed {{ui:views.pivot.value.count}}.
- A date field in the rows or columns has a {{ui:views.pivot.settings.dateBucket}} menu beside it, for days, weeks, months, quarters, or years.

{{ui:views.pivot.settings.options}} holds the rest:

- {{ui:views.pivot.settings.order}} sorts the rows {{ui:views.pivot.order.labelAscending}}, {{ui:views.pivot.order.labelDescending}}, {{ui:views.pivot.order.valueAscending}}, or {{ui:views.pivot.order.valueDescending}}.
- {{ui:views.pivot.settings.rowTotals}} adds a {{ui:views.pivot.total}} column at the end of each row, when there are columns.
- {{ui:views.pivot.settings.columnTotals}} adds a {{ui:views.pivot.total}} row at the bottom.  Without columns, the switch is called {{ui:views.pivot.settings.grandTotal}}.

Totals start on.  With more than one row field, each outer group also has a row of its own above the rows inside it, with an arrow that folds them away.  Folding changes only what you see.

Select any number to list the records behind it, and a record's name to open it.  {{ui:views.pivot.downloadTable}} saves the table as a CSV file named after the table and the view, exactly as it's shown, so rows inside folded groups are left out.

A pivot table shows up to 1,000 rows and 100 columns, and says so when it leaves some out.  Its totals still count every record.

## How records are grouped

- Records with nothing in the grouping field form a group of their own, "{{ui:views.chart.empty}}".
- A record with several options, people, or linked records counts once in each of their groups.
- Checkboxes group as {{ui:views.chart.checked}} and {{ui:views.chart.unchecked}}.
- A date with a time counts on the day it falls on in your time zone, or in its field's time zone if the field sets one.  Weeks start on Monday.  A {{ui:fields.dateRange.name}} counts on the day it starts.
- Long text, attachments, record IDs, autonumbers, JSON, locations, signatures, and buttons can't group records, since nearly every record would have a group of its own, or there's nothing to group by.

## Which calculations fit which fields

- {{ui:views.chart.fn.count}} needs no field.
- {{ui:views.chart.fn.countUnique}} works with any field except attachments, signatures, and buttons.
- {{ui:views.chart.fn.sum}}, {{ui:views.chart.fn.average}}, {{ui:views.chart.fn.min}}, and {{ui:views.chart.fn.max}} work with fields that hold numbers: {{ui:field.type.number}}, {{ui:field.type.currency}}, {{ui:field.type.percent}}, {{ui:field.type.duration}}, {{ui:field.type.rating}}, {{ui:field.type.autoNumber}}, and {{ui:field.type.count}} fields, and formulas and rollups that return numbers.

Numbers appear the way their field shows values, such as an amount in its currency.  For the same numbers on a page with other charts and notes, see {{doc:dashboards}}.
