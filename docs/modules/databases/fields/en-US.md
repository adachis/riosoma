---
id: fields
title: Fields and their types
summary: The kinds of values a field can hold, and how to change a field.
area: databases
order: 1
level: simple
related: [databases-and-tables, editing, linked-records, formulas, ai-fields, attachments]
anchors: [grid.field.add, field.name, field.type, field.create, field.editor]
demo: fields
sections: [field.name=adding-and-editing-fields, field.type=choosing-a-type, grid.field.add=adding-and-editing-fields, field.create=adding-and-editing-fields, field.editor=adding-and-editing-fields]
---

Each field holds one kind of value, which decides how it's shown, how it sorts and filters, and what you can type into it.

## Choosing a type

| Type | Holds |
|---|---|
| {{ui:field.type.text}} | A short line of text |
| {{ui:field.type.longText}} | Paragraphs of text, plain or formatted |
| {{ui:field.type.number}} | A number, shown with the decimal places you choose |
| {{ui:field.type.currency}} | An amount with a currency code and decimal places you choose |
| {{ui:field.type.percent}} | A fraction shown as a percentage, such as 0.25 shown as 25% |
| {{ui:field.type.duration}} | A length of time stored in seconds and shown as hours, minutes, and optional seconds |
| {{ui:field.type.rating}} | A score with a maximum from 1 to 10, an icon, and a color |
| {{ui:field.type.user}} | One or more people chosen from the database's collaborators |
| {{ui:field.type.autoNumber}} | A number assigned automatically to each record |
| {{ui:field.type.attachment}} | Files, with previews and an order you can change |
| {{ui:field.type.link}} | Connections to records in another table or the same table |
| {{ui:field.type.lookup}} | Values read from a field in linked records |
| {{ui:field.type.rollup}} | A summary of values from linked records |
| {{ui:field.type.count}} | The number of records in a linked field |
| {{ui:field.type.formula}} | A calculated value that updates from the record's fields |
| {{ui:fields.ai.name}} | A value a model writes from a prompt that reads the record's fields |
| {{ui:field.type.checkbox}} | Checked or not |
| {{ui:field.type.date}} | A date, optionally with a time |
| {{ui:fields.dateRange.name}} | A start date and an end date together, optionally with times |
| {{ui:field.type.singleSelect}} | One option from a list you define |
| {{ui:field.type.multipleSelect}} | Any number of options from a list |
| {{ui:field.type.email}}, {{ui:field.type.url}}, {{ui:field.type.phone}} | Addresses you can open with a click |
| {{ui:fields.location.name}} | A place, as a latitude and a longitude, with an optional name or address |
| {{ui:fields.json.name}} | Structured data, such as details from another app, checked when you save |
| {{ui:fields.signature.name}} | A drawn or typed signature, with who signed and when |
| {{ui:fields.button.name}} | A button that opens a web page made from the record's fields |
| {{ui:field.type.createdTime}}, {{ui:field.type.lastModifiedTime}} | When the record was made or last changed, filled in for you |
| {{ui:field.type.createdBy}}, {{ui:field.type.lastModifiedBy}} | Who made or last changed the record |
| {{ui:field.type.recordId}} | The record's permanent ID |

For setup and examples, see {{doc:linked-records}}, {{doc:formulas}}, {{doc:ai-fields}}, and {{doc:attachments}}.  Long text, date ranges, locations, JSON, signatures, and buttons are described below.  Calculated fields and automatically assigned values are read-only in records.

## Adding and editing fields

Add a field with the plus button {{ui:grid.field.add}} at the end of the grid's headers, or insert one next to another from a field's menu.  Scroll to the end of the headers to bring the full plus target into view.  {{ui:grid.field.edit}} changes a field's name, description, and options, such as a select field's list or a date's format.

## Changing a field's type

Use {{ui:grid.field.edit}} to change a field's type.  Before you save a conversion, Riosoma shows how many values can't be converted and would be cleared, with examples.  Text becomes select options automatically.  If the result isn't what you wanted, undo restores the original values exactly.

