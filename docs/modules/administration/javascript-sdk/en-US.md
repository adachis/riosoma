---
id: javascript-sdk
title: Using the JavaScript SDK
summary: Install the SDK, sign in with a token or with OAuth, read and write records, and check webhook signatures.
area: administration
order: 3
level: advanced
related: [rest-api, command-line-tool, oauth-development, webhooks, airtable-api]
---

`@riosoma/sdk` is a typed client for the REST API.  It runs in Node.js 20 or newer and in browsers, it brings no runtime dependency of its own, and its types are the contracts the server validates with rather than copies of them, so a change to the API shows up as a compile error instead of a wrong answer at runtime.  Every call it makes is a call to `/api/v1`, which means permissions, audit events, undo, and the updates the app shows anyone watching a table all apply exactly as they do to a change made in the interface.

The command line tool is built on this package.  See {{doc:command-line-tool}}.

## Installing

Until the package is published to npm, it comes from a checkout of the repository, where it's a workspace package:

```
pnpm install
pnpm --filter @riosoma/sdk build
```

An app in the same workspace then depends on it as `"@riosoma/sdk": "workspace:*"`.  Once it's published, an install is one line:

```
npm install @riosoma/sdk
```

Its types come with it, so there's no `@types` package to add, and it imports nothing at runtime, so a browser bundle carries only what a bundle uses.  A browser reaches the API on its own origin, or through a proxy of your own, since the API sends no cross-origin headers.

## Signing in

Everything starts with a client, which holds one credential for one server:

```ts
import { RioClient } from '@riosoma/sdk';

const client = new RioClient({
  baseUrl: 'https://riosoma.example.com',
  token: process.env.RIOSOMA_TOKEN,
});
```

A personal access token is the simplest credential.  Make one under {{ui:shell.nav.settings}}, then {{ui:settings.nav.tokens}}, then {{ui:tokens.create}}, and choose the {{ui:tokens.scopes}} it needs: {{ui:tokens.scope.schemaRead}} to list databases and tables, {{ui:tokens.scope.recordsRead}} to read records, and {{ui:tokens.scope.recordsWrite}} to change them.  The token is shown once, so store it where a secret belongs and read it from the environment rather than from your source.  See {{doc:rest-api}}.

### OAuth with PKCE

A browser, or a script that shouldn't hold a long-lived secret, signs in with OAuth instead.  An owner registers the app first, under {{ui:oauth.apps}}, as a public app with a redirect address of its own.  See {{doc:oauth-development}}.  The SDK does the rest of the flow, and every step is a function you can call on its own:

```ts
import {
  apiResource,
  authorizationCallback,
  authorizationServerMetadata,
  authorizationUrl,
  createPkceChallenge,
  exchangeAuthorizationCode,
} from '@riosoma/sdk';

const metadata = await authorizationServerMetadata('https://riosoma.example.com');
const pkce = await createPkceChallenge();
const address = authorizationUrl({
  baseUrl: metadata.issuer,
  clientId: 'the app’s client ID',
  redirectUri: 'http://127.0.0.1/callback',
  scopes: ['schema.bases:read', 'data.records:read', 'data.records:write'],
  state: pkce.state,
  challenge: pkce.challenge,
  resource: apiResource(metadata.issuer),
});
// Send the person to `address`, then read the redirect when it comes back.
const callback = authorizationCallback(window.location.href);
if (callback.state !== pkce.state) throw new Error('the redirect came from somewhere else');
const tokens = await exchangeAuthorizationCode({
  baseUrl: metadata.issuer,
  tokenEndpoint: metadata.token_endpoint,
  clientId: 'the app’s client ID',
  code: callback.code!,
  codeVerifier: pkce.verifier,
  redirectUri: 'http://127.0.0.1/callback',
});
```

A client built with those tokens replaces an access token that runs out, as long as it also has the refresh token and the client ID, and it hands the fresh tokens back so they can be stored:

```ts
const client = new RioClient({
  baseUrl: 'https://riosoma.example.com',
  accessToken: tokens.access_token,
  refreshToken: tokens.refresh_token,
  clientId: 'the app’s client ID',
  expiresIn: tokens.expires_in,
  onTokens: async (fresh) => store(fresh),
});
```

`revokeToken` ends the installation when someone signs out, and the app's own {{ui:oauth.connectedApps}} list shows what's still connected.

## Reading records

A read returns a page, and the page says how to ask for the next one:

