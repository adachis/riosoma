---
id: undo
title: Undoing changes
summary: Take back your own changes, even while others keep working.
area: databases
order: 4
level: simple
related: [editing, together, trash-and-favorites, merging-duplicates]
---

Press Cmd+Z (Ctrl+Z on Windows and Linux) to undo your last change, and Cmd+Shift+Z (Ctrl+Y) to redo it.  Most toasts after a change also have an {{ui:grid.undo}} button.

## Undoing a new database or table

Undoing database or table creation asks before moving it to the trash.  This includes imports, duplicates, templates, tables added from data sources, and creations by Rio.  The confirmation names the item, shows its current table and record counts, and mentions other people's changes since creation.  Choose {{ui:undo.major.moveToTrash}} to continue, or {{ui:undo.major.keep}} to keep it.  Keeping it is the default, and Escape keeps it too.

The same confirmation applies to the shortcut, {{ui:undo.history.open}}, toast buttons, and {{ui:rio.receipt.undo}}.  Major creations show {{ui:undo.history.asksFirst}} in the history.  Redo restores the item and its contents from the trash without another question.  You can also restore it through {{doc:trash-and-favorites}} during the usual retention period.

Fields, including line-items fields, stay one-step undo.  Views and records do too.  Undoing creation of a table with line items asks only about that table.  Its contents and inverse link fields on other tables are preserved, just as when you delete the table by hand.

Undo takes back your own changes, not other people's.  If someone changed a cell after you did, undo leaves their change in place and tells you how many cells it skipped, so nobody's work is lost.

{{ui:grid.undo}} and redo require the role that allowed the original change.  If you become a reader, you can no longer undo or redo record edits.  If you become an editor, you can still undo record edits, but changes to fields, tables, and views require the creator role.  A refused request leaves your history available if your role is restored.

Current field locks, record rules, and person membership apply to undo and redo too.  A cell that you can no longer change, or whose earlier value is no longer allowed, is skipped.  A reversal that would move records outside your rules is skipped without changing those records.  Undoing or redoing a list move skips records you can no longer see and leaves their positions unchanged.

Redo reverses only what undo actually changed.  If a reversal is fully refused and records no inverse, the change stays in its current history list so you can try again after your access is restored.

Your browser tab keeps up to 100 recent changes in each database: cell edits, pastes, new and deleted records, and changes to fields, tables, and views.  The history stays available when you leave the database or reload the page.  Undo needs a connection, so it waits while you're offline.  After a reload interrupts undo or redo, history navigation waits for the server to confirm the result.

## Undo history

{{ui:undo.history.open}}, at the top of the database, lists your recent changes there, newest first, such as "Changed 3 cells in Tasks" or "Deleted the Status field", with when you made each one.  Press {{keys:undo.history}} or search for it with {{keys:palette.open}} to open it from anywhere in the database.

Choose a change to undo it and every change you made after it, newest first, just as pressing undo that many times would.  When that's more than one change, Riosoma asks first.  What you undid moves to its own list, where choosing a change redoes it and the ones undone after it.

The list holds only your own changes, so nobody else's work is undone from here.  The usual rules still apply: cells someone changed since are left as they are, and a change that can't be undone stops the rest and says why.
