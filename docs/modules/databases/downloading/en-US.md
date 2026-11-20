---
id: downloading
title: Downloading a view as CSV, Excel, Word, PowerPoint, or PDF
summary: Save the records a view shows as a file for a spreadsheet, a report, or a presentation, or print them, in the view's order and with its filter.
area: databases
order: 21
level: simple
related: [views, importing, fields, printing-and-pdfs, public-view-links, scheduled-reports]
anchors: [view.menu, grid, view.export]
demo: downloading
sections: [view.export=downloading]
---

Any view can become a file: a CSV file that every spreadsheet opens, an Excel workbook, a Word document, or a PowerPoint deck.  Grids, galleries, and kanbans can also be printed or saved as a PDF.  The file holds what the view shows, so shape the view first, as described in {{doc:views}}.

## Downloading

Open the view's menu, beside its name in the row of views, and choose {{ui:export.csv}}, {{ui:export.xlsx}}, {{ui:export.docx}}, or {{ui:export.pptx}}.  On a narrow screen, the view's toolbar also has a {{ui:toolbar.more}} button, shown as three dots, with the same choices.  Riosoma says "{{ui:export.pending}}" while it builds the file, and then your browser saves it, named after the table and the view.  A Word document or a deck asks a question or two first, as the next sections describe.

Anyone who can open the database can download its views, including people with the {{ui:share.role.reader}} role.  One download runs at a time.

To have a view's records emailed as a file on a schedule, including as a Word document or a deck, choose {{ui:reports.menu}} in the same menu, as {{doc:scheduled-reports}} describes.

## What's in the file

- The records the view shows, in its order, with its filter applied.  Relative dates in the filter, such as "within the past week", follow your time zone.
- The fields the view shows, in the view's order.  Hidden fields are left out.
- Values the way Riosoma shows them, in your language and time zone: options, people, and linked records by name, attachments by file name, and dates in their field's format.

In an Excel file, numbers, currency, percentages, dates, and checkboxes are real values, formatted the way Riosoma shows them, so a spreadsheet can total a column or sort by date without anyone retyping it.  Everything else is text, and the header row stays in view as you scroll.  In a CSV file, a checked box reads "checked".

A value that starts with =, +, -, or @ gets an apostrophe in front of it, so a spreadsheet treats it as text instead of running it as a formula.

Records and fields you can't see are never in the file.  If a download fails, Riosoma says "{{ui:export.failed}}"

## Word documents

A Word document is made for reading and passing along, such as for a report to the people you work for.  Choose {{ui:export.docx}}, give it a {{ui:export.office.title}}, which starts as the view's name, and choose {{ui:export.office.download}}.

The document starts with its title, when it was made, how many records the view holds, and the view's filter put into words, such as "Filter: Status is Done and Amount is at least $10.00".  Then comes a table of the fields the view shows, in the view's order, with the header row repeated at the top of every page and the page number at the bottom.  Values keep their formatting: currency and dates the way you read them, a check mark for a checked box, options, people, and linked records by name, attachments by file name, and rich text with its bold, italics, lists, and links.  A table with more than six fields turns the pages sideways so the columns have room.

A kanban, a grouped list, or a timeline with lanes gets a heading for each group with how many records are in it, and a table under each.  A kanban's groups follow the board, in its order and without the stacks it hides.

## PowerPoint decks

Choose {{ui:export.pptx}}, give the deck a {{ui:export.office.title}}, and pick how its slides lay the records out:

- {{ui:export.office.layout.records}} puts each record on a slide of its own, titled with its primary field, with up to eight of the view's other fields as a list of names and values, and the first picture from the view's first attachment field when the record has one.
- {{ui:export.office.layout.table}} shows the view as a table, 12 records to a slide, with the view's first eight fields as its columns.

Either way, the deck opens with a title slide that says where it came from and what the view's filter is, and its titles are drawn in your theme's accent color, made darker when it's too light to read on a white slide.

## One record as a Word document

Open a record, choose its menu, shown as three dots beside the arrows at the top of the card, and choose {{ui:export.record.menu}}.  The document is titled with the record's primary field, and lists every field you can see as a name and its value, in the card's order.  Pictures among its attachments are drawn under their field, up to 20 of them, each scaled to fit the width of the page.  A picture still waiting for its virus scan is left out, in a deck's slides too.  Check {{ui:export.record.comments}} to add the record's comments at the end, each with who wrote it and when.

## How much a Word document or deck holds

A CSV file or a workbook holds every record in the view, however many.  A Word document or a deck is built whole before your browser gets it, so each stops at a limit, and says so on its first page when the view has more:

- A Word document holds up to 5,000 records, and up to 50,000 values in its table, so a view that shows 20 fields stops at 2,500 records.
- A deck with a slide for each record holds up to 200 of them.
- A table deck holds up to 1,200 records, which is 100 slides.

When a view holds more than that, download it as CSV or Excel for all of it, or narrow the view with a filter first.  Like every download, Word documents and decks hold only the records and fields you can see, and each download is kept in the organization's audit log with the view and the number of records, and never any values.

## Printing and saving as PDF

A grid, gallery, or kanban can also become a PDF, shaped for paper instead of for a spreadsheet.  Choose {{ui:print.menu}} in the view's menu, or in a record's menu to print one record, then pick a title, a paper size, an orientation, and the fields to put on the page.  {{ui:print.save}} keeps the file and {{ui:print.print}} hands it to your browser's print dialog.  {{doc:printing-and-pdfs}} goes through the whole of it, including what the pages look like and how long a big view takes.
