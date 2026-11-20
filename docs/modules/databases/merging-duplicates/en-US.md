---
id: merging-duplicates
title: Finding and merging duplicate records
summary: Compare up to three fields, look at each set of duplicates side by side, and merge a set into one record you can undo.
area: databases
order: 29
level: standard
related: [undo, trash-and-favorites, comments-and-history, linked-records, importing]
anchors: [database.table.menu, database.table.dedupe, dedupe.field, dedupe.search]
demo: merging-duplicates
---

A person, order, or client typed in twice leaves two records that each hold part of what's true.  Riosoma can find the records that match on the fields you choose, show each set side by side, and merge a set into one record.  Merging keeps the record you choose, moves the others' links and comments to it, and puts them in the trash.

## Finding duplicates

Open a table's menu in the database's sidebar, shown as three dots, and choose {{ui:dedupe.find}}.  The panel that opens starts by comparing the table's primary field, or the first field it can compare.

1. Under {{ui:dedupe.compare.field}}, choose the field to compare.  {{ui:dedupe.compare.add}} compares another one beside it, up to three at once, and the X button on a row stops comparing that field.  Comparing more fields narrows the sets down, which is what you want when one field on its own matches too much.
2. Beside each field, choose how its values are matched: {{ui:dedupe.match.exact}}, {{ui:dedupe.match.loose}}, or {{ui:dedupe.match.similar}}.  Text starts out matched loosely, since "Ada Lovelace" and "ada  lovelace" are the same name.  Similar text also catches small differences, such as a missing middle initial or a street written two ways, and finds more, so it needs more looking at.  Only {{ui:field.type.text}}, {{ui:field.type.longText}}, {{ui:field.type.email}}, {{ui:field.type.url}}, and {{ui:field.type.phone}} fields can be matched loosely or as similar text.  Numbers, dates, checkboxes, choices, people, and links match exactly, and fields that hold nothing comparable, such as formulas, lookups, files, and signatures, aren't offered.
3. Choose {{ui:dedupe.search}}.  Riosoma says "{{ui:dedupe.searching}}" while it works, and then counts the sets it found among the records it compared.  When nothing matches, it says "{{ui:dedupe.none}}"

Records you can't see never take part, so the sets are only ever made of records you could open yourself.

## Reading the sets

Each set is headed by its oldest record's name and how many records it holds.  Under that, the records stand side by side in columns numbered from the oldest, with a row for each field you compared and one for the primary field, so you can tell them apart.  An empty value reads "{{ui:dedupe.empty}}"  Under each set:

- {{ui:dedupe.review}} opens the set in full, as described below.
- {{ui:dedupe.merge}} merges it with the defaults, right away.
- {{ui:dedupe.skip}} puts the set aside when the records only look alike, and {{ui:dedupe.unskip}} brings it back.  A set you skipped is marked "{{ui:dedupe.state.skipped}}", one that merged is marked "{{ui:dedupe.state.merged}}", and one that couldn't merge is marked "{{ui:dedupe.state.failed}}" and stays listed.

{{ui:dedupe.done}} closes the panel.  Nothing you didn't merge has changed.

## Reviewing one set

{{ui:dedupe.review}} loads every record of the set in full, side by side.  "{{ui:dedupe.review.intro}}" is the panel's own wording, and it works like this:

- Under {{ui:dedupe.keep}}, choose the record that survives.  Each choice says when its record was added, and the oldest is chosen to start.  Keeping the oldest is usually the right call, since the record you keep goes on being itself, with its own created date and its own history, while the others wait in the trash.
- Under each field whose value differs, choose whose value the kept record ends up with.  A field that holds a list also offers {{ui:dedupe.combine}}, which keeps every record's items, the kept record's first.  That covers fields with several choices, files, several people, and links that hold more than one record.
- Fields that are the same in every record have nothing to choose, and are folded away under their own heading.

If you merge without reviewing, the defaults are the choices above: keep the oldest record, combine the lists, and for everything else keep the kept record's value, or when that's empty, the value of the record changed most recently that has one.  Fields that work themselves out, such as formulas, lookups, counts, and created and changed times, are left to do that, and a link that follows matching values keeps following them, so a merge never writes either.

