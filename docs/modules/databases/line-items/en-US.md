---
id: line-items
title: Line items
summary: Edit ordered child records inside an invoice, order, or other parent record.
area: databases
level: standard
order: 47
related: [fields, formulas, undo]
---

# Line items

Use a {{ui:field.type.lineItems}} field for an invoice's rows, an order's lines, or another ordered collection inside a record.  Add columns when creating the field: text, number, currency, date, checkbox, single select, or a link to another table.  Each line is a real record in a child table hidden from the table sidebar.

Open a record to edit its lines, or focus its grid cell and press Enter.  {{ui:lineItems.add}} creates a row.  Edit a cell and press Enter or move focus to save it.  The remove icon deletes a line.  Drag the row’s body, press and hold on touch, or use {{ui:sortable.menu.up}}, {{ui:sortable.menu.down}}, or {{ui:sortable.menu.to}} to change its position.  With the move control focused, Space picks it up, arrows move it, and Space drops it.  Escape cancels.  Alt+Up or Alt+Down moves it directly.  Numeric columns show their totals.  Paste tab-separated spreadsheet cells into the section to add rows together.  Blank link cells stay empty.  A populated link cell must match one visible record name, ignoring capitalization.  Separate multiple names with commas or line breaks.  On phones, each line stacks its labeled cells vertically.

Create a rollup using the {{ui:field.type.lineItems}} field and a numeric child column to calculate SUM.  A Count field counts lines.  Lookups and filtered rollups work through the same linked records, and formulas can use their results.  Lines follow their parent's record visibility, field restrictions, field locks, and record locks.  History and undo use the ordinary record command history.

REST v1 and record commands accept linked record IDs or nested rows shaped as `[{ "id": "rec…", "values": { "fld…": 12.5 } }]`.  Omit a new row's ID to create one.  A nested write replaces the ordered collection and removes omitted lines.  Send `[]` to remove every line.  Undo restores the removed records and their order.  The Airtable-compatible API exposes the field as linked records.  The same record commands are available to MCP and Rio.  Imported cells can contain that JSON row array.  Form questions use a repeatable section.  Public forms omit linked columns.  A response edit link opens the saved lines in order with only permitted child values.  Undoing a response edit restores its eligible parent and child changes together, preserving cells edited afterward.  A formatted XLSX download includes a worksheet for each line items field, with parent record IDs and typed child cells.

Database archives keep child ownership, parent record IDs, and line order when restored.

The column definitions are fixed when the field is created.  Choose currency codes, date formats, choices, and linked tables before saving the field.
