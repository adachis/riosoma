---
id: levels
title: Simple, Standard, and Advanced
summary: Choose how much of Riosoma your menus show, and move up whenever you're ready for more.
area: personal
order: 1
level: simple
anchors: [settings.levels.level, settings.levels]
related: [palette, fields, views]
routes: [/settings/levels, /settings/*/levels, /admin/*/levels]
sections: [settings.levels=choosing-your-level]
---

Riosoma can do a great deal, and you don't have to see all of it at once.  Your experience level decides what the menus, pickers, and sidebar offer.  It never takes anything away: whatever already exists shows, opens, and works at every level, and search always finds every feature.

Choose {{ui:settings.draft.save}} in the save bar at the bottom of the page to store a new level or organization default.  {{ui:settings.draft.discard}} restores the stored choices.

## What each level shows

**{{ui:levels.simple}}** is for keeping track of things together:

- the {{ui:view.type.grid}}, {{ui:view.type.kanban}}, {{ui:view.type.gallery}}, {{ui:view.type.calendar}}, and {{ui:view.type.form}} views
- the everyday field types: {{ui:field.type.text}}, {{ui:field.type.longText}}, {{ui:field.type.number}}, {{ui:field.type.currency}}, {{ui:field.type.date}}, {{ui:field.type.checkbox}}, {{ui:field.type.singleSelect}}, {{ui:field.type.multipleSelect}}, {{ui:field.type.attachment}}, {{ui:field.type.user}}, {{ui:field.type.link}}, {{ui:field.type.email}}, {{ui:field.type.url}}, and {{ui:field.type.phone}}
- {{ui:view.toolbar.sort}}, {{ui:view.toolbar.filter}}, grouping cards into stacks, {{ui:database.share}}, comments, and templates

**{{ui:levels.standard}}** adds everything for shaping and reporting on your data:

- the {{ui:views.timeline.name}}, {{ui:views.gantt.name}}, {{ui:views.chart.name}}, {{ui:views.pivot.name}}, {{ui:views.list.name}}, and {{ui:views.map.name}} views
- the other field types, among them {{ui:field.type.formula}}, {{ui:field.type.lookup}}, {{ui:field.type.rollup}}, {{ui:field.type.count}}, and {{ui:fields.ai.name}} fields
- conditional colors, from {{ui:views.color.toolbar}} above a view
- {{ui:dashboards.section}}, {{ui:interfaces.section}}, and {{ui:automations.section}}, apart from code steps
- {{ui:import.add.menu}}, and {{ui:synced.add.sync}}
- {{ui:signatures.request.title}} on a record's documents

**{{ui:levels.advanced}}** adds the tools for building on Riosoma:

- {{ui:scripts.section}} and the script panel, and the {{ui:automations.step.script}} step in automations
- {{ui:sql.title}}
- the API and MCP, and {{ui:settings.nav.tokens}}
- {{ui:webhooks.title}}, including the {{ui:automations.step.callWebhook}} step and the {{ui:automations.trigger.webhook}} trigger
- field {{ui:grid.field.permissions}} and {{ui:permissions.records.menu}}

Administration settings show at every level, since you only go there on purpose.

## Choosing your level

Open {{ui:shell.nav.settings}}, then {{ui:settings.nav.levels}}, and choose under {{ui:levels.settings.label}}.  The change is instant and follows you to every device where you sign in.  You can also pick one when you first join.

Unless you choose, you follow your organization's default, which starts at {{ui:levels.standard}}.  Guests start at {{ui:levels.simple}}.  Once you've chosen, {{ui:levels.settings.default}} takes you back to following the default, so you move whenever an admin changes it.

## Reaching for more

Search with {{keys:palette.open}} finds every feature, whatever your level.  Open one from a higher level and it works as usual, with a short note that it's from that level and a button to show its level's features everywhere.

If you open features from a higher level three times in a week, your home screen suggests moving up.  Dismiss it and it never comes back.

## Something made at a higher level

A formula someone else added, an automation with a code step, a table fed by a data source, or a field with permissions shows and works for you at any level.  You can open it, edit it, and use it.

Whatever you already have keeps its place in the menus too.  A database with dashboards keeps {{ui:dashboards.add}}, a database with webhooks keeps {{ui:webhooks.title}} in its settings, and once you hold {{ui:settings.nav.tokens}}, their page stays in your settings.  Only features nobody has used yet wait for the level they belong to.

## For administrators

Owners and admins with the People role see {{ui:levels.org.title}} on the same page.  {{ui:levels.org.default}} is where members start until they choose, and {{ui:levels.org.guests}} is as far up as guests can go.  A guest who chose a higher level before the limit was lowered works at the limit.
