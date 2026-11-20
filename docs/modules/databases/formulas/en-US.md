---
id: formulas
title: Writing formulas
summary: Calculate values from fields and find functions for text, numbers, dates, logic, and lists.
area: databases
order: 8
level: standard
related: [fields, linked-records, templates]
anchors: [field.formula.expression]
demo: formulas
sections: [field.formula.expression=writing-and-checking]
---

A {{ui:field.type.formula}} field calculates a value for each record.  Its cells are read-only and update from the fields the formula uses.

## Writing and checking

Choose {{ui:grid.field.add}}, select {{ui:field.type.formula}}, and enter an expression in {{ui:field.formula.expression}}.  Put field names in braces, as in `{Quantity} * {Unit price}`.  Use your table's actual field names.  Name matching ignores capitalization, and saved references survive field renames.

Type `{` to find fields, or start a function name to see suggestions.  Up and Down select a suggestion, Enter or Tab inserts it, and Escape dismisses the list.

As you type, the editor checks syntax, field references, function names, argument counts, compatible types, and circular references.  It highlights the problem and explains it.  You cannot save an empty or invalid formula.

## Guided computed fields

In a formula field, choose {{ui:field.builder.editAs}} to use a guided builder:

- {{ui:field.builder.combine}} joins two fields with a {{ui:field.builder.separator}}.  Blank values contribute empty text.
- {{ui:field.builder.difference}} subtracts {{ui:field.builder.start}} from {{ui:field.builder.end}} in days, hours, or minutes.  Reversing the dates gives a negative result.
- {{ui:field.builder.mapping}} compares a text value to one exact match and returns the text in {{ui:field.builder.then}} or {{ui:field.builder.otherwise}}.
- {{ui:field.builder.bucket}} splits a number at {{ui:field.builder.boundary}}.  Values equal to the boundary use the otherwise result.  Blank numbers use the otherwise result.
- {{ui:field.builder.links}} returns one linked record's name at {{ui:field.builder.position}}, in link order.  A missing position returns blank.

Builders save ordinary formulas through the same field commands, with the same permissions and audit history.  The generated formula is visible beneath the controls.  Literal text can include line breaks.  Choose {{ui:field.type.formula}} to edit it directly, including more mappings or boundaries.  Editing a saved field, including opening its field-edit link, reopens the matching builder.  Expressions outside these shapes, or literals with carriage returns, open in the formula editor without changing them.  Choosing a different builder starts a new expression.

## Operators and results

Use `+`, `-`, `*`, and `/` for arithmetic, and `&` to join text.  Comparisons use `=`, `!=`, `<>`, `<`, `<=`, `>`, and `>=`.  `&&` means both conditions must hold, and `||` means either may hold.  Use parentheses to group expressions and quotes for text, such as `{First name} & " " & {Last name}`.

The editor infers a result of {{ui:field.formula.type.number}}, {{ui:field.formula.type.text}}, {{ui:field.formula.type.boolean}}, {{ui:field.formula.type.date}}, {{ui:field.formula.type.datetime}}, or {{ui:field.formula.type.array}}.  A formula can also return blank.  Both result branches of `IF` must have compatible types, apart from blanks.

## Handling errors

A formula can pass the editor's checks and still fail for a particular record, such as when dividing by zero.  Its cell shows {{ui:grid.formula.error}}.  Correct the source value or guard the calculation with `IF`, such as `IF({Quantity} = 0, BLANK(), {Total} / {Quantity})`.  `ISERROR` detects errors, and `IF` evaluates only the branch it needs.

Blank values become zero in arithmetic and empty text when joined.  Zero and false are not blank.  List and text positions start at 1.  The examples below use sample field names that you can replace with your own.

## Text functions

