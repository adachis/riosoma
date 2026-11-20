---
id: list-and-map
title: Working with a list or a map
summary: Arrange records as short lines in your own order, in groups or under their parents, or pin them on a map, colored and shared by link like any view.
area: databases
order: 28
level: simple
related: [views, conditional-colors, maps, linked-records, undo]
anchors: [view.settings.list, view.settings.map]
sections: [view.settings.list=shaping-a-list, view.settings.map=placing-records-on-a-map]
---

A list shows each record as one short line: its first field and a few more.  A map puts each record with a place on it as a pin.  Choose {{ui:database.views.add}}, then {{ui:views.list.name}} or {{ui:views.map.name}}, to add one to a table.

## Shaping a list

Open {{ui:views.list.settings}} in the view's toolbar:

- {{ui:views.list.settings.group}} gathers records into groups by a {{ui:field.type.singleSelect}}, {{ui:field.type.user}}, or {{ui:field.type.link}} field, with a count on each group.  Records with nothing in the field share a group of their own, at the bottom.
- {{ui:views.list.settings.parent}} nests each record under the record its parent field names, as an outline.  The parent field is a {{ui:field.type.link}} field that links to the same table.  A list can be grouped or nested, not both, so choosing one sets the other to {{ui:views.list.settings.none}}.
- {{ui:views.list.settings.fields}} sets how many of the view's fields each line shows after its first field, in the order {{ui:view.toolbar.hide}} gives them.

Select a line to open its record, or press Enter.  The pencil on a line, or F2, edits its first field right there.  {{ui:views.list.newRecord}} adds a record just after the one you're on, in its group or under its parent.

## Arranging a list by hand

A list keeps an order of its own, which everyone who opens it sees, and two lists of the same table can arrange the same records differently.  Records nobody has moved stay in the order they were added, so new records come last.

- Drag a record by its row and drop it on another record: on the upper half to put it just before that record, or on the lower half to put it just after.  A line shows where it will land.
- Dropping it on a record in another group moves it into that group too, and nesting it beside a record under another parent moves it under that parent.  Dropping it on the middle of a record in an outline nests it under that record.
- From the keyboard, press {{keys:views.moveUp}} or {{keys:views.moveDown}} to move the record you're on up or down.  In a grouped list, a record at either end of its group goes on into the group before or after.  In an outline, {{keys:views.moveRight}} nests a record under the one above it, and {{keys:views.moveLeft}} moves it out a level.

Moving a record takes the {{ui:share.role.editor}}, {{ui:share.role.creator}}, or {{ui:share.role.owner}} role.  Each move can be undone, as {{doc:undo}} explains.

While a list has a sort, from {{ui:view.toolbar.sort}}, its records follow the sort, and a note above the list says that records can't be dragged into an order of their own.  You can still drag records into other groups or under other parents.  Remove the sort and the list's own order comes back as it was.

On a touch screen, press and hold the row before dragging.  Moving right away scrolls instead.  The target explains refused drops, including locked records, locked views, restricted grouping fields, and read-only Data Source fields.  Other rows stay in place until release.  Escape cancels the drag, and one undo step reverses a saved move.

## Placing records on a map

A map reads each record's place from a {{ui:fields.location.name}} field.  Open {{ui:views.map.settings}} to choose it under {{ui:views.map.location}}, and to color the pins by a {{ui:field.type.singleSelect}} field under {{ui:views.map.color}}.  A table with no location field yet offers {{ui:views.map.setup.add}}.

Drag the map to move around it, or use the arrow keys, and zoom with {{ui:views.map.zoomIn}} and {{ui:views.map.zoomOut}}.  Pins close together gather into a circle with a count, which zooms in when you select it.  Select a pin to see its record's place and first few fields, then {{ui:views.map.card.open}} to open it.  {{ui:views.map.fit}} brings every pin into sight again.

{{ui:views.map.list.open}} lists every record with its place, in the view's order, and {{ui:views.map.list.show}} finds one on the map.  {{ui:views.map.unplaced}} counts the records that have no place, and lists them to open.  When the server turns maps off, as {{doc:maps}} explains, the view lists each record with its place instead.

## Colors

Lists and maps can color records by their values, with the same rules as other views: choose {{ui:views.color.toolbar}} in the view's toolbar, as {{doc:conditional-colors}} explains.

- On a list, a record rule marks the start of the record's line, and cell rules and scales color the values on the line.
- On a map, a record rule colors the record's pin, ahead of the option in {{ui:views.map.color}}.  The pin's card and the list of places show the rule's mark too.

Screen readers say the name of each rule behind a color, so color is never the only clue.

## Sharing by link

Choose {{ui:shareView.menu}} from the view's menu, then {{ui:shareView.publish}}, to let anyone with the link read a list or a map without signing in.  Under {{ui:shareView.fields}}, choose {{ui:shareView.fieldsAll}} or {{ui:shareView.fieldsSome}}.  A list always shares the field it groups or nests by, and a map its location and color fields, marked {{ui:shareView.fieldRequired}}.  No other field leaves the server, and files open through addresses that stop working after a short while.

Turn on {{ui:shareView.passwordOn}} to ask for a {{ui:shareView.password}} before the view opens.  A shared list keeps its own order and can't be changed there.  A shared map uses the same map as the app, and lists each place instead when maps are off.  The page doesn't show the view's colors.  {{ui:shareView.stop}} turns the link off at once.