```ts
const page = await client.records.list('tbl…', {
  view: 'Open work',
  filter: {
    conjunction: 'and',
    conditions: [{ id: 'c1', fieldId: 'fld…', operator: 'is', value: 'Open' }],
  },
  sort: [{ fieldId: 'fld…', direction: 'desc' }],
  fields: ['Name', 'Amount'],
  pageSize: 50,
});
for (const record of page.records) console.log(record.id, record.fields);
```

Filters and sorts name fields by ID, which is what keeps them working when a field is renamed.  A filter condition carries a short `id` of its own, which is a key for editing rather than anything the server keeps.  Values are the outside-friendly forms the REST API documents: select options by name, people as `{ id, email, name }`, files as `{ id, url, filename, size, type, thumbnails }`, links as record IDs, and dates as `YYYY-MM-DD` or as instants.

### Paging

`iterate` walks every record a read reaches, and asks for a page only when the one before it ran out, so stopping early stops reading:

```ts
for await (const record of client.records.iterate('tbl…', { pageSize: 100 })) {
  if (record.fields.Status === 'Done') continue;
  await act(record);
}
```

`pages` gives whole pages instead, with the `next` cursor each one carried, for a caller that wants to checkpoint its own place in a long read.  A cursor holds the moment the first page was read, so every page of one read sees the same records, and a cursor from a different read is refused.

One record by ID:

```ts
const record = await client.records.get('tbl…', 'rec…');
```

Values come back as data by default.  `cellFormat: 'string'` asks for the text the app would show, formatted for the `locale` and `timeZone` you name, and `fieldKey: 'id'` keys each record's fields by ID rather than by name.

## Writing records

A write goes through the same command bus the app uses, so it's validated, authorized, audited, broadcast to anyone watching, and undoable:

```ts
const created = await client.records.create('tbl…', [
  { fields: { Name: 'Ada Lovelace', Amount: 10, Status: 'Open' } },
]);
const updated = await client.records.update('tbl…', [
  { id: created.ids[0], fields: { Amount: 12 } },
]);
const replaced = await client.records.replace('tbl…', [{ id: 'rec…', fields: { Name: 'Only this' } }]);
const trashed = await client.records.delete('tbl…', ['rec…']);
```

One request carries up to a thousand records.  `update` changes the fields a record names and leaves the rest alone, while `replace` writes a record whole and clears the editable fields it leaves out.  `delete` moves records to the trash, where they stay restorable.  With `typecast`, a value sent as text is read as the field's own type, and a select option nobody made yet is made.  Every write returns the records as they now stand and the `undoGroupId` that takes the whole write back.

### Upserting

An upsert changes the record each one matches and makes a record for each one that matches nothing:

```ts
const merged = await client.records.upsert(
  'tbl…',
  [{ fields: { Email: 'ada@example.com', Amount: 12 } }],
  { databaseId: 'db…', keys: ['Email'] },
);
console.log(merged.created, merged.updated, merged.undoGroupIds);
```

Matching happens on the server, so an upsert follows the same rules as the app's own, and it can't race with another writer the way a read followed by a write from a client can.  It goes through the Airtable-compatible route, which is the one that merges on field values, and that route takes ten records at a time, so a larger upsert is several requests with an undo group each.  One to three keys may be merged on, and only fields whose values compare the way they read: text, long text, email, address, phone, the numeric types, which are number, currency, percent, duration, and rating, dates, a single choice, and a checkbox.

## Reading the schema

```ts
const databases = await client.databases.list();
const tables = await client.tables.list('db…');
const fields = await client.fields.list('db…', 'People');
const views = await client.views.list('tbl…');
```

A table, a field, and a view may all be named by ID or by name, so a script can say `People` rather than look an ID up first.  `client.tables.get` returns one table with its fields and views, which is where the IDs a filter needs come from.  `client.openapi()` reads the API's own document, and `client.request(method, path, options)` reaches any route this client has no method for.

## Changing the schema

Choose {{ui:tokens.scope.schemaWrite}} on the token and hold the {{ui:share.role.creator}} or {{ui:share.role.owner}} role in the database.  `client.tables`, `client.fields`, and `client.views` each offer `create`, `update`, and `trash`, covering every REST schema write.  These methods take IDs and the REST request body, typed by the shared `SchemaTableCreate/Update`, `SchemaFieldCreate/Update`, and `SchemaViewCreate/Update` contracts.

