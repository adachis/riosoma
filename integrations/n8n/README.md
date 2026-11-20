# n8n-nodes-riosoma

Read and write [Riosoma](https://github.com/adachis/riosoma) records from [n8n](https://n8n.io) workflows, and start workflows when records change.  The package has two nodes:

- **Riosoma** lists databases and tables, and gets, searches, creates, updates, upserts, and deletes records.
- **Riosoma Trigger** starts a workflow when records, fields, or tables change, through a Riosoma webhook it adds and removes itself.

Both talk to Riosoma's REST API with a personal access token.

## Installation

Once the package is on npm, a self-hosted n8n can install it from **Settings**, then **Community nodes**, then **Install**, with the name `n8n-nodes-riosoma`.

To use a build of your own, build the package and copy it into n8n's folder for custom nodes, then restart n8n:

```
pnpm install
cd integrations/n8n && pnpm install && pnpm run build && pnpm pack
mkdir -p ~/.n8n/custom/n8n-nodes-riosoma
tar xzf n8n-nodes-riosoma-*.tgz --strip-components=1 -C ~/.n8n/custom/n8n-nodes-riosoma
```

With Docker, mount the unpacked folder instead, such as `-v "$PWD/n8n-nodes-riosoma:/home/node/.n8n/custom/n8n-nodes-riosoma:ro"`.

## Credentials

In Riosoma, choose **Settings**, then **Personal access tokens**, then **Create token**.  Choose the scopes the workflows need, and the databases the token may reach.

| To | The token needs |
| --- | --- |
| Pick databases, tables, fields, and views | Read tables, fields, and views |
| Get and search records | Read records |
| Create, update, upsert, and delete records | Add, change, and delete records |
| Use the Riosoma Trigger | Change tables, fields, and views, plus Read records to include records |

A token acts as you, so it never does more than your role in each database allows.  Writing records takes the Editor, Creator, or Owner role, and adding webhooks takes Creator or Owner.

In n8n, add a **Riosoma API** credential with:

- **Address**, the address you open Riosoma at, such as `https://riosoma.example.com`.
- **Personal Access Token**, the `rio_pat_…` token Riosoma showed once.
- **Ignore SSL Issues**, only for a server whose certificate n8n can't check.

Saving the credential tests it by listing databases.

## Riosoma node

| Resource | Operation | What it does |
| --- | --- | --- |
| Database | Get Many | Lists the databases the token can reach. |
| Table | Get Many | Lists a database's tables with their fields and views. |
| Record | Get | Gets a record by its ID. |
| Record | Search | Finds records by a field's value or a filter, reading every page. |
| Record | Create | Adds a record. |
| Record | Update | Changes the fields you set and leaves the rest. |
| Record | Create or Update | Updates the record whose field matches a value, or creates one when none does. |
| Record | Delete | Moves a record to Riosoma's trash, where it stays for 30 days. |

Pick the database and table from the lists, or paste an ID or the address of the table in Riosoma.  Each operation runs once for each item it receives.

### Records as items

A record becomes an item with its fields by name, then `id` and `createdTime`.  With **Nest Fields**, the fields go under `fields` instead, which keeps a field named `id` or `createdTime`.  Values come back the way Riosoma's API gives them:

- Numbers as numbers, with percentages as fractions and durations in seconds.
- Checkboxes as `true` or `false`.
- Dates as `2026-10-15`, or `2026-10-15T14:30:00.000Z` for fields that include a time.
- Select options by name, people as `{ id, email, name }`, and linked records as lists of record IDs.
- Files as `{ id, url, filename, size, type, thumbnails }`, with absolute addresses.  Riosoma serves files to people signed in, so a token can't download them.

**Values As Text** returns every value as text, formatted the way Riosoma shows it, in the workflow's time zone.

### Setting fields

Create, Update, and Create or Update map values to fields by name.  Set them one by one in the node, or choose **Map Automatically** to take them from the item, which suits items from another Riosoma node.  Riosoma fills in formulas, lookups, rollups, counts, autonumbers, and the created and modified fields itself, so values for them are left out, as are the `id` and `createdTime` of an item from an earlier Riosoma node.

| Field | Accepted values |
| --- | --- |
| Text, long text, email, URL, and phone | Text.  Numbers and dates become text. |
| Number, currency, percent, duration, and rating | Numbers, or text that holds one, such as `"12.5"`. |
| Checkbox | `true` or `false`, or text such as `yes`, `no`, `1`, or `0`. |
| Date | A date, a date and time, or a date from n8n's date picker.  A field without a time keeps the day as written.  A time without an offset, such as `2026-10-15 14:30`, is read in the workflow's time zone. |
| Single select | An option's name. |
| Multiple select | A list of option names, or names with commas between them. |
| Person | A person's ID or email, or a list of them. |
| Link | Record IDs, as a list, with commas between them, or as records from an earlier node. |
| Attachment | Files already in Riosoma, by ID, by the file objects a read returns, or by their Riosoma address. |
| JSON, date range, location, and signature | The same forms the REST API takes. |

Riosoma's API attaches only files already stored in Riosoma, so a file from another address has to be uploaded in Riosoma first.

Values you set in the node that are empty are left out, so Riosoma keeps what the field holds.  Turn on **Send Empty Values** to clear those fields instead.  With **Typecast**, Riosoma reads text as numbers, checkboxes, and dates, and adds select options it doesn't have yet, which takes the Creator or Owner role.  A value named for no field stops the node, unless **Ignore Unknown Fields** is on.

### Search

**Filter By** chooses how records are found:

- **No Filter** reads every record, or every record in the chosen view.
- **Field Value** finds records whose field equals a value.  Text and option names match without regard to case, numbers as numbers, and dates by the day.
- **Filter (JSON)** takes a filter group in the form Riosoma's API uses, except that fields may go by name as well as ID.

```json
{
  "conjunction": "and",
  "conditions": [
    { "field": "Status", "operator": "is", "value": "Open" },
    { "field": "Due", "operator": "isBefore", "value": "2026-10-15" },
    {
      "conjunction": "or",
      "conditions": [
        { "field": "Count", "operator": "gte", "value": 10 },
        { "field": "Name", "operator": "contains", "value": "rush" }
      ]
    }
  ]
}
```

Riosoma leaves out a condition it can't use rather than refusing it, which would widen a search without saying so.  The node checks each condition against its field first and stops on one that doesn't fit.

| Field | Operators |
| --- | --- |
| Text | `is`, `isNot`, `contains`, `doesNotContain`, `isEmpty`, `isNotEmpty` |
| Number | `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `isEmpty`, `isNotEmpty` |
| Checkbox | `is` with `true` or `false` |
| Date | `is`, `isNot`, `isBefore`, `isAfter`, `isOnOrBefore`, `isOnOrAfter`, `isEmpty`, `isNotEmpty`, and `isWithin` a period such as `{ "mode": "pastWeek" }` |
| Single select and person | `is`, `isNot`, `isAnyOf`, `isNoneOf`, `isEmpty`, `isNotEmpty` |
| Multiple select and people | `hasAnyOf`, `hasAllOf`, `isExactly`, `hasNoneOf`, `isEmpty`, `isNotEmpty` |
| Link | `contains` a linked record's name, `doesNotContain`, `hasAnyOf` and `hasNoneOf` record IDs, `isEmpty`, `isNotEmpty` |
| Attachment and JSON | `contains`, `doesNotContain`, `isEmpty`, `isNotEmpty` |

A date condition takes a day as `"2026-10-15"`, or a target such as `{ "mode": "today" }` or `{ "mode": "daysAgo", "days": 7 }`.  Formulas, lookups, and rollups take the operators of the kind of value they produce.

The node reads 100 records at a time and follows Riosoma's cursor until it has them all, or until it reaches **Limit**.  **Options** add a view, whose filter and fields apply and whose sorts break ties, sorts of your own, and the fields to return.

### Create or Update

Choose the field under **Field to Match On**, and set a value for it.  The node looks for records whose field equals that value, as Field Value search does.  It updates the one it finds, creates a record when it finds none, and stops when it finds more than one, since it can't tell which to update.  Match on a field whose values are unique, such as an ID from another system.  Text, number, checkbox, date, and single select fields can be matched on.

## Riosoma Trigger

Choose the database, the events, and optionally the tables.  When the workflow is activated, the trigger adds a Riosoma webhook that sends those events to n8n, and keeps the webhook's signing secret with the workflow.  When the workflow is deactivated, it removes the webhook.

| Event | When |
| --- | --- |
| Record Created | A record was added. |
| Record Updated | A record's fields changed. |
| Record Deleted | A record was moved to the trash. |
| Field Changed | A field was added, changed, or removed. |
| Table Changed | A table was added, renamed, or removed. |

Riosoma sends up to 100 changes in a call.  The trigger checks each call's `Riosoma-Signature` against the secret, and refuses one that's unsigned, signed with another secret, or more than five minutes old, so nothing starts the workflow but Riosoma.  It then emits an item for each change, in order:

```json
{
  "event": "record.updated",
  "databaseId": "db…",
  "tableId": "tbl…",
  "recordId": "rec…",
  "fieldIds": ["fld…"],
  "seq": 1042,
  "at": "2026-10-15T14:30:00.000Z",
  "deliveryId": "dlv…",
  "webhookId": "whk…",
  "record": { "Name": "Order 1042", "Status": "Open", "id": "rec…", "createdTime": "…" }
}
```

Riosoma's calls name what changed, never the values, so with **Include Record**, on by default, the trigger reads each created or updated record and adds it under `record`.  A record deleted since reads as `null`.  Riosoma retries a call that fails, with the same `deliveryId`, which a workflow can use to skip one it has already handled.

Riosoma sends webhooks only to `https` addresses on the public internet.  If n8n's webhook address uses `http`, or n8n and Riosoma share a private network, the trigger shows Riosoma's reason when it's activated.  Set n8n's `N8N_WEBHOOK_URL`, or `WEBHOOK_URL` before n8n 2, to its public `https` address, or have Riosoma's operator set `RIOSOMA_AUTOMATIONS_ALLOW_PRIVATE_HOSTS=true` for a private network.

## Errors

Riosoma's errors become n8n errors with Riosoma's message, the field and value it names, a hint for the common cases, and its message key, such as `data.value.notNumber`.  A token without the scope a request needs says which scope to add.  Values the node can't convert, filters that don't fit their fields, and record IDs in the wrong form stop the node before it calls Riosoma.  When the node's **On Error** setting is **Continue**, the error goes on the failed item and the other items carry on.

## Compatibility

Tested with n8n 2.40.7 and Riosoma's REST API `v1`.  The package has no runtime dependencies, and n8n provides `n8n-workflow`.

## Development

This folder is its own pnpm workspace, outside Riosoma's, the same way as the Zapier app.  `n8n-workflow` and n8n's lint rules are listed only in this folder's `pnpm-lock.yaml`, so Riosoma's own install and image never fetch them.  The build, lint, and tests reuse the repository's TypeScript, ESLint, and Vitest, so install the repository first with `pnpm install` at its root.  Then, from the repository root:

```
pnpm n8n:test
```

That installs this folder from its own lockfile, then typechecks, lints, builds, and tests it.  From this folder, the same steps are `pnpm install` and `pnpm test`.

The tests run the nodes against a small stand-in for Riosoma's API.  Lint runs the repository's rules together with the checks n8n runs on community nodes.

## License

MIT
