# Connector contracts and certification

The shared kit is exported from `@riosoma/connectors`.  Its declarations in
`packages/connectors/src/contract/capabilities.ts` cover all 47 shipped source kinds,
including the server's Airtable and incoming webhook connectors.  A declaration is
the connector's claim, not a successful test result.  Webhooks have discovery and
key contracts but no snapshot read or remote timeout contract.

## Commands and scheduling

Run these commands from the repository root:

| When | Command | Result |
| --- | --- | --- |
| Every push | `node tools/connector_contract.mjs contract` | Runs connector protocol fixtures, shared assertions, and server-owned connector fixtures, and fails with the missing connector/operation pairs if coverage is incomplete. |
| Nightly, or weekly for expensive accounts | `node tools/connector_contract.mjs contract:live` | Runs existing configured fleet/account suites with shared assertions, then strict live contracts, and writes successful certifications. |
| Nightly, after downloading retained certifications | `node tools/connector_contract.mjs certification:check` | Fails with every missing, invalid, expired, future-dated, version-mismatched, or incomplete certificate. |

The runner builds its workspace prerequisites.  It uses the existing dependencies
and changes no manifests.  Package script aliases were intentionally omitted
because this unit prohibits editing `package.json`.  The three command names can
be used as CI job names.  Workflow files are left to the workflow owner.

Every shipped connector runs the complete strict contract against its actual public
adapter and native protocol or driver fixtures.  The coverage gate requires a
successful `ContractResult` with every declared capability, including query refusal,
filter and sort pushdown, secret sanitization, and timeout evidence.  Observations
alone cannot pass the gate.  Paging requires a completed stream with multiple
batches and exact expected rows.  The existing syntax-specific scenarios remain
part of the run.  Fixture results cannot refresh live certificates.

The fixture command has a PostgreSQL-independent connector project and a server
project that uses `startTestPostgres` from `@riosoma/testkit`.  To run the former
alone when PostgreSQL is unavailable:

```sh
pnpm --filter @riosoma/connectors exec vitest run --config contract.config.ts --maxWorkers=3
pnpm --filter @riosoma/connector-drivers exec vitest run --config contract.config.ts --maxWorkers=3
```

The second runs the connectors the connector service hosts, whose fixtures live in
`packages/connector-drivers`, under the same contract setup, and the runner covers
both packages in its fixture and live modes.  Each warehouse's driver fixture is in a
`*.fixture.test-support.ts` file beside its tests, so the connector service's own
contract test (`apps/connector-service/src/contract.test.ts`) runs the same fixtures
through the server's connector and the real service.  `relationalFixture` in the kit
does the same for the SQL dialects, with a `through` option that runs its connector
elsewhere.

The regular workspace tests keep their existing configuration and live/fleet
tests.  Nothing in the fixture project's selection changes the regular verify
command.

## Writing a contract adapter

`runConnectorContract` accepts a `ConnectorContract`:

- A real connector, its connection context, and the object selected for testing.
- Expected native column suggestions, including options, and declared key candidates.
- A read projection, its key columns and batch size, and every expected row.  Seed
  more rows than one batch.  Row order is ignored for snapshot equality.  An ordered
  sort probe checks ordering separately.
- Filter and sort probes for declared pushdown capabilities.  Each probe returns
  its rows and the requests actually received by the fixture, captured at the
  driver's boundary, or read from the service's query history.  Specify both the
  exact expected rows and fragments required in those requests.  Returning a copy
  of the input request is insufficient evidence.
- A deliberate service failure, a slow operation honoring `context.timeoutMs`,
  and a cleanup probe confirming that the cursor, session, or transport stopped.
- A two-operation input for a native query syntax when the SQL/GraphQL default
  does not apply, and captured logs if the connector uses a logger besides console.

Every adapter supplies `executions()`, which reads actual driver or transport
execution evidence.  The kit checks that forbidden inputs add no execution after
each describe, preview, and read call.  An error after execution fails the contract.

The kit refuses SQL pairs through describe, preview, and read, and requires
connectors without queries to refuse the same inputs.  GraphQL and other native
syntaxes must also exercise the guard on the settings/query path they use.  The
protocol suites include those native guard scenarios.

The timeout probe receives a ten-millisecond budget.  It must produce a typed timeout
error and finish within that budget plus 100 milliseconds of scheduling tolerance.
A separate two-second watchdog detects an operation that never settles.  Delayed
unrelated failures and immediate errors both fail the timeout contract.
Console logging is captured during a strict run, so run adapters sequentially.
Use distinctive credential sentinels in fixture failures.  The leak check covers
error messages, nonenumerable fields, causes, parameters, URL encoding, base64,
and supplied logger output.  Contract failure diagnostics contain check identifiers
instead of service responses or credentials.

