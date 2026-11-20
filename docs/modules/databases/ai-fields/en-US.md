---
id: ai-fields
title: AI fields
summary: Let a model fill in a field from a prompt that reads the record's other fields.
area: databases
order: 33
level: standard
related: [fields, formulas, field-and-record-permissions, undo]
---

An {{ui:fields.ai.name}} field holds a value a model writes for each record, from a prompt you write once, such as "Summarize {Notes} in one sentence" or "Pick the category that fits {Description}."  It suits summaries, categories, tags, and quick judgments you'd otherwise type by hand.

AI fields need an AI provider.  Until an admin turns on AI and connects one in the AI settings, the type menu shows why {{ui:fields.ai.name}} isn't available.

## Making one

Choose {{ui:fields.ai.name}} as the field's type, then fill in:

- {{ui:fields.ai.prompt}}: what to write.  Put a field's name in braces where its value belongs.  Typing `{` suggests the table's fields, the same way formulas do.  Braces always name a field, so a prompt can't use them for anything else.
- {{ui:fields.ai.outputType}}: {{ui:field.type.text}}, {{ui:field.type.longText}}, {{ui:field.type.singleSelect}}, {{ui:field.type.multipleSelect}}, {{ui:field.type.number}}, {{ui:field.type.checkbox}}, or {{ui:field.type.date}}.  A select field lists its options below, and the model has to choose from them.
- {{ui:fields.ai.tier}}: {{ui:fields.ai.tier.fast}} uses your organization's everyday model, or its power model when that's the only one.  {{ui:fields.ai.tier.careful}} uses its power model, which takes more care and costs more.
- {{ui:fields.ai.trigger}}: {{ui:fields.ai.trigger.referencedChange}}, or {{ui:fields.ai.trigger.onRequest}}.

You type field names, but Riosoma remembers which field each one means, so renaming a field doesn't break the prompt.  A prompt can't read the field itself, a button, or anything that reads this field back, such as a formula or another AI field that reads it, in this table or through a link.  The same goes the other way: a formula, lookup, or rollup can't be made, changed, or converted to read an AI field whose prompt reads it, since each would keep setting the other off.  If such a loop comes about some other way, the field's runs stop with an error in each cell instead of asking the model.

## How values are written

With {{ui:fields.ai.trigger.referencedChange}}, a record's value is written again whenever a field its prompt names changes, including through a formula of the record's own fields.  A lookup, rollup, count, or link in the prompt counts too: renaming a linked record, or changing a value a lookup reads from it, writes the value again for the records linked to it, through up to four links and for up to 1,000 records a change.  To bring more up to date at once, use {{ui:fields.ai.generateAll}}.  A new record starts a run when it arrives with a value the prompt reads.  Pasting or importing many records starts a run for each of them, and every run counts toward the monthly AI budget.

A cell waiting for its value shows a bar along its bottom and says {{ui:fields.ai.pending}} when you point at it.  When a run fails, the cell keeps what it had and shows a mark in its corner, and pointing at it gives the reason, such as an answer that isn't one of a select's options.  The model's answer is always checked against the field's type: a number has to be a number, a date a date, and a select answer one of the options.  An answer outside the options is an error, never a new option.

Values are written like anyone's edits, so they show in the record's history, reach everyone with the table open at once, set off automations, and can be undone.  An AI field and an automation that keep setting each other off stop after five steps, the same limit a chain of automations has.  You can also type over an AI cell yourself.  Your value stays until that cell's next run.

If a prompt's fields are all empty, the value is cleared without asking the model.

## Generating on demand

- In a cell's menu, {{ui:fields.ai.generate}} or {{ui:fields.ai.regenerate}} writes the value for that record, or for up to 25 selected records.
- In the field's menu, {{ui:fields.ai.generateAll}} and {{ui:fields.ai.generateEmpty}} write values for many records at once.

Before a run over many records starts, Riosoma estimates it the way Rio's usage line counts: the model, the number of tokens, and the cost when the model's price is known, as a range, since answers vary in length.  More than 25 records ask you to confirm first.  While the run goes, the field's header shows how far it has come, and {{ui:fields.ai.stop}} in the field's menu stops it.  Values already written stay.

## Whose access a run uses

Runs read and write as the person who last saved the field's settings, the way automations act as the person who turned them on.  The prompt can only name fields that person can see.  If they lose access to the database, or to a field the prompt reads, runs stop and the field's header says why.  Saving the settings again makes you the field's person, with your access.

Someone who can't see a field the prompt reads can't see the AI field either, the same as a formula over a restricted field.  So does someone a record rule limits on a linked table the prompt reads, through a link, lookup, rollup, or count, since the field's value was written from the linked records its person can see, which may be more than theirs.  For the same reason, someone limited that way can't save the settings, and runs stop if the field's person comes to be limited that way.  A field the prompt reads still counts while it's in the trash, since its values are in what the AI field wrote.  Once it's deleted for good, the AI field's values are cleared, and the field stays hidden from anyone a record rule limits, since what it read can no longer be told.  See {{doc:field-and-record-permissions}}.

## Cost, limits, and the API

Each run keeps its model, its tokens, its cost, and how it ended, and its cost counts toward your organization's monthly AI budget and the spend the AI settings show.  When the budget is used up, runs wait until the next month, or until an admin changes the budget, and the field's header says so.  Admins can turn {{ui:ai.fields}} off in the AI settings, which stops new runs and keeps every value already written.

The REST API and MCP read AI fields like any other field, and downloads hold their values.  A write to an AI field through the API is refused, as it is for a formula, unless the request sets `overrideAiFields` to true.
