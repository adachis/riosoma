---
id: sync-out
title: Syncing a view out to Airtable
summary: Keep a copy of a view's rows in an Airtable table, updated on a schedule or whenever you ask.
area: databases
order: 23
level: standard
related: [downloading, scheduled-reports, synced-tables, airtable-import, field-and-record-permissions]
anchors: [view.toolbar, view.syncOut, syncOut.add, syncOut.setup.kind, syncOut.setup.token, syncOut.setup.start]
---

Sync out keeps a copy of a view's rows in another tool.  Riosoma sends the fields the view shows, in the view's order, for the rows the view shows, so the view's filters decide what goes.  When records change, the next sync updates only the rows that changed.

It goes one way.  Changes made in the other tool don't come back.  A value someone changes there stays until its record next changes in Riosoma, and then Riosoma's value is written over it.  To bring data in from another tool, see {{doc:synced-tables}}.

## Setting one up

Open the view and choose {{ui:syncOut.title}} at the end of the view's toolbar.  On a narrow screen it's an icon, or it's in the toolbar's {{ui:toolbar.more}} button.  You need to be able to change the view to see it.  Choose {{ui:syncOut.add}}, then follow the four steps:

1. Choose {{ui:syncOut.kind.airtable}}.
2. Paste an Airtable personal access token with the scopes the step lists and access to the base you'll sync to.  Riosoma seals the token and never shows it again.  Choose a base, then name the new table ({{ui:syncOut.target.new}}), which gets a column for each field in the view.
3. Check the columns.  Each field shows the column it goes to and the column's type.
4. Name the sync and choose a schedule, then {{ui:syncOut.setup.start}}.  The first sync starts right away.

One table takes one sync.  To send two views to the same base, give each its own table.

## What Riosoma changes there, and what it leaves alone

Riosoma adds one column of its own, named Riosoma record ID.  It tells the rows apart, so leave it as it is.

Rows are never touched unless Riosoma made them or they carry the record ID of a record the view shows, so other rows in the base are left alone.

With {{ui:syncOut.form.removeMissing}} on, a record that is deleted, or that stops matching the view's filters, has its row removed there on the next sync.  Turn it off to keep those rows.

If you hide a field in the view, its column stays there and its cells are cleared.

## How values are sent

Text, numbers, checkboxes, dates, and choices go into columns of the matching type.  Linked records, lookups, and people go as the names you see in the grid.  Formulas and rollups go as their results.  Attachments go as web addresses, which open for people who are signed in to Riosoma and may see the file.  A value Airtable has no type for goes as text.

## Whose access it uses

A sync runs as the person who set it up, and sends what that person can see in the view at that moment.  Fields and records hidden from them by {{doc:field-and-record-permissions}} are never sent, and neither are fields whose classification keeps them from leaving Riosoma.

If the view filters or sorts by a field whose classification keeps it from leaving, nothing is sent, because the choice of rows would give the values away.  Change the view's filter or sort, or the field's classification, and sync again.

## Syncing now, schedules, and history

{{ui:syncOut.syncNow}} syncs at once.  A schedule syncs every 15 minutes, every hour, or every day.  {{ui:syncOut.item.history}}, in a sync's menu, shows the last 50 syncs, with how many rows each one added, updated, removed, and left unchanged, and anything that went wrong.

If a sync doesn't finish, the list says why.  A sync on a schedule tries again at its next time, and {{ui:syncOut.tryAgain}} tries at once.  Riosoma checks what arrived before it sends anything again, so no row is sent twice.

## Changing or deleting a sync

{{ui:syncOut.item.edit}}, in a sync's menu, changes its name, its schedule, and whether rows that leave the view are removed.  Only the person who set the sync up can change it, because it runs with their access.  The switch beside a sync's name turns it off and on, and turning it on syncs at once.

The base, the table, and the token can't be changed.  To use another table or token, delete the sync and set it up again.

{{ui:syncOut.item.delete}} stops the syncing and leaves the rows that are already there.  The person who set the sync up can delete it, and so can anyone who manages the database.

## When a sync stops

A sync turns itself off, and its line in the list says why, when the view is deleted, when the person who set it up can no longer open the view, when that person leaves the organization, or when your organization turns Sync out off.  It sends nothing after that.

Once the cause is fixed, the person who set it up turns it back on with the switch beside its name.  If that person has left, delete the sync and set it up again.

## Limits

An Airtable table takes up to 50,000 rows from one sync, and up to 500 fields.  A view with more rows or fields than that can't be synced until it's narrowed.

Your organization's admins can turn Sync out off for everyone, or for a unit, with {{ui:orgUnits.policy.syncOut}} in the organization's policy.  Sync out also needs {{ui:orgUnits.policy.externalSharing}} to be on.
