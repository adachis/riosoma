---
id: timeline-and-gantt
title: Planning on a timeline or a Gantt chart
summary: See records as bars across time, drag them to new dates, and follow what each task waits on.
area: databases
order: 23
level: simple
related: [calendar, views, fields, formulas]
anchors: [view.settings.timeline, view.settings.gantt]
sections: [view.settings.timeline=choosing-the-dates, view.settings.gantt=a-gantt-chart-s-extras]
---

A timeline and a Gantt chart both draw each record as a bar that runs from a start date to an end date, on a strip of time you can scroll and zoom.

- A timeline packs its bars into as few rows as fit, or sorts them into lanes, such as one for each person.  It suits schedules, bookings, and campaigns.
- A Gantt chart gives every record a row of its own, fills in how far along each task is, and draws arrows from the tasks each one waits on.  It suits projects.

Choose {{ui:database.views.add}}, then {{ui:views.timeline.name}} or {{ui:views.gantt.name}}.

## Choosing the dates

A new timeline or Gantt chart starts its bars at a date field whose name says it's a start, such as "Start date", "Begins", or "Kickoff", and ends them at one whose name says it's an end, such as "End date", "Due", or "Deadline".  It knows these words in each language Riosoma speaks.  Without such names, it takes the table's first two date fields.  To change them, open the settings button in the view's toolbar, {{ui:views.timeline.settings}} or {{ui:views.gantt.settings}}:

- {{ui:views.timeline.start}} decides where each bar begins.  A record without a start date has no bar.
- {{ui:views.timeline.end}} decides where it ends.  Choose {{ui:views.timeline.settings.none}} when records have only one date.  A record with no end, or with an end before its start, is drawn one column long, with a dashed far edge to show it has no end of its own.
- {{ui:views.timeline.label}} chooses the field each bar is named by.  It starts as the table's primary field.

Dates can come from date fields, created and last modified times, and formulas that return dates.  A date range field can't be chosen itself, but you can show one: add two formula fields, `START({Dates})` and `END({Dates})`, and choose those.  {{doc:formulas}} has more on both.

If the table has no date field yet, the view says "{{ui:views.timeline.setup.title}}" and offers {{ui:views.timeline.setup.add}}, which adds a date field named {{ui:views.timeline.newField}}.  A Gantt chart offers {{ui:views.gantt.setup.add}} instead, which adds {{ui:views.gantt.newStart}} and {{ui:views.gantt.newEnd}}.

People with the {{ui:share.role.creator}} or {{ui:share.role.owner}} role change the settings, and they apply for everyone who uses the view.

## Finding your way

The view opens with today about a third of the way across, marked by a line.  Scroll sideways to move through time, and up and down through the records.  {{ui:views.timeline.today}} brings today back into view.

The {{ui:views.timeline.zoom}} menu beside it sets how much time each column covers: {{ui:views.timeline.zoom.day}}, {{ui:views.timeline.zoom.week}}, {{ui:views.timeline.zoom.month}}, {{ui:views.timeline.zoom.quarter}}, or {{ui:views.timeline.zoom.year}}.  Creators and owners save the zoom with the view.  Anyone else zooms for themselves, until they leave the page.

Each bar shows its label and the other fields the view shows, so choose them with {{ui:view.toolbar.hide}}.  Point at a bar, or move to it with the keyboard, to see its dates and those fields in full.  Select a bar to open its record.

{{ui:view.toolbar.filter}} decides which records appear.  A timeline arranges bars by when they start, and a Gantt chart's rows follow the view's {{ui:view.toolbar.sort}}.

## Lanes on a timeline

{{ui:views.timeline.group}} sorts a timeline's bars into lanes by a {{ui:field.type.singleSelect}}, {{ui:field.type.user}}, or {{ui:field.type.link}} field: one lane for each option, person, or linked record, labeled with its name and how many records it holds.

- A record with several people or linked records appears in each of their lanes.
- Records with nothing in the field go in a lane named {{ui:views.timeline.lane.empty}}, at the bottom.
- Options keep the order of their list, and other lanes go in order by name.

{{ui:views.timeline.group.none}} puts every bar in one space, packed into as few rows as fit.

## Changing dates

Drag a bar to move it to other dates, keeping its length.  Drag either end of a bar to change only its start or only its end.  Press Escape before you let go to cancel.  A change saves right away, shows in every view, and can be undone.

