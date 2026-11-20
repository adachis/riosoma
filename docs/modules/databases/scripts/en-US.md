---
id: scripts
title: Running scripts
summary: Save JavaScript with a database and run it by hand, with questions along the way and one undo for everything it changed.
area: databases
order: 19
level: standard
related: [automations, undo, field-and-record-permissions, trash-and-favorites]
---

A script is JavaScript saved with a database that you run by hand from its panel.  It can read and change records, ask you questions as it goes, and show text, formatted notes, and tables.  Scripts run on the server in the same sandbox as an automation's {{ui:automations.step.script}} step.

People with the {{ui:share.role.creator}} or {{ui:share.role.owner}} role write, rename, and delete scripts.  Anyone who can edit records, including the {{ui:share.role.editor}} role, can run them, and sees each script's name and {{ui:scripts.description}} but not its code.

## Adding a script

Scripts are listed under {{ui:scripts.section}} in a database's sidebar.  Choose {{ui:scripts.add}} to make one.  It starts empty, named "{{ui:scripts.untitled}}", and opens in the panel beside the grid.  Rename it or delete it from the menu beside its name, with {{ui:scripts.rename}} and {{ui:scripts.delete}}.  A deleted script goes to the trash, and every change to a script undoes like other changes to the database.

Write the code in the {{ui:automations.script.code}} box.  It saves a moment after you stop typing.  Tab indents by two spaces, Shift+Tab outdents, and Escape then Tab leaves the box.

## Running a script

Choose {{ui:scripts.run}}.  The script runs as you, with your role and any field and record permissions that apply to you, so it can never read or change more than you could yourself.  What it logs and shows appears under {{ui:scripts.output}} as it runs, and {{ui:scripts.stop}} ends it.

Everything one run changes is a single step in your undo history, named after the script, such as "Ran the Tidy names script."  Undo takes back every record the run added, changed, or deleted at once, skipping any cell someone else has changed since.  Closing the panel stops a run that's still going, and what it had already changed stays undoable.

## Showing things

- `output.text(value)` shows plain text.
- `output.markdown(value)` shows headings, bold and italic text, lists, quotes, code, and links.  Other markup, including HTML, shows as typed.
- `output.table(rows)` shows a table.  Give it a list of objects to make a column of each property, a list of lists for numbered columns, or a list of plain values for one column.
- `console.log`, `console.info`, `console.warn`, and `console.error` show messages, with warnings and errors marked.

## Asking questions

Each of these waits for your answer, shown in the panel, and then the script carries on with it.  {{ui:scripts.prompt.stop}} ends the script instead.

- `input.textAsync(label)` asks for text, and returns what you type.
- `input.buttonsAsync(label, options)` shows a button for each option and returns the one you choose.  An option can be text, or `{ label, value }` to return the value instead of the label.  A question can have up to 20 buttons.
- `input.tableAsync(label)` asks you to choose a table, and returns its `id` and `name`.
- `input.recordAsync(label, tableId)` asks you to choose a record in a table, and returns it with its `id` and `values`, as `records.find` would.  You can only choose a record you can see.

Time spent waiting for you doesn't count toward the script's time limit.

## Reading and changing records

Records work as they do in an automation's script, with field IDs as keys and values in their stored JSON types:

- `records.find(tableId, { filter, limit })` returns up to 100 records, 20 unless you ask for more.  Filters use the same field IDs, operators, and groups as view filters.
- `records.create(tableId, values)` adds a record, and `records.update(tableId, recordId, values)` changes one.  Both return `recordId` and `tableId`.
- `records.delete(tableId, recordIds)` deletes one record or a list of up to 1,000.  Before anything is deleted, the panel asks, with {{ui:scripts.prompt.deleteConfirm}} and {{ui:scripts.prompt.deleteKeep}}.  If you choose not to delete, nothing is deleted and the call fails, which the script can catch.

A change you couldn't make yourself fails with a reason the script can catch, such as a record hidden from you or a value outside your record permissions.  Scripts can't sign signature fields or fill in fields Riosoma computes.  `fetch` and `sleep` work as they do in automations.

## Examples

Ask for a name and greet it:

```javascript
const name = await input.textAsync('Who is this for?')
await output.markdown(`**Hello, ${name}!**`)
```

List the records of a table you choose:

```javascript
const table = await input.tableAsync('Which table?')
const found = await records.find(table.id, { limit: 100 })
await output.table(found.map((record) => ({ id: record.id, ...record.values })))
```

Delete a record, after the panel asks:

```javascript
const table = await input.tableAsync('Delete from which table?')
const record = await input.recordAsync('Which record?', table.id)
try {
  await records.delete(table.id, record.id)
  await output.text('Deleted.')
} catch (error) {
  await output.text('Nothing was deleted.')
}
```

## Limits

Each run starts in a sandbox of its own, which can't reach the server, files, modules, or any network besides `fetch` to HTTPS addresses on the public internet.  A script's own time is limited to 60 seconds, not counting time spent waiting for you, and a server's operator can raise that to 10 minutes with `RIOSOMA_SCRIPTS_TIMEOUT_MS`.  Every run also stops after 30 minutes in all, waits included.  The other limits match automation scripts: 64 KB of code, 64 MB of memory, 256 KB of output in all, 64 KB of messages, and 1,000 calls carrying 1 MB of data.  A server runs at most two scripts at a time for one person, and eight in all.
