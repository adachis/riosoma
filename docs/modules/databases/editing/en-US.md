---
id: editing
title: Editing in the grid
summary: Typing, moving around, and pasting from other spreadsheets.
area: databases
order: 2
level: simple
related: [fields, undo, views]
anchors: [grid]
sections: [grid=moving-around]
routes: [/db*/tbl*/viw*]
---

Select a cell and start typing to replace its value, or press Enter to edit what's there.  Enter saves and moves down, Tab saves and moves right, and Escape cancels.  Date and select fields open a picker instead.

## Editing text together

Long text, formatted text, and JSON editors keep the value you started from.  When someone else is editing the same cell, their name appears beside the editor.  Changes to different parts merge when you save, and the editor shows the merged result with a quiet note.

If the changes overlap, {{ui:textEdit.conflict.title}} shows {{ui:textEdit.mine}} and {{ui:textEdit.theirs}}, with the other person's name and time.  Your draft stays open.  Choose {{ui:textEdit.keepMine}}, {{ui:textEdit.useTheirs}}, or edit {{ui:textEdit.combined}} and choose {{ui:textEdit.saveCombined}}.  Remove the conflict markers before saving.  JSON must still be valid.

An expanded record stays open while a text save is pending or a conflicting draft needs attention.  Resolve the conflict, then choose {{ui:record.close}} or navigate again.  In a plain long text record editor, the first Escape reverts an unsaved draft.  A second Escape closes the record.

## Records beside Rio

Choose {{ui:record.layout.panel}} from {{ui:record.layout}} to keep a record beside Rio.  At narrow tablet widths, the header controls wrap so {{ui:print.record.menu}}, {{ui:record.close}}, and record navigation stay reachable.  Use Tab to reach a control and Enter to activate it.  On a phone, the record fills the screen, and following a record link from Rio collapses the conversation.  Reopen {{ui:rio.ai}} to continue it.

## Moving around

The arrow keys move one cell at a time.  Hold Cmd (Ctrl on Windows and Linux) to jump to the first or last row or column.  Hold Shift while moving or clicking to select a block of cells.

## Copying and pasting

Copy cells and paste them into Excel, Google Sheets, or Numbers, and the other way around.  Riosoma reads numbers, dates, and options from pasted text in your language's format.  Pasting a single value over a block fills the whole block.

When a paste would add records or options, change more than a thousand cells, or includes values that can't be read, Riosoma shows what will happen first and waits for you to confirm.

## Filling and finding

Drag the small square at the corner of a selection to continue a series, such as 1, 2, 3 or Monday, Tuesday, into the cells beside it.  Ctrl+D copies down and Ctrl+R copies across.  To find text anywhere in the view, press Ctrl+F (Cmd+F on a Mac).  {{doc:find-and-fill}} explains all of these.

## Deleting

Delete or Backspace clears the selected cells.  To delete whole records, select their rows and choose {{ui:grid.record.delete}} from the menu.
