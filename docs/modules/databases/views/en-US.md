---
id: views
title: Views, filters, and sorting
summary: The kinds of views a table can have, and how to filter, sort, and hide fields without changing the records.
area: databases
order: 3
level: simple
related: [editing, together, downloading, conditional-colors, timeline-and-gantt, charts-and-pivot-tables, list-and-map, printing-and-pdfs, public-view-links]
anchors: [view.toolbar, view.filter, view.sort, view.group, view.hide, database.views, database.views.add, view.settings.grid, view.settings.orgChart]
demo: views
sections: [view.toolbar=toolbar-labels, view.filter=filter, view.sort=sort, view.group=group-records-in-a-grid, view.hide=hide-fields-and-row-height, view.settings.grid=hide-fields-and-row-height, view.settings.orgChart=org-chart]
---

A view is a way of looking at a table.  Each table can have several, listed above the grid, and {{ui:database.views.add}} makes another.  Views share the same records, so a change made in one shows in all of them.

On a phone, the list folds into one button that names the view you're on.  Tap it for a sheet of the table's views, with a search once there are more than eight, and {{ui:database.views.add}} at its foot.  Each view's menu in the sheet renames, duplicates, shares, downloads, or deletes it.

In a grid, {{ui:grid.addRecord}} and {{ui:grid.field.add}} use plus icons.  Scroll until the whole button comes into view before choosing it.

## Toolbar labels

{{ui:view.toolbar.label}} shows whole labels while there is room.  As the window narrows, active controls use short labels, then icons with count badges.  Point at an icon or focus it with the keyboard to read its full label.  {{ui:view.toolbar.filter}}, {{ui:view.toolbar.sort}}, {{ui:view.toolbar.group}}, and {{ui:view.toolbar.hide}} stay in the row longest.

On a phone, use the icons and {{ui:toolbar.more}} when more controls are available.  {{ui:toolbar.more}} holds the remaining controls and downloads.  Arrow keys move between controls or menu items, Enter opens one, and Escape closes it.  The database header, dashboards, interfaces, and automations fit their actions the same way.  A single action, such as {{ui:database.share}}, stays directly available as an icon.  Changes still save to the current view and open through its existing link.

Active controls use an accent background with contrasting text and icons.  Escape also closes {{ui:view.toolbar.filter}} and {{ui:views.color.toolbar}} while you are typing a condition.  During a drag, the first Escape cancels the move and leaves the panel open.

## Kinds of views

When you add a view, choose what kind it is:

- {{ui:view.type.grid}} shows records in rows and fields in columns, like a spreadsheet, for typing, pasting, and filling in values.  See {{doc:editing}}.
- {{ui:view.type.kanban}} shows records as cards in stacks, one for each option or person, so you can move work from one stage to the next.  See {{doc:kanban}}.
- {{ui:view.type.gallery}} shows records as cards with a picture, for things you know by sight.  See {{doc:gallery}}.
- {{ui:view.type.calendar}} places records on the days of a date field.  See {{doc:calendar}}.
- {{ui:views.timeline.name}} draws records as bars across time, in lanes or packed together.  See {{doc:timeline-and-gantt}}.
- {{ui:views.gantt.name}} gives each record a row with a bar, its progress, and arrows from what it waits on.  See {{doc:timeline-and-gantt}}.
- {{ui:view.type.form}} asks questions and adds a record for each set of answers.  See {{doc:forms}}.
- {{ui:views.chart.name}} groups records by a field and draws a count or a total for each group.  See {{doc:charts-and-pivot-tables}}.
- {{ui:views.pivot.name}} groups records into rows and columns, with numbers where they meet.  See {{doc:charts-and-pivot-tables}}.
- {{ui:views.list.name}} shows records as short lines, in groups or nested under a parent record, in an order you can arrange by hand.  See {{doc:list-and-map}}.
- {{ui:views.map.name}} puts records with a place on a map as pins, and lists them with their places.  See {{doc:list-and-map}}, and {{doc:maps}} for the map itself.

