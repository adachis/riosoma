---
id: palette
title: Searching and running commands
summary: Jump to any database, table, view, dashboard, or automation, or run a command, from one box.
area: getting-started
order: 2
level: simple
related: [welcome, databases-and-tables, install-app]
anchors: [palette.open, palette.query, palette.results]
demo: palette
---

Search takes you anywhere in Riosoma without reaching for the mouse.  Press {{keys:palette.open}}, or choose {{ui:palette.open}} at the top of the screen, and start typing.  The keys work even while you're typing in a cell or a field.

## Finding a place

Before you type anything, the list shows {{ui:palette.group.recent}}, the last five databases, tables, and views you went to, then the open database's {{ui:palette.group.tables}}, then {{ui:palette.group.commands}}.

As you type, the list narrows to what matches:

- {{ui:home.tags.title}}: shared and private tags visible to you
- {{ui:palette.group.databases}}: every database you can open
- the open database's {{ui:palette.group.tables}}, {{ui:palette.group.views}}, {{ui:palette.group.dashboards}}, and {{ui:palette.group.automations}}
- {{ui:palette.group.commands}}
- {{ui:palette.group.settings}}: settings your roles allow you to open, including matches in their help

The letters you type only need to appear in a name in order, so a few from each word are usually enough.  "sal pip" finds a database named Sales pipeline, for example.  Names that start with what you typed come first, and each group shows its best eight.

Up and Down move through the list, Home and End jump to its ends, and Enter opens what's highlighted.  Escape closes search without going anywhere.

## Running a command

Commands do something instead of opening a place: {{ui:palette.cmd.home}}, {{ui:palette.cmd.newDatabase}}, {{ui:import.palette.newDatabase}}, {{ui:palette.cmd.trash}}, {{ui:palette.cmd.appearance}}, {{ui:palette.cmd.language}}, {{ui:palette.cmd.help}}, and {{ui:palette.cmd.signOut}}.  People who manage the organization's members also see {{ui:palette.cmd.people}}.

{{ui:palette.group.recent}} is kept in this browser only, so it's yours alone and doesn't follow you to other devices.