- A date's time of day stays as it was.
- A bar with no end stays that way when you move it, and gets an end when you drag one of its edges.
- An end can't be dragged before its start, or a start past its end.

Bars move for people with the {{ui:share.role.editor}}, {{ui:share.role.creator}}, or {{ui:share.role.owner}} role, when the dates come from ordinary date fields.  Dates from formulas and from created and last modified times are shown but can't be dragged, since nobody types them in, and neither can dates a synced table copies from a source that doesn't allow changes.  A locked record or restricted date field also refuses the move before release.

With the keyboard, press Tab to reach the bars.  Up and Down move between records, and Home and End jump to the first and the last.  Left and Right move a bar by one column, such as a week at the {{ui:views.timeline.zoom.week}} zoom, {{keys:views.endLeft}} or {{keys:views.endRight}} moves only its end, and {{keys:views.moveLeft}} or {{keys:views.moveRight}} moves only its start.  Enter opens the record.

On a touch screen, press briefly before dragging a bar or either end.  Moving right away scrolls.  A highlighted bar and an announcement show the proposed dates or explain why they cannot be saved.  Other bars stay in place until release.

## A Gantt chart's extras

{{ui:views.gantt.settings}} has two more fields:

- {{ui:views.gantt.dependency}} is a {{ui:field.type.link}} field that links the table to itself, naming the records each record waits on.  Arrows run from the end of each of those records to the start of the one waiting.  When a record starts on or before the day something it waits on ends, its arrow turns dashed and its bar is marked at the start, so the clash is easy to spot.
- {{ui:views.gantt.progress}} fills each bar to show how far along it is.  Choose a {{ui:field.type.percent}} field, or a {{ui:field.type.number}} field that holds 0 to 100.

Drag the diamond on a prerequisite bar onto another bar to add a dependency.  Drag between the same bars again to remove it.  From the focused prerequisite, press {{keys:views.dependencies}}, or choose {{ui:views.gantt.dependencies}} in the view's toolbar, then pick the {{ui:views.gantt.prerequisite}} and the {{ui:views.gantt.dependent}}, and select {{ui:views.gantt.addDependency}} or {{ui:views.gantt.removeDependency}}.  The toolbar item opens the dialog for the bar you reached last, or the first bar in the chart.  This dialog has a shareable address.  Escape cancels a drag or closes the dialog.  Each saved dependency change is one undo step, and locked or read-only dependency fields refuse changes.

A new Gantt chart picks these for you when the table has them: the first link to its own table, and the first percent field.

Every record in the view has a row, in the view's order, whether or not it has dates.  The column down the side names each one, and selecting a name opens the record.  To widen or narrow that column, drag the edge of its heading, at the top.  With the keyboard, press Tab to reach that edge ({{ui:views.gantt.resize}}), then use Left and Right, or Home and End for the narrowest and the widest.  Like the zoom, the width saves with the view when a creator or owner changes it.

## Listing records and dates

{{ui:views.timeline.list}} opens {{ui:views.timeline.list.title}}: every record in the view with its dates, in a table, in the view's order.  A timeline adds its lane field, and a Gantt chart adds progress and what each record waits on.  Select a record's name to open it.  The list is also the easiest way to read a busy chart with a screen reader.

When some records have no start date, a timeline's toolbar shows {{ui:views.timeline.undated}} with how many.  Choose it to list them, and select one to open it and give it a date.

## Subscribing in a calendar app

A timeline or a Gantt chart can go into Apple Calendar, Google Calendar, or Outlook, the same way a calendar can.  Open the view's menu and choose {{ui:calendarFeeds.menu}}.  Each record becomes an event from its start to its end.  A record with no end is an event on its start alone: a whole day for a date, or a single moment for a date with a time.  {{doc:calendar}} explains how to add the address to each calendar app, how often each one checks for changes, and how to stop it.

## Large tables

A timeline or Gantt chart loads up to 19,800 records.  A view with more says so and shows the first ones in its order, so filter the view to see the rest.  Records other people add or change appear about a second later.

On touch screens, short bars keep room in the middle for moving, so a bar too short for the dependency diamond has no diamond to drag.  Choose {{ui:views.gantt.dependencies}} in the view's toolbar instead: it opens the same dialog, where both records of the dependency are chosen from a list.