The filter, sort, and hidden fields below work in most kinds of views.  A chart or a pivot table has only a filter, since sorting and hiding fields wouldn't change its numbers, and a form shows the questions you choose instead.  Grid, kanban, gallery, list, and map views can also color records by their values, as {{doc:conditional-colors}} explains.

View-specific controls follow the shared controls in the same row.  For example, {{ui:kanban.cards}}, {{ui:calendar.settings}}, and {{ui:views.timeline.settings}} move into {{ui:toolbar.more}} before {{ui:view.toolbar.filter}}, {{ui:view.toolbar.sort}}, or {{ui:view.toolbar.hide}}.  Open a field picker to see its current choice and all available choices.

## Filter

{{ui:view.toolbar.filter}} shows only the records that match your conditions.  Combine conditions with "and" or "or", and group them for more complex questions.  Date conditions can be relative, such as "is within the past week", and follow each person's time zone.

Drag a condition by its grip to reorder it or move it into or out of a group.  Drag a group by its header grip to move everything inside it.  The line marks the destination, and other rows stay still until you drop.  On a phone, briefly hold the grip before moving your finger.  Groups can nest three levels deep, including the outer group.

To cancel with a mouse, pen, or finger, move outside the panel and release.  The line disappears, and the order stays unchanged, even when rows are scrolled out of view.  On a phone, you can move to either screen edge to cancel.  This also works in {{ui:view.toolbar.sort}} and {{ui:view.toolbar.hide}}.  If someone edits the list while you use the keyboard, the line follows the same destination item and the announced position updates.

Focus a grip with the keyboard, then press {{keys:reorder.pick}} or {{keys:reorder.pickEnter}} to pick up.  Use {{keys:reorder.up}} and {{keys:reorder.down}} to move, {{keys:reorder.in}} to enter the group above, and {{keys:reorder.out}} to leave a group.  Press {{keys:reorder.pick}} to drop or {{keys:reorder.cancel}} to cancel.  {{keys:reorder.upNow}} and {{keys:reorder.downNow}} move immediately.  Each row's menu has {{ui:view.filter.moveMenu}} with the same moves.  Moving the last condition out removes its empty group.  A group's header holds its conjunction, {{ui:view.filter.duplicateGroup}}, and {{ui:view.filter.removeGroup}}.

Each drop saves as one change that you can undo, and everyone viewing the same view sees it.  The view's existing link opens the saved filter and order.

## Sort

{{ui:view.toolbar.sort}} orders records by one or more fields.  Text sorts naturally, so "Item 2" comes before "Item 10", and empty cells always come last.  A list without a sort keeps an order you arrange by hand instead.

Drag a sort row to change its priority.  On the focused move control, use {{keys:reorder.pick}} or {{keys:reorder.pickEnter}} to pick up, {{keys:reorder.up}} or {{keys:reorder.down}} to move, {{keys:reorder.pick}} to drop, and {{keys:reorder.cancel}} to cancel.  {{keys:reorder.upNow}} and {{keys:reorder.downNow}} move immediately.  On a phone, press and hold the row before dragging.

## Group records in a grid

{{ui:view.toolbar.group}} groups a grid by up to three fields.  Choose {{ui:view.group.add}}, pick a field and direction, and move levels with the reorder handle or its arrow keys.  Date fields can group by day, week, month, or year.  Weeks start on Monday, and date fields with times use the field's time zone.  The view's sorts order records inside each group.

Empty values share {{ui:grid.group.empty}}.  Multiple selections, linked records, and people group by their complete combination.  Each header shows its record count and the column summaries, including records beyond the current page.

Click a group header to collapse or expand it.  With the header selected, Left collapses it, and Right expands it.  The grid's context menu offers {{ui:grid.group.collapseAll}} and {{ui:grid.group.expandAll}}.  Your collapsed groups stay in this browser for your account.  The {{ui:view.toolbar.group}} control keeps its icon on a narrow screen.

Pastes that would reach records inside collapsed groups are canceled.  Double-clicking or double-tapping the fill handle fills down only as far as the first collapsed group.  Use {{ui:grid.group.expandAll}} before pasting or filling across those records.

