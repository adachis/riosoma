---
id: conditional-colors
title: Coloring records by their values
summary: Color the cells and records that match a rule, shade numbers and dates on a scale, and draw bars behind numbers.
area: databases
order: 25
level: simple
related: [views, kanban, gallery, fields, list-and-map]
anchors: [view.color]
sections: [view.color=rules]
---

Conditional colors make the records that need attention easy to spot: overdue tasks in red, high scores in green, or the biggest orders with the longest bars.  They belong to a view, so each view can color the same records its own way, and everyone who opens the view sees them.

Grid, kanban, gallery, list, and map views have them.  A list marks a colored record at the start of its line, and a map draws its pin in the record's color.  Choose {{ui:views.color.toolbar}} in the view's toolbar.  Once a view has colors, the button counts them.  People with the {{ui:share.role.creator}} or {{ui:share.role.owner}} role add and change colors, and changes save as you make them.

## Rules

A rule colors what matches a condition, the same kind of condition a filter uses.

1. Choose {{ui:views.color.rules.add}}.
2. After {{ui:views.color.rule.when}}, choose a field, a {{ui:views.color.rule.operator}}, and a value, as you would for a filter.  For example, a due date that is before today, or a status that is Blocked.
3. Pick a {{ui:views.color.rule.color}}.
4. Under {{ui:views.color.rule.target}}, choose {{ui:views.color.rule.cell}} to color only that field's cells, or {{ui:views.color.rule.record}} to tint the whole record.
5. Give the rule a {{ui:views.color.rule.name}} that says what the color means, such as "Overdue".  Screen readers say the name wherever the color shows, so color is never the only clue.  Without a name, they read the condition itself.

Rules are checked from the top.  The first matching {{ui:views.color.rule.cell}} rule colors a cell, and the first matching {{ui:views.color.rule.record}} rule colors a record, so put the rules that matter most first.  Drag a rule row to move it.  On a phone, press and hold the row before dragging.  Focus the move control ({{ui:views.color.rule.move}}), then press {{keys:reorder.pick}} or {{keys:reorder.pickEnter}} to pick up, {{keys:reorder.up}} or {{keys:reorder.down}} to move, {{keys:reorder.pick}} to drop, and {{keys:reorder.cancel}} to cancel.  {{keys:reorder.upNow}} and {{keys:reorder.downNow}} move immediately.  The line marks the destination, and other rules stay still until you drop.  {{ui:views.color.rule.remove}} deletes a rule.  A view can have 50 rules.

A condition that's still missing its value colors nothing yet.  If a field's type changes so a rule no longer fits it, the rule says "{{ui:views.color.rule.doesNotApply}}"

## Color scales

A color scale shades a field's cells from one color to another, so high and low values stand out at a glance.  It works with {{ui:field.type.number}}, {{ui:field.type.currency}}, {{ui:field.type.percent}}, {{ui:field.type.duration}}, {{ui:field.type.rating}}, and {{ui:field.type.date}} fields.

Choose {{ui:views.color.scales.add}} and pick the field.  The scale has a row for each end, {{ui:views.color.scale.lowest}} and {{ui:views.color.scale.highest}}, with a color and a value.  A new scale runs from red to green, and you can change either color.  Check {{ui:views.color.scale.middle}} to add a third color between them, on a row marked {{ui:views.color.scale.halfway}}.

Leave the values empty to follow the lowest and highest values in the view, so the colors spread across whatever the records hold.  Or set them, so that, for example, a score of 90 is always fully green.  Values past an end take that end's color.  A middle color sits halfway between the ends unless you give it a value too.

Each field can have one scale.  Where a rule colors a cell, the rule's color wins.

## Data bars

A data bar draws a bar behind a number, longer for bigger numbers, like a small bar chart running down the column.  It works with {{ui:field.type.number}}, {{ui:field.type.currency}}, {{ui:field.type.percent}}, {{ui:field.type.duration}}, and {{ui:field.type.rating}} fields.

