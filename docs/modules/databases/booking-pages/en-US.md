---
id: booking-pages
title: Taking bookings with a booking page
summary: Share a public page where anyone picks an open time for an appointment, a room, or a class, and each booking becomes a record.
area: databases
order: 32
level: standard
related: [forms, calendar, automations, field-and-record-permissions, public-view-links]
anchors: [bookings.theme]
---

A booking page is a public page made from a table.  Visitors pick an open time and fill in a few details, and each booking adds a record to the table.  Use one for appointments, office hours, rooms, equipment, or classes.  Visitors don't need a Riosoma account.

## Setting up a page

Open the table's menu in the sidebar and choose {{ui:bookings.menu}}, then {{ui:bookings.add}}.  Managing booking pages takes the {{ui:share.role.creator}} or {{ui:share.role.owner}} role, and tables synced from a data source can't take bookings.

The table needs a date field that includes a time, or a date range field that includes times, to hold each booking's time.  It also needs a text field for the booker's name and an email field for their address.  The page picks the first of each, and you can change them.

- {{ui:bookings.form.title}} and {{ui:bookings.form.description}} are what visitors read at the top of the page.
- {{ui:publicTheme.label}} gives the page a theme of its own, which wins over the database's.  {{ui:publicTheme.inherit}} follows the database.  Picking one changes only how the page looks, so the page keeps adding bookings as the person who last saved its other settings.
- {{ui:bookings.form.timeField}} holds the booking's time.  A date field gets the start, and a date range field gets the start and the end.
- {{ui:bookings.form.resource}} is optional.  Choose a single select of rooms, people, or equipment, and visitors pick one before they see times.  Each option is booked on its own, so the same time can be taken in one room and open in another.
- {{ui:bookings.form.length}} sets how long each booking lasts, from 15 minutes to 8 hours.  {{ui:bookings.form.buffer}} keeps time free before and after every booking.
- {{ui:bookings.form.places}} is one for appointments.  Raise it for a class, and the time stays open until that many people have booked it.

## Opening hours and when people can book

Under {{ui:bookings.form.hours}}, choose the {{ui:bookings.form.timeZone}} your hours are in, then turn on each day you take bookings and set its hours.  Choose the plus icon beside a day for a second stretch, such as the afternoon after a lunch break.  Times start at the beginning of each stretch and repeat every booking length plus the buffer.  Visitors see every time in their own time zone, and daylight saving changes are handled for you.

{{ui:bookings.form.ahead}} limits how far after today people can book, and {{ui:bookings.form.notice}} sets how long before a time people have to book it.  Use {{ui:bookings.form.block}} to close a day, such as a holiday.

## What people fill in

The booker always gives their name and email address, in the fields you chose for {{ui:bookings.form.nameField}} and {{ui:bookings.form.emailField}}.  You can ask about other fields too, and choose which of them are required.  People, linked records, attachments, and computed fields can't be asked about.

Add a {{ui:bookings.form.confirmation}}, such as where to go or what to bring.  It's shown after booking and included in the confirmation email.

## Sharing the page

Choose {{ui:bookings.list.copy}} to copy the {{ui:bookings.list.link}}, and send it however you like.  The list also shows how many upcoming bookings each page has.

Visitors pick what they're booking, if the page asks, then a day on the calendar, then a time, then fill in their details and choose {{ui:bookings.page.book}}.  Days without open times are struck through.  Everything works with the keyboard and with screen readers.

If someone else takes the last place while a visitor is deciding, the visitor is told the time was just taken and offered the next open times.  Two people can never book the last place at once.

## Which times are open

A time is open when fewer records than its places overlap it, counting the buffer on both sides.  Every record in the table counts, including ones added in the app rather than through the page, as long as it isn't in the trash.  With {{ui:bookings.form.resource}}, only records for the chosen option count.

Visitors never see anything about anyone else's booking.  A time is simply open or not, with no names, counts, or places left.

## Whose booking it is

A page runs as the person who last saved its settings.  Each booking adds a record as if they had added it: it's credited to them in the record's history, their field and record permissions apply, and any automation that watches the table starts.  Times are counted from the records that person can see.  If they can no longer add records to the table, the page stops taking bookings and the list says why.  Saving its settings again makes you the person it runs as.

## Confirmation and canceling

When your server can send email, each booker gets a confirmation with a calendar invitation attached and a link to cancel.  The link opens a page that asks before canceling, so nothing changes until the booker chooses {{ui:bookings.cancel.confirm}}.  Canceling moves the record to the trash and frees the time.  A booking can't be canceled online once it has started.

## Turning a page off

Turn off a page's switch in the list, or {{ui:bookings.form.enabled}} while editing it, to stop taking bookings at once.  Visitors are told the page isn't taking bookings, and cancel links keep working.  Choose {{ui:bookings.list.delete}} to remove a page for good.  Its records stay in the table, but the cancel links it sent stop working.

## Limits that keep out junk

Like public forms, a booking page has a hidden check that catches bots, and a page left open for more than a day has to be reloaded before booking.  One internet connection can try to book at most 10 times an hour on one page, and an IPv6 connection counts as its whole /64 network.  {{ui:bookings.form.daily}} limits how many bookings one email address can make on the page in a day, three unless you change it.

## Taking a payment

Use {{ui:payments.required}} to collect a fixed price or a price from a single select question, optionally multiplied by a quantity.  Visitors pay through Stripe Checkout, and verified webhooks update the protected payment result fields.  A booking waiting for payment holds its time while Checkout stays open, for 30 minutes, and until Stripe confirms the outcome.  Putting its record in the trash frees the time and ends its Checkout at once.  One internet connection can have one such booking on a page at a time, and they can take at most a third of a day's places.  Booking confirmations wait until payment is confirmed.  See [Taking payments](../payments/en-US.md) for setup, booking holds, and refunds.

## Embedding a booking page

Open the booking page's settings and turn on {{ui:shareView.embedOn}}.  List up to 20 exact origins in {{ui:shareView.sites}}, choose {{ui:shareView.sitesSave}}, and use {{ui:shareView.copyEmbed}}.  Include the scheme and any nondefault port.  Paths, queries, and wildcard hosts are rejected.  Empty lists allow only same-origin frames.  Administrators can disable embedding for the organization at /settings/public-sharing with {{ui:publicSharing.allowEmbedding}}.

Use Tab to reach a dialog’s scrolling content or its controls.  Page Up, Page Down, and the arrow keys scroll content that has keyboard focus.  The dialog’s actions stay visible, and {{ui:ui.dialog.close}} puts the dialog aside.