The plus button inside a header adds a record with the writable group fields filled in.  Computed fields still calculate their own values.  Shared links, interface record lists, and printouts keep the groups.  CSV and XLSX downloads contain a flat list without group headers, counts, or group summaries.

Grouping is saved with the view, so its existing view link opens the same grouping for everyone with access.  Grouping also works with synced copies and live source tables.

## Pinned records, column groups, and header colors

Open a record's grid menu and choose {{ui:grid.pin.add}} to keep it above the scrolling rows.  A view holds up to 20 pinned records, shared with everyone who opens it.  {{ui:grid.pin.remove}} returns a record to the scrolling rows.  Inserting above or below a pinned record places the new record after the pinned section.  Filters and access rules still apply.  On a phone, a long pinned section scrolls separately and leaves room for the rest of the grid.

A pin the view's filter excludes stays saved and still counts toward the limit, but nothing draws it.  When the limit is reached and some pins are not shown, {{ui:grid.pin.add}} says how many in its reason, and the next option in the menu unpins the records not shown without touching the filter.  Pins a record rule hides from a person stay saved for everyone else.

Open a field header's menu and choose {{ui:grid.appearance.title}}.  Pick {{ui:grid.appearance.headerColor}}, or create a labeled column group and choose {{ui:grid.appearance.groupColor}}.  The palette stays readable in every theme.  Choose the group's band to collapse or expand it.  These settings save with the view, and the dialog's address opens the same field's settings.

Drag a field header to reorder it.  Dropping on a grouped field joins that group, and dropping on an ungrouped field leaves the group.  The primary field stays first.  Drag a record's {{ui:grid.drag.row}} handle to reorder records when the view has no sort.  Dropping on another record group changes its writable grouping values.  Locked records, computed grouping fields, source restrictions, and access rules explain refused moves before the drop.

Mouse and pen drags start after a small movement.  On touch screens, hold briefly before moving.  For the keyboard, focus a header or row handle, press Space, use the arrow keys to choose a destination, and press Enter to drop.  Escape cancels.  Screen readers announce destinations and refusals.  Nothing rearranges until the drop, and one {{ui:grid.undo}} reverses the move.

Letting go outside the grid cancels the move instead of dropping it on the nearest edge, and the hint says so while the pointer is out there.  That is a touch's way back out, since it has no Escape to press.

Public links keep the saved colors, column groups, and accessible pinned records.  Printouts include the header colors and group labels.  XLSX downloads carry the palette colors and freeze the pinned records and columns.

Use Alt+Up from a grid cell to focus its field header.  Left and Right move between headers.  Up from a grouped header focuses its band, and Enter collapses or expands it.  Space starts a field move, the arrow keys choose its position, Enter finishes, and Escape cancels.  Down returns to the cells.  Fields stay within their frozen or scrolling columns.

Collapsing a column group changes only the grid display.  API reads, search, print, record details, and exports still include its shown fields.  Moving a record within its current group preserves its values.  A move into a date bucket, time-bearing date, or multiple-value group is refused when the target cannot preserve the original value.

## Hide fields and row height

{{ui:view.toolbar.hide}} chooses which fields the view shows and in what order.  {{ui:view.toolbar.rowHeight}} makes rows taller, so long text and many options show more.

## Summary row

The row at the foot of a grid sums up each column.  Under the first field it counts the view's records.  Under any other field, choose the footer to pick what it shows.  An empty one reads {{ui:grid.summary.choose}} when you point at it.  From the keyboard, press the down arrow past the last row, then Enter.

Every field can show {{ui:grid.summary.kind.count}}, {{ui:grid.summary.kind.filled}}, {{ui:grid.summary.kind.empty}}, {{ui:grid.summary.kind.percentFilled}}, or {{ui:grid.summary.kind.unique}}.  Numbers add {{ui:grid.summary.kind.sum}}, {{ui:grid.summary.kind.average}}, {{ui:grid.summary.kind.median}}, {{ui:grid.summary.kind.min}}, {{ui:grid.summary.kind.max}}, and {{ui:grid.summary.kind.range}}.  Dates add {{ui:grid.summary.kind.earliest}}, {{ui:grid.summary.kind.latest}}, and {{ui:grid.summary.kind.range}} in days.  Checkboxes add {{ui:grid.summary.kind.checked}} and {{ui:grid.summary.kind.unchecked}}.  {{ui:grid.summary.kind.none}} takes a summary away.