The newer types change to and from only some others, so values always carry over in a way that makes sense.  A date range can become text or a date, which keeps its start, and text and dates can become date ranges.  Locations and JSON can become text, and text can become either one.  Numbers and checkboxes can become JSON too.  A signature can become text, but nothing can become a signature, since only a person can sign.  Any field can become a button, and a button can become any type, though a button has no values to carry over.

The first field is the primary field, which names each record and stays visible.  It accepts {{ui:field.type.text}}, {{ui:field.type.number}}, {{ui:field.type.date}}, {{ui:field.type.email}}, {{ui:field.type.url}}, {{ui:field.type.phone}}, {{ui:field.type.createdTime}}, {{ui:field.type.lastModifiedTime}}, {{ui:field.type.recordId}}, {{ui:field.type.formula}}, {{ui:field.type.currency}}, {{ui:field.type.percent}}, {{ui:field.type.duration}}, and {{ui:field.type.autoNumber}}.

## Default values

A field can give new records a value to start with.  Open {{ui:grid.field.edit}} and choose one under {{ui:field.default.title}}.  A default fills a field only when a record is added and nobody gives that field a value.  Changing a record never applies one, and changing a default never changes records that already exist.

| Type | What it can start with |
| --- | --- |
| {{ui:field.type.text}}, {{ui:field.type.email}}, {{ui:field.type.url}}, {{ui:field.type.phone}} | Text you type |
| {{ui:field.type.number}}, {{ui:field.type.currency}}, {{ui:field.type.percent}} | A number |
| {{ui:field.type.rating}} | A rating up to the field's maximum |
| {{ui:field.type.checkbox}} | {{ui:field.default.checked}} |
| {{ui:field.type.singleSelect}} | One of its options, or {{ui:field.default.firstChoice}} |
| {{ui:field.type.multipleSelect}} | Any of its options |
| {{ui:field.type.date}} | {{ui:field.default.date}}, or {{ui:field.default.today}}, which reads {{ui:field.default.now}} when the field includes a time |
| {{ui:field.type.user}} | {{ui:field.default.creator}} |

- {{ui:field.default.today}} gives the day the record is added, in the field's time zone, or in the time zone of the person adding it when the field follows each person's.  Records added through the API, MCP, Rio, or an automation use UTC for that day.  {{ui:field.default.now}} gives the moment the record is added.
- {{ui:field.default.firstChoice}} follows the list, so reordering the options changes which one new records get.
- A record added through a form's public link belongs to no person, so {{ui:field.default.creator}} leaves it empty.
- A select that follows another select gets its default only when the parent's value allows it.

### Where defaults apply

- New rows in the grid and other views, records added through forms, the API, the Airtable-compatible API, MCP, Rio, automations, scripts, and imports all get defaults.  A new row shows its defaults while it's being added.
- In a form, a question left blank gets the field's default, and an answer always wins.  A usable default also answers a required question and supplies the quantity or price option for a payment.  A box checked by default starts checked, so clearing it is an answer too.
- Through the API, a field left out of a new record gets its default, and a field sent empty stays empty.
- When you import into a table, a column you leave out gives new records the default, and a blank cell in a column you import stays blank.  {{ui:field.default.today}} uses the import's time zone when the field follows each person's time zone, just as it does for a new grid record.
- Synced and joined tables never use defaults, since their records come from their sources.  AI fields fill in their own values, so they have no default either.

### Defaults and changes to a field

- A default has to fit the field's options and its rules, such as a minimum, a maximum, or a pattern.  A field with {{ui:field.validation.unique}} can't have a default, since every new record would repeat it.
- Deleting an option that a default uses takes it out of the default.
- Changing a field's type keeps its default only when the new type can hold it.  Otherwise the default is cleared.
- Copies, snapshots, archives, and templates keep each field's default.
- The API's field metadata includes a field's default as `options.defaultValue`, such as `{ "kind": "value", "value": 5 }`, `{ "kind": "today" }`, `{ "kind": "firstChoice" }`, or `{ "kind": "creator" }`.  Fields are created and changed with the same shape.