- `CONCATENATE`: joins values as text with `CONCATENATE({Name}, " draft")`.
- `LEN`: counts text positions with `LEN({Name})`.
- `LEFT`: takes characters from the beginning with `LEFT({Name}, 3)`.
- `RIGHT`: takes characters from the end with `RIGHT({Name}, 3)`.
- `MID`: takes characters from a position with `MID({Name}, 2, 3)`.
- `FIND`: finds a case-sensitive position, or zero with `FIND("A", {Name})`.
- `SEARCH`: finds a position ignoring case, or blank with `SEARCH("draft", {Name})`.
- `SUBSTITUTE`: replaces matching text with `SUBSTITUTE({Name}, "old", "new")`.
- `REPLACE`: replaces a range of characters with `REPLACE({Name}, 1, 3, "New")`.
- `LOWER`: makes text lowercase with `LOWER({Name})`.
- `UPPER`: makes text uppercase with `UPPER({Name})`.
- `TRIM`: removes spaces around text with `TRIM({Name})`.
- `REPT`: repeats text with `REPT("-", 3)`.
- `T`: keeps text and turns other values blank with `T({Name})`.
- `ENCODE_URL_COMPONENT`: encodes text for a URL component with `ENCODE_URL_COMPONENT({Name})`.
- `REGEX_MATCH`: checks whether a pattern matches with `REGEX_MATCH({Name}, "^[A-Z]")`.
- `REGEX_EXTRACT`: returns the first complete match with `REGEX_EXTRACT({Name}, "[0-9]+")`.
- `REGEX_REPLACE`: replaces all pattern matches with `REGEX_REPLACE({Name}, "[0-9]+", "#")`.
- `RECORD_ID`: returns this record's permanent ID with `RECORD_ID()`.

## Number functions

- `ABS`: returns the distance from zero with `ABS(-4)`.
- `ROUND`: rounds to decimal places with `ROUND(3.14159, 2)`.
- `ROUNDUP`: rounds away from zero with `ROUNDUP(3.14159, 2)`.
- `ROUNDDOWN`: rounds toward zero with `ROUNDDOWN(3.14159, 2)`.
- `CEILING`: rounds up to a multiple with `CEILING(7, 5)`.
- `FLOOR`: rounds down to a multiple with `FLOOR(7, 5)`.
- `INT`: rounds down to an integer with `INT(-2.3)`.
- `MOD`: returns the division remainder with `MOD(7, 3)`.
- `POWER`: raises a number to a power with `POWER(2, 3)`.
- `SQRT`: returns a square root with `SQRT(16)`.
- `EXP`: raises e to a power with `EXP(1)`.
- `LOG`: returns a logarithm with an optional base with `LOG(8, 2)`.
- `LOG10`: returns a base-ten logarithm with `LOG10(100)`.
- `MAX`: returns the largest number, including a list's with `MAX({Prices}, 0)`.
- `MIN`: returns the smallest number with `MIN(2, 5, 3)`.
- `SUM`: adds numbers, including each one in a list with `SUM({Line totals})`.
- `AVERAGE`: returns the mean of numbers with `AVERAGE(2, 5, 3)`.
- `COUNT`: counts numeric values, including list items with `COUNT({Scores})`.
- `COUNTA`: counts nonblank values, including false and zero with `COUNTA({Tags})`.
- `COUNTALL`: counts values, including blanks with `COUNTALL({Tags})`.
- `VALUE`: reads a number from text with `VALUE("1,250.50")`.
- `EVEN`: rounds away from zero to an even integer with `EVEN(3)`.
- `ODD`: rounds away from zero to an odd integer with `ODD(4)`.

## Date functions

Dates accept parseable text.  Units can use names such as `"days"` and `"months"`.  Calendar calculations use the applicable time zone, and month additions keep dates within the destination month.

