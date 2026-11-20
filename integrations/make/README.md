# Riosoma for Make

This folder contains a Make custom app and a deployment script with no package dependencies.  It uses Riosoma's public `/api/v1` API.  No Make account, token, or deployment is needed for local checks.

## Build and test

Install and build the repository first.  From the repository root, run:

```sh
pnpm turbo run build --filter=@riosoma/server... --output-logs=errors-only
pnpm --filter ./integrations/make test
node integrations/make/deploy.mjs --check
```

The tests parse every file, evaluate the app's expressions in a small local harness, check requests against the server's generated OpenAPI document and required scopes, exercise menu output and partial updates, and mock Make's deployment API.  They do not contact Make or run browser tests.  The harness covers this app's expressions and does not replace Make's own runtime or validation.

`app.mjs` defines the app using message keys from `locales/en-US.json`.  Run `node integrations/make/app.mjs` after editing those sources to regenerate the native JSON files.  Runtime functions live in `functions/`.  The checked-in `makecomapp.json`, component directories, and `.iml.json` files use [Make's local development format](https://github.com/integromat/vscode-apps-sdk/blob/master/README-local-development-for-apps.md).  Both the deploy script and tests reject stale generated files.  Labels, help, and errors resolve through the app's American English catalog.  Database, table, view, field, and select-option names come from Riosoma.

Open this folder in Make Apps Editor to inspect the native files.  Its `origins` list is intentionally empty.  After deploying, use the editor's new-origin workflow to pair the app and its components with your account if you want to use its pull and deploy tools.  Keep any account origin settings and `.secrets` files outside version control.  The script uses environment variables and never writes an origin or credential file.

## Connecting

In Riosoma, open Settings, then Personal access tokens.  Create a token for the databases this scenario needs.  Reading menus and records requires `schema.bases:read` and `data.records:read`, labeled Read tables, fields, and views and Read records.  Writing also requires `data.records:write`, labeled Add, change, and delete records.  Instant triggers also require `schema.bases:write`, labeled Change tables, fields, and views, and the Creator or Owner role in the database.

In Make, enter the HTTPS address you open Riosoma at and the token.  The address must have no path, query, fragment, username, or password.  A trailing slash is accepted.  The connection checks `/api/v1/databases` with authentication.  Tokens are password inputs, authorization headers are sanitized in Make logs, redirects are disabled, and webhook secrets returned by Riosoma are sanitized and not retained.

## Triggers

Watch New Records, Watch Updated Records, and Watch New Records in a View register dedicated webhooks through Riosoma's subscription routes.  Removing a webhook unregisters it using its saved database and subscription IDs.  A subscription already removed counts as removed.

Each delivery is split into events in sequence order and filtered by event type, database, and table.  Each event reads the record through the connected person's current access.  Outputs keep Record ID separate from Event ID.  An updated Event ID includes the sequence, and Update a Record accepts either ID.

Watch New Records in a View means a newly created record matching the selected view when the record is read.  Existing records entering the view after an update do not trigger it.  View filters are evaluated by Riosoma.  A delayed delivery can observe a newer state.  A missing record or a record outside the selected view returns no record value from enrichment.  Make documents a single enrichment request with no iteration for instant triggers, so whether its runtime suppresses an undefined output must be confirmed in the owner's scenario before use.

This app cannot verify Riosoma's delivery signature using Make's documented custom-app webhook interface.  [Make documents](https://developers.make.com/custom-apps-documentation/app-components/webhooks) a parsed body and headers without exposing the exact raw request body required by Riosoma's HMAC-SHA256 signature.  Serializing the parsed body does not reproduce those bytes reliably.  The app does not claim signature verification, authenticated delivery, or replay protection.  Treat the dedicated webhook URL as sensitive.  Event filtering and an authenticated record read do not authenticate the sender.  Scenarios that require verified delivery need a receiver that checks the signature before forwarding to Make, which is outside this app.

## Actions and searches

Create a Record, Update a Record, Get a Record, Search Records, and Make an API Call use the connection's token.  There is no delete module.

Database and table selections load nested menus.  Create and update show optional inputs keyed by stable field IDs, with numeric inputs, dates, email addresses, URLs, boolean choices, select choices, and JSON text for structured values.  Computed fields are omitted.  Untouched and null inputs are omitted, and empty strings, false, and zero are preserved.  Use JSON text `null` to clear a structured field.  Update uses PATCH and sends only supplied fields.  Riosoma remains authoritative for write permissions and value validation.

Search Records supports exact text, numeric, and checkbox equality, matching the Zapier app.  It follows response cursors with pages of 100 and stops at 1,000 results.  Repeated cursors fail.  Make's own request count and execution time limits still apply.

Make an API Call accepts a path starting with `/api/v1`, such as `/api/v1/databases`, with separate query parameters and an optional JSON body.  It supports GET, POST, PATCH, PUT, DELETE, HEAD, and OPTIONS, subject to the route's methods and the token's scopes.  It returns body, headers, and status code.  Paths cannot contain encoded characters, query strings, fragments, or relative path segments.  Authorization comes from the connection and cannot be replaced by module inputs.  The universal module does not add pagination or upload support.

Mutations are not retried by this app.  Record and subscription changes use the existing API access checks, command bus, audit trail, realtime delivery, and undo behavior.  Retried webhook deliveries may run a scenario more than once, so downstream writes should account for duplicates.

## Deployment

The owner runs deployment.  This run did not deploy the app or contact a Make account.

Create a Make API token with `sdk-apps:read` and `sdk-apps:write`.  Set `MAKE_API_TOKEN` and `MAKE_ZONE` in the environment, using the account's zone, such as `us2.make.com`.  The supported zones are `us1.make.com`, `us2.make.com`, `eu1.make.com`, and `eu2.make.com`.  Do not put tokens in arguments or files.

Run the offline check first:

```sh
node integrations/make/deploy.mjs --check
```

It needs no environment variables and makes no network requests.  It validates native files and prints the names, major version, and planned status of every app section it would send.  It does not dump request bodies or credentials.

Once the owner is ready, run:

```sh
node integrations/make/deploy.mjs
```

The script finds the account's `riosoma` app at major version 1 or creates it, creates missing components, maps account-assigned connection and webhook names, and replaces every section represented by the local files through [Make's SDK Apps API](https://developers.make.com/api-documentation/api-reference/sdk-apps).  Existing components are found by name, with labels used for account-assigned names.  Ambiguous matches and incompatible component types fail.  It does not remove unrelated components, publish the app, or commit a production app version.  A failed upload can leave a partial draft, and the owner can rerun after fixing the cause.  Status output contains only component names, the major version, and statuses.  API error bodies are never printed because they could echo credentials.

The app uses custom IML functions for field types, partial writes, filter validation, address validation, and event processing.  [Make requires account access to custom IML functions](https://developers.make.com/custom-apps-documentation/app-components/iml-functions), which may need to be enabled by its support team.  Confirm that access before deploying.  If deployment fails, check that access, the account zone, token scopes, and component conflicts in Make's editor.

Account registration, live connection checks, webhook delivery and empty-output behavior, scenario editor checks, version publication, and marketplace approval remain for the owner's Make account.  Polling triggers, deleting records, schema changes, file uploads, and a signature-verifying relay are not included.
