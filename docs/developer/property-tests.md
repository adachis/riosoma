# Command and realtime property tests

The properties live in `apps/web/src/data/commands.property.test.ts`, where the existing
fast-check dependency is available.  They use the built server test fixture, a temporary
PostgreSQL database, the HTTP command bus, and actual realtime WebSocket connections.
The web workspace's task configuration builds the server before tests and type checking.
No external service or production database is needed.

Run just the properties from the repository root:

```sh
pnpm turbo run build --filter=@riosoma/server...
pnpm --filter @riosoma/web exec vitest run src/data/commands.property.test.ts --maxWorkers=1
```

The default is eight cases per property, including the explicit examples.  Undo sequences contain at most 14 commands,
and convergence cases contain at most six rounds of simultaneous writes from two or three clients.
State-dependent commands run only when their targets meet the command's preconditions.
An explicit undo example covers every generated command kind on each run.

Use a larger nightly run without changing dependencies or test code:

```sh
RIOSOMA_PROPERTY_RUNS=1000 pnpm --filter @riosoma/web exec vitest run src/data/commands.property.test.ts --maxWorkers=1
```

`RIOSOMA_PROPERTY_RUNS` must be a positive integer.  The test timeout grows with this setting.
The normal Turbo test task also accepts this setting and includes it in the cache key.
Local PostgreSQL binaries, `RIOSOMA_PG_BIN`, and `RIOSOMA_TEST_DATABASE_URL` work as in the
other database tests.  All fixture databases, sockets, and timers are removed when tests finish.

Undo generates both individual commands and groups of commands.  It checks a snapshot after
each action group, undoes groups in reverse order, and checks
every prior snapshot.  Redo checks every corresponding after snapshot.  Snapshots include
field definitions and values, existing trash, view configurations, exact record positions,
and junction edges with their order on both sides.  Record deletion means the reversible
`record.trash` command; permanent purge is outside the undo contract.

History is append-only.  Undo and redo preserve the original history entries and record
references, append entries with the correct group and reversal markers, and update group
status.  Exact editable-state comparisons exclude updated timestamps, cache versions,
physical conversion-column names, and tombstones retained for creations absent from a prior
snapshot.  Creation metadata, cell values, trash status, view settings, and link order are
compared without normalization.

Convergence tests start real browser data sessions, hold the server's messages while clients
write concurrently, deliver echoes in generated orders with duplicates, and discard held
messages when a client reconnects.  The reconnect subscription replays the missing operations.
After every round, each session's sequence, schema, and cached record values must equal the
server's authoritative state after normal background reads settle, without explicitly
reloading cached records to satisfy the assertion.

fast-check shrinks failing sequences and prints a seed, path, and counterexample.  Replay one
property by copying its reported seed and path and selecting its test name:

```sh
RIOSOMA_PROPERTY_SEED=123 RIOSOMA_PROPERTY_PATH='0:1:2' pnpm --filter @riosoma/web exec vitest run src/data/commands.property.test.ts -t 'restores every prior state' --maxWorkers=1
```

Use `-t 'converges two or three clients'` for a convergence failure.  Do not disable shrinking.
When a failure reveals a product bug, fix the product and translate the smallest counterexample
into an ordinary regression test.  The single field-creation placement regression in
`apps/server/src/data/undo.test.ts` came from the undo property.
Placement reversals record only the field order, preserving collaborators' view names,
column widths, and positions through repeated cycles.  Regressions also cover views locked
or trashed before undo or redo, where the field reverses and the placement is skipped.