```ts
const created = await client.tables.create(databaseId, {
  name: tableName,
  fields: [{ name: primaryFieldName, type: 'text' }],
});
if (created.table) {
  await client.tables.update(created.table.id, { name: renamedTableName, index: 0 });
  await client.fields.create(created.table.id, fieldInput);
  const view = await client.views.create(created.table.id, { name: viewName });
  if (view.view) {
    await client.views.update(view.view.id, { index: 0, fieldOrder: fieldIds });
    await client.views.trash(view.view.id);
  }
  await client.tables.trash(created.table.id);
}
```

Create and update results contain `table`, `field`, or `view`, and each write returns `undoGroupId` for undo in the app.  Trash results contain the item’s `id`.  Reorder fields through `client.views.update` with `fieldOrder`.  A field’s type and options change through `client.fields.update`.  A link field’s target table cannot change.  See {{doc:rest-api}} for validation, select choices, and trash rules.

## Rate limits and failures

A 429 is waited out, for as long as the answer's `Retry-After` asks, up to four further tries.  A wait longer than a minute is handed back as a failure instead, since a caller that can't wait that long should decide for itself:

```ts
const client = new RioClient({ baseUrl, token, retries: 2, maxRetryDelayMs: 10_000 });
```

A failure arrives as one of two errors.  `RioApiError` is an answer from the server, with its `status`, its `code`, the `messageKey` an interface translates, the plain English `message`, and the `fields` and `issues` that say which cell was refused.  `RioClientError` is anything else: options that can't work together, a server that couldn't be reached, an answer nothing can read, or a caller that gave up.  Neither carries a credential, and a secret the server echoed back is taken out of the text before it becomes an error.

```ts
import { RioApiError } from '@riosoma/sdk';

try {
  await client.records.create('tbl…', [{ fields: { Status: 'Not a status' } }]);
} catch (error) {
  if (error instanceof RioApiError && error.code === 'validation_failed')
    for (const issue of error.issues ?? []) console.error(issue.recordId, issue.fieldId, issue.messageKey);
}
```

A call takes an `AbortSignal`, and a client may carry one for every call it makes, which is how a long import stops when someone asks it to.

## Checking a webhook

`verifyWebhookSignature` checks that a call really came from Riosoma, and refuses one signed more than five minutes ago so a copied call can't be replayed:

```js
import { readWebhookPayload, WEBHOOK_DELIVERY_HEADER, WEBHOOK_SIGNATURE_HEADER } from '@riosoma/sdk';

app.post('/hook', express.raw({ type: 'application/json' }), async (request, response) => {
  const payload = await readWebhookPayload({
    // The body exactly as it arrived, since one changed byte stops the signature matching.
    payload: request.body,
    signature: request.get(WEBHOOK_SIGNATURE_HEADER),
    secret: process.env.RIOSOMA_WEBHOOK_SECRET,
    deliveryId: request.get(WEBHOOK_DELIVERY_HEADER),
  });
  for (const event of payload.events) console.log(event.event, event.tableId, event.recordId);
  response.sendStatus(204);
});
```

`readWebhookPayload` throws when a call isn't genuine, and `verifyWebhookSignature` returns why instead, as `missing`, `malformed`, `stale`, or `unsigned`.  While a secret is being replaced the header carries two signatures, and either one is accepted.  See {{doc:webhooks}}.

## Webhooks themselves

The webhooks that follow a database's changes are reachable too, with a token that holds the schema-write scope:

```ts
const webhook = await client.webhooks.create('db…', {
  url: 'https://example.com/hook',
  events: ['record.created', 'record.updated'],
});
// The secret is shown once, so store it now.
await store(webhook.secret);
for await (const delivery of client.webhooks.iterateDeliveries('db…', webhook.id))
  console.log(delivery.state, delivery.eventCount);
```

## Request and signature boundaries

Pass a relative route to `client.request`, such as `/api/v1/databases`.  The configured base path stays in front of the route.  Absolute addresses, alternate authorities, backslashes, fragments, and parent-directory traversal are rejected before a credential is sent.  API requests and OAuth token posts reject redirects, so configure the final server address.

Concurrent calls on one client share an OAuth refresh.  A late authentication refusal retries with the refreshed credential.  Refresh attempts do not consume the retries configured for rate limits.

Pass the original request body bytes to `verifyWebhookSignature` or `readWebhookPayload`.  Verification includes every byte, including a byte order mark, before decoding the payload.  Do not decode and re-encode a body before verification.
