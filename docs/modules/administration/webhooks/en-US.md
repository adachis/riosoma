---
id: webhooks
title: Checking webhook signatures
summary: Confirm that each webhook call came from Riosoma and arrived unchanged, in JavaScript or Python.
area: administration
order: 2
level: advanced
related: [rest-api, javascript-sdk]
---

Webhooks tell another app when something changes in a database.  To add one, open the database, choose {{ui:webhooks.menu}}, then {{ui:webhooks.title}}, then {{ui:webhooks.add}}.  Adding webhooks takes the {{ui:share.role.creator}} or {{ui:share.role.owner}} role, and tokens can manage them through `/api/v1/databases/db…/webhooks` with {{ui:tokens.scope.schemaWrite}}.

In a database with field or record permissions, a webhook names only the records and fields the person who added it can see.  If a rule limits what you see there, you can change, and replace the secret of, only the webhooks you added.

Riosoma shows the webhook's signing secret only once, when you add it.  Store it with the app that receives the calls.  If you lose it, choose {{ui:webhooks.secret.new}}.  The old secret keeps working for 24 hours, so you can switch the receiver over without missing a call.

## What a call contains

Each call is a `POST` with a JSON body naming up to 100 changes from the last second or so.  It names what changed, never the values, so the receiver reads what it needs through the REST API with its own token.  See {{doc:rest-api}}.

```
{
  "id": "dlv…",
  "webhookId": "whk…",
  "databaseId": "db…",
  "events": [
    {
      "event": "record.updated",
      "databaseId": "db…",
      "tableId": "tbl…",
      "recordId": "rec…",
      "fieldIds": ["fld…"],
      "seq": 1042,
      "at": "2026-10-15T14:30:00.000Z"
    }
  ]
}
```

The events are `record.created`, `record.updated`, `record.deleted`, `field.changed`, and `table.changed`.  `seq` puts changes in order.  `Riosoma-Delivery-Id` matches the body's `id` and stays the same when a call is retried or sent again, so a receiver can skip one it has already handled.

Answer with any 2xx status within 10 seconds.  Riosoma retries timeouts, network errors, 408, 429, and 5xx answers after 5 minutes, then 15 minutes, then 1, 3, 6, 12, and 24 hours.  It doesn't retry other answers.  A webhook whose calls fail for 24 hours without a success turns itself off, and says why in {{ui:webhooks.title}}, where {{ui:webhooks.deliveries.title}} lists the last 7 days of calls.  A webhook that's off holds the calls it hasn't sent, and sends them, oldest first, once it's back on.

## Checking the signature

Every call carries a `Riosoma-Signature` header like `t=1760538600,v1=5f2b…`.  `t` is when Riosoma signed it, in Unix seconds, and each `v1` is an HMAC-SHA256 of the time, a period, and the raw body, keyed with the secret and written in hex.  While a secret is being replaced, the header carries a second `v1` signed with the old one, so accept the call if any `v1` matches.

1. Read the body exactly as it arrived.  Parsing the JSON and writing it out again changes its bytes, and the signature stops matching.
2. Compute the HMAC of `t`, a period, and the body with your secret.
3. Compare it with each `v1` in constant time.
4. Refuse a call whose time is more than five minutes from now, so a copied call can't be replayed later.

In JavaScript with Node.js:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

/** True when the call is signed with the secret and is less than five minutes old. */
export function fromRiosoma(header, rawBody, secret) {
  const parts = header.split(',').map((part) => part.split('='));
  const t = parts.find(([key]) => key === 't')?.[1];
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  return parts.some(
    ([key, value]) =>
      key === 'v1' && value?.length === expected.length && timingSafeEqual(Buffer.from(value), expected),
  );
}
```

With Express, `express.raw({ type: 'application/json' })` keeps the body as it arrived, and `request.get('Riosoma-Signature')` reads the header.

In Python:

```python
import hashlib
import hmac
import time


def from_riosoma(header: str, raw_body: bytes, secret: str) -> bool:
    """True when the call is signed with the secret and is less than five minutes old."""
    parts = [part.split("=", 1) for part in header.split(",") if "=" in part]
    t = next((value for key, value in parts if key == "t"), None)
    if t is None or not t.isdigit() or abs(time.time() - int(t)) > 300:
        return False
    expected = hmac.new(secret.encode(), t.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return any(key == "v1" and hmac.compare_digest(value, expected) for key, value in parts)
```

With Flask, `request.get_data()` returns the body as it arrived, and `request.headers["Riosoma-Signature"]` reads the header.

Riosoma sends calls only to `https` addresses on the public internet.  An operator can let webhooks and automations reach private networks by setting `RIOSOMA_AUTOMATIONS_ALLOW_PRIVATE_HOSTS=true`.