- `TODAY`: returns the current day with `TODAY()`.
- `NOW`: returns the current instant with `NOW()`.
- `DATEADD`: adds an amount in the chosen unit with `DATEADD({Due}, 7, "days")`.
- `DATETIME_DIFF`: subtracts the second date in whole units with `DATETIME_DIFF({End}, {Start}, "days")`.
- `DATETIME_FORMAT`: formats a date as text with `DATETIME_FORMAT({Due}, "YYYY-MM-DD")`.
- `DATETIME_PARSE`: reads a date from text with `DATETIME_PARSE("2026-09-27", "YYYY-MM-DD")`.
- `YEAR`: returns the calendar year with `YEAR({Due})`.
- `MONTH`: returns the month from 1 to 12 with `MONTH({Due})`.
- `DAY`: returns the day of the month with `DAY({Due})`.
- `HOUR`: returns the hour from 0 to 23 with `HOUR({Start})`.
- `MINUTE`: returns the minute from 0 to 59 with `MINUTE({Start})`.
- `SECOND`: returns the whole second with `SECOND({Start})`.
- `WEEKDAY`: returns the weekday starting at zero with `WEEKDAY({Due}, "Monday")`.
- `WEEKNUM`: returns the week number, counting January 1 in week one with `WEEKNUM({Due}, "Monday")`.
- `WORKDAY`: moves by working days, excluding weekends and optional holidays with `WORKDAY({Start}, 5)`.
- `WORKDAY_DIFF`: counts working days including both endpoints with `WORKDAY_DIFF({Start}, {End})`.
- `IS_BEFORE`: checks whether the first date is earlier with `IS_BEFORE({Due}, TODAY())`.
- `IS_AFTER`: checks whether the first date is later with `IS_AFTER({Due}, TODAY())`.
- `IS_SAME`: checks the same calendar unit with `IS_SAME({Due}, TODAY(), "day")`.
- `SET_TIMEZONE`: uses a named zone in later date operations with `DATETIME_FORMAT(SET_TIMEZONE({Start}, "America/New_York"), "HH:mm")`.
- `DATESTR`: returns year-month-day text with `DATESTR({Due})`.
- `TIMESTR`: returns hour-minute-second text with `TIMESTR({Start})`.
- `CREATED_TIME`: returns when this record was created with `CREATED_TIME()`.
- `LAST_MODIFIED_TIME`: returns when this record last changed with `LAST_MODIFIED_TIME()`.
- `START`: returns the first day of a date range with `START({Booking})`.
- `END`: returns the last day of a date range with `END({Booking})`.

`LAST_MODIFIED_TIME` also accepts field references, but needs per-field change information and returns an error if that information is unavailable.

## Number, people, and file fields

Currency, percent, duration, rating, and auto number fields all read as plain numbers, so arithmetic, comparisons, and number functions work on them directly:

- A currency field reads as its amount, without a symbol or grouping, so `{Price} * {Quantity}` works and `"$" & {Price}` reads as `$12.5`.
- A percent field reads as a fraction, 0.25 for 25%, so `{Share} * 100 & "%"` reads as `25%`.
- A duration field reads as a number of seconds, so `{Time} / 60` gives minutes.
- A rating reads as its number of stars, and an auto number as its number, so `"BUG-" & {Number}` reads as `BUG-7`.

Numbers joined with text show all the digits they hold, such as `0.30000000000000004` for a sum that isn't exact, so use `ROUND` first when a label should show fewer places.

A people field reads as a list of its people's names, so `"Led by " & {Owner}` names everyone, separated by commas, and `ARRAYJOIN({Owner}, " and ")` chooses the separator.  A list isn't text, so `LEN({Owner})` is refused.  Created by and last modified by read as one person's name.  An attachment field reads as a list of its files' IDs.

## Linked records and choices

A {{ui:field.type.link}} field reads as the names of the records it links to, in the order they're linked.  A record's name is its table's primary field, as it shows on the record's chip, so `{Client} & " Order #" & {Order Number}` reads as `Forrester Legal Partners Order #420`.  Several linked records join with commas, as any list does, and `ARRAYJOIN({Client}, " and ")` chooses the separator.  A record linked to nothing reads as an empty list, and a linked record with an empty name still counts as linked, with an empty name.

Where a formula needs one value, a link reads as its one name, the same way a lookup does below.  So `{Client} = "Forrester Legal Partners"` checks which client an order has, `LEN({Client})` counts the name's characters, and either is an error when the order links to more than one client.

A {{ui:field.type.singleSelect}} field reads as its choice's name, and a {{ui:field.type.multipleSelect}} field as a list of its choices' names, in the order they were chosen.  So `{Status} = "Done"` compares the name, `SWITCH({Status}, "Done", 1, 0)` matches it, and `"Tags: " & {Tags}` lists every tag.  A lookup of either reads its choices by name too, and so does a lookup of a link.

Formulas follow names as they change.  Rename a linked record, change what its primary field formula reads, or rename a choice, and every formula that reads it shows the new name, in the grid, in the record, in filters and sorts, and in downloads.  A comparison with the old name stops matching, so `{Status} = "Done"` is false once Done is renamed Shipped.  Deleting a choice clears it from its records, so formulas stop reading it as well.