## Long text and rich text

A {{ui:field.type.longText}} field holds paragraphs, with line breaks where you put them.  Turn on {{ui:fields.richText.option}} in the field's options to format the text with bold, italic, strikethrough, inline code, links, headings, bulleted and numbered lists, checklists, block quotes, and code blocks.  Turning it on or off never changes a value, so text written before reads the same.

In a record or a form, the toolbar above the text applies each format to the selection or to the line you're on.  The keys do too, with Cmd in place of Ctrl on a Mac:

- Bold is Ctrl+B, italic Ctrl+I, strikethrough Ctrl+Shift+S, and inline code Ctrl+E.
- Headings are Ctrl+Alt+1, Ctrl+Alt+2, and Ctrl+Alt+3.
- A bulleted list is Ctrl+Shift+8, a numbered list Ctrl+Shift+7, and a checklist Ctrl+Shift+9.
- A block quote is Ctrl+Shift+B, and a code block Ctrl+Alt+C.
- Ctrl+Enter saves, and so does leaving the field.  Escape puts back what was saved.

Typing works as a shortcut too.  At the start of a line, `#` and a space makes a heading, `-` and a space a bulleted list, `1.` and a space a numbered list, `[ ]` and a space a checklist item, `>` and a space a block quote, and `` ``` `` a code block.

{{ui:fields.richText.link}} adds a link to the selected text, or asks for an address to add.  A bare domain such as example.com gets https:// in front of it, and an email address becomes a link that starts an email to it.  Links only open web and email addresses, in a new tab.  Anything else, such as a link that would run a script, is refused, and a link like that already in the text shows as the characters it was written with.

Pasting from a web page or a document keeps the formats above and drops everything else, such as colors, fonts, images, and tables.  Nothing in a value is ever read as HTML, so tags and entities show exactly as typed.

The grid shows a formatted value's words on one line, without its formatting.  Open the cell to see and edit it formatted, then save with {{ui:fields.richText.save}} or Ctrl+Enter, or click elsewhere.  Escape leaves the cell as it was.  An expanded record shows the text formatted, even when you can't change it.

Riosoma keeps formatted text as Markdown, a plain way of writing formats, such as `**bold**` for **bold**.  That's what everything else reads:

- Search and filters look at the text as it's stored, Markdown included.  A word finds its value in any format, but a phrase that changes format partway, such as one bold word beside plain ones, may not.
- Sorting goes by the stored text.
- Downloads and the API give the Markdown.  See {{doc:downloading}}.
- Formulas read the Markdown as text.

## Date ranges

A {{ui:fields.dateRange.name}} field keeps a start and an end in one place, such as a booking, a trip, or a sprint.  Its options are the same as a date's: a format, whether to include a time, and which time zone to use.

Open a cell to choose both ends, {{ui:fields.dateRange.start}} and {{ui:fields.dateRange.end}}.  Choosing only one makes a range of a single day.  An end before the start isn't saved until you fix it.  You can also paste two dates joined by a dash or by "to", such as 2026-10-01 to 2026-10-05.

- Sorting goes by the start.
- Filters ask about the start with {{ui:fields.dateRange.op.is}}, {{ui:fields.dateRange.op.isBefore}}, {{ui:fields.dateRange.op.isAfter}}, and the like.  Three more look at the whole range: {{ui:fields.dateRange.op.containsDate}} matches a range that includes a day you choose, {{ui:fields.dateRange.op.overlaps}} one with any of its days in a period such as the next week, and {{ui:fields.dateRange.op.isWithin}} one with all of its days in the period.
- Downloads show both dates in the field's format, with a dash between them, or one date for a single day.
- Formulas take a range apart with `START()` and `END()`, as {{doc:formulas}} describes.

## Locations

A {{ui:fields.location.name}} field holds a place as a latitude and a longitude, with an optional name or address under {{ui:fields.location.label}}.  Type or paste the coordinates the way maps copy them, such as 40.7128, -74.0060, or choose {{ui:fields.location.useMine}} to fill in where you are.  Your browser asks you first, and only when you choose it.  The coordinates decide where the place is, and the label is there for people to read.

- The grid shows the label, or the coordinates when there's no label.  Copying a cell copies both, such as Paris (48.8566, 2.3522), so it pastes back whole.
- A filter finds places {{ui:view.filter.op.isWithin}} a distance of a point.  Type the point under {{ui:fields.location.filter.point}} and the distance in {{ui:fields.location.filter.km}}.  A filter can also check whether the field is empty.
- Sorting goes by the label, or by the coordinates when there's no label.
- Downloads and formulas give the coordinates, such as 40.7128, -74.006, without the label.

## JSON

A {{ui:fields.json.name}} field holds structured data: an object, a list, text, a number, true, or false.  It suits details that come from another app, or settings that don't need fields of their own.

Open a cell to edit the JSON, laid out with one item to a line.  Saving checks it.  JSON that doesn't make sense stays in the box with a message saying which line and column to look at, and nothing is saved until it's right, so a broken value never reaches the table.  In the grid, save with {{ui:fields.json.save}}, or Ctrl+Enter (Cmd+Enter on a Mac).  Riosoma keeps the JSON without its spacing, and lays it out again each time you open it.

- Filters look for text in it with {{ui:view.filter.op.contains}} and {{ui:view.filter.op.doesNotContain}}, or check whether it's empty.
- Sorting goes by its text.
- Downloads and formulas read it as its text, without the spacing.

## Signatures

A {{ui:fields.signature.name}} field collects a signature, such as an approval or a receipt for a delivery.  Open the cell, then draw on the pad with a mouse, a pen, or a finger, type your name under {{ui:fields.signature.typeName}}, or both, and choose {{ui:fields.signature.sign}}.  {{ui:fields.signature.clear}} wipes the pad so you can start over.  The cell then shows the typed name, or the signer's own name when only a drawing was made, and when it was signed.

A signature can be replaced or removed, but never changed.  {{ui:fields.signature.again}} replaces it with a new signature, and {{ui:fields.signature.remove}} takes it away.  That way, a signature always means one thing: this person signed, at this moment.  Riosoma records the signed-in person and the time itself, rather than trusting the browser, so a signature can't be credited to someone else's account or given another time.  For the same reason, a signature can't be pasted into a cell.

A signature made on a public form, where nobody is signed in, keeps only what was drawn or typed, and when.

- Filters can only check whether a record is signed or not, since there's nothing else to compare.
- Sorting goes by when each record was signed.
- Downloads say who signed and when, as the cell does.  The drawing itself isn't in the file.
- Formulas read a signature as the moment it was signed, so `IS_BEFORE({Signature}, {Deadline})` checks that it came in on time.  An unsigned record reads as blank.

## Buttons

A {{ui:fields.button.name}} field puts a button on every record that opens a web page made from that record's own fields, such as the order in your shop's admin, a map, or a search.  A button holds no value of its own.

In the field's options:

- {{ui:fields.button.label}} is the text on the button.  Leave it empty to use the field's name.
- {{ui:fields.button.link}} is the web address.  Put a field's name in braces where its value belongs, such as `https://shop.example.com/orders/{Order number}`, or choose a field from {{ui:fields.button.addField}} to add it at the end.