Summaries cover every record the view's filter lets through, not only the rows on screen, and only the records and fields you have access to.  They show in each field's own format and update a moment after anything changes.  Anyone who can change the view can choose its summaries.

Changes to a view save as you make them, and everyone who opens the view sees them.

A locked view keeps its order until someone who can edit it unlocks it.  Its disabled move controls explain that the view is locked.  If your access does not allow editing, the move controls explain that permission is needed instead.

## Arranging views

Drag a view's named tab to reorder the tabs.  On a phone, open {{ui:database.views.label}} to arrange the list.  Clear {{ui:database.views.search}} before changing its order.  Focus its move control, press Space, use the arrow keys, and press Space to drop.  Escape cancels.  Locked views retain their positions.  Group-by rules use the same movement controls as sort rules.

## Org chart

{{ui:views.orgChart.name}} connects record cards through a link to the same table.  Choose {{ui:views.orgChart.parent}} in {{ui:views.orgChart.settings}}.  The first linked parent present in the view determines the branch.  Filtered or unavailable parents leave a card at the top, and a cycle is opened into a tree for display.  These display choices never change the saved links.

Use {{ui:view.toolbar.hide}} to choose and order the fields on each card.  Drag the background or scroll to pan, hold Control or Command while scrolling to zoom, use {{ui:views.orgChart.zoomIn}} and {{ui:views.orgChart.zoomOut}}, or choose {{ui:views.orgChart.fit}}.  The controls scroll horizontally on a phone.  Swipe from a card to pan, or hold it briefly before dragging to change its parent.  Cards show simple boxes when zoomed far out.  {{ui:views.orgChart.collapseAll}} and {{ui:views.orgChart.expandAll}} control all branches.  A card's branch button, or {{ui:views.orgChart.collapse}} and {{ui:views.orgChart.expand}}, controls one branch.

Type in {{ui:views.orgChart.search}} and press Enter or {{ui:views.orgChart.find}} to center the next match.  Searching includes the displayed card fields and opens any collapsed ancestors.  Enter keeps focus in the search box so you can find successive matches.  Down moves focus to the selected card.  After navigation settles, copy the current address to keep the selected card, search, pan, and zoom.  Collapsed branches are also saved when they fit within 100 branch IDs or exceptions to {{ui:views.orgChart.collapseAll}}.  Larger custom collapse selections stay on the current page to keep addresses short.

Up and Down move through the tree.  Right opens a branch or moves to its first child.  Left closes a branch or moves to its parent.  Home and End move to the first and last visible records.  Enter opens the selected record.  Screen readers receive tree levels, sibling positions, branch states, and card field values.  If you can edit the chart, a locked record's card says so when you select it.  Anything that stops every move, such as a locked parent field or records still loading, is said only when you try a move.

Drag a card onto another to change its parent.  On a touch screen, briefly hold the card before dragging.  Escape cancels.  Alt+Right moves the selected card under the previous sibling, and Alt+Left moves it out a level.  {{ui:views.orgChart.root}} moves it to the top.  Moving requires permission to edit the record and its parent link.  Moves are unavailable while records are loading or the chart exceeds its record limit.  A card cannot move under itself or one of its descendants.  A loop through a record this view's filter hides is one only the server can see, so it refuses the change and the chart says {{ui:views.orgChart.invalidDrop}}.  Each move is one change that you can undo.

Public links offer the same chart navigation with reading access only.  Dragging a card on a public link pans the chart.  {{ui:print.menu}} prints the expanded chart in readable tiles, with cards and connecting lines continuing across pages.  Printouts contain only records and fields you can read.  The interactive chart draws only the cards and lines in its viewport, and loads up to 19,800 records.  Filter larger views to reach the remaining records.
