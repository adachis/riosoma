# Data core

How Riosoma stores tables, changes them, shows them in the grid, and keeps every open copy in step.  This is the design the server's `data/` and `realtime/` modules, the web app's `data/` and `grid/` modules, and `packages/grid-core` implement.  The request and message shapes live in `packages/contracts/src/data/`, and that code is the source of truth where the two disagree.

## Storage

- **System tables** live in the app schema (`rio_app` by default): `databases`, `tables`, `fields`, `views`, `grants`, `changes`, `commands`, and `undo_groups`.  Every row carries `org_id`.
- **Records** live in the data schema (`rio_data` by default), one real Postgres table per Riosoma table.  The physical table is named by the table's ID and each field's column by the field's ID, both quoted, so renaming never touches the database and names never collide.  IDs are validated against the ID pattern before they're used as identifiers.
- Every record table has these system columns:

  | Column | Type | Meaning |
  |---|---|---|
  | `__rid` | `bigint` identity, primary key | Internal row number.  Never leaves the server. |
  | `__id` | `text`, unique | Public record ID (`rec…`).  Clients may choose it when they create a record, so offline creation works. |
  | `__created_at`, `__created_by` | `timestamptz`, `text` | Set on insert |
  | `__updated_at`, `__updated_by` | `timestamptz`, `text` | Set on every change |
  | `__deleted_at` | `timestamptz` | Set when the record is trashed.  Every read excludes these rows. |

- **Field types and columns** in this phase:

  | Type | Column | Value in the API |
  |---|---|---|
  | `text`, `email`, `url`, `phone` | `text` | string or null |
  | `longText` | `text` | string or null |
  | `number` | `numeric` | number or null |
  | `checkbox` | `boolean` | true or false (null reads as false) |
  | `date` | `date`, or `timestamptz` when the field includes a time | `YYYY-MM-DD`, or an ISO 8601 instant in UTC |
  | `singleSelect` | `text` (the choice ID) | choice ID or null |
  | `multipleSelect` | `text[]` (choice IDs) | array of choice IDs, empty when none |
  | `createdTime`, `lastModifiedTime` | reads `__created_at`, `__updated_at` | ISO 8601 instant |
  | `createdBy`, `lastModifiedBy` | reads `__created_by`, `__updated_by` | user ID |
  | `recordId` | reads `__id` | record ID |

  Select values store choice IDs, so renaming a choice changes only the field's options.  Empty strings and empty arrays are stored as null.
- **Trash is soft.**  Trashing a record, field, table, or database only marks it.  A purge job removes marked things after the retention period (30 days by default).  A trashed field keeps its column until the purge, so restoring it is instant.
- **Type changes keep a backup.**  Converting a field renames its column to a backup name and writes the converted values into a new column, so undo restores the original exactly.  Values that can't be converted become empty, and the preview says how many.
- **Sorting text** uses an ICU collation created in the data schema (`rio_natural`, root locale with numeric ordering), so "Item 2" sorts before "Item 10" and case doesn't split the list.  When the server's Postgres lacks ICU, sorting falls back to the database's default collation.  Empty values sort last in both directions.

## Changing things: the command bus

Every change, from typing in a cell to deleting a table, is a **command** sent to `POST /api/databases/:databaseId/commands`.  Nothing else writes.  Each command runs through the same steps in one transaction:

1. **Validate** the command against its contract and the table's current fields.
2. **Authorize** it through `AccessScope` (below).
3. **Apply** it, capturing the previous values of everything it changes.
4. **Record** a change: the next sequence number for the database, the new values, and the previous ones.  The sequence number is taken just before commit by incrementing `databases.change_seq`, so sequence order is commit order within a database.
5. **Audit** it: schema changes write one audit event each, and record changes write one per command with counts, never values.
6. **Remember** it for idempotency: the command's ID and result go into `commands`, so a command sent twice (a retry, or an offline queue replayed) applies once and answers the same way both times.

After commit, the change is announced (see Realtime).  Commands in one request apply one at a time, each in its own transaction, and each gets its own result, so one stale command in a replayed offline queue doesn't block the rest.

Record commands carry at most 1,000 records.  Bigger pastes and imports are split by the client into several commands that share a `groupId`.

## Undo

Undo covers a person's own changes.  Commands the client sends together as one action share a `groupId`, and the client keeps a stack of group IDs per open database.

