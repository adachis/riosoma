---
id: comments-and-history
title: Commenting on records and reading their history
summary: Talk about a record where everyone can see it, mention people, and look back at every change made to it.
area: databases
order: 20
level: simple
related: [together, undo, automations, notifications, merging-duplicates]
anchors: [grid, grid.record.expand, notifications.open, notifications.list]
demo: comments-and-history
---

Every record has a place for conversation and a list of everything that happened to it.  Expand a record, from its row number or with Shift+Space, and use the {{ui:record.tab.comments}} and {{ui:record.tab.history}} tabs beside its fields.

## Commenting

Type in the box at the bottom of {{ui:record.tab.comments}}, then choose {{ui:comments.send}} or press Cmd+Enter (Ctrl+Enter on Windows and Linux).  Comments appear for everyone right away, oldest first.  If your connection drops, a comment waits in the browser and is sent when you're back online.

People with the {{ui:share.role.commenter}}, {{ui:share.role.editor}}, {{ui:share.role.creator}}, or {{ui:share.role.owner}} role can comment.  Readers see the comments but can't add their own.

If comments cannot load, choose {{ui:files.retry}} to read them again without closing the record.  Edits, deletions, and moved comments received while a retry loads stay current when it finishes.  If your role changes to reader while a comment editor or delete confirmation is open, it closes.

## Commenting on a cell

Open a cell's context menu with a right-click, a touch hold, or Shift+F10, then choose {{ui:comments.cell.menu}}.  The record opens on that field's thread.  New comments stay anchored to the field, and a corner mark appears in the grid.  Choose that mark to return to the thread.  Keyboard users can focus it and press Enter.

The address includes the record and field, so reloading or sharing the link opens the same thread.  On a phone, the record opens in the existing full-width layout.  The record's {{ui:record.tab.comments}} tab shows each cell comment's field name alongside ordinary record comments.  Closing and reopening the record without the field link shows the whole conversation.

Cell comments follow field visibility.  A hidden or trashed field's thread stays private until the field is visible again.  Database archives preserve cell anchors, and copied anchors point to the copy's fields.  When a copy omits a field, its discussion stays in the original database.

## Mentioning someone

Type @ and the start of a person's name or email address, then choose them from the list that appears.  Up and Down move through the list, Enter picks the highlighted person, and Escape puts the list away.  Only people who can open the database are offered.

A mention shows the person's name, and it keeps pointing to them even if their name changes later.  The person you mention hears about it under {{ui:notifications.title}}, the bell at the top of every page, and by email unless they've turned that off in their settings.

Cell mentions appear and send only while the recipient can read the database, record, and field.  Losing access hides the notification and stops any pending delivery.

## Changing or deleting a comment

Choose {{ui:comments.edit}} under one of your own comments to change it, then {{ui:comments.save}}.  A changed comment is marked {{ui:comments.edited}}.

Choose {{ui:comments.delete}} to remove a comment for everyone.  You can delete your own comments, and owners can delete anyone's.  Comments aren't part of undo or the trash, so a deleted comment can't be brought back.  Deleting a record keeps its comments, and they return if the record is restored.

## History

{{ui:record.tab.history}} lists every change to the record, newest first: who made it, when, and each field's value before and after.  Choose {{ui:history.more}} to see older changes.

Long read-only field values, including a change log, can scroll within the record.  Press Tab to focus an overflowing value, then use the arrow keys or Page Down to read more.

In a record panel or page, Escape closes an open picker before it closes the record.  Press Escape again after the picker closes to return to the view.

The open history updates when someone changes this record in another window.  Older pages you opened with {{ui:history.more}} stay visible, and the next page continues from where you left off.  If a page cannot load, choose {{ui:files.retry}} to try that page again.  Changes already loaded stay visible while an older page retries.

- Changes an automation made appear under the name of the person the automation acts as.
- Changes no person made, such as a response to a public form, are credited to {{ui:history.system}}.
- In a synced table, "{{ui:history.synced}}" marks changes that came from the source.  A value corrected here says "{{ui:history.overrideSet}}", and a correction that was cleared says "{{ui:history.overrideCleared}}".

History shows only the fields you can see.  If your access changes while history is open, it immediately clears the loaded values and reads them again with your current permissions, even if the view cannot refresh.  It tells you what happened, and to take back one of your own changes, use undo, as described in {{doc:undo}}.