Choose {{ui:dedupe.mergeThese}} to merge, or {{ui:dedupe.review.close}} to go back without changing anything.  If someone deleted one of the records while you looked, the panel says "{{ui:dedupe.review.missing}}"

## What merging changes

One merge does all of this at once:

- The record you kept takes the values you chose, and the other records go to the trash, where they stay for 30 days.
- Links follow the records.  Anything in another table that linked to a merged record now links to the kept one, in the same place in its list, so an order keeps its position among a client's orders.  Links between records of the same set collapse onto the kept record, which doesn't end up linked to itself.
- Comments on the merged records move to the kept record, in the order they were written, and a mention in one of them still points at the person it named.  Undo puts them back where they were.
- Files are ordinary values, so combining an attachment field gives the kept record every file.
- A signature keeps its original signer and signing time when you choose it for the kept record.
- The kept record's history shows its new values as an ordinary change, and an automation that watches the table sees that change the way it sees any other edit.

A merge copies nothing.  The record you kept is the record it was, with new values, and the ones you merged away sit in the trash with their own, which is how one undo can put everything back exactly.

Links follow your record access too.  {{ui:dedupe.combine}} includes only the linked records you can see.  Hidden links already on the kept record stay there, and hidden links on the other records are not transferred.

## Undoing a merge

A merge is one step, so one undo takes all of it back: the merged records return with their own values and links, the kept record gets its old values back, and the comments go home.  Choose {{ui:grid.undo}} in the message after the merge, press Cmd+Z (Ctrl+Z on Windows and Linux), or pick the merge out of {{ui:undo.history.open}}, as {{doc:undo}} describes.  Redo does the merge again.

The usual rules for undo apply: it takes back your own changes, it needs a connection, and a value in the kept record that someone else changed since is left as it is.  Undo also works only while the merged records are still in the trash, so within those 30 days.

Undo and redo move a comment only when your current record rules allow access to both records, including a record in the trash.  Comments involving a record you can no longer access stay where they are and count as skipped.

Restoring a merged record from the trash, as {{doc:trash-and-favorites}} describes, is not the same as undoing.  The record comes back with its values and links, but the kept record keeps the values the merge gave it, and the comments stay where the merge put them.

## Merging every set at once

Once you're happy that the sets are really duplicates, the button in the footer merges all the ones still waiting, and names how many that is.  It asks first, saying how many records will go to the trash and that their links and comments will move, and {{ui:dedupe.mergeAll.confirm}} carries on.  Sets you skipped and sets you already merged are left out, and each set merges with the choices you made for it in review, or the defaults.

A bar shows "{{ui:dedupe.progress}}" while it works, and a summary afterward counts the sets merged, the records that went to the trash, and any set that couldn't merge.  Everything merged this way is one step, so one undo puts all of it back.

A set can still fail, most often because someone deleted one of its records a moment ago.  Those are marked and stay listed, and Riosoma finds the sets again so what's left is what's really there.

## Who can merge, and which tables can't

Finding duplicates only needs read access to the table.  Merging takes the {{ui:share.role.editor}}, {{ui:share.role.creator}}, or {{ui:share.role.owner}} role, and someone who can't sees "{{ui:dedupe.readOnly}}" instead of the merge buttons.

A synced table's records come from its source, so merging them here would only bring them back at the next sync.  The panel says "{{ui:dedupe.synced}}" and leaves the merge buttons out.  Fix the duplicates in the source, as {{doc:synced-tables}} describes.

## Large tables

A comparison is bounded, so it answers in a sensible time even on a big table, and the panel says which bounds it hit:

- Up to 100,000 records are compared in full.  Above that Riosoma compares a sample of the table's values, chosen so that every record holding a sampled value is in its set, and says how many it compared.
- At most 500 sets come back, largest first.  When there were more, the panel says it's showing the largest ones.
- A set with more than 50 records is left out, since that many matches usually means the fields are too broad to be duplicates.  Comparing another field narrows them down.
- Similar text is compared by trigram similarity when the database has the extension for it, and otherwise by text with its case, spaces, and punctuation taken out, which finds less.  The panel says which it used.
- A comparison that runs out of time answers with what it had found and warns you, so try exact matching or fewer fields to see more.