`exerciseFixture` supplements existing fixtures with discovery, description,
key reporting, and a bounded read of a known row count.  `observeConnector` applies
the invariants to protocol tests without changing their expected values.  Since
some diagnostic fixtures intentionally choose nonunique candidate keys, the
observer checks key encoding and arity, while controlled fixture and live runs
also check uniqueness across pages.

## Live accounts and fleet adapters

The live command runs all existing connector account suites, the relational fleet
and pooled-read suites, and the server's Airtable, spreadsheet, Microsoft, MongoDB,
and object-storage account suites.  They retain their existing setting names and
run when those settings are present.  A suite failure makes the command fail while
the remaining suites and strict adapters still run.  Ordinary account-suite
results cannot replace a strict adapter's certification evidence.

The built-in SQL adapter uses `startTestPostgres`, creates a temporary database,
and tests the real PostgreSQL connector.  Local live clusters use a distinct
password with SCRAM authentication, so diagnostic keys and test-file paths cannot
be mistaken for a leaked placeholder password.  It also recognizes the existing fleet
settings `RIOSOMA_TEST_MYSQL_URL`, `RIOSOMA_TEST_MSSQL_URL`,
`RIOSOMA_TEST_ORACLE_URL`, and `RIOSOMA_TEST_FIREBIRD_URL`.  Those accounts need
permission to create and drop a temporary table.  The SQL adapters capture actual
driver statements and release their tables, clients, and test databases afterward.

The default runner also provides adapters for the other 42 kinds.  Native SDK,
HTTP, file transport, document, search, graph, spreadsheet, and installed-driver
adapters use the existing production factories and record requests at their actual
transport boundaries.  The webhook adapter starts an isolated server, creates its
source through the authorized API, and posts samples through the inbound route.
Preparation, contract, connection test, certificate write, and cleanup run
independently for each connector.  A failing account suite blocks only its own
connector's certificate and still makes the overall command fail.

Existing account settings remain supported.  They include the warehouse and
MongoDB `RIOSOMA_TEST_*` settings, installed-driver `RIOSOMA_<KIND>_*` settings,
MinIO settings, Sheets service account settings, the Airtable token and base, and
the Microsoft app and site or environment settings.  Their mapping is in
`tools/connector_live_settings.mjs`.  For a service without an existing account
suite, supply `RIOSOMA_TEST_<KIND>_SETTINGS`, with hyphens replaced by underscores
and the kind capitalized.  Its JSON contains the existing `connection` and
`secrets` contracts, an optional `object` and `keyColumns`, and `allowedRoots` for
local DuckDB files.  Excel accounts that provide only an app and site discover
workbooks in the site's default drive.  A configured account must provide readable
sample data, just as its existing account suite does.  Use a stable test object with 2 through 1000 rows.  Preview
and snapshot are executed separately and must agree.  Select an object explicitly
when an account contains larger production datasets.

An optional `RIOSOMA_CONTRACT_LIVE_MODULE` may replace the default adapters.  It
exports `contracts`, either an array or an async function returning adapters.
Service versions come from native connection tests, version endpoints, transport
banners, response headers, or a versioned service API verified in captured requests.
Services with no engine release endpoint report the tested API version.  Missing
version evidence fails certification.

Each adapter can supply `prepare()`, `cleanup()`, and `serverVersion()`.  A version
probe must return observed service or API version evidence.  It cannot use an
unverified environment label.

The live runner reports unconfigured kinds explicitly and continues after an
individual contract failure.  A failed adapter never replaces an existing
certificate.  An unavailable live account does not become certified by its
fixture test.  The nightly freshness check still requires every shipped kind,
including kinds whose settings were absent from the most recent live run.

## Certification artifacts

By default, live results go to
`packages/connectors/certifications/<connector>/certification.json`.  Set
`RIOSOMA_CERTIFICATION_DIR` to a retained artifact directory in CI.  Download
that directory before the nightly freshness check.  Upload successful live
results afterward, including when a different adapter failed.  A weekly live
schedule needs the same artifact retention as a nightly schedule.

Each file contains `connector`, the connector package `version`, an ISO UTC
`date`, `serverVersionTested`, and the exact `capabilitiesPassed` set.  The writer
requires a successful live connection test and all declared capabilities, writes
a temporary file, and atomically replaces the certificate.  A certificate expires
at exactly 30 days, and a new connector package version requires a new certificate.
Do not manufacture certificates for unconfigured services or replace the version
with an environment-provided label.  Missing certifications intentionally make
the nightly check fail until those live contracts have passed.
