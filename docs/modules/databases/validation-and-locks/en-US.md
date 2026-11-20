---
id: validation-and-locks
title: Validation, unique fields, and locks
summary: Require valid values, prevent duplicates, and protect approved records and view settings.
area: databases
order: 32
level: standard
related: [fields, views, forms, field-and-record-permissions, importing]
---

Field rules apply whenever a record is written, including edits, paste, fill, forms, imports, APIs, scripts, automations, and routines.  A refusal leaves that command's records unchanged and explains which values need attention.

## Setting field rules

Open a field's settings and find {{ui:field.validation.title}}.  Turn on {{ui:field.validation.required}} to refuse empty values.  Zero and an unchecked checkbox count as values.

Numbers, currency, percentages, durations, and dates support {{ui:field.validation.min}} and {{ui:field.validation.max}}.  Date bounds use ISO dates or timestamps.  Text supports {{ui:field.validation.minLength}} and {{ui:field.validation.maxLength}}, counted in Unicode characters.

Text, email, URL, and phone fields support {{ui:field.validation.pattern}}.  Choose an email, URL, phone, postal code, digits, or letters preset, or choose {{ui:field.validation.custom}}.  Postal code and phone presets check a general format rather than a country's full addressing rules.  Each rule can have its own {{ui:field.validation.message}}.

Custom patterns support character classes, groups, alternatives, anchors, and simple repetition.  Backreferences, lookaround, and nested quantifiers are refused.  Use `^` and `$` to match the whole value.  Pattern matching refuses values longer than 10,000 characters.  Pattern size and repetition limits keep matching predictable.

Existing values are checked when their records are next written.  The grid shows a refused edit beside the cell.  Paste lists refused cells before applying, forms show field errors, imports identify refused rows, and automation and routine runs keep the refusal in their results.  Record APIs return status 422 with field errors.

## Requiring unique values

Turn on {{ui:field.validation.unique}} for text, numbers, email, URL, phone, dates, or single select.  Text also offers {{ui:field.validation.caseInsensitive}}.  Empty values may repeat.  Trashed records do not reserve a value, so restoring one can be refused if its value has been used again.

If active records already repeat a value, saving lists the duplicates and links to the dedupe tool.  Resolve them and save again.  Uniqueness also applies when two writes arrive together.  Source fields cannot require uniqueness.  Turn uniqueness off before converting a field's type, then enable it again after conversion.

## Locking records

Open the table's {{ui:permissions.records.menu}} dialog and find {{ui:locks.table.title}}.  Set a condition, such as Status is Approved, add a {{ui:locks.reason}}, and choose {{ui:locks.save}}.  A record becomes locked as soon as its current values match.  Clearing the condition stops automatic locking.

To lock a single record, expand it, choose {{ui:locks.record.lock}}, enter a reason, and choose {{ui:locks.record.confirm}}.  The row and expanded record show a lock icon and the reason.  A manual lock stays until an allowed person chooses {{ui:locks.record.unlock}}, even if the table's condition changes.

{{ui:locks.bypass}} defaults to {{ui:locks.owners}}.  You can also choose {{ui:locks.creators}} or {{ui:locks.nobody}}.  These settings control editing, trashing, and unlocking.  With Nobody, change the table's policy before unlocking a manually locked record.  Record visibility and field permissions still apply.

## Locking views

Owners and creators can choose {{ui:locks.view.lock}} in the view toolbar.  A locked view refuses configuration changes from everyone, including its owner.  Choose {{ui:locks.view.unlock}} before changing filters, sorting, visible fields, or other view settings.  Record editing still follows record and field rules.

## Links and history

Record and view addresses open their current state directly.  A table address with `?fieldRules=FIELD_ID` opens field rules, `?recordLocks=TABLE_ID` opens record access and locks, and `?duplicates=TABLE_ID` opens dedupe.  Rule changes, record locks, and view locks appear in the change history and audit log.  Undo checks the rules and locks that apply when it runs.
