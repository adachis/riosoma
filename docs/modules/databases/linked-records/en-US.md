---
id: linked-records
title: Linking records and summarizing values
summary: Connect records across tables, then look up, summarize, or count their values.
area: databases
order: 7
level: simple
related: [fields, formulas, editing, suggested-links, merging-duplicates]
anchors: [field.link.table, field.link.multiple, field.link.limit, field.link.details]
demo: linked-records
---

A linked field connects records without copying them.  For example, a task can link to its project, and the project can show all its tasks.  You can also link records within one table, such as connecting a task to its dependencies.

## Setting up a link

Choose {{ui:grid.field.add}}, select {{ui:field.type.link}}, and choose the destination table in {{ui:field.link.table}}.  The list groups tables by database and has a filter box.  You can choose any database where you can edit records.  When you can change the destination's structure, Riosoma creates a paired field there, including when both fields are in the same table.  Otherwise, {{ui:field.link.oneWay}} explains that the link will appear only in this table.  Adding or removing a paired link updates both sides.

Turn on {{ui:field.link.multiple}} to allow several records in a cell.  Turn it off to allow one.  The paired field has its own setting, so one project can have many tasks while each task belongs to one project.

## Adding and removing links

Open a linked cell and use {{ui:grid.link.find}} to search by record name or any chosen extra field.  Choose a result to add it.  In a field limited to one record, choosing another replaces the current link.  Use a linked record's remove button to disconnect it without deleting either record.  Backspace in an empty search removes the last link.

For a destination in another database, the picker names that database and searches only records you can read there.  Open a linked record to follow its address into its own database.  Paired additions and removals update both databases live, appear in both audit histories, and undo together with one action.

The field owner can choose up to three extra fields to show beside each result.  Select values keep their colored chips.  Hover over a result, or focus it with the arrow keys, to see {{ui:grid.link.preview}} with its other readable fields.  Press Tab from a result to focus the preview, and use the arrow keys to scroll it.  Shift+Tab returns to the result.  Tab after the preview leaves the picker and advances to the next grid cell.  Use Enter to choose the focused result.  Large lists load in pages, and scrolling or {{ui:grid.link.more}} loads the next page.  The preview sits below the list on a phone.

## Limiting the choices

In a linked field's options, choose {{ui:field.link.limit}}.  You can allow all records, choose {{ui:field.link.limit.view}} and an {{ui:field.link.view}}, or choose {{ui:field.link.limit.filter}} and build a filter.  A view limit follows the view's saved filter, including later changes.  A filter can compare a destination field with a field in the current record, such as the same Region.  Draft form values and edits in an expanded record update the choices.

These limits also apply to the paired field, REST writes, forms, automations, Rio changes, and restored records.  A refused link explains that its record is outside the allowed choices.  Changing a current-record value that would break a retained link is refused.  Change or remove that link in the same edit.  A deleted view or filter field makes the choices unavailable until the field owner repairs the options.  Limits do not grant access to destination records or fields.  The choices say something about every field the limit reads, so a linked field limited by a filter or a view is hidden, with its paired field and anything computed from it, from anyone who can't see a field that filter or that view's filter uses, and nobody can limit a linked field to a view whose filter uses a field they can't see.  A refusal would say something about those fields too, so restoring a record, or changing a current-record value, checks only the linked fields you can see.  A link in a field hidden from you stays as it was.

When a search has no matches, the Add new record button, which shows what you typed, creates a record and links it in one action.  This is available when you can create destination records and the destination's primary field is editable and accepts what you typed.  Other fields in the new record take their defaults.  The new link must meet the same choice limits as an existing record.

A link within one table reads as a direction, from each record to the ones it names.  Records can name one another freely, the way related topics list each other.  The exception is a parent or dependency link, one a list outline or an org chart uses for parents, or a Gantt chart uses for dependencies.  There, a change that would make a record its own ancestor through other records is refused.  A record may still name itself.  A loop saved before a view used the link stays as it is, and its records can still reorder or change their other links.

## Looking up and counting

A {{ui:field.type.lookup}} reads values through a link.  Choose {{ui:field.lookup.link}}, then {{ui:field.lookup.target}}.  It returns a list of nonempty values in link order, keeping duplicates.  Edit the original records to change those values.

A {{ui:field.type.count}} needs only {{ui:field.count.link}}.  It counts linked records, including those whose other fields are empty.

## Summarizing linked values

