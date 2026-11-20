---
id: incoming-webhooks
title: Filling a table from an incoming webhook
summary: Give another system an address to post JSON to, and turn each post into records, with signatures, replay checks, and a delivery log.
area: databases
order: 16
level: advanced
related: [synced-tables, feeds, webhooks, field-and-record-permissions, automations]
---

An incoming webhook is a data source that other systems post JSON to.  Each post becomes a record, or updates one, in every table that syncs from the webhook, the moment it arrives.

## Adding a webhook

Data Sources admins add one in {{ui:shell.nav.settings}}: choose {{ui:sources.add}}, then {{ui:sources.kind.webhook}}, name it, and choose {{ui:sources.save}}.  Riosoma then shows the {{ui:sources.webhook.address}} once.  Copy it and give it to the system that sends posts.  The address holds a token that Riosoma keeps only as a fingerprint, so nobody can read it back later, including admins.  If it's lost or leaks, edit the webhook and choose {{ui:sources.webhook.replace}}.  The old address stops working at once.

A few settings decide how posts turn into records:

- **{{ui:sources.webhook.records}}** is a path like `data.items` when posts keep their records inside them.  Leave it empty when the post itself is the record or the list of records.
- **{{ui:sources.webhook.split}}** makes each item of a list its own record.  With it off, the whole post is one record.
- **{{ui:sources.webhook.paused}}** refuses posts with `503` until it's turned off again.  Most senders try again later.
- Under {{ui:sources.advanced}}, **{{ui:sources.webhook.perMinute}}** is how many posts the address takes in a minute, 120 unless you change it.  Past that, posts are refused with `429` and a `Retry-After` header.  Every post counts, including ones refused for being too large, since the address checks the pace before it reads a post.

## Checking signatures

Turn on {{ui:sources.webhook.signed}} and paste the sending system's {{ui:sources.secret.signingSecret}}.  Riosoma then refuses any post whose HMAC-SHA256 signature doesn't match.  Choose the {{ui:sources.webhook.format}} the sender uses:

- **A time and a signature**, the form another Riosoma's webhooks send, and Stripe's too.  The {{ui:sources.webhook.header}}, `Riosoma-Signature` unless the sender names another, holds `t=<Unix seconds>,v1=<hex>`, where `v1` is the HMAC of the time, a period, and the body.
- **The signature alone**, the form GitHub and many others send.  The header holds the HMAC of the body in hex, with or without `sha256=` in front.  When the sender puts the time in a header of its own, name it under {{ui:sources.webhook.timestampHeader}}, and the signature covers the time, a period, and the body.

A post signed longer ago than {{ui:sources.webhook.tolerance}}, 300 seconds unless you change it, is refused, so a post someone copied can't be sent again later.

## Mapping posts to fields

In a database's sidebar, choose {{ui:synced.add.menu}}, then {{ui:synced.add.sync}}, pick the webhook, and choose its posts.  While the field step is open, send a few posts to the address.  The last 10 posts sent while it's open appear as a preview, with a column for each path they hold, like `customer.email`, and Riosoma forgets them once the step closes.  To map a path no post has shown yet, type it under {{ui:synced.wizard.path}}.

Include the paths you want as fields, and pick each field's type.  Under {{ui:synced.wizard.key}}, a key is optional:

- With a key, like an order number, a post whose key matches a record updates that record, and any other post adds one.
- Without one, every post adds records.

Long whole numbers, like 64-bit IDs, keep every digit they were sent with, so two IDs that differ only in their last digit are two keys.

A post can add choices to a single or multiple select field, up to the field's limit of 1,000 choices and 255 characters a name.  A record that names a choice the field can't add isn't written, the post's other records are, and the delivery log says so.

The table has no schedule, since it fills as posts arrive.

## What happens to a post

Riosoma answers each post at once.  A post it takes gets `202` and `{"accepted": 3, "delivery": "dlv…"}`, and is written moments later.  A post it refuses gets a plain code in `{"error": "…"}`:

| Status | Code | Why |
| --- | --- | --- |
| 404 | `not_found` | The address is wrong, or was replaced. |
| 413 | `payload_too_large` | The body is over 1 MB. |
| 413 | `too_many_records` | The post holds more than 1,000 records. |
| 415 | `unsupported_content_type` | The post isn't sent as `application/json`. |
| 401 | `signature_missing`, `signature_invalid`, or `timestamp_expired` | The signature is absent, wrong, or too old. |
| 400 | `invalid_json` | The body isn't JSON. |
| 422 | `records_missing` or `record_not_object` | Nothing is at the records path, or a record isn't an object. |
| 429 | `rate_limited` | Too many posts this minute. |
| 503 | `paused` | The webhook is paused. |

The address checks what it can before reading a post, in this order: the address, a pause, the pace, and the type.  Then it checks the size, the signature, and the JSON.

Each table's records are written through the same path as a person's edits, as the person who made the table, so automations run, each record's history shows the change, and that person's permissions hold.  A post their record rules wouldn't let them add is refused for that table, and the table's bar says so.  Everyone else sees the table through their own permissions, as with any table.

A post Riosoma took is never dropped because the database was busy or briefly out of reach.  It waits and tries again, 30 seconds later at first and longer each time, and later posts wait behind it so they're written in order.  After 10 tries over at least an hour, Riosoma marks it failed, keeps it in the delivery log with the reason, and tells the person who set up the webhook once.  Later posts are written as usual.  Only a refusal that would happen again, like a record the table's person may not add, ends a post for a table.

## The delivery log

Edit the webhook to see its last 100 posts, and any it's still holding, like one that failed: when each came, how Riosoma answered, its size, and what became of it.  The log doesn't keep what posts said.  While you're working out a problem, turn on {{ui:sources.webhook.bodies}}, and the log keeps each post's body for the next hour.  When the hour ends, it stops on its own and forgets the bodies it kept.  Turning it off sooner forgets them too.

## Trying it

Without a signature:

```sh
address='https://riosoma.example.com/api/inbound/<token>'
curl -X POST "$address" \
  -H 'Content-Type: application/json' \
  --data-binary '{"order": "A-1001", "customer": {"email": "ada@example.com"}, "total": 42}'
```

With a signature in Riosoma's form, signing the time, a period, and the exact body that's sent:

```sh
address='https://riosoma.example.com/api/inbound/<token>'
secret='the shared secret'
body='{"order": "A-1001", "total": 42}'
t=$(date +%s)
signature=$(printf '%s.%s' "$t" "$body" | openssl dgst -sha256 -hmac "$secret" -hex | sed 's/^.* //')
curl -X POST "$address" \
  -H 'Content-Type: application/json' \
  -H "Riosoma-Signature: t=$t,v1=$signature" \
  --data-binary "$body"
```

For the signature alone, sign just the body and send it in the sender's header, like `-H "X-Hub-Signature-256: sha256=$signature"`.
