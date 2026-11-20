---
id: calendar
title: Scheduling records on a calendar
summary: See dated records by month or week, move them to another day, and subscribe to them in a calendar app.
area: databases
order: 12
level: simple
related: [views, fields, undo, timeline-and-gantt]
routes: [/settings/calendar-feeds, /settings/*/calendar-feeds, /admin/*/calendar-feeds]
anchors: [settings.calendar.feeds, view.settings.calendar]
sections: [settings.calendar.feeds=subscribing-in-a-calendar-app, view.settings.calendar=choosing-dates]
---

A calendar places records on the days from a date field.  Use it for deadlines, publishing schedules, or events.  Choose {{ui:database.views.add}}, then {{ui:view.type.calendar}}, to add a calendar to a table.

## Choosing dates

Set {{ui:calendar.start}} to the field that decides where records appear.  An optional {{ui:calendar.end}} lets records span several days.  Records without a start date do not appear, so use another view to find and date them.

You can choose ordinary date fields, creation or modification times, and formulas that return dates.  Calculated dates can be displayed but cannot be moved directly.  Dates with times follow their field's time zone settings.

Choose {{ui:calendar.month}} or {{ui:calendar.week}} for the range.  Use the arrow buttons, {{ui:calendar.previous}} and {{ui:calendar.next}}, to browse, or {{ui:calendar.today}} to return to the current date.  The view's filters decide which records are included.  A narrow calendar stacks its days and shows each full date so event names and actions fit.

## Adding and moving records

Open a record on the calendar to edit it.  A day's add button creates a record with that day as its start date when the start field is editable.

Drag a record to another day to reschedule it.  Moving preserves its time of day and shifts an existing end date by the same number of days.  Moving is available when the start field and any selected end field are ordinary editable date fields.  The changed dates appear in every view and can be undone.

For events with times, {{ui:calendar.week}} shows half-hour drop targets.  Drop on a time to change both the day and time while keeping the event's duration.  Drag the resize control beside a timed event to change its end, or drop that control on a time target.  Hold over {{ui:calendar.previous}} or {{ui:calendar.next}} while dragging to move into an adjacent week or month.  The calendar date stays in the address, so a copied link opens the same range.

While a drag is held, the calendar scrolls itself near its own top and bottom edges, even over a day's time targets, so a drag reaches the days off screen and {{ui:calendar.previous}} and {{ui:calendar.next}}.  Between those edges, holding near the top or bottom of the time targets scrolls through that day's hours instead.

On a touch screen, press briefly before dragging.  Move right away to scroll.  A highlighted target and an announcement describe the destination or explain a refusal.  Escape cancels without changing dates.  A completed drag is one undo step.  Locked records, restricted or locked date fields, calculated dates, and read-only Data Source dates cannot be changed.

## Using the keyboard

Use arrow keys to focus days.  Enter opens a day's record list when it has records, or adds a record on an empty day when editing is allowed.

With an event focused, {{keys:views.moveLeft}} or {{keys:views.moveRight}} moves it one day.  For timed events, {{keys:views.moveUp}} or {{keys:views.moveDown}} moves it by 30 minutes, and {{keys:views.endUp}} or {{keys:views.endDown}} changes only the end.  The resize control also accepts Up and Down.

To reschedule without dragging, open the record's actions menu and choose {{ui:calendar.moveTo}}.  Pick the destination date and confirm with {{ui:calendar.moveTo}}.  You can also expand the record and edit its dates directly.

## Subscribing in a calendar app

You can see a calendar's records in the calendar app you already use, beside your other events.  Open the view's menu, beside its name in the row of views, and choose {{ui:calendarFeeds.menu}}.  On a narrow screen, it's in the view toolbar's {{ui:toolbar.more}} button, shown as three dots.  Then choose {{ui:calendarFeeds.make}}.

Riosoma shows a private address made just for you.  Choose {{ui:calendarFeeds.copy}} to paste it into a calendar app, or {{ui:calendarFeeds.open}} to hand it straight to the calendar app on this device.  The address is shown only this once, since Riosoma doesn't keep the address itself.  Anyone with it can read what it shows, so keep it to yourself.

### What your calendar app shows

- Each record in the view is an event, named by its primary field, on the dates from {{ui:calendar.start}} and {{ui:calendar.end}}.  Dates without times make all-day events.  Dates with times appear at their time, shown in your calendar app's own time zone.
- A record with no end, or an end before its start, is an event on its start day alone.
- An event's notes list the other fields the view shows, and its link opens the record in Riosoma.
- The view's filter decides which records appear, as it does here.
- The address reads the view as you see it.  Records and fields hidden from you never appear, and once you can no longer open the view, the address stops working.
- A calendar app gets up to 5,000 events.  A view with more sends the ones nearest to today.

Nothing can be changed through the address.  To move a record, change it in Riosoma, and the calendar app catches up the next time it checks.  A calendar on a table that reads its source live can't be subscribed to.

### Adding it to your calendar app

- **Apple Calendar on a Mac:** choose File, then New Calendar Subscription, and paste the address.  Under Auto-refresh, choose how often it checks, from every 5 minutes to once a week.  Under Location, choose On My Mac if your Riosoma server can only be reached from your own network, since iCloud reads the address from Apple's servers.
- **Apple Calendar on an iPhone or iPad:** choose {{ui:calendarFeeds.open}}, or in Settings, open Calendar's accounts, add an account of the Other kind, and choose Add Subscribed Calendar.  It checks for changes on the schedule set under Fetch New Data.
- **Google Calendar:** on a computer, choose the add button next to Other calendars, then From URL, paste the address, and choose Add calendar.  It then shows on your phone too.  Google reads the address from its own servers, so your Riosoma server has to be reachable from the internet.  Google decides how often to check, usually every several hours and sometimes only once a day, and it can't be made to check sooner.
- **Outlook:** in Outlook on the web or the new Outlook, open the calendar, choose Add calendar, then Subscribe from web, paste the address, and choose Import.  It checks every few hours, and a change can take up to a day to show.  Like Google, it reads the address from Microsoft's servers, so your Riosoma server has to be reachable from the internet.  In classic Outlook for Windows, choose Add Calendar, then From Internet.  It checks about once an hour, as the address asks.

### Changing or stopping it

Choose {{ui:calendarFeeds.menu}} again to see when you made the address and when a calendar app last read it.

- {{ui:calendarFeeds.replace}} makes a new address and stops the old one at once.  Use it when an address got out, or when you need to see an address again.  Then subscribe your calendar apps to the new one.
- {{ui:calendarFeeds.stop}} stops the address.  Calendar apps subscribed to it stop updating, so remove the subscription there too.

Each person has one address for each view.  Anyone who can open the database, including people with the {{ui:share.role.reader}} role, can subscribe.

An owner or an admin with the security role can turn calendar feeds off for the whole organization in Settings, under {{ui:calendarFeeds.settings.title}}.  That stops every address at once, and turning feeds back on doesn't bring those back.

When moving a multi-day event, the day you grabbed moves to the drop day.  In month view, resizing keeps the end time and changes the end day.  In week view, {{ui:calendar.timeTargets}} appear beside the events during a timed drag without shifting the days.  Hold near the top or bottom of the time targets to scroll through the whole day, and near the top or bottom of the calendar to scroll the whole week.