How the link is made:

- Each field in braces is replaced with that record's value, written out as text: numbers and dates as they're stored, such as 1234.5 and 2026-09-27, options, people, and linked records by name, and checkboxes as true or false.  Values are encoded, so spaces and symbols in them can't break the address.
- A field at the very start of the link is used as it is, so a {{ui:field.type.url}} field can supply the whole address.  A bare domain there, such as example.com, gets https:// in front of it.
- You type names in the braces, but Riosoma remembers which field each one means, so renaming a field doesn't break the button.  A name that matches no field in the table can't be saved.

Pressing the button opens the link in a new tab, and only when it's a web address that starts with http:// or https://.  Anything else, such as a link that would run a script or open another program, is refused, so a link action only opens a web page, whatever a record holds.  That's also why the options ask for a link that starts with http:// or https://, or with a field.  When a record's values don't make a web address, its button shows as unavailable, and pointing at it gives the reason: "{{ui:fields.button.invalid}}"

The link only uses fields the person pressing the button can see.  If a field it uses is deleted, the button says "{{ui:fields.button.missingField}}"

- Buttons can't be sorted or filtered, since they hold nothing.
- Downloads hold each record's link, or nothing when the record can't make one.  See {{doc:downloading}}.


## Barcodes

A {{ui:field.type.barcode}} field stores text, including leading zeros.  Type the code, or choose {{ui:fields.barcode.scan}} on a browser that supports camera detection.  Scanning requests the rear camera without audio.  The camera stops when it finds a code, when you choose {{ui:fields.barcode.stop}}, or when you close the editor.  Typed entry remains available when the camera is unavailable or permission is denied.

