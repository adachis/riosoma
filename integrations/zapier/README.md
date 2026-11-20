# Riosoma for Zapier

This folder is its own pnpm workspace, outside Riosoma's.  Its one dependency, `zapier-platform-core`, is licensed under the Zapier Platform Agreement, which the owner has accepted, and it brings `json-metaschema`, labeled Public Domain.  Only this folder's `pnpm-lock.yaml` lists them, so Riosoma's own install, workspace build, and container image never fetch Zapier code.

## Build and test

Install the repository first with `pnpm install` at its root, since the build and tests reuse its compiler, TypeScript, ESLint, and Vitest.  Then run `pnpm zapier:test` from the root, which installs this folder from its own lockfile and runs its tests.  From this folder, the same steps are `pnpm install` and `pnpm test`.  The test script typechecks, lints, builds `dist/index.cjs`, and runs the platform schema validator and Zapier's `createAppTester` against a local HTTP server.  No Zapier account is needed for these tests.  The separate CLI can run them without an account using `pnpm dlx zapier-platform-cli@19.3.0 test` from this folder.  It is not a repository dependency.

## Connecting

Register a public OAuth app in Riosoma settings.  Use Zapier's exact redirect address for the app, and allow `schema.bases:read`, `schema.bases:write`, `data.records:read`, and `data.records:write`.  Enter the Riosoma address and app ID when connecting.  Zapier supplies the state and S256 PKCE challenge.  Code exchange includes the verifier and binds tokens to `/api/v1`.  Refresh tokens rotate through the platform's OAuth refresh handler.  Addresses require HTTPS, with HTTP on a loopback IP allowed for local tests.

The app exports from `dist/index.cjs`.  Database, table, and view menus use the caller's schema access.  Create and update inputs use stable field IDs, omit computed fields, and accept JSON for structured values such as attachments and linked records.  Updates send only supplied fields.  Empty strings, false, and zero are preserved.  The API remains authoritative for write permissions and value validation.

## Triggers

Triggers subscribe through REST hooks and unsubscribe by the saved database and webhook IDs.  Riosoma signs each delivery in its `Riosoma-Signature` header, which Zapier hands to the app as `Http-Riosoma-Signature`.  The app accepts either name.  The signature covers the exact raw body and must be within five minutes of the current time.  Each event fetches the record through the connected person's current access.  Missing records are omitted.

Every trigger gives an Event ID and a Record ID.  An Updated Record Event ID adds the event sequence, so later updates are not deduplicated as earlier ones.  Map Record ID into later steps such as Update Record, which also accepts an Updated Record Event ID.  Editor samples carry both IDs too.

“New Record in a View” means a newly created record that matches the selected view when the webhook is processed.  It does not track existing records entering a view after an update.  View filters are evaluated by the server.  Delayed delivery may observe a newer record state.

## Actions and searches

Find Records supports exact text, numeric, and checkbox equality and follows cursors up to 1,000 results.  Find or Create writes the searched value on a miss.  It is a read followed by a create, so simultaneous runs can create duplicates unless the table enforces the relevant uniqueness rule.  Mutations are not retried by this app.

Record changes and subscription changes use the existing REST routes, access checks, command bus, audit trail, realtime delivery, and undo behavior.  The same records remain available to the existing record API, MCP, and Rio tools.

The app's labels and messages are Lingui messages in the app's own catalogs, shared with the browser clipper.  Zapier shows them in American English.

Deployment, account registration, live Zap editor checks, and publishing wait for the owner's Zapier account in task 21.  Local schema and execution tests do not establish publication approval.