- `POST /api/databases/:databaseId/undo` with a `groupId` applies the inverse of that group's changes, built from the previous values stored with each change.  It skips any cell someone else has changed since, and the answer says how many it skipped so the person can be told.
- `POST /api/databases/:databaseId/redo` reapplies the group the same way.
- Undoing and redoing are commands themselves, so they're recorded, audited, and broadcast like any other change.
- A group can be undone only by the person who made it.
- Database and table creations require `confirmedMajorCreation: true` on every undo.  Field-owned line-items child tables are excluded, so creating a field stays one-step undo.  Missing confirmation returns `data.undo.majorCreationConfirmationRequired` without changing history or contents.  This applies to every caller of the undo command, including receipts and outside clients.
- `GET /api/databases/:databaseId/undo-preview/:groupId` reads current names, table and record counts, and other people's changes.  The app asks with Move to trash and Keep it, with Keep it focused and Escape keeping the item.  The undo panel marks major creations with Asks first.
- Confirmed creation undo trashes the parent through the ordinary deletion path, preserving its current contents, owned child tables, inverse link fields on other tables, and the usual retention.  Redo restores the parent without another question.  File imports share one group across database initialization and imported records.

## Who can see and change what: AccessScope

`AccessScope` answers every permission question and is the only place those answers come from.  In this phase access is granted per database through `grants`:

| Role | Read | Edit records | Change fields, tables, and views | Share and delete the database |
|---|---|---|---|---|
| `owner` | ✓ | ✓ | ✓ | ✓ |
| `creator` | ✓ | ✓ | ✓ | |
| `editor` | ✓ | ✓ | | |
| `commenter` | ✓ | | | |
| `reader` | ✓ | | | |

Whoever creates a database becomes its owner.  Every record read goes through `scope.recordPredicate(table)` and `scope.visibleFields(table)`, which apply the database's field and record permissions: restricted and locked fields, and record rules that limit which records a role or person sees.  [Field and record permissions](permissions.md) describes the model and every path that honors it.

## Reading records: two-phase paging

A grid shows a window of rows from a view that may hold millions.  Reads happen in two steps:

1. **Order.**  The server builds the view's ordered list of row numbers (`__rid`) for its filter and sorts, and keeps it in memory as a **snapshot** with an ID.  Snapshots are cached per replica, least recently used first out, within a memory budget.  A list view with no sort follows its own order instead: `record.move` gives a moved record an exact decimal position in `record_positions` for that view alone, and every other record keeps its row number as its place, so a move writes only the records that moved.
2. **Rows.**  `GET /api/views/:viewId/rows?snapshot=&offset=&limit=` slices the snapshot and fetches just those rows by primary key.  A page is at most 500 rows.  The response carries the snapshot ID and the total, which sizes the scrollbar.

A client keeps paging its own snapshot while the snapshot exists, so rows never shift under someone who's reading.  When a snapshot has been evicted, the server builds the current one and says so, and the client re-anchors on the first visible record.

When records change, the server works out, for each snapshot a client is watching, which changed records entered the view, left it, or may have moved, and sends that as a **view delta**.  The client uses it to show "new records" and "order changed" prompts instead of moving rows on its own.  Records the person creates themselves appear where they created them until the next refresh.

On large tables the server adds indexes for the sorts and filters people actually use, concurrently and in the background, and only when it has the privilege to.

## Realtime

One WebSocket per browser tab at `/api/realtime`.  The upgrade requires a valid session and an `Origin` matching the server's own origin.  The client subscribes to the databases it has open, passing the last sequence number it has seen, and the server replays any changes it missed, or tells it to reload when it's too far behind.

- **Changes** go out in sequence order to every subscriber who can read the database.  Previous values are stripped before sending.  Someone a field or record rule limits gets each change as they may see it, read again through their own access, as [Field and record permissions](permissions.md) describes.
- **Presence** is ephemeral: who's in the database, which table, view, and record, and which cell or range is selected.  It's never stored.  Idle clients drop out of the list after 60 seconds.
- **Several replicas** coordinate through Postgres `LISTEN`/`NOTIFY`: a commit sends a small notice with the database and sequence number, and each replica reads the change itself.  Behind a transaction pooler, `LISTEN` uses the profile's direct connection (`listenHost`), and without one each replica polls the change log every second.

## Offline

