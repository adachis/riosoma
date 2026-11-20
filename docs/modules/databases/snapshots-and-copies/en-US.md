---
id: snapshots-and-copies
title: Snapshots, duplicates, and your own templates
summary: Keep copies of a whole database, restore one as a new database, duplicate a database, and save one as a template for your organization.
area: databases
order: 29
level: standard
related: [trash-and-favorites, templates, synced-tables, automations, attachments]
anchors: [database.menu, database.menu.snapshots, archives.snapshot.name, archives.snapshot.take, settings.snapshots]
demo: snapshots-and-copies
routes: [/settings/snapshots, /settings/*/snapshots, /admin/*/snapshots]
sections: [settings.snapshots=taking-a-snapshot]
---

A snapshot keeps a whole database as it was at one moment: its tables, fields, records, files, views and each list's own order, comments, dashboards, automations, interfaces, scripts, and the database's icon, color, and theme.  Restoring a snapshot, duplicating a database, and starting from one of your organization's templates all make a new database from a copy like this, with every part under new IDs, so the original never changes.

Snapshots, duplicates, and templates are for people with the {{ui:share.role.creator}} or {{ui:share.role.owner}} role in a database.  They copy all of a database, so someone who can't see every table and field in it can't take one.

## Taking a snapshot

Open the database, choose {{ui:webhooks.menu}} at the top, then {{ui:archives.snapshots.title}}.  Type a {{ui:archives.snapshot.name}}, such as "Before the spring cleanup," and choose {{ui:archives.snapshot.take}}.

The snapshot reads the whole database at one instant.  Changes other people make while it's being taken wait for the next one, so a snapshot is never half before a change and half after it.

Each snapshot in the list shows its name, when it was taken and by whom, how many records it holds, and its size.

## Automatic snapshots

Every day, each database that changed the day before gets an automatic snapshot, listed with the ones people took.  Riosoma keeps the newest automatic snapshot of each of the last 7 days and of each of the last 4 weeks, and removes older ones.  Snapshots people take themselves stay until someone deletes them.

Organization admins, who are the owner and anyone with an administrator's role, choose how this works.  Open {{ui:shell.nav.settings}}, then {{ui:settings.nav.snapshots}}.  Turn {{ui:archives.settings.automatic}} off to stop them, or change {{ui:archives.settings.daily}} and {{ui:archives.settings.weekly}}, then choose {{ui:settings.draft.save}} in the save bar at the bottom of the page.

## Restoring a snapshot

Open the menu beside a snapshot and choose {{ui:archives.snapshot.restore}}.  Give the new database a name under {{ui:archives.restore.name}}, then choose {{ui:archives.restore.start}}, or {{ui:home.dialog.cancel}} to go back.  The database you're in stays exactly as it is.

A large database takes a while to copy.  You can close the dialog, and the new database appears on Home when it's ready.  Otherwise, choose {{ui:archives.copy.open}} when it finishes, or {{ui:archives.snapshots.back}} to return to the list.

What comes back:

- Every table, field, view, and record, with each record's created and modified times and people, and every list in the order it had.
- Formulas, lookups, rollups, and counts, which work out the same values from the copied records, and links between records.
- Files, copied so the new database has its own.  A file whose field was deleted and emptied from the trash after the snapshot was taken can't be copied, and the finished copy says how many were left out.
- Comments, dashboards, interfaces, and scripts.  A script's code names the new database's own tables and fields.

What changes on the way:

- Automations come back turned off, so nothing runs until someone turns one on in the new database.
- A synced table keeps syncing only when its data source still exists and you may use it.  Otherwise it comes back as an ordinary table with the records it had, which you can edit.  See {{doc:synced-tables}}.
- The new database is shared with you alone, as its owner.  Its views have no shared links and its forms have no public links, so a copy never answers a link someone was given for the original.  Webhooks aren't copied either.
- Nothing in the trash comes along, and the new database starts with no history of changes.

## Downloading and deleting snapshots

Open the menu beside a snapshot and choose {{ui:archives.snapshot.download}} to save it as a file.  The file is a JSON document of the whole database, which names each file by where it's stored and its checksum rather than including the files themselves.

Choose {{ui:archives.snapshot.delete}} to remove a snapshot for good.  The database itself doesn't change.

## Duplicating a database

On Home, open the menu on a database's card and choose {{ui:archives.duplicate.menu}}.  In a database, the same choice is under {{ui:webhooks.menu}}.  Type its {{ui:archives.restore.name}}, and turn off {{ui:archives.duplicate.records}} to copy only its tables, fields, views, dashboards, interfaces, and automations.  Choose {{ui:archives.duplicate.start}}, and {{ui:archives.copy.open}} when it's done, or {{ui:archives.close}} to let it finish on its own.

A duplicate changes on the way just as a restored snapshot does.

## Saving a database as a template

Organization admins can save a database as a template that everyone in the organization can start from.  In the database, choose {{ui:webhooks.menu}}, then {{ui:archives.template.title}}.  Give it a {{ui:archives.template.name}}, a {{ui:archives.template.description}}, and a {{ui:archives.template.category}}.

A template keeps the structure of the database: its tables, fields, views, dashboards, interfaces, and automations, which start turned off in each database made from it.  To include examples, set {{ui:archives.template.samples}} to how many of each table's first records to keep, up to 100.  Links between sample records come along too.  Comments never do.  Choose {{ui:archives.template.save}} to finish.

Your organization's templates appear under {{ui:archives.templates.own}} when anyone chooses {{ui:home.new}}.  An admin can choose the remove icon for a template, then {{ui:archives.templates.removeConfirm}}, to take it away.  In a long list, select the template first to show its removal action.  Databases already made from it stay as they are.  See {{doc:templates}}.
