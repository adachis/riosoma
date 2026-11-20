---
id: feeds
title: Syncing a table from a feed
summary: Keep a table of a blog's, a podcast's, or a news site's items, from its RSS, Atom, or JSON feed.
area: databases
order: 16
level: standard
related: [synced-tables, incoming-webhooks, fields]
---

A feed source reads an RSS or Atom feed, or a JSON Feed, and each of its items becomes a record in a synced table.  Riosoma reads RSS 2.0, RSS 1.0, Atom 1.0, and JSON Feed 1.1.

## Adding a feed

Data Sources admins add a feed in {{ui:shell.nav.settings}}: choose {{ui:sources.add}}, then {{ui:sources.kind.feed}}, and paste its {{ui:sources.feed.url}}, like `https://example.com/feed.xml`.  A feed that only its subscribers may read can send {{ui:sources.secret.headers}}, such as an `Authorization` header with a token, and they're stored like any other secret.

The address has to be https, and it can't point at a private network, so Riosoma refuses an address like `https://10.0.0.5/feed.xml` before it's saved, and refuses a name that turns out to lead somewhere private when it reads the feed.  {{ui:sources.test}} reads the feed once and says which format it found.

## Syncing its items

In a database's sidebar, choose {{ui:synced.add.menu}}, then {{ui:synced.add.sync}}, and pick the feed.  It offers one thing, its items, and every feed has the same columns:

- **id**, the item's `guid` or `id`.  When an item has neither, its link stands in, and when it has no link either, a fingerprint of what it says does.  The id is the key.
- **title**, as plain text.  Markup in a title, which some feeds put there, is left out.
- **link**, the item's address.  An address written relative to the feed, like `/posts/2`, is made whole.
- **author**, the names of its authors.  A feed's own author stands in for an item without one.
- **published** and **updated**, as dates with times in UTC.
- **summary**, as plain text.
- **content**, as rich text.  Paragraphs, headings, lists, quotes, code, bold, italic, and links come across, and everything else, like scripts, styles, frames, and images, is left out, so nothing in a feed can run in Riosoma.
- **categories**, as a multiple choice field whose choices fill in as new ones appear.
- **enclosure**, the address of its first attachment, like a podcast episode's audio.

Under {{ui:synced.wizard.every}}, a feed syncs {{ui:synced.every.15}}, {{ui:synced.every.60}}, {{ui:synced.every.360}}, or {{ui:synced.every.1440}}, or {{ui:synced.every.manual}}.  Choosing {{ui:synced.every.manual}} pauses it until someone chooses {{ui:synced.syncNow}}.

## What each sync does

Each sync asks the feed only for what changed since the last one, with the `ETag` and `Last-Modified` the feed gave.  When the feed says nothing changed, the sync finishes at once and every record stands.  Changing the feed's address or its request headers makes the next sync read the whole feed again.

An item whose title, content, or anything else changes updates its record.  Feeds list only their newest items, so an item that scrolls out of the feed stays in the table.  To remove records whose items leave the feed instead, turn on {{ui:synced.feed.removeMissing}} when you start the table, or later in {{ui:synced.settings}}.

A feed table is a synced table like any other: people can override values, add their own fields beside the feed's, and see only what their record rules let them.  See {{doc:synced-tables}}.