The client applies every edit immediately, then queues its command in IndexedDB until the server confirms it.  When the connection drops, the queue keeps growing and the app says it's offline.  On reconnect, the queue is sent again in order, and command IDs keep anything from applying twice.  Conflicting edits resolve by server order: the last change to reach the server wins.

## The grid

`packages/grid-core` is a plain TypeScript grid with no framework.  It renders only the rows and columns in view from recycled DOM pools, keeps its own scroll position in content pixels so a million rows scroll smoothly and reach the last row, and routes all typing through one focused input element so input methods for Japanese, Chinese, and Korean work when someone starts typing on a cell.  The React side supplies cell renderers, editors, and data.

## Dashboards

A dashboard is a row in `dashboards` whose `config` holds up to 50 tiles (numbers, charts, record lists, and notes) placed on a 12-column grid.  Dashboards change through commands (`dashboard.create`, `dashboard.update`, `dashboard.move`, `dashboard.trash`, `dashboard.restore`), so they're authorized, undone, broadcast, and trashed like tables.  The client saves the whole configuration with each change, and waits a moment after layout moves so a drag saves once.

Tile values are never stored.  `POST /api/dashboards/:dashboardId/data` computes them on the server, for the person asking:

- **Access.**  Every tile reads through that person's `AccessScope`: `recordPredicate` and `visibleFields` as the grid applies them, then the view's filter, then the tile's own.  Two people can see different numbers on one dashboard, and nobody sees a record they couldn't open.
- **One snapshot.**  A single `REPEATABLE READ READ ONLY` transaction covers every tile, so the numbers on a dashboard agree with each other.
- **SQL does the work.**  Charts group in SQL, keep their first `limit` categories and fold the rest into "Other", split into at most 25 series, and bucket times into days in their field's time zone, or the reader's when the field has none.  Record tiles read one short page in the view's order.
- **Failures stay local.**  Each tile runs in a savepoint with a 5-second statement timeout, and a request stops starting tiles after 20 seconds.  A tile whose table, view, or field is gone or hidden, whose calculation doesn't fit its field, or that runs out of time answers with its own error, so one broken tile never blanks the dashboard.

The client batches tiles into one request.  A tile that was just added or changed waits for its configuration to save, since the server computes from what it holds.  After records change in any table a tile reads, including tables its lookups, rollups, and counts reach through links, the tile refreshes, waiting 600 ms for a burst of changes to settle and never more than 3 seconds.  It keeps its last data on screen while fresh data loads.

## Automations

An automation is a row in `automations` whose `config` holds a trigger, optional conditions, and up to 25 steps.  It changes through commands (`automation.create`, `automation.update`, `automation.move`, `automation.trash`, `automation.restore`) that need schema access.  The server's `automations/` module queues its runs and runs them.

- **Triggers** queue rows in `automation_runs`.  Record triggers queue from `queueTriggeredRuns`, which `recordChange` calls inside the command's transaction, so a run is queued exactly when its change commits and never for one that rolled back.  `recordMatches` compares matches before and after the change, read by `matchedBefore` just before the command applies.  Schedules keep `next_run_at`, which the worker checks every 10 seconds, and a schedule that fell behind runs once and moves on to its next time.  Webhooks arrive at `POST /api/hooks/:automationId/:secret`, which checks the secret in constant time, queues a run with the JSON body, and answers 202 at once.  Only a hash of the webhook secret is stored.
- **The run queue.**  Each server's worker claims queued runs with `FOR UPDATE SKIP LOCKED` and a lease, up to four at a time, so replicas share the work.  A run whose server stopped is claimed again when its 15-minute lease runs out and carries on from the step it was on.  Record steps send commands with IDs derived from the run and step, so the command bus applies a resumed step once.  Each automation starts at most 60 runs a minute, and runs are kept for 30 days.
- **Acting as a person.**  Runs act as `run_as_id`, whoever turned the automation on or last published a change while it was on.  A run records that person in `actor_id` together with the version it runs: in the statement that leases a queued run and snapshots its configuration, or when it's queued for a rerun, a resume, or a button, which choose the version then.  A run whose `actor_id` differs from `run_as_id` when it starts, or when it goes on after a wait or a lost lease, fails before running anything more, with `automations.runAs.changed`, or `automations.resume.runAsChanged` once steps have finished, so a version never runs as anyone but the person who published it or turned it on.  A test, whole or single-step, acts as the person testing, never as `run_as_id`, since it may run a draft nobody published.  Undo and redo follow the commands: one that turns the automation back on, or changes what's published while it's on, sets `run_as_id` to whoever undid or redid it.  A resumed run reuses what earlier steps worked out with their person's access, so it's refused once `run_as_id` differs from the source run's `actor_id`, or for someone a rule limits on a table those steps read, and it fails before running anything if `run_as_id` changes before it starts.  A run checks that this person is still an active member with a role in the database, then sends its record changes through the command bus as them, with the automation's ID as the client ID.  The changes are validated, authorized, audited, and broadcast like anyone's, and their history entries carry the automation's ID.
- **Stopping on lost access.**  When that person can't do what a step needs, the run fails and the engine turns the automation off with `stopped_because` set to `automations.runAs.denied`.  That's a system change, broadcast and audited, with no undo.  Turning the automation back on clears the reason and makes it act as whoever turned it on.  Runs queued before an automation was turned off or trashed are skipped.
- **Chains.**  An automation's own changes never queue it again, and runs carry a depth, so a chain of automations each set off by the one before stops after five.
- **Outbound calls.**  Webhook steps refuse any address off the public internet unless `RIOSOMA_AUTOMATIONS_ALLOW_PRIVATE_HOSTS` is set, connect to the address they checked, never follow redirects, give up after 10 seconds, and keep the first 64 KB of the answer.  Email steps render a small Markdown subset with every inserted value escaped.