Barcodes work in grids, record layouts, and forms.  Filters, sorting, formulas, imports, downloads, and the API treat them as text.

## Time without a date

Use {{ui:field.type.time}} for a wall-clock time that stays the same in every time zone.  Enter a time such as `14:30` or `2:30 PM`.  {{ui:field.date.timeFormat}} can follow the person's locale or use a 12-hour or 24-hour clock.  Seconds are preserved.

The API stores `HH:mm:ss`.  Sorting runs from midnight to the end of the day.  Filters compare times before, after, or at a chosen time.  Formulas read the stored text.  Summaries offer the earliest and latest times, and imports accept the same typed forms as the editor.

## Change logs

A {{ui:field.type.changeLog}} field shows who changed the record's fields and when, using existing record history.  It shows up to 50 recent entries, newest first, in the reader's time zone and language.  It names only current fields the reader can access.  Deleted fields and history outside the retention period do not appear.  Public links and sites include only displayed, unrestricted fields.  Change logs cannot filter, sort, or group records.  Their only summary counts records.

The field is read-only and is left out of forms and imports.  Formulas and JSON API reads use structured entries containing the time, actor ID, and visible field IDs.  Downloads and text API reads show the time in the selected export time zone, the person's name, and the visible field names.  SQL editor queries return an empty value for this field and for a lookup or rollup of it, and joined tables cannot use it as an output field.  Open the record's history for the individual before and after values.

## Amounts in several currencies

A {{ui:field.type.multiCurrency}} field holds an {{ui:fields.multiCurrency.amount}} and a {{ui:field.currency.code}} in each cell.  Its default currency is used for new amounts.  Every value retains its own code, such as `USD` or `EUR`.  Converting a currency field preserves its original currency code.  Groups sort by currency code, then by numeric amount.

The API value is `{ "amount": 12.5, "code": "EUR" }`.  Clipboard text, formulas, imports, and downloads use `EUR 12.5`, so the currency is preserved.  Text filters can match a code or amount.  Sorting uses the currency code first, then the amount.  {{ui:grid.summary.kind.sum}} reports separate totals for each currency, with no exchange-rate conversion.

Bare amounts in paste, imports, and API typecasts use the field’s default currency.  Amounts round to the configured decimal places before storage.  Number fields convert to multi-currency using that default code, and currency fields keep their existing code.  Numeric filters compare amounts, and text filters can match currency codes.  Sum and average rollups never combine currency codes.

## Buttons that run work

Choose {{ui:fields.button.action}} in a button field's settings, then {{ui:fields.button.runAutomation}} or {{ui:fields.button.runScript}} and the saved item to run.

Automation buttons require permission to change the database's schema, as manual automation runs do.  The person pressing the button must own the database or be the automation's configured person.  The automation must be enabled, and a record trigger must belong to the button's table.  Pressing the button queues the published version using the automation's configured person.  If the automation acts as someone else by the time the run starts, the run fails without running anything.  For conditional triggers, enable {{ui:fields.button.conditionalTriggers}}.  The record must still match every trigger condition.  A form trigger requires a recorded submission for that automation.  Undo cancels a run while it is queued.  After execution starts, its record changes use the usual command history.

