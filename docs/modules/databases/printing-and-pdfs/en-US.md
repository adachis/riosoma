---
id: printing-and-pdfs
title: Printing a view or a record, or saving it as a PDF
summary: Make a PDF of a grid, gallery, kanban, or one record, choosing the paper, the fields, and the title first.
area: databases
order: 28
level: simple
related: [downloading, views, gallery, kanban]
---

A printout is a PDF that Riosoma draws itself, so the pages come out the same on every computer and every printer.  Save the file to send it or keep it, or hand it straight to your printer.  For a file a spreadsheet can work with, see {{doc:downloading}}.

## Where printing is offered

{{ui:view.type.grid}}, {{ui:view.type.gallery}}, and {{ui:view.type.kanban}} views print.  Open the view's menu, beside its name in the row of views, and choose {{ui:print.menu}}.  On a narrow screen the view's toolbar also has a {{ui:toolbar.more}} button, shown as three dots, with the same choice.  A view of another kind, such as a calendar, a chart, or a form, has no {{ui:print.menu}} in its menu.  To print those records, add a grid, gallery, or kanban view of the same table, which shows the same records, and print that.

To print one record, open it and choose {{ui:print.menu}} from {{ui:print.record.menu}}, the button shown as three dots at the top of the card.

Anyone who can open the database can print, including people with the {{ui:share.role.reader}} role.  A printout holds the records the view shows, in its order and with its filter applied, and only ever the ones the person printing can see.

## Choosing how it prints

The dialog asks four things, and each starts at a sensible answer:

- {{ui:print.titleLabel}} heads the first page and names the file.  It starts as the view's name, or the record's.
- {{ui:print.pageSize}} is {{ui:print.pageSize.letter}} or {{ui:print.pageSize.a4}}, starting as the one your language and region usually print on.
- {{ui:print.orientation}} is {{ui:print.orientation.portrait}} or {{ui:print.orientation.landscape}}.  A grid starts in {{ui:print.orientation.landscape}}, which fits more columns, and cards and records start in {{ui:print.orientation.portrait}}, which reads top to bottom.
- {{ui:print.fields}} decides what goes on the page for each record.  "{{ui:print.fields.viewHelp}}" for a view, and "{{ui:print.fields.recordHelp}}" for a record.  The primary field is always in, marked "{{ui:print.fields.always}}", because it names every record.  A field the view hides keeps its place in the list, unchecked, so you can put it on the page without changing the view for anyone else.

## Making the file

{{ui:print.save}} saves the PDF, named after the table and the title, the way a CSV download is named, so both sit together in your downloads folder.  {{ui:print.print}} makes the same PDF and opens it in your browser's print dialog, where you choose the printer and how many copies you want.  {{ui:print.cancel}} closes the dialog and makes nothing.

While it works, Riosoma reads the view's records 500 at a time under "{{ui:print.loading}}", showing how far it has gotten, and then draws the file under "{{ui:print.making}}"  The order is taken once, from the first page, so a record someone adds or moves while the pages arrive doesn't show up twice or go missing.  {{ui:print.stop}} ends the read at any point, and the dialog says "{{ui:print.stopped}}"

A view with more than 5,000 records asks first, since a PDF that long takes a while to make and can be slow to open.  {{ui:print.continue}} carries on, and {{ui:print.stop}} ends it.

If something goes wrong, the dialog says "{{ui:print.failed}}" and shows the server's reason when it gave one.  Your choices stay as they were, so you can try again.  A browser that won't open its print dialog still leaves you with the file: Riosoma saves the PDF instead and says "{{ui:print.printFallback}}"

The PDF library and its fonts are large, so they load the first time anyone prints rather than with the app.  That first printout takes a moment longer than the ones after it.

## What the pages look like

A view's first page carries the title, and under it how many records the printout holds.  A record's carries the title alone.  A view with nothing in it says "{{ui:print.empty}}"  Every page names the database and the view at the top, with the date and time it was printed, and its page number at the bottom.

- A grid becomes a table.  Columns keep the widths the view gives them, scaled together to fill the page, the header row repeats on every page, long text wraps, and numbers line up at the right.  With more than ten fields the type gets smaller rather than dropping words, and a table with very many columns keeps a readable width for each even if that runs past the edge of the page.
- A gallery becomes cards, one to four across depending on {{ui:gallery.size}} and the orientation.  Each card's title is the record's name, with the other chosen fields under it, each field's name above its value.
- A kanban becomes the same cards under each stack's name and count, in the board's order.  Stacks you hid are left out, and so are empty ones when {{ui:kanban.hideEmpty}} is on.
- A record becomes a list, one field to a line, with its name at the left and its value at the right.  Files and linked records are listed one to a line instead of run together, a JSON field keeps its line breaks, and a signature is drawn large enough to read.

Cards in a row stay together on one page when they fit, and a kanban's stack name stays with the first row of cards under it whenever the two fit on a page.  Long text on a card stops after about 280 characters, the way a card on screen cuts it off, so print the record instead when you need all of it.

Values read the way the grid shows them, in your language and time zone: options, people, and linked records by name, attachments by file name, dates in their field's format, and checkboxes as checked or not.  A formula that has gone wrong reads "{{ui:grid.formula.error}}"  A button has nothing to press on paper, so it reads as the link it opens, and a signature is drawn the way it was drawn on screen.

Cover images and the colors from {{doc:conditional-colors}} aren't printed, and a printout leaves out the comments and history beside a record.

## Your browser's own Print

With a record open, your browser's Print prints that record: every field at its full length, without the buttons, the comments, or the history.  Anywhere else it prints the screen as it looks, which is rarely what you want, so reach for {{ui:print.menu}} instead.

PDFs use the same fonts as help's own PDFs, so text in Chinese, Japanese, or Korean doesn't show in them yet.