## Scripts

A script is a row in `scripts` holding a name, a description, and JavaScript that people run by hand from the database's script panel.  It changes through commands (`script.create`, `script.update`, `script.move`, `script.trash`, `script.restore`) that need schema access, and it undoes, broadcasts, and goes to the trash like an interface.  Only people who can change the schema receive a script's code, in the schema and in its changes, since code can hold addresses and keys the way a webhook step can.  The server's `scripts/` module holds the commands and the runs.

- **A run is a WebSocket.**  `GET /api/scripts/:scriptId/run` upgrades beside the realtime socket, with the same origin check, and the panel's first message carries the session's CSRF token.  The run lives exactly as long as the socket, on the server that holds it, so nothing about a run is stored or routed between replicas.  Anyone who can edit records may run a saved script.  Only saved code runs, so the panel saves before it starts one.
- **The same sandbox, on its own thread.**  A run uses the automation step's QuickJS sandbox, with the panel's globals: `input.textAsync`, `input.buttonsAsync`, `input.tableAsync`, and `input.recordAsync`, `output.text`, `output.markdown`, and `output.table`, `console`, `fetch`, `sleep`, and `records.find`, `create`, `update`, and `delete`.  It runs in a worker thread, so a script that spins never holds up the server's other requests, and stopping a run ends the thread at once.  Calls cross to the server's thread as serialized values, as they cross the sandbox's own boundary.
- **Acting as the person.**  Every read goes through the person's access with their field and record rules, read fresh for each call, and every write through the command bus as them, marked with the script and run in the audit log.  All of a run's writes share one `groupId`, which the server chooses and tells the panel, and the panel puts that group on the person's undo stack named for the script, so undo takes the run back in one step.  `records.delete` asks the person in the panel before any record is trashed.
- **Time.**  The script's own time is limited to `RIOSOMA_SCRIPTS_TIMEOUT_MS`, 60 seconds unless set, up to 10 minutes.  While a prompt waits for the person, the clock stands still.  A separate cap ends any run after 30 minutes in all.  The other limits are the automation step's.  Each server runs at most two scripts at a time for one person and eight in all.
- **The limit holds whatever the script does.**  The sandbox checks the clock only between a script's own instructions, so one long built-in operation, such as joining a huge list, runs past the limit inside it.  The server's thread follows the script's clock (`runInSandbox` in `scripts/sandbox.ts`), pausing with it during prompts, and ends the worker one second after the limit.
- **Automation script steps run the same way.**  `runScriptStep` in `automations/script-step.ts` runs a step's script through `runInSandbox` with the automation's globals, so a published run, a test, a single-step test, and a simulation all leave the server's thread free.  Each server runs at most four script steps at a time for one organization and eight in all (`SCRIPT_STEPS`), and the rest wait in order.  A published run's step always waits its turn, since the engine has only a few runs under way at once.  A test's or a simulation's is refused with `scripts.run.busy` when 16 from its organization already wait, and because those run inside the request that asks for them, `testingScripts` lets one person have two with a script step under way at once and refuses a third before anything of it is stored.  All of one run's script steps share five minutes (`scriptBudget`), counted across loop iterations and across a wait, and a run that spends it fails with `automations.script.runTimeout`.  The run is charged each script's own time, from when its sandbox is ready, which the step's stored result keeps as `scriptMs` beside the whole step's `ms`, so a run that starts again has what it had left.