A formula never reads a linked record's ID.  To get one, add a formula of `RECORD_ID()` in the linked table and look it up.  When the linked table's primary field is a formula that has an error or can't be sorted or filtered, such as one using `REGEX_REPLACE`, formulas can't read its names, and a formula over the link shows an error for records that link to any.  A primary field formula can't read its own table's names back through links, so a formula that would do that, or a primary field choice that would, is refused.

## Lookups in arithmetic and totals

A lookup holds a list: the values of every record its link reaches.  Wherever a formula needs a single value, such as in arithmetic, a comparison, or a function like `LEN`, a lookup reads as its one value instead:

- With one linked value, it reads as that value, so `{Unit price} * {Quantity}` multiplies a line item's product price by its quantity.
- With no linked values, it reads as blank, which arithmetic counts as zero.
- With more than one, it's an error, since there's no telling which one is meant.  `ISERROR` can catch it, such as `IF(ISERROR({Unit price} * 1), "Choose one product", {Unit price} * {Quantity})`.

The editor names the lookups a formula reads this way, below its result type.

Totals and counts use every value instead.  `SUM`, `AVERAGE`, `MAX`, and `MIN` include each number in a lookup, `COUNT`, `COUNTA`, and `COUNTALL` count each value, and `CONCATENATE` and `&` join the values with commas.  So `SUM({Line totals})` adds up an order's lines, the same as a {{ui:field.type.rollup}} with a sum would.  Where a list itself fits, such as in `IF` conditions or the list functions below, a lookup stays a list.

A formula that multiplies a looked-up price by a quantity can be summed by a rollup in turn, which is how an order's total comes from its line items.

Formulas can't loop back on themselves, even through other tables.  A formula that reads a rollup of formulas in another table, which in turn read this one, is refused when you save it, and so is a lookup or rollup that would close such a loop.

## Date ranges, signatures, and other newer types

A {{ui:fields.dateRange.name}} field reads as a list of its two ends, which `START` and `END` take apart.  Each end is a date, or a date and time when the field includes times, so the other date functions work on it, such as `DATETIME_DIFF(END({Booking}), START({Booking}), "days")` for a range's length in days.  An empty range gives blank.  Timeline, Gantt, and calendar views show single dates, so a formula with `START` or `END` is also how to put a date range on one of them.

Calendars, timelines, and Gantt charts find their records by date in the database, so they can use a date formula only when it can be sorted and filtered.  A few functions, such as `WORKDAY` and `DATETIME_PARSE`, are calculated only as a record is shown, so a date formula that uses them isn't offered for those views' dates, and the settings say so.

A {{ui:fields.signature.name}} field reads as the moment it was signed, or blank when it isn't signed, so `IF({Approval}, "Signed", "Waiting")` and `IS_BEFORE({Approval}, {Deadline})` both work.  A {{ui:fields.location.name}} field reads as its coordinates, such as `40.7128, -74.006`, and a {{ui:fields.json.name}} field reads as its text.

## Logic functions

- `IF`: chooses a result based on a condition with `IF({Score} >= 3, "Ready", "Review")`.
- `SWITCH`: chooses the first matching result, or a default with `SWITCH({Status}, "Done", 1, 0)`.
- `AND`: checks that all arguments are true with `AND({Ready}, {Approved})`.
- `OR`: checks that any argument is true with `OR({Ready}, {Approved})`.
- `NOT`: reverses a condition with `NOT({Ready})`.
- `XOR`: checks for an odd number of true arguments with `XOR({Ready}, {Approved})`.
- `TRUE`: returns true with `TRUE()`.
- `FALSE`: returns false with `FALSE()`.
- `BLANK`: returns an empty value with `BLANK()`.
- `ERROR`: produces an error deliberately with `ERROR()`.
- `ISERROR`: checks whether an expression returns an error with `ISERROR(1 / 0)`.

## List functions

Use a lookup, link, people, or multiple select field as a list.  These examples assume `{Tags}` contains several values.

- `ARRAYJOIN`: joins list items into text with `ARRAYJOIN({Tags}, ", ")`.
- `ARRAYUNIQUE`: keeps the first occurrence of each distinct item with `ARRAYUNIQUE({Tags})`.
- `ARRAYCOMPACT`: removes blanks while keeping false and zero with `ARRAYCOMPACT({Tags})`.
- `ARRAYFLATTEN`: removes nested lists while keeping item order with `ARRAYFLATTEN({Tags})`.
- `ARRAYSLICE`: takes items using inclusive positions with `ARRAYSLICE({Tags}, 1, 3)`.

