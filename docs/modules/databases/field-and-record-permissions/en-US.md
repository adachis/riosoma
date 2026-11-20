---
id: field-and-record-permissions
title: Field and record permissions
summary: Hide a field from everyone but chosen people, lock who can change a field, and show some people only the records meant for them.
area: databases
order: 31
level: standard
related: [fields, views, linked-records, formulas, public-view-links, forms, snapshots-and-copies, scheduled-reports]
anchors: [grid, database.table.menu, database.table.recordAccess, permissions.records.add, permissions.records.who, permissions.records.condition, permissions.save]
demo: field-and-record-permissions
---

A database's roles decide what each person can do everywhere in it.  Permissions narrow that down, field by field and record by record.  A salary column can be for the people who run payroll alone, a status only the team lead changes, and each sales rep can see only their own accounts.  The database's owners always see and change everything, whatever a permission says.

Permissions are for people who can change the database's tables and fields, so they take the {{ui:share.role.creator}} or {{ui:share.role.owner}} role.

## Restricting who can see a field

Open a field's menu from its column header and choose {{ui:grid.field.permissions}}.  Turn on {{ui:permissions.field.restrict}} and choose {{ui:permissions.field.seeWho}}: tick roles under {{ui:permissions.audience.roles}}, or find people by name or address under {{ui:permissions.audience.people}}, or both.  Then choose {{ui:permissions.save}}.

Everyone else stops receiving the field entirely.  Its values, its name, and its description never leave the server for them, in the grid, a record, a search, a download, a dashboard, a report, the REST API, or anywhere else.  Anything computed from the field goes with it: a formula that uses it, a lookup or rollup of it, and anything built on those in turn.  Where a view or a filter still names the field, they see "{{ui:permissions.restrictedField}}" in its place, and nothing about it.

People who can see a restricted field see "{{ui:permissions.mark.restricted}}" on its column header.

A field that only shows who made or last changed a record, when, or its ID can't be restricted, since every record carries those anyway: "{{ui:data.access.recordDetail}}"

A restricted field is never shared by a public link, and a public form never asks about it.  A view that filters, sorts, or sums by a restricted field can't be shared by link at all until it stops, since the link would give some of it away.

## Locking who can change a field

In the same dialog, turn on {{ui:permissions.field.lock}} and choose {{ui:permissions.field.changeWho}}.  Everyone who can see the field still sees its values, and only the people you choose, and the owners, can change them.  Its header reads "{{ui:permissions.mark.locked}}"  For everyone else its cells don't open for editing, and a change made any other way, such as a paste, an import, or the REST API, is refused with "{{ui:data.access.fieldLocked}}"

Changing a link also changes the other side of it, so a lock on either side of a link keeps the other side from being changed too.

Unlock a field before converting its type, even if you are a database owner: "{{ui:data.access.fieldLockedConversion}}"  Removing choices from a locked select field clears stored values, so only a database owner can do it: "{{ui:data.access.fieldLockedChoices}}"  These checks also apply when undo or redo would rewrite those cells.

## Locking a record

Open a record and choose {{ui:locks.record.lock}}.  Enter a {{ui:locks.reason}}, then choose {{ui:locks.record.confirm}}.  The reason belongs to this record, so navigating to another record starts with a fresh lock draft.  Losing edit access also closes the draft.

Reasons can contain up to 1,000 characters.  If a lock cannot be changed, correct the reason or retry {{ui:locks.record.confirm}}.

A locked record still opens for reading and commenting according to your database role.  Its fields cannot be changed unless your role is allowed to bypass the table's lock policy.  Owners can bypass locks by default.  People allowed to unlock a manually locked record can choose {{ui:locks.record.unlock}}.

## Choosing which records people see

Open a table's menu in the sidebar and choose {{ui:permissions.records.menu}}.  Each rule has two parts: {{ui:permissions.records.who}}, as roles and people, and {{ui:permissions.records.where}}, as conditions like a view's filter.  Choose {{ui:permissions.records.add}} for another rule, and {{ui:permissions.save}} when they're right.

For person and created-by fields, a condition can compare with "{{ui:permissions.currentPerson}}", which stands for whoever is reading.  A rule for editors where Owner has {{ui:permissions.currentPerson}} shows each editor only the records they own.

How rules combine:

- Someone a rule names sees only the records its conditions match.
- Someone several rules name sees the records any of them allows.
- Someone no rule names sees every record.
- A condition that can't be checked, such as one on a field that was deleted, matches no records, so a broken rule hides rather than reveals.

Records outside a person's rules don't exist for them.  They aren't in the grid, counts, summaries, charts, dashboards, searches, downloads, reports, or a record's history.  A link to one shows as "{{ui:permissions.hiddenRecord}}", with no name, and lookups, rollups, and counts are worked out from the records they can see alone.

What a person adds or changes has to stay within their rules.  A new record outside them, or a change that would move one outside them, is refused with "{{ui:data.access.recordOutsideRules}}"  Changing a link keeps the links to hidden records as they are.  A file can go into another record of its attachment field only when it is already in a record they can see, or is their own upload that no record holds yet.  Any other file is refused as unknown, so placing a file never opens one a rule hides.

Merging duplicates checks the chosen values, both sides of linked fields, person membership, and the kept record's rules.  If the merged result would be outside your rules, the merge is refused, and all records stay as they were.

Someone a record rule limits in a table can't change that table's rules, so nobody can widen what they see.

## Views, dashboards, and automations

Views are shared by everyone who can open the database, so a view built on a restricted field reads differently for the people who can't see it: its conditions and sorts on that field are left out for them.  They can arrange the columns they see, and the ones they can't keep their places.  They can't change a filter, a dashboard, an automation, or an interface that uses a field they can't see, which is refused with "{{ui:data.access.fieldHidden}}"

An automation reads and changes records as the person it acts as, so it sees what they see.  A test of an automation, whole or of a single step, acts as the person testing.  A webhook names only what the person who added it can see, and someone a rule limits can change only the webhooks they added.

## Copies, templates, and reports

Snapshots, restores, and duplicates take the whole database, so only people who see all of it can make them.  A copy keeps the original's permissions.  A database with any permission can't be saved as a template for the organization, since everyone could start from it.  A scheduled report sends each member what they can see themselves, and reports to outside addresses are turned off for a database with a restricted field.

## When permissions change

Everyone with the database open gets it again at once, with what they can now see.  Every change to a permission is kept in the organization's audit log with the fields, tables, roles, and people it named, and never any values.
