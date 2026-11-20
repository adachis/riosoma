---
id: find-and-fill
title: Filling cells and finding text in the grid
summary: Continue a series by dragging, copy values down or across, and find or replace text in a view.
area: databases
order: 26
level: simple
related: [editing, undo, views]
---

A grid fills and finds the way a spreadsheet does.  Drag to continue a list of numbers or dates, copy a value into the cells below it, or find every cell that mentions a word and change it.

## The fill handle

Select a cell, or a block of cells, and a small square appears at its bottom corner.  That's the fill handle.  Drag it down, up, or across, and an outline shows the cells it will fill.  Let go to fill them.  Dragging near the edge of the grid scrolls it, and Escape cancels before you let go.

Riosoma continues whatever the cells you started from were doing:

- Numbers keep their step, so 1 and 2 continue as 3, 4, 5, and 10 and 20 as 30, 40.  A single number is copied.
- Dates keep theirs, a day or a week at a time, or a month or a year at a time when they're a whole number of months apart.  Dates on the last day of each month stay on the last day.  A single date continues a day at a time.
- Text that ends in a number counts up, so "Item 10" follows "Item 9", and "Ticket 007" keeps its zeros.
- Names of weekdays and months, whole or short, continue in order and wrap around, such as Friday, Saturday, Sunday, or Nov, Dec, Jan.
- Anything else, such as options, people, or checkboxes, repeats in the same order.

To copy the cells exactly instead, hold Alt (Option on a Mac) as you let go.

When you fill down or up, each column continues on its own, and when you fill across, each row does.  A value that lands in a field of another type is read the way pasted text would be.

Double-click the fill handle, or double-tap it, to fill down as far as the column beside it has values, so a new column's first value reaches the bottom of a list in one move.

## Filling with the keyboard

- Ctrl+D fills down: it copies the top row of the selection into the rest of it.  With only one row selected, it copies the row above.
- Ctrl+R fills right: it copies the first column of the selection into the rest of it.  With only one column selected, it copies the column before.

On a Mac, Cmd+D and Cmd+R work too.  These always copy, and never continue a series.

## What a fill changes

A fill changes up to 10,000 cells, as one step, so {{ui:grid.undo}} in the message afterward, or Cmd+Z (Ctrl+Z on Windows and Linux), takes it all back.  The message says how many cells it filled, and anything it left alone:

- Cells that can't be changed are skipped, such as formulas, lookups, created times, and values a synced table copies from a source that doesn't allow changes.
- A value that doesn't fit its field, such as text headed for a number field, is left out.

Filling takes the {{ui:share.role.editor}}, {{ui:share.role.creator}}, or {{ui:share.role.owner}} role.

## Finding text

In a grid, press Ctrl+F (Cmd+F on a Mac) to open the find bar at the top, and type what you're looking for.  Riosoma looks through every record the view's filter lets through, in the fields the view shows, ignoring capital letters.  Numbers and dates match the way the grid shows them, options match their names, and people match theirs.

The bar counts the matches and marks them.  Enter or {{ui:grid.find.next}} goes to the next match, and Shift+Enter or {{ui:grid.find.previous}} to the one before, in the view's order.  If there are more than 100,000 matches, you step through the first 100,000.  Escape or {{ui:grid.find.close}} closes the bar and puts you back in the grid.

## Replacing text

People who can fill cells can replace text too.  Press Ctrl+H, or on a Mac Cmd+Shift+H, since Cmd+H hides the app.  You can also choose {{ui:grid.find.toggleReplace}} in the find bar.  Type the new text in {{ui:grid.find.replaceLabel}}, then choose:

- {{ui:grid.find.replace}} to change the match you're on and move to the next one.  Enter in the replace box does the same.
- {{ui:grid.find.replaceAll}} to change every match at once, as one step you can undo.  It changes up to 10,000 cells at a time, so for more, choose it again.

Replacing changes every copy of the text in a cell, however it's capitalized.  It works in {{ui:field.type.text}}, {{ui:field.type.longText}}, {{ui:field.type.email}}, {{ui:field.type.url}}, and {{ui:field.type.phone}} fields, where the text is what's stored.  Matches in other fields, such as numbers, options, and formulas, are found but left alone, and the bar says how many.  A cell whose new text wouldn't fit its field stays as it was.