## Archives: snapshots, restores, duplicates, and templates

An archive is a whole database as one versioned JSON document (`format: 'riosoma.database'`, `version: 1`), whose zod schema is `DatabaseArchive` in `packages/contracts/src/archives.ts`.  The server's `data/archives/` module writes and restores them.

- **What it holds.**  The database's name, description, icon, color, and `settings` (its theme), then each live table with its fields (every type, with options, formulas, links and their `match`, and synced source columns), views with each list's `record_positions`, records, and comments, then dashboards, automations, interfaces, scripts, and the files the records name.  Everything keeps its own ID, so references hold.  A record keeps its row number, its created and modified times and people, and, in a synced table, its source key and overrides.  Computed values aren't kept.  Files are kept by reference: storage key, checksum, and the details the file row holds, never the bytes.
- **What it leaves out.**  The trash, grants, shared view links and public form links, webhooks, indexes the server added, and the change log.  Record history lives in the database's change log rather than with each record, so a copy starts with none.
- **Writing** happens in one `REPEATABLE READ` transaction, so an archive is never half old and half new.  Snapshots and templates store it gzip-compressed in `database_snapshots` and `org_templates`.
- **Restoring** makes a new database in one transaction, in phases: tables with the fields that hold values (through `table.create` and `field.create`, so physical tables and columns are made the usual way), records with their files, links (`field.create` for one side, `field.update` to name the other, then the junction rows written directly with both sides' orders), formulas, lookups, rollups, counts, and buttons, views and list places, then dashboards, automations, interfaces, scripts, and comments.  Every ID is new.  `IdMap` replaces archive IDs wherever they appear in options, formulas, button links, view settings, dashboards, automations, interfaces, and scripts' code, and leaves any other text alone.  Records keep their row numbers, so natural order and list places come back exactly, and each table's identity and auto number sequences carry on from the highest.
- **Files are copied**, since a stored file's key belongs to one file row and deleting a file deletes its bytes, so there's no reference counting to share them with.  The store that holds a file makes the copy: PostgreSQL copies its chunk rows, a folder copies the file, and a bucket or container copies the object itself.  A file is found by its key wherever it's stored now, since moving files between stores keeps their keys.  A file whose bytes are gone or whose checksum no longer matches is left out and counted in the copy's report.
- **What changes in a copy.**  Automations come back turned off, with new webhook addresses.  A synced table keeps syncing only when its source still exists in the organization and the person may use it, and is otherwise an ordinary table.  The person restoring is the only one it's shared with.
- **Restores and duplicates** run in the background through `DatabaseCopier`, a couple at a time per server, with progress in `database_copies` that people follow with `?since=`.  A copy cut short by a stopped server rolls back with its transaction and is marked failed by the next sweep.  Templates from the organization restore in the request.
- **Automatic snapshots.**  Each server looks every ten minutes for a UTC day it hasn't done.  For each organization with them on, every database with a change the day before gets one snapshot standing for that day (unique per database and day), taken under an advisory lock.  Then each database keeps the newest automatic snapshot of each of its last `keepDaily` days and `keepWeekly` weeks.
- **Who.**  Every archive action needs `editSchema` and `AccessScope.readsEverything` for every table: a person with a restricted record rule or hidden field can't take a copy.  Saving and removing templates, and the snapshot settings, are for organization admins.  Each action writes an audit event with IDs and counts, never values.

## Budgets

| Measure | Budget |
|---|---|
| First rows of a 1M-row, 20-field table, server warm | ≤ 800 ms |
| Scrolling | ≥ 55 fps, 95th percentile frame ≤ 16.7 ms |
| Jump to row 900,000 | ≤ 300 ms |
| Own edit shown | ≤ 16 ms |
| Server confirms an edit, 95th percentile | ≤ 150 ms |
| Another person sees the edit, 95th percentile | ≤ 250 ms |
| Sort on an indexed field, 1M rows | ≤ 650 ms |

Nightly benchmarks fail when a measure regresses more than 10% from its baseline.
