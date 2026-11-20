# @riosoma/sdk

A typed client for the Riosoma REST API, for Node.js 20 or newer and for browsers, with no runtime
dependencies.

The full guide is the [JavaScript SDK](../../docs/modules/administration/javascript-sdk/en-US.md)
help module in the app.  This file is the short version.

## What it does

- Records: list with filters, sorts, and paging, get one, create, update, replace, upsert, and
  delete, in batches of up to a thousand.
- Async iterators that page for you, and stop reading when you stop.
- The schema: read databases, tables, fields, and views by ID or name, and create, update, reorder,
  and trash tables, fields, and views with undo groups.
- Sign-in with a personal access token, or with OAuth and a proof key, including the refresh a
  client does by itself when an access token runs out.
- A wait-and-retry for a 429 that honors `Retry-After`.
- A webhook signature verifier, and the webhooks themselves.
- Types that are the contracts the server validates with, re-exported rather than copied.

The built JavaScript imports nothing at all: `fetch`, `URL`, and Web Crypto are the platform's own,
so one build serves a server and a browser.

```ts
import { RioClient } from '@riosoma/sdk';

const client = new RioClient({ baseUrl: 'https://riosoma.example.com', token: process.env.RIOSOMA_TOKEN });

for await (const record of client.records.iterate('tbl…', { pageSize: 100 })) {
  console.log(record.id, record.fields.Name);
}

const created = await client.records.create('tbl…', [{ fields: { Name: 'Ada Lovelace' } }]);
await client.records.update('tbl…', [{ id: created.ids[0], fields: { Name: 'Ada L.' } }]);
```

## Building it

```
pnpm --filter @riosoma/sdk build
```

Its tests start a real Riosoma server on a port of this machine and talk to it over HTTP, so they
need the server built first and a PostgreSQL to make a throwaway database in:

```
pnpm --filter @riosoma/sdk test
```

## Publishing

The package isn't published yet.  Its types come from `@riosoma/contracts`, which it imports for
types only, so whoever publishes it decides whether to bundle those types or to declare the
package as a dependency.