Choose {{ui:views.color.bars.add}}, pick the field, and choose the {{ui:views.color.bar.color}}.  Turn off {{ui:views.color.bar.showValue}} to leave only the bar.  Screen readers still read the number.

Bars start from zero, or from the lowest value when some are below zero, and the highest value in the view reaches all the way across.  Each field can have one data bar, and a cell can have a bar and a color at once.

## Icon sets

Choose {{ui:views.color.icons.add}} for a numeric field, then select {{ui:views.color.icons.arrows}}, {{ui:views.color.icons.flags}}, or {{ui:views.color.icons.ratings}} under {{ui:views.color.icons.style}}.  Each field can have one icon set alongside its colors and data bar.

Set {{ui:views.color.icons.middleThreshold}} and {{ui:views.color.icons.highThreshold}}.  Values below the middle threshold get the low icon, values at or above it get the middle icon, and values at or above the high threshold get the high icon.  Equal thresholds leave the middle band empty.  Thresholds are fixed numbers, so filtering records does not change their meaning.  Blank cells have no icon.

Each band has a text alternative you can customize.  Empty alternatives use a translated description of the band's thresholds.  Screen readers read the number and alternative together; hovering over the grid icon also shows the alternative.  The controls wrap on a phone and work with Tab, arrow keys, and Enter.  The Color panel's URL can be bookmarked or shared.

When you open a record, its icons appear beside the existing color dots, and screen readers keep both descriptions.  If you convert a numeric field to a nonnumeric type, its saved icon set stays dormant, and other view settings still save.  Converting the field back to a compatible numeric type restores its icons.  Changing a dormant set requires a compatible numeric field.

XLSX downloads keep numbers as numeric cells and carry native conditional icon formats.  Ratings use the spreadsheet's native rating bars at three levels.  {{ui:views.color.icons.remove}} removes an icon set.

## Where the colors show

- In a grid, a record's color tints its whole row, and a cell's own color or bar shows on top.
- On kanban and gallery cards, a record's color shows as a colored edge on the card, and the fields on the card show their own colors and bars.
- When you open a record from one of these views, a small dot beside its name, and beside each colored field, shows the same colors.

The colors are soft tints, chosen so that text stays easy to read on them in every theme, light or dark.

Scales and bars that follow the lowest and highest values use every record the view's filter lets through, not only the ones on screen.  Like everything else, they only count records you can see.  Other kinds of view don't show conditional colors.

## Sparklines

Choose {{ui:views.sparkline.add}} in the color editor for a lookup, rollup, JSON number list, or formula that returns a list. Sparklines show a list as a small chart in grids, gallery and kanban cards, lists, records, and interfaces. JSON lists use a JSON array such as `[3, 1, 4]`. Blanks, text, and nonfinite values are omitted. A rollup charts its linked numeric values while keeping its aggregate value.

Choose {{ui:views.sparkline.line}}, {{ui:views.sparkline.column}}, or {{ui:views.sparkline.winLoss}} under {{ui:views.sparkline.type}}. Win and loss uses equal-height marks above or below zero; zero has no bar. The first, last, minimum, and maximum points can each be highlighted. Chart colors follow the theme's accent and legible colors. The controls wrap on phones.

Lookup and rollup points follow the order of linked records. Drag the records in the link field to change that order. Under {{ui:views.sparkline.order}}, choose another field of the linked table and an ascending or descending direction to order by that field instead. Ties keep linked-record order, and missing ordering values come last. Plain lists keep their own order.

{{ui:views.sparkline.sharedAxis}} uses the same minimum and maximum across every visible record admitted by the view's filters and your permissions. Turn it off to scale each row independently. Screen readers hear the minimum, maximum, last value, and whether the last value rises, falls, or stays equal to the first. Print and PDF output include the chart and this text alternative, using a paper palette that stays legible when the app uses a dark scheme.

Formatted XLSX downloads include native line, column, and win-and-loss sparklines, backed by numeric cells on a hidden worksheet. Spreadsheet readers that do not support sparklines still receive the cell values. Lists exceeding spreadsheet source-range limits retain their values without a native chart. Choose {{ui:views.sparkline.remove}} to remove a sparkline.
