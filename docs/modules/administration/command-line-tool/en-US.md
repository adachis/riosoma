---
id: command-line-tool
title: Using the riosoma command line
summary: Sign in, list databases and tables, read and change records, import and export files, and save a schema.
area: administration
order: 4
level: advanced
related: [javascript-sdk, rest-api, export-and-import, importing, oauth-development]
---

`riosoma` is the command line tool.  It's built on the JavaScript SDK, so it reaches the same `/api/v1` routes with the same permissions, and everything it changes is validated, audited, broadcast to anyone watching the table, and undoable.  It answers with tables a person reads at a terminal, or with JSON a script pipes into the next thing, and its summaries and warnings go to standard error so standard output carries only the answer.

See {{doc:javascript-sdk}} for the library it's built on, and {{doc:rest-api}} for the API itself.

## Installing

Until the tool is published to npm, it comes from a checkout of the repository:

```
pnpm install
pnpm --filter @riosoma/cli build
```

That leaves the command at `apps/cli/dist/main.js`, which runs on Node.js 20 or newer.  To type `riosoma` anywhere, put it on your path:

```
cd apps/cli && npm link
```

Or point a folder on your path at it:

```
ln -s "$PWD/apps/cli/dist/main.js" ~/.local/bin/riosoma
```

Once it's published, an install is one line:

```
npm install --global riosoma
```

Every command has its own help, and the tool prints its own when it's given a word it doesn't know:

```
riosoma help
riosoma help records
riosoma --version
```

## Signing in

The simplest way in is a personal access token, made under {{ui:shell.nav.settings}}, then {{ui:settings.nav.tokens}}, then {{ui:tokens.create}}.  Choose the {{ui:tokens.scopes}} the work needs: {{ui:tokens.scope.schemaRead}} to list databases and tables, {{ui:tokens.scope.recordsRead}} to read records, and {{ui:tokens.scope.recordsWrite}} to change them.  Then give it to the tool once:

```
riosoma login --url https://riosoma.example.com --token rio_pat_…
```

The token is checked before it's kept, so a mistake says so at once, and it's never printed back.  `riosoma login` on its own says what's stored, and `--check` tries it:

```
riosoma login --check
```

`riosoma logout` forgets it, and `--all` forgets every profile.  A failed removal returns a nonzero exit code.  Resolve the keychain error and run logout again before treating the credential as removed.

On macOS and Linux, each profile is stored in its own keychain entry.  Existing entries remain readable and move to that format when saved.  Keychain writes receive credentials through standard input.  If the keychain is unavailable or an entry exceeds its input limit, the tool uses a private file.  New credential contents are created with owner-only permissions in a private directory, then replace the previous file atomically.

### Where the credential lives

It goes into the operating system's keychain where there is one, which is the Keychain on macOS and a freedesktop keyring on Linux.  Where there isn't one, it goes into `~/.config/riosoma/credentials.json`, which the tool writes so that only the person who wrote it can read it.  `RIOSOMA_CLI_HOME` puts that file somewhere else, and `RIOSOMA_KEYCHAIN=off` asks for the file even where a keychain exists.

More than one server is more than one profile:

```
riosoma login --profile work --url https://riosoma.example.com --token rio_pat_…
riosoma databases --profile work
```

A command's own options come first, then the environment, then what's stored, so one command can point somewhere else without disturbing anything:

```
RIOSOMA_URL=https://riosoma.example.com RIOSOMA_TOKEN=rio_pat_… riosoma databases
riosoma databases --url https://staging.example.com --token rio_pat_…
```

The variables are `RIOSOMA_URL`, `RIOSOMA_TOKEN`, `RIOSOMA_PROFILE`, `RIOSOMA_CLIENT_ID`, `RIOSOMA_CLI_HOME`, and `RIOSOMA_KEYCHAIN`.

### Signing in through a browser

A browser sign-in keeps a long-lived secret out of a shell's history.  It needs an OAuth app an owner registered under {{ui:oauth.apps}}, public rather than confidential, with a redirect address of `http://127.0.0.1/callback` in its {{ui:oauth.redirects}}.  See {{doc:oauth-development}}.  The tool then listens on a loopback address of its own, prints the address to approve, opens a browser, and takes the tokens the approval produces:

```
riosoma login --browser --url https://riosoma.example.com --client-id <id>
```

The port is whatever this machine gives it, which the server allows for a public app's loopback address.  On a machine with no browser, `--no-open` prints the address to copy into one, `--wait` says how many seconds to wait for the approval, and `--scopes` asks for less than the app holds.  The tokens are stored like any other credential, and the access token is replaced with a fresh one when it runs out.

