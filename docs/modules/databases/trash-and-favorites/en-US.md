---
id: trash-and-favorites
title: The trash, favorites, and recent databases
summary: Restore deleted tables, fields, views, records, and databases for 30 days, and keep the databases you use close at hand.
area: databases
order: 17
level: standard
related: [undo, databases-and-tables, editing, merging-duplicates, retention]
anchors: [database.tables, database.trash, trash.list, shell.home]
demo: trash-and-favorites
---

Deleting something in Riosoma moves it to the trash instead of erasing it.  Tables, fields, views, dashboards, automations, records, and whole databases stay there for 30 days, and anyone with the right role can restore them.  Deleting and restoring both apply to everyone who uses the database.

Thirty days is the default.  An owner or a Security admin can choose another window for the organization or for one database, and can place a database under a legal hold, which stops its purging altogether, as {{doc:retention}} explains.  Where this article says 30 days, the window your administrator chose applies.

Right after you delete something, you can undo it, as described in {{doc:undo}}.  The trash is for when you notice later.

## Restoring from a database's trash

In a database's sidebar, choose {{ui:trash.open}}.  Deleted tables, fields, views, dashboards, and automations are listed newest first, each with who deleted it, when, and how many days it has left.  Deleted records are grouped by table.  Open a group to see its records, and choose {{ui:trash.more}} to load more.

Choose {{ui:trash.restore}} to bring something back.

- A restored table returns with its fields, views, and records.
- A restored record returns with its values and comments.
- Deleting a link field also deletes its paired field, and restoring one restores both.
- If another field now has a restored field's name, Riosoma adds "(restored)" to the restored field's name.
- A table or view can't be restored while another one has its name, so rename the other one first.

A database always keeps at least one table, a table keeps at least one view, and a table's primary field can't be deleted.

## Who can restore what

Anyone who can open a database can look in its trash.  Restoring takes the same role as deleting:

- People with the {{ui:share.role.editor}}, {{ui:share.role.creator}}, or {{ui:share.role.owner}} role can restore records.
- People with the {{ui:share.role.creator}} or {{ui:share.role.owner}} role can restore tables, fields, views, dashboards, and automations.
- Only an owner can delete or restore a whole database.

## Deleting and restoring a database

From Home, open the menu on a database's card and choose {{ui:home.card.delete}}.  Only owners see this choice.  The database disappears for everyone it's shared with, and anyone who has it open is told it was deleted and returns to Home.  To change your mind right away, choose {{ui:home.deleted.undo}} in the notification.

Later, choose {{ui:trash.open}} at the top of Home.  {{ui:trash.databases}} lists the databases you own that were deleted in the last 30 days.  Choose {{ui:trash.restore}} to bring one back just as it was, shared with the same people.

## After 30 days

Each deleted item shows how many days it has left.  When they run out, Riosoma removes it permanently, and it can no longer be restored.

## Favorites and Recent

Home keeps the databases you use most within reach.

- Choose the star on a database's card ({{ui:home.favorite.add}}) to list it under {{ui:home.favorites}} at the top of Home.  Choose the star again ({{ui:home.favorite.remove}}) to take it off.
- {{ui:home.recent}} shows up to eight other databases you've opened in the last 30 days, most recent first.
- {{ui:home.all}} lists every database you can open, most recently updated first.

Favorites and Recent are yours alone, so starring a database doesn't change Home for anyone else.
