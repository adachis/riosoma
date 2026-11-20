# Adding a database migration

Shipped migrations are permanent.  Add a new numbered migration in `apps/server/src/migrations/`, register it in `MIGRATIONS` in `index.ts`, and record it from the repository root:

```sh
pnpm --filter @riosoma/server exec tsx ../../tools/record-migrations.ts
```

Commit the migration and `apps/server/src/migrations/checksums.json` together.  The record uses the database runner's SHA-256 checksum of the original SQL, before schema placeholders are rendered.  The server tests reject changed or removed recorded migrations and name the command above when a new migration is missing from the record.  The recording command adds new entries and refuses to change or remove existing ones.  Restore a shipped migration if it changed, and put the change in a new migration instead.

Migrations may arrive out of order across releases.  A lower-numbered migration missing from a database runs even if higher-numbered migrations have already run.  When extending `notifications_kind_check`, preserve its current expression and add only missing kinds, as `0133_notification_kinds` does.  Replacing it with a fixed list can discard a kind a newer migration added.  Never update the lists in shipped migrations to match a new list.

The migration upgrade test runs the complete set twice and requires the second run to apply nothing.  Keep that test and the checksum record check in the normal server test suite.
