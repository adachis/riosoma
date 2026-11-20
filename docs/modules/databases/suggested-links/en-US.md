---
id: suggested-links
title: Finding links between tables
summary: Let Riosoma suggest fields that point to records in another table, and keep those links in step with the values.
area: databases
order: 22
level: standard
related: [linked-records, synced-tables, importing, fields]
---

Tables often refer to each other with a shared value, such as an order's customer number or a task's project code.  Riosoma can find those fields for you and turn them into links that follow the values, so the links stay right as the values change.

## Getting suggestions

In a database's sidebar, open a table's menu and choose {{ui:joins.find}}.  Riosoma looks for values in that table that match values in another table, in either direction, which can take a few seconds when tables are large.  Then it lists what it found under {{ui:joins.title}}.  It skips tables that already have an ordinary link between them, and fields a link already follows.  Finding links takes the {{ui:share.role.creator}} or {{ui:share.role.owner}} role.

Each suggestion names a field in one table and the field in another table whose values it matches, and shows:

- how confident Riosoma is that the two belong together
- how many of the first field's values it found in the other table
- how many of the matches name just one record, since a value shared by several records makes a weaker link
- a few of the values it found on both sides

Names and a source's key columns help distinguish a relationship from numbers that happen to overlap.  When the values support a named relationship, Riosoma favors it over unrelated matches.  Short values need more evidence than long ones, since they overlap by chance: two-letter codes, like countries and states, are suggested on their values alone only when the field holds at least ten different codes and the other table has every one of them.  Wide tables share the discovery budget with their related tables, with key fields checked first.

Choose {{ui:joins.link}} to accept a suggestion.  Riosoma adds a link field, named after the other table, to the table the suggestion names first, and links every record to its matches.  When no fields match closely enough, it says "{{ui:joins.none}}"

## Links that follow values

A link that follows matching values connects each record to the records in the other table whose field holds the same value.  It updates on its own whenever either value changes, including through syncs, so nobody has to link these records by hand.  Their cells can't be edited, and hovering over one says "{{ui:field.link.matchedTooltip}}"  The paired field in the other table follows the same values.

Values have to match exactly, with a few allowances.  Spaces at either end are ignored, a number matches the same number stored as text, and empty values match nothing.  Capital letters count, so "ab-100" doesn't match "AB-100".  When several records share a value, the link holds all of them.

Lookups, rollups, and counts work through these links like any other, as described in {{doc:linked-records}}.

## Setting one up yourself

When you add a link field, turn on {{ui:field.link.match}}.  Then choose a field under {{ui:field.link.matchField}}, and the field it pairs with under {{ui:field.link.matchLinkedField}}.  {{ui:field.type.text}}, {{ui:field.type.email}}, {{ui:field.type.url}}, {{ui:field.type.phone}}, {{ui:field.type.number}}, {{ui:field.type.autoNumber}}, and {{ui:field.type.recordId}} fields can be matched.

Turning on {{ui:field.link.match}} for a link that already exists replaces its links with the matches.  Turning it off keeps the links it has as ordinary links you can edit.  If a field the link follows is deleted, its links stay and become ordinary links too.
