---
id: updates
title: Updates
summary: See when a new release is out, read what's in it, and update the server, in one click where the updater runs.
area: administration
order: 7
level: advanced
related: [telemetry, export-and-import]
routes: [/settings/updates, /settings/*/updates, /admin/*/updates]
anchors: [settings.updates]
sections: [settings.updates=where-the-notice-comes-from]
---

Riosoma checks for new releases once a day, and whenever an admin asks.  When one is out, the owner and the organization's admins see {{ui:updates.notice.available}} at the top of every page.  It turns into {{ui:updates.notice.security}} when a newer release fixes a security problem, so update soon when you see it.  Nobody else sees the notice.  Choose it to read the release notes, then {{ui:updates.notice.open}}.

Everything about updates is in {{ui:shell.nav.settings}} → {{ui:updates.title}}: the version this server runs, when it last checked, every newer release with its notes, and how to update.  Choose {{ui:updates.checkNow}} to look right away.

## Where the notice comes from

The server downloads a list of releases, the update feed, and trusts it only when all of these hold:

- It's signed with a key that this release of Riosoma carries.  The feed names the key it was signed with, so the key can change from one release to the next without a gap.
- It was signed within the last 14 days, so an old copy can't hide a newer release.
- It's no older than the last feed the server trusted.

A feed that fails any of these is ignored, and {{ui:updates.title}} says why.  The last feed that passed keeps showing its releases until it's 14 days old.  Checking sends nothing about your server: it downloads the feed and compares versions on the server itself.

This release of Riosoma may not carry a signing key yet.  Until one does, it can't trust any feed, so it shows no notices, and {{ui:updates.title}} says so.  Update by hand in the meantime, as your install guide shows.

Your server operator can turn checks off entirely with `RIOSOMA_UPDATE_CHECKS=off`, for a server with no way out to the internet.

## Updating in one click

With Docker Compose and the updater turned on, the owner updates from {{ui:updates.title}}: choose the update button under {{ui:updates.how}}, then {{ui:updates.confirm.update}}.  The updater then:

1. Checks the signed feed itself, and that the release is the one this server would choose.
2. Checks that the backup service backs up Riosoma's own database.
3. Downloads the new release's image by the exact digest the signed feed names, and checks it's that release.
4. Stops Riosoma, so nothing changes while it backs up.
5. Backs up the database with the backup service.
6. Starts the new version with the same settings, and waits for it to answer that it's running, for up to 10 minutes unless your server operator set a different time.
7. Replaces itself with the new version too.

Riosoma is unavailable for those few minutes, and the page follows along and picks up again when it's back.  If the new version doesn't answer in time, the updater removes it, restores the backup, and starts the version you had, and {{ui:updates.title}} says what went wrong.  If the update stops before the new version starts, nothing needs restoring, and the version you had simply starts again.  A server that fell several releases behind updates to the newest release it can reach first, and then to the next.

If the updater is older than Riosoma, {{ui:updates.title}} says so and shows the steps to update by hand instead of the button, since an older updater may not trust newer feeds.

Only the owner can update.  Admins see the notice and the steps, and that the owner can update.  Every check, update, and rollback goes in the audit log.

## Updating by hand

For Kubernetes, the Helm chart, Azure Container Apps, Amazon ECS, Google Cloud Run, plain Docker, and installs from source, and for Compose without the updater, {{ui:updates.title}} shows the exact commands for your kind of install, filled in with the release.  They name the image by the digest the signed feed gives, so what you pull is exactly the release that was signed, even if someone moved its tag.  Back up the database first.  Each install guide's upgrade section explains the same steps, and how to roll back.

## Turning on the updater

The updater is a small service beside Riosoma in Docker Compose.  Your server operator turns it on with the `updater` and `backup` profiles and a shared token.  See [The updater](../../../install/updater.md).
