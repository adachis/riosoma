---
id: telemetry
title: Anonymous usage counts
summary: Choose whether the server sends a few anonymous counts each week, and see exactly what they are.
area: administration
order: 8
level: advanced
related: [updates]
routes: [/settings/telemetry, /settings/*/telemetry, /admin/*/telemetry]
anchors: [settings.telemetry]
sections: [settings.telemetry=what-s-sent]
---

Riosoma can send a short list of anonymous counts once a week, so the project learns which parts of it are used.  They're off unless the owner turns them on, and only the owner can.  Setup asks once, after the owner account is made, and the choice is in {{ui:shell.nav.settings}} → {{ui:telemetry.title}} after that.

## What's sent

Only counts and on or off flags:

- The version, or `custom` for a build whose version isn't a release's, and how Riosoma was installed, such as Docker Compose or Kubernetes.
- How many databases and tables hold how many records, in ranges such as 100 to 999.
- Which features are in use, such as automations, single sign-on, or custom domains: on or off, and nothing about how they're set up.
- Roughly how often things happened in the week before, in ranges of 0, 1 to 9, 10 to 99, 100 to 999, and 1,000 or more: changes made in databases, automations run, Rio messages, sign-ins, and a few more.  Ranges rather than exact numbers keep a small server's counts from describing what one person did.
- A random install ID, which tells one week's counts from another server's.  It exists only while counts are on.

Never names, record values, file names, email addresses, network addresses, or anything else that identifies your organization or its people.  The counts are made from what the server already records, so turning them on doesn't make it keep anything new.

{{ui:telemetry.title}} shows {{ui:telemetry.preview}}: the payload exactly as it would go, before you choose.  While counts are off there's no install ID yet, so the one in the preview is an example, and nothing else differs.  Once counts are on, it also shows {{ui:telemetry.lastPayload}}, and when.  The address they go to is shown there too.  Like any request, the counts reach that address from your server's network address, which isn't part of what's sent.

## Turning them on or off

Switch {{ui:telemetry.switch}} on or off.  Turning them on makes a new random install ID.  The first counts go within the hour, and then once a week, each covering the week before, from Monday in UTC.  Turning them off stops the next one, and deletes the install ID and the record of what was last sent, so counts sent after turning them on again carry a new ID.  Each change goes in the audit log, and so does each weekly send.

While counts are on, {{ui:telemetry.resetId}} replaces the install ID with a new random one.  A new ID means later reports can't be linked to earlier ones by their ID, though the counts themselves may still look like earlier weeks', since a server's features and sizes seldom change from one week to the next.

Your server operator can keep counts off whatever the owner chooses, with `RIOSOMA_TELEMETRY=off`.  {{ui:telemetry.title}} then says so, and the switch stays off.

The default receiver is the Riosoma hub at `https://hub.riosoma.com/telemetry`. It stores exactly the payload shown, one row per random install ID and week; a repeat replaces that week's row. It does not store your request IP or headers. Maintainers can read weekly totals by version, install method, and feature behind a secret bearer token. No operating-system field is collected. Your operator can point `RIOSOMA_TELEMETRY_URL` at a different receiver or turn counts off. `RIOSOMA_HUB_URL` controls bug reports separately, and `RIOSOMA_UPDATE_FEED_URL` controls update checks.