Script buttons require permission to edit records.  They open the script panel and start the saved script as the person who pressed the button.  Scripts can read the clicked row with `await input.buttonRecordAsync()`, which returns `tableId`, `recordId`, and `fieldId`.  A run opened from the panel without a button returns `null`.  The server checks access to the clicked row and includes the button context in the run’s change audit.  Prompts and output stay in the panel, and its record changes undo together.  The panel has a shareable `script` query parameter.  Opening that link opens the panel without starting a run.

Action buttons hold no editable cell value, so forms, filters, and numeric summaries leave them out.  The API includes their configured action alongside their label.  Automation callers can send `button.run` with a field ID and record ID through the command API.  Interactive scripts use the existing script runner.
## Select options that follow other values

For a {{ui:field.type.singleSelect}} or {{ui:field.type.multipleSelect}} field, open {{ui:grid.field.edit}} and choose an {{ui:field.select.mode}}.

Choose {{ui:field.select.cascade}} to make a cascading select, such as Country followed by City.  Add the child's options, choose its {{ui:field.select.parent}}, and check the child options allowed under each parent value.  An empty parent allows no child choices.  When the parent holds multiple values, their allowed choices are combined.  The grid, forms, and record layouts offer only the allowed choices.  A change that would leave an invalid child selection is refused, including through imports and the API.  Clear the child before changing its parent, or update both values together through the API.

Choose {{ui:field.select.table}} to use records from another table in the same database.  Choose the {{ui:field.select.sourceTable}} and use {{ui:field.select.primary}}, or choose another field under {{ui:field.select.sourceField}}.  Text, numbers, dates, and checkbox values can supply labels.  Use {{ui:field.select.filter}} to narrow the source records.  The picker shows the first 1,000 nonempty records and says when more are available.  Search to find later records.  Use a filter to keep larger lists focused.

Source options follow record additions, edits, deletions, restorations, and filter changes.  Renaming a source value keeps existing selections because each option follows its record.  Records with the same label remain separate options.  A deleted or inaccessible record stops supplying an option, and existing selections retain their IDs without revealing its label.  You can remove a selection whose source was deleted, filtered out, or given an empty label.  Selections hidden by record access rules are preserved.  Restoring access or the record makes its label available again.  Live source tables must be switched to a synced copy before supplying options.

Each person sees only the source records and fields they can read.  An anonymous form has no access to a private source table, so it has no options from that table.  Use fixed or cascading choices for public forms.  Cascades use fixed parent choices, and a field cannot use both a parent mapping and a source table.

A cascade mapping holds at most 10,000 child choices in total.  In {{ui:field.select.parentValue}}, choose one parent option, then use {{ui:field.select.findChildren}} to find its allowed children.  Removing a parent option removes its mapping when no dependent selection would become invalid.  Otherwise, the refusal names the child field and the number of affected records.  Clear those selections first.  A child field you cannot see can also prevent a parent change.  Detach child selects before moving their parent field to trash.  Restore the parent before restoring a child.

Source questions work in signed-in forms.  Remove them before sharing a form publicly.  A cascade question requires its parent question on the same form.  Site forms that run without scripts omit optional cascade questions.  A site cannot publish a form with a required cascade question, or with a cascade question whose field has the Required rule.  Public sites and shared views do not reveal source-table option labels.

Changing the source table, or switching between fixed and table options, uses a conversion preview.  Converting source selections to labels, including text, numbers, and fixed options, requires access to every source record, at most 1,000 matching records, and an available label for every stored selection.  The server builds the complete fixed list.  Conversion previews report dropped selections and retained IDs without labels.  Syncs preserve local child values and flag a selection when its parent no longer allows it.

When writing a source select through the API, sending its current label keeps the same selected record.  A new selection with an ambiguous label must use the option ID.