For a {{ui:field.type.rollup}}, choose {{ui:field.lookup.link}}, {{ui:field.rollup.target}}, and {{ui:field.rollup.fn}}.  The available summaries depend on the selected field's type.  Summaries ignore empty values except where noted.  Lists contribute their individual values.

| Summary | What it returns |
|---|---|
| {{ui:field.rollup.fn.sum}} | Total of numeric values |
| {{ui:field.rollup.fn.average}} | Mean of numeric values |
| {{ui:field.rollup.fn.min}} | Smallest value |
| {{ui:field.rollup.fn.max}} | Largest value |
| {{ui:field.rollup.fn.count}} | Number of nonempty values, including false and zero |
| {{ui:field.rollup.fn.countAll}} | Number of linked records, including empty target fields |
| {{ui:field.rollup.fn.countUnique}} | Number of distinct nonempty values |
| {{ui:field.rollup.fn.and}} | Whether every nonempty boolean value is true |
| {{ui:field.rollup.fn.or}} | Whether any boolean value is true |
| {{ui:field.rollup.fn.concatenate}} | Values joined with a comma and a space |
| {{ui:field.rollup.fn.arrayUnique}} | Distinct nonempty values in their first-seen order |
| {{ui:field.rollup.fn.earliest}} | Earliest date or time |
| {{ui:field.rollup.fn.latest}} | Latest date or time |

Lookups, rollups, and counts update when links or source values change.  Their cells are read-only.

When a destination formula calls a named function, linked summaries use the function defined in that destination database.  A function with the same name in this database keeps its own definition.

## Access to linked values

Linked values follow your access to the destination table.  A {{ui:field.type.lookup}}, {{ui:field.type.rollup}}, or {{ui:field.type.count}} uses only destination records you can read.  A restricted destination field also hides values computed from it.

For a link between databases, owning the database that contains the link does not grant access to the other database.  Each side keeps its own permissions.  Creating, trashing, or restoring a paired {{ui:field.type.link}} requires schema access in both databases.  A one-way link requires schema access here and record editing access at its destination.  Open a readable linked record to navigate to its destination database, with an address you can bookmark.  A destination in the trash is unavailable, and restoring it makes the retained links readable again.

Choose {{ui:archives.duplicate.menu}} to copy a database.  Links to another database keep their original destination as one-way links, and their values include only records you can read there.  If you cannot read a destination table, the copy keeps the field with empty values, and its report names that field and explains why.  The original database and its links stay as they were.

A database snapshot requires both ends of every link to be inside the database being archived.  A destination with only incoming one-way links can have its own snapshot.  Restoring that snapshot creates a new database and leaves the original links pointing to their original records.  Organization exports include both linked databases and their relationships.

Copying or restoring a one-way link within a database keeps it one-way.  An existing snapshot keeps the tables and links it captured, even if a table later moves to another database.  Downloading or restoring it still requires access to all of its stored data.

## Keeping links through database changes

Renaming either database or table, moving a database to a folder, or changing its owners keeps the links and linked record addresses.  Sharing each database controls what a person can see at that end.  Removing access to the open database returns that person to Home.  Removing access to its destination hides the linked values without changing stored relationships.

Choose {{ui:database.sidebar.delete}} to move a table to Trash, and use {{ui:trash.restore}} to bring it back.  Trashing either endpoint makes its linked values unavailable until it is restored.  When the retention window ends, the deleted endpoint and its junctions are removed for good, along with any link field at the surviving end that pointed to it.

Converting a {{ui:field.type.link}} to {{ui:field.type.text}} uses only destination records you can read.  Converting it back uses the current text values.  Cleared text stays unlinked, and undo restores the earlier relationship.

Conversion previews and changes require access to every source record.  Conversion honors source record locks.  Converting text to links matches only destination records allowed by the field's choice filter or allowed view.  A paired conversion also honors locks on its matched destination records.

## Letting Riosoma find links

When a table already holds values that name records in another table, such as customer numbers, you don't have to link each record by hand.  Riosoma can suggest the link, or you can turn on {{ui:field.link.match}} while setting one up, and the links then follow those values as they change.  {{doc:suggested-links}} explains both.

## Arranging linked records

Drag a linked record's named chip in the cell editor or expanded record to change its order.  With its move control focused, press Space, use Left or Right, and press Space to drop.  Escape cancels.  You can still use {{ui:grid.link.find}} to add another link.  Reordering preserves links that you cannot see, and each drop can be undone.
