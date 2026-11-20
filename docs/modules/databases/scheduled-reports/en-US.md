---
id: scheduled-reports
title: Scheduled reports by email
summary: Email a view's records on a schedule, as a CSV, Excel, Word, PowerPoint, or PDF file and a short summary, to yourself or to other people who can open the database.
area: databases
order: 22
level: standard
related: [downloading, views, automations]
anchors: [view.menu, view.reports, reports.add, reports.form.name, reports.form.format, reports.form.frequency, reports.form.save, settings.reports]
demo: scheduled-reports
routes: [/settings/reports, /settings/*/reports, /admin/*/reports]
sections: [settings.reports=setting-one-up]
---

A scheduled report emails a view's records on a schedule you choose: every day, on some days of the week, or once a month.  Each email has a short summary, with how many records the view holds and the first 20 of them, and the whole view as a file, the same file {{doc:downloading}} describes.

## Setting one up

Open the view's menu, beside its name in the row of views, and choose {{ui:reports.menu}}.  On a narrow screen, it's in the view toolbar's {{ui:toolbar.more}} button, shown as three dots.  The dialog lists the view's reports.  Choose {{ui:reports.add}}, then:

- {{ui:reports.form.name}}, which starts the email's subject, before the view's name.  It starts as the view's name.
- {{ui:reports.form.format}}: {{ui:reports.format.xlsx}}, {{ui:reports.format.csv}}, {{ui:reports.format.docx}}, {{ui:reports.format.pptx}}, {{ui:reports.format.pdf}}, or {{ui:reports.format.none}}, which sends the summary and a link to the view without a file.  A Word document or deck is titled with the view's name, a deck has a slide for each record with Riosoma's own green for its titles, and each holds as many records as the same download would, as {{doc:downloading}} describes.  A PDF uses the email's layout with grouped rows, totals, conditional color rules and scales, and embedded chart images.  Its table headers repeat on each page, pages are numbered, and wide tables turn sideways.  PDFs hold up to 5,000 records or 50,000 cells.  The file and history say when that limit leaves records out.

- {{ui:reports.form.frequency}}: {{ui:reports.form.daily}}, {{ui:reports.form.weekly}} on the days you check under {{ui:reports.form.days}}, or {{ui:reports.form.monthly}} on the {{ui:reports.form.day}} you choose.  A report set for the 31st goes on the last day of a shorter month.
- {{ui:reports.form.at}}, a time of day in the {{ui:reports.form.timeZone}} you choose.  It starts as your own.  Reports keep that time when clocks change for daylight saving.  If the server was down when one was due, it goes once when the server is back, rather than once for every time it missed.
- {{ui:reports.form.recipients}}, who gets it.  It starts with you, and if you take yourself off, {{ui:reports.form.addMe}} puts you back.
- {{ui:reports.form.enabled}}, which you can turn off to keep a report without sending it.

Then choose {{ui:reports.create}}.

For a PDF schedule, {{ui:reports.download}} makes a fresh file with the records and fields you can currently see.  Scheduled emails and {{ui:reports.send}} apply each recipient's permissions in the same way.  The server's optional PDF renderer carries theme print styling into the PDF.  The built-in renderer uses standard fonts, including Japanese and Korean characters, and splits wide tables into sections with the first column and headers repeated.  Characters unavailable in its fonts appear as replacement marks.  {{ui:reports.runs.title}} lists missing characters and any styling or chart simplifications for each recipient without storing record values.

## Who can get it

Anyone who can open the database, including people with the {{ui:share.role.reader}} role, can set up a report that goes to themselves.  People with the {{ui:share.role.creator}} or {{ui:share.role.owner}} role, who can change the view, can also add other members of the database under {{ui:reports.form.addMember}}.

Every member who gets a report gets the records and fields they could see themselves at the moment it's sent, so one report can send different records to different people.  Someone who can no longer open the database when a report goes gets nothing, and the report's history says why.

An organization can let reports go to addresses outside it.  That's off to start with, and an owner or an admin with the security role turns it on in Settings, under {{ui:reports.title}}, with {{ui:reports.policy.outside}}.  Once it's on, people who can change the view add an outside address under {{ui:reports.form.address}} and {{ui:reports.form.address.add}}.  An outside address gets what the person who set up the report sees, so reports from a database with restricted fields never go outside the organization.  An address that belongs to someone in the organization is treated as that person.

## What the email holds

The subject is the report's name and the view's name.  The summary says how many records the view holds and shows the first 20 as a small table of the view's first five fields, worded the way Riosoma shows them.  Summary cells stop at 120 characters, with an ellipsis for longer text.  The PDF retains the full cell text.  A CSV or Excel file holds every record and every field the view shows, and a Word document or deck holds up to its limit and says so when the view has more.  A file larger than 20 MB isn't attached, and the email links to the view instead.

At the bottom, the email names the report and who set it up, with a link to stop receiving it.  The link works without signing in, for the person it was sent to, and stops working 90 days after the email was sent.  It opens a page that asks first, and {{ui:reports.unsubscribe.confirm}} stops that one person getting the report.  Mail apps that offer an unsubscribe button of their own do the same in one step.

## Changing, sending, and stopping

In the view's {{ui:reports.menu}} dialog, the switch beside a report you set up turns it on or off.  Its menu has:

- {{ui:reports.edit}}, to change anything about it.
- {{ui:reports.send}}, which sends it to everyone on it right away, whether or not it's on.  It's the quickest way to see what it looks like.
- {{ui:reports.runs.title}}, which lists every time it went, newest first: when, to whom, how many records each person got, and what went wrong, without any of the records themselves.  {{ui:reports.runs.more}} shows older ones, and {{ui:reports.back}} returns to the list.
- {{ui:reports.delete}}.

Only the person who set up a report can change it.  People who can change the view see every report on it, and a database's owners can delete any of them.  Everyone else sees only the reports they set up or receive.

When the mail server doesn't take an email, Riosoma tries again after a minute, then after 5 minutes, then after 25, for just the people it didn't reach.  After that it stops trying, and the history says who didn't get it.

A report turns itself off when its view is deleted or when the person who set it up can no longer open the database.  They hear about it under the bell, and by email when they choose {{ui:notifications.settings.reportStopped}} in their notification settings.

## Your reports

Settings has a {{ui:reports.title}} section that lists {{ui:reports.settings.owned}}, each linking to its view, and {{ui:reports.settings.receiving}}.  {{ui:reports.leave}} beside a report takes you off it.