## Conditional linked records

When configuring a {{ui:field.type.lookup}}, {{ui:field.type.rollup}}, or {{ui:field.type.count}}, use {{ui:field.lookup.filter}} to select the linked records to include.  Conditions use the same groups and operators as view filters.  In {{ui:field.lookup.compareWith}}, choose {{ui:field.lookup.constant}} or a field of the current record, such as including linked prices greater than this record's budget.

Lookups also offer {{ui:field.lookup.sort}}, {{ui:field.lookup.direction}}, and {{ui:field.lookup.limit}}.  To show the latest value, sort a date descending and enter 1 as the maximum.  The limit selects records before collecting their values.  Blank values are left out as usual.

## Other tables

Structured references read another table in the same database without a link.  Write `Contacts[Email]`, or `'Sales Leads'[Email]` for a table name with spaces.  Table and field references survive renames.  Start typing a table name in {{ui:field.formula.expression}} to find suggestions, then use the same keyboard controls as for functions.

Every range in one lookup or conditional total must belong to the same table.  Criteria accept exact values, expressions such as `{Customer}`, comparisons such as `">5"` or `"<>Done"`, and text wildcards.  `*` matches any number of characters, `?` matches one, and `~*` or `~?` matches that character literally.  Text matching ignores capitalization.  For a calculated threshold, use `">" & {Budget}`.

### XLOOKUP

`XLOOKUP({Email}, Contacts[Email], Contacts[Name], "Missing")` finds a matching email and returns its name.  The fourth argument is the result when no record matches, which defaults to blank.  The fifth argument selects exact matching (`0`, the default), exact or next smaller (`-1`), exact or next larger (`1`), or wildcards (`2`).  The sixth selects the first (`1`, the default) or last (`-1`) match in creation order.

### SUMIFS

`SUMIFS(Orders[Amount], Orders[Customer], {Name}, Orders[Status], "<>Canceled")` adds amounts whose customer and status satisfy both criteria.  No numeric matches gives zero.

### COUNTIFS

`COUNTIFS(Contacts[Status], "Active", Contacts[Score], ">5")` counts records satisfying every range and criterion pair.  No matches gives zero.

### AVERAGEIFS

`AVERAGEIFS(Orders[Amount], Orders[Customer], {Name})` averages matching numeric amounts.  No numeric matches returns an error that `ISERROR` can catch.

### MAXIFS

`MAXIFS(Orders[Amount], Orders[Customer], {Name})` returns the largest matching number, or zero if there are none.

### MINIFS

`MINIFS(Orders[Amount], Orders[Customer], {Name})` returns the smallest matching number, or zero if there are none.

## Other records in this table

These functions use the whole readable table, regardless of the view's filters or page.  Order fields sort ascending, with blanks last.  Without an order field, records follow creation order.  Creation time and record ID settle ordering ties.  A partition field starts an independent calculation for each of its values.

### RANK

`RANK({Score}, 0, {Team})` ranks scores within each team, largest first.  Use `1` for smallest first.  Ties share a rank and leave gaps, such as 1, 1, 3.  Blank scores have no rank.

### PREVIOUS

`PREVIOUS({Amount}, {Date}, {Account})` returns the preceding amount for the same account in date order.  The first record returns blank.  The first argument can be an expression, such as `{Price} * {Quantity}`.

### NEXT

`NEXT({Amount}, {Date}, {Account})` returns the following amount for the same account.  The last record returns blank.

### RUNNINGSUM

`RUNNINGSUM({Amount}, {Date}, {Account})` adds amounts through the current record, separately for each account.  Blank amounts add nothing.

### RUNNINGCOUNT

`RUNNINGCOUNT({Amount}, {Date}, {Account})` counts nonblank amounts through the current record.  `RUNNINGCOUNT()` counts all records through the current record in creation order.

## Access and updates

Cross-record formulas and conditional linked values use only records and fields you can read.  A formula that depends on a restricted field is hidden with that field.  Record rules apply before totals, lookups, ranks, and running calculations.  A view refreshes when a referenced table changes, including changes made from another open session.
