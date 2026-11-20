# riosoma, the command line tool

Sign in, list databases and tables, read and change records, move records through CSV and JSON
files, and save a database's schema.  Built on [@riosoma/sdk](../../packages/sdk/README.md), so it
reaches the same routes with the same permissions, and everything it changes is validated, audited,
broadcast, and undoable.

The full guide is the
[command line tool](../../docs/modules/administration/command-line-tool/en-US.md) help module in the
app.  This file is the short version.

```
riosoma login --url https://riosoma.example.com --token rio_pat_…
riosoma databases
riosoma tables "People" --fields
riosoma records list "People" Contacts --filter '{"conjunction":"and","conditions":[{"id":"1","fieldId":"Status","operator":"is","value":"Open"}]}' --sort Due:asc --limit 20
riosoma records create "People" Contacts --field Name="Ada Lovelace" --field Amount=10
riosoma records update "People" Contacts --id rec… --field Status=Done
riosoma records delete "People" Contacts rec…
riosoma import "People" Contacts --file contacts.csv --upsert-on Email
riosoma export "People" Contacts --file contacts.csv --fields Name,Email
riosoma schema "People" --file people.json
```

Tables for a person, `--json` for a script, summaries and warnings on standard error so standard
output carries only the answer, and an exit code of 0 when a command did its work, 1 when it
couldn't, and 2 when it was asked for something that isn't a command.

## Building it

```
pnpm --filter @riosoma/cli build
node apps/cli/dist/main.js help
```

The command is `apps/cli/dist/main.js`, and `cd apps/cli && npm link` puts `riosoma` on your path.  Its tests run the tool against a real Riosoma server on a port of this machine, so they need
the server built first and a PostgreSQL to make a throwaway database in:

```
pnpm --filter @riosoma/cli test
```

## Credentials

A credential goes into the operating system's keychain where there is one, which is the Keychain on
macOS and a freedesktop keyring on Linux, and otherwise into `~/.config/riosoma/credentials.json`,
written so only the person who wrote it can read it.  `RIOSOMA_CLI_HOME` puts that file somewhere
else, `RIOSOMA_KEYCHAIN=off` asks for the file even where a keychain exists, and `--profile` keeps
more than one server apart.

## Publishing

The package isn't published yet.
