import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

/**
 * Every line a demo says or types, by the message ID its script names.  Scripts hold only IDs,
 * so every line is translated like the rest of the interface.  Narration is short and plain, one
 * idea to a step.
 */
export const NARRATION: Record<string, MessageDescriptor> = {
  // Databases, tables, and records
  'demos.databases-and-tables.list': msg({
    id: 'demos.databases-and-tables.list',
    message: 'Your tables are listed here.  Each one holds one kind of thing, like tasks or people.',
  }),
  'demos.databases-and-tables.grid': msg({
    id: 'demos.databases-and-tables.grid',
    message: 'The open table’s records fill the grid, one row each.',
  }),
  'demos.databases-and-tables.add': msg({
    id: 'demos.databases-and-tables.add',
    message: 'Add another table here whenever you need one.',
  }),
  'demos.databases-and-tables.menu': msg({
    id: 'demos.databases-and-tables.menu',
    message: 'Each table has a menu of its own.',
  }),
  'demos.databases-and-tables.rename': msg({
    id: 'demos.databases-and-tables.rename',
    message: 'Rename a table here when its name no longer fits.',
  }),
  'demos.databases-and-tables.delete': msg({
    id: 'demos.databases-and-tables.delete',
    message: 'Delete it here, too.  It waits in the trash for a while, in case you change your mind.',
  }),

  // Fields
  'demos.fields.add': msg({
    id: 'demos.fields.add',
    message: 'The plus at the end of the header row adds a field.',
  }),
  'demos.fields.name': msg({ id: 'demos.fields.name', message: 'Give the field a name.' }),
  'demos.fields.sampleName': msg({ id: 'demos.fields.sampleName', message: 'Due date' }),
  'demos.fields.type': msg({ id: 'demos.fields.type', message: 'Then choose the kind of value it holds.' }),
  'demos.fields.date': msg({
    id: 'demos.fields.date',
    message: 'A date field shows a calendar when you fill it in.',
  }),
  'demos.fields.create': msg({
    id: 'demos.fields.create',
    message: 'Create field adds it for everyone.  This demo leaves your table just as it was.',
  }),

  // Views, filters, and sorting
  'demos.views.toolbar': msg({
    id: 'demos.views.toolbar',
    message: 'These controls change what this view shows.  The records themselves stay the same.',
  }),
  'demos.views.filter': msg({
    id: 'demos.views.filter',
    message: 'Filter shows only the records that match.',
  }),
  'demos.views.condition': msg({
    id: 'demos.views.condition',
    message: 'Add a condition, then choose a field and what it should match.',
  }),
  'demos.views.sort': msg({ id: 'demos.views.sort', message: 'Sort puts records in the order you choose.' }),
  'demos.views.sortAdd': msg({
    id: 'demos.views.sortAdd',
    message: 'Add a sort, then pick a field and a direction.',
  }),
  'demos.views.hide': msg({
    id: 'demos.views.hide',
    message: 'Hide fields tucks away the columns you don’t need in this view.',
  }),
  'demos.views.shared': msg({
    id: 'demos.views.shared',
    message: 'Each view keeps its own settings, for everyone who opens it.',
  }),

  // Kanban
  'demos.kanban.views': msg({
    id: 'demos.kanban.views',
    message: 'A table can have several views.  They all share the same records.',
  }),
  'demos.kanban.add': msg({ id: 'demos.kanban.add', message: 'Add view offers every kind of view.' }),
  'demos.kanban.kanban': msg({
    id: 'demos.kanban.kanban',
    message: 'A kanban shows records as cards in stacks, one for each option or person.',
  }),
  'demos.kanban.drag': msg({
    id: 'demos.kanban.drag',
    message: 'Drag a card to another stack to move it to the next stage.',
  }),

  // Forms
  'demos.forms.add': msg({
    id: 'demos.forms.add',
    message: 'A form is a kind of view, so it starts in Add view.',
  }),
  'demos.forms.form': msg({
    id: 'demos.forms.form',
    message: 'A form asks questions, and each set of answers becomes a new record.',
  }),
  'demos.forms.tabs': msg({
    id: 'demos.forms.tabs',
    message: 'It sits here with the table’s other views, where you choose its questions and share its link.',
  }),

  // Linked records
  'demos.linked-records.add': msg({
    id: 'demos.linked-records.add',
    message: 'A link is a field, so it starts with the plus.',
  }),
  'demos.linked-records.name': msg({
    id: 'demos.linked-records.name',
    message: 'Name it after what it links to.',
  }),
  'demos.linked-records.sampleName': msg({ id: 'demos.linked-records.sampleName', message: 'Project' }),
  'demos.linked-records.type': msg({
    id: 'demos.linked-records.type',
    message: 'Open the list of field types.',
  }),
  'demos.linked-records.link': msg({
    id: 'demos.linked-records.link',
    message: 'Choose Link to another record.',
  }),
  'demos.linked-records.table': msg({
    id: 'demos.linked-records.table',
    message: 'Pick the table to link to.  Riosoma adds a matching field there, too.',
  }),
  'demos.linked-records.multiple': msg({
    id: 'demos.linked-records.multiple',
    message: 'Choose whether a cell holds one link or several.',
  }),
  'demos.linked-records.create': msg({
    id: 'demos.linked-records.create',
    message: 'Create field connects the two tables.  Nothing changes until you choose it.',
  }),

  // Formulas
  'demos.formulas.add': msg({
    id: 'demos.formulas.add',
    message: 'A formula is a field, too, so it starts with the plus.',
  }),
  'demos.formulas.name': msg({ id: 'demos.formulas.name', message: 'Give it a name.' }),
  'demos.formulas.sampleName': msg({ id: 'demos.formulas.sampleName', message: 'Total' }),
  'demos.formulas.type': msg({ id: 'demos.formulas.type', message: 'Open the list of field types.' }),
  'demos.formulas.formula': msg({ id: 'demos.formulas.formula', message: 'Choose Formula.' }),
  'demos.formulas.expression': msg({
    id: 'demos.formulas.expression',
    message: 'Write the calculation here.  Put a field’s name in curly brackets to use its value.',
  }),
  // What the demo types.  It uses no field names, so it works in any table.
  'demos.formulas.sample': msg({ id: 'demos.formulas.sample', message: 'ROUND(19.99 * 3, 2)' }),
  'demos.formulas.check': msg({
    id: 'demos.formulas.check',
    message: 'Riosoma checks the formula as you type, and says what kind of value it gives.',
  }),
  'demos.formulas.create': msg({
    id: 'demos.formulas.create',
    message: 'Create field works it out for every record at once.',
  }),

  // Sharing a database
  'demos.sharing.open': msg({ id: 'demos.sharing.open', message: 'Share shows who can use this database.' }),
  'demos.sharing.add': msg({
    id: 'demos.sharing.add',
    message: 'Add people from your organization by name or email.',
  }),
  'demos.sharing.people': msg({
    id: 'demos.sharing.people',
    message: 'Everyone with access is listed here, each with a role that says what they can do.',
  }),
  'demos.sharing.everyone': msg({
    id: 'demos.sharing.everyone',
    message: 'You can also open the database to everyone in your organization.',
  }),

  // Automations
  'demos.automations.section': msg({
    id: 'demos.automations.section',
    message: 'Automations live here, under your tables.',
  }),
  'demos.automations.add': msg({
    id: 'demos.automations.add',
    message: 'Add one, and it starts turned off, so nothing runs until you’re ready.',
  }),
  'demos.automations.steps': msg({
    id: 'demos.automations.steps',
    message: 'Each one waits for something to happen, like a new record, then does its steps for you.',
  }),

  // Asking Rio
  'demos.asking-rio.open': msg({
    id: 'demos.asking-rio.open',
    message: 'Rio lives here.  Choose Rio to ask about your data.',
  }),
  'demos.asking-rio.ask': msg({ id: 'demos.asking-rio.ask', message: 'Ask in your own words.' }),
  'demos.asking-rio.sample': msg({
    id: 'demos.asking-rio.sample',
    message: 'Which tasks are due this week?',
  }),
  'demos.asking-rio.send': msg({
    id: 'demos.asking-rio.send',
    message: 'Send it, and Rio answers with records, counts, or a plan.',
  }),
  'demos.asking-rio.changes': msg({
    id: 'demos.asking-rio.changes',
    message: 'Rio asks before it changes anything, and you can undo whatever it does.',
  }),

  // Dashboards
  'demos.dashboards.section': msg({
    id: 'demos.dashboards.section',
    message: 'Dashboards are listed here, under your tables.  Each one sums up a database at a glance.',
  }),
  'demos.dashboards.add': msg({
    id: 'demos.dashboards.add',
    message: 'Add one here.  It starts empty, and you fill it with tiles: numbers, charts, lists, and notes.',
  }),
  'demos.dashboards.records': msg({
    id: 'demos.dashboards.records',
    message: 'A tile works its value out from these records every time, so it’s never out of date.',
  }),
  'demos.dashboards.roles': msg({
    id: 'demos.dashboards.roles',
    message: 'Only people who can change the database add one.  Share shows who they are.',
  }),

  // Interfaces, and the sites they become
  'demos.interfaces.section': msg({
    id: 'demos.interfaces.section',
    message: 'Interfaces are listed here.  Each one is a set of pages you build for your records.',
  }),
  'demos.interfaces.add': msg({
    id: 'demos.interfaces.add',
    message: 'Add one here.  It starts with a single empty page.',
  }),
  'demos.interfaces.blocks': msg({
    id: 'demos.interfaces.blocks',
    message:
      'A page is made of blocks: lists of these records, one record’s details, numbers, charts, and text.',
  }),
  'demos.interfaces.roles': msg({
    id: 'demos.interfaces.roles',
    message: 'Only people who can change the database build one.  Everyone else uses the pages as they are.',
  }),
  'demos.sites.interface': msg({
    id: 'demos.sites.interface',
    message: 'A site is an interface you publish, so it starts here.',
  }),
  'demos.sites.pages': msg({
    id: 'demos.sites.pages',
    message: 'Build its pages first.  Then open the interface and choose Publish.',
  }),
  'demos.sites.permission': msg({
    id: 'demos.sites.permission',
    message: 'Publishing takes the same permission as sharing this database.',
  }),
  'demos.sites.records': msg({
    id: 'demos.sites.records',
    message: 'A site shows what its pages name, read through the permissions of whoever published it.',
  }),

  // Scheduled reports
  'demos.scheduled-reports.menu': msg({
    id: 'demos.scheduled-reports.menu',
    message: 'Each view has a menu of its own, beside its name.',
  }),
  'demos.scheduled-reports.open': msg({
    id: 'demos.scheduled-reports.open',
    message: 'Reports emails this view’s records on a schedule you choose.',
  }),
  'demos.scheduled-reports.add': msg({
    id: 'demos.scheduled-reports.add',
    message: 'Set one up here.  Nothing is sent until you save it.',
  }),
  'demos.scheduled-reports.name': msg({
    id: 'demos.scheduled-reports.name',
    message: 'The name starts the email’s subject, before the view’s name.',
  }),
  'demos.scheduled-reports.sampleName': msg({
    id: 'demos.scheduled-reports.sampleName',
    message: 'Weekly tasks',
  }),
  'demos.scheduled-reports.format': msg({
    id: 'demos.scheduled-reports.format',
    message: 'Choose the file it sends: Excel, CSV, Word, a deck, or no file at all.',
  }),
  'demos.scheduled-reports.when': msg({
    id: 'demos.scheduled-reports.when',
    message: 'Then when it goes: every day, on some weekdays, or on a day each month.',
  }),
  'demos.scheduled-reports.save': msg({
    id: 'demos.scheduled-reports.save',
    message: 'Set up report turns it on.  The demo sends nothing.',
  }),

  // A view's public link
  'demos.public-view-links.menu': msg({
    id: 'demos.public-view-links.menu',
    message: 'Each view has a menu of its own, beside its name.',
  }),
  'demos.public-view-links.open': msg({
    id: 'demos.public-view-links.open',
    message: 'Share view puts this one view on the web, and nothing else in the database.',
  }),
  'demos.public-view-links.help': msg({
    id: 'demos.public-view-links.help',
    message: 'Anyone with the link reads it without signing in, and nobody can change anything.',
  }),
  'demos.public-view-links.publish': msg({
    id: 'demos.public-view-links.publish',
    message: 'Turn this on and Riosoma makes the link at once.  The demo changes nothing.',
  }),
  'demos.public-view-links.records': msg({
    id: 'demos.public-view-links.records',
    message: 'The link shows these records, through the fields this view shows.',
  }),

  // Importing a file
  'demos.importing.add': msg({
    id: 'demos.importing.add',
    message: 'A file becomes a table of its own, so importing starts here.',
  }),
  'demos.importing.choose': msg({
    id: 'demos.importing.choose',
    message: 'This opens the dialog for a CSV or Excel file.',
  }),
  'demos.importing.file': msg({
    id: 'demos.importing.file',
    message: 'Choose your file here, or drop it into the dialog.',
  }),
  'demos.importing.start': msg({
    id: 'demos.importing.start',
    message: 'Riosoma previews the rows first.  Import adds them, and nothing happens until you choose it.',
  }),
  'demos.importing.tableMenu': msg({
    id: 'demos.importing.tableMenu',
    message: 'To add rows to a table you already have, open its menu.',
  }),
  'demos.importing.into': msg({
    id: 'demos.importing.into',
    message: 'This appends the file’s rows, or updates the records that match.',
  }),

  // Tables that read from a data source
  'demos.synced-tables.settings': msg({
    id: 'demos.synced-tables.settings',
    message:
      'From Home, open Settings, where a Data Sources admin connects sources for the whole organization.',
  }),
  'demos.synced-tables.add': msg({
    id: 'demos.synced-tables.add',
    message: 'Once your organization has one, this menu offers Sync from a data source.',
  }),
  'demos.synced-tables.list': msg({
    id: 'demos.synced-tables.list',
    message: 'A synced table is listed here beside the others, and it opens like any other table.',
  }),
  'demos.synced-tables.read': msg({
    id: 'demos.synced-tables.read',
    message: 'Its records fill this grid, and the source stays the place they come from.',
  }),

  // Talking about a record
  'demos.comments.where': msg({
    id: 'demos.comments.where',
    message: 'Every record has a place for conversation, and a list of what happened to it.',
  }),
  'demos.comments.expand': msg({
    id: 'demos.comments.expand',
    message: 'Open a record from here.  Its comments, and the changes to it, are beside its fields.',
  }),
  'demos.comments.bell': msg({
    id: 'demos.comments.bell',
    message: 'When someone mentions you in a comment, it lands here.',
  }),
  'demos.comments.notice': msg({
    id: 'demos.comments.notice',
    message: 'Each one opens that record, straight to its comments.',
  }),

  // Who sees which fields and records
  'demos.permissions.field': msg({
    id: 'demos.permissions.field',
    message: 'A field’s menu, in its column header, hides it from everyone but the people you choose.',
  }),
  'demos.permissions.tableMenu': msg({
    id: 'demos.permissions.tableMenu',
    message: 'A table’s menu has Record access, for the records each person sees.',
  }),
  'demos.permissions.open': msg({
    id: 'demos.permissions.open',
    message: 'A rule names the people it’s for, and the records they see.',
  }),
  'demos.permissions.add': msg({
    id: 'demos.permissions.add',
    message: 'Add a rule here.  Rules are drafts until you save them.',
  }),
  'demos.permissions.who': msg({
    id: 'demos.permissions.who',
    message: 'Choose the roles, or the people, that this rule is for.',
  }),
  'demos.permissions.condition': msg({
    id: 'demos.permissions.condition',
    message: 'Then the records it matches.  Someone no rule names sees every record.',
  }),
  'demos.permissions.save': msg({
    id: 'demos.permissions.save',
    message: 'Save turns the rules on for everyone.  The demo changes nothing.',
  }),

  // The trash and favorites
  'demos.trash.delete': msg({
    id: 'demos.trash.delete',
    message: 'Deleting a table, a field, a view, or a record never erases it straight away.',
  }),
  'demos.trash.open': msg({
    id: 'demos.trash.open',
    message: 'It moves to the trash, and stays there for the window an administrator set.',
  }),
  'demos.trash.list': msg({
    id: 'demos.trash.list',
    message: 'Everything deleted here is listed, newest first, and Restore brings one back for everyone.',
  }),
  'demos.trash.favorites': msg({
    id: 'demos.trash.favorites',
    message: 'Your favorites, and the databases you opened lately, live on your Home screen.',
  }),

  // Snapshots and copies
  'demos.snapshots.menu': msg({
    id: 'demos.snapshots.menu',
    message: 'The database’s own settings live behind this gear.',
  }),
  'demos.snapshots.open': msg({
    id: 'demos.snapshots.open',
    message: 'A snapshot keeps the whole database as it is right now.',
  }),
  'demos.snapshots.name': msg({
    id: 'demos.snapshots.name',
    message: 'Name it after what you’re about to change.',
  }),
  'demos.snapshots.sampleName': msg({
    id: 'demos.snapshots.sampleName',
    message: 'Before the spring cleanup',
  }),
  'demos.snapshots.take': msg({
    id: 'demos.snapshots.take',
    message: 'Take a snapshot here.  Restoring one makes a new database, so nothing is overwritten.',
  }),
  'demos.snapshots.more': msg({
    id: 'demos.snapshots.more',
    message: 'The same menu duplicates the database, or saves it as a template for your organization.',
  }),
  'demos.snapshots.duplicate': msg({
    id: 'demos.snapshots.duplicate',
    message: 'A duplicate is a new database, with every part of it under new IDs.',
  }),

  // Searching and running commands
  'demos.palette.open': msg({
    id: 'demos.palette.open',
    message: 'Search takes you anywhere in Riosoma, from one box.',
  }),
  'demos.palette.type': msg({
    id: 'demos.palette.type',
    message: 'Start typing, and the list narrows to whatever matches.',
  }),
  'demos.palette.sample': msg({ id: 'demos.palette.sample', message: 'help' }),
  'demos.palette.results': msg({
    id: 'demos.palette.results',
    message: 'Databases, tables, views, dashboards, and commands all turn up here.',
  }),
  'demos.palette.go': msg({
    id: 'demos.palette.go',
    message: 'Enter opens the row you’re on.  Escape leaves, and nothing changes.',
  }),

  // Downloading a view
  'demos.downloading.menu': msg({
    id: 'demos.downloading.menu',
    message: 'A view’s menu holds its downloads.',
  }),
  'demos.downloading.csv': msg({
    id: 'demos.downloading.csv',
    message: 'CSV sends the whole view as plain text, which any spreadsheet reads.',
  }),
  'demos.downloading.xlsx': msg({
    id: 'demos.downloading.xlsx',
    message: 'Excel sends it as a workbook, with each field’s type kept.',
  }),
  'demos.downloading.office': msg({
    id: 'demos.downloading.office',
    message: 'Word and PowerPoint send it as a document, or a deck with a slide for each record.',
  }),
  'demos.downloading.scope': msg({
    id: 'demos.downloading.scope',
    message: 'A download holds what this view shows of these records, and only the fields you can see.',
  }),

  // Keeping up with notifications
  'demos.notifications.open': msg({
    id: 'demos.notifications.open',
    message: 'News lands here: mentions, shares, and how your automations are doing.',
  }),
  'demos.notifications.list': msg({
    id: 'demos.notifications.list',
    message: 'Each one opens the record, table, or automation it’s about.',
  }),
  'demos.notifications.read': msg({
    id: 'demos.notifications.read',
    message: 'Mark all as read clears the count on the bell.',
  }),
  'demos.notifications.settings': msg({
    id: 'demos.notifications.settings',
    message: 'Which ones you get, and where they go, is a choice in Settings.',
  }),

  // Finding and merging duplicates
  'demos.merging-duplicates.menu': msg({
    id: 'demos.merging-duplicates.menu',
    message: 'A table’s menu has Find duplicates.',
  }),
  'demos.merging-duplicates.open': msg({
    id: 'demos.merging-duplicates.open',
    message: 'This looks for records that resemble each other.',
  }),
  'demos.merging-duplicates.field': msg({
    id: 'demos.merging-duplicates.field',
    message: 'Choose the fields to compare, and how closely they have to match.',
  }),
  'demos.merging-duplicates.find': msg({
    id: 'demos.merging-duplicates.find',
    message: 'Find duplicates lists the sets it finds.  Nothing is merged until you say so.',
  }),

  // Automations, after the trigger and the steps
  'demos.automations.trigger': msg({
    id: 'demos.automations.trigger',
    message: 'A trigger waits for something: a new record here, a change to one, or a time of day.',
  }),
  'demos.automations.history': msg({
    id: 'demos.automations.history',
    message: 'Every run is kept in a history, so you can see what an automation did, and why.',
  }),

  // Forms, after the answers arrive
  'demos.forms.records': msg({
    id: 'demos.forms.records',
    message: 'Each set of answers becomes a new record here, in the form’s own table.',
  }),
  'demos.forms.public': msg({
    id: 'demos.forms.public',
    message: 'A form has a link of its own, so anyone can send answers without an account.',
  }),

  // Sharing a database, after the people are listed
  'demos.sharing.role': msg({
    id: 'demos.sharing.role',
    message: 'Change what one person can do beside their name, from reader up to owner.',
  }),
};

/** Where a demo has to start, said when its first step isn't on screen. */
export const PLACES = {
  database: msg({
    id: 'demos.where.database',
    message: 'This demo starts inside a database.  Open one, then choose Show me again.',
  }),
  table: msg({
    id: 'demos.where.table',
    message: 'This demo starts on a table.  Open one in any database, then choose Show me again.',
  }),
} as const;

/** Why a demo stopped early. */
export const STOPPED = {
  level: msg({
    id: 'demos.stopped.level',
    message:
      'The demo stopped here, because this part of Riosoma is above your level.  Choose a higher level in Settings to see it.',
  }),
  access: msg({
    id: 'demos.stopped.access',
    message:
      'The demo stopped here, because this part of Riosoma isn’t on your screen.  You may not have access to it.',
  }),
  refused: msg({
    id: 'demos.stopped.refused',
    message: 'The demo stopped here, because this step would have changed something, and demos never do.',
  }),
  failed: msg({
    id: 'demos.stopped.failed',
    message: 'This demo couldn’t be loaded.  Try again in a moment.',
  }),
} as const;