## Listing what's there

```
riosoma databases
riosoma tables "People"
riosoma tables "People" --fields
riosoma schema "People" --file people.json
```

A database and a table may be named by ID or by name, and `--json` gives the API's own values rather than a table.  `schema` writes the whole of a database's tables, fields, and views as JSON, which is where the IDs a filter needs come from, and a saved copy is a record of what a database looked like on the day it was taken.

## Records

```
riosoma records list "People" Contacts --limit 20
riosoma records list "People" Contacts --view "Open work" --sort "Due:asc" --fields Name,Due
riosoma records list "People" Contacts --filter '{"conjunction":"and","conditions":[{"id":"1","fieldId":"Status","operator":"is","value":"Open"}]}'
riosoma records get "People" Contacts rec…
riosoma records create "People" Contacts --field Name="Ada Lovelace" --field Amount=10 --field Status=Open
riosoma records create "People" Contacts --data '[{"fields":{"Name":"Grace Hopper"}}]'
riosoma records update "People" Contacts --id rec… --field Status=Done
riosoma records delete "People" Contacts rec… rec…
```

A list pages through as many records as the table holds, printing each page as it arrives, so `--limit` is how you stop early and `--page-size` is how much a request carries.  A filter is JSON, and it names fields by name or by ID, since the tool looks each name up first.  A sort is written `Field:desc`, and more than one is separated by a comma.  Values come back as data, or as the text the app shows with `--cell-format string`, formatted for the `--locale` and `--time-zone` you name.

A write prints the records as they now stand, and says on standard error how many it wrote and which undo group takes them back:

```
Created 2 records in Contacts.
Undo group: act2fQ…
```

`update` changes the fields a record names and leaves the rest alone.  A record that has to be made if it isn't there yet is an upsert, which matches on one to three fields:

```
riosoma records update "People" Contacts --upsert-on Email --data '[{"fields":{"Email":"ada@example.com","Amount":12}}]'
```

`delete` moves records to the trash, where the app can restore them, and prints the primary field of each one it moved so you can see what went.

Values given as `--field Name=value` are read as JSON when they are JSON and as text when they aren't, so `Amount=10` is the number ten and `Name=Ada` is text.  A write reads text as the field's own type unless you say `--no-typecast`, which is what lets a file of plain text land in number, date, and checkbox fields.

## Files

```
riosoma import "People" Contacts --file contacts.csv
riosoma import "People" Contacts --file contacts.csv --upsert-on Email --batch 200
riosoma import "People" Contacts --file contacts.ndjson --json
riosoma export "People" Contacts --file contacts.csv --fields Name,Email
riosoma export "People" Contacts --format json --with-id > contacts.json
```

An import reads a CSV file whose first row names the fields, or a JSON file holding an array of records or one record per line, each as `{"fields": {…}}` or `{"id": "rec…", "fields": {…}}`.  A cell left empty says nothing about that field, so it's left out rather than sent as blank.  A file is read as it arrives and sent in batches, so one bigger than memory imports all the same, and `--batch` says how many records a request carries.  With `--upsert-on`, a row changes the record whose values for those fields match its own, and makes one when nothing does.

An export writes each record as it arrives, so a table bigger than memory exports too.  CSV is the default, and the shape follows the file's name, so `.json` writes JSON.  `--with-id` adds a leading `id` column, which is what makes a round trip work: a file with an `id` column changes those records rather than making new ones.  With no `--file` the records go to standard output, so the tool sits in a pipe.

## In a script

`--json` gives values rather than a table, and the exit code says how the command ended: 0 when it did its work, 1 when it couldn't, and 2 when it was asked for something that isn't a command.

```
riosoma records list "People" Contacts --json --limit 5 | jq '.[].fields.Email'
riosoma databases --json | jq -r '.[].id' | while read -r database; do riosoma schema "$database" --file "$database.json"; done
```

A failure says what the server said, names the field a value was refused for, and says what to try instead, as a token that needs a scope it doesn't have.  `RIOSOMA_DEBUG=1` adds a stack for a fault nobody could have expected.

## Checking transfers

`riosoma export --fields` accepts field names, field IDs, or both.  CSV headings use the field names, in the requested order, and each selected value is preserved.

A JSON array import requires commas between records, a closing bracket, and only whitespace after that bracket.  Invalid input returns a nonzero exit code.  Imports stream in batches, so earlier batches may already have been applied when a later record fails.  Check the imported records before retrying the file.

To replace a credential, open {{ui:shell.nav.settings}}, then {{ui:settings.nav.tokens}}.  Create a replacement with {{ui:tokens.create}} and only the {{ui:tokens.scopes}} your commands need.
