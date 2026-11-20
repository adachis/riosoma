---
id: notifications
title: Keeping up with notifications
summary: Choose the bell, email, push, digests, admin SMS, Slack, and Teams for notifications.
area: account
order: 2
level: simple
related: [comments-and-history, automations, synced-tables]
anchors: [notifications.open, notifications.list, notifications.read, shell.settings, settings.notifications]
demo: notifications
routes: [/settings/notifications, /settings/*/notifications, /admin/*/notifications]
sections: [settings.notifications=what-you-hear-about]
---

Riosoma lets you know when something needs you.  The bell at the top of every page, {{ui:notifications.title}}, shows how many notifications you haven't read yet, up to 9 and then "{{ui:notifications.bell.many}}".  Choose it to see them, newest first, under {{ui:notifications.today}} and {{ui:notifications.earlier}}.  More load as you scroll.

## What you hear about

- Someone mentions you in a comment on a record you can see.  The notification quotes the start of the comment.
- Someone shares a database with you.  It says which role they gave you.  Sharing a database with everyone in the organization doesn't notify each person.
- An automation that acts as you turns itself off, usually because you can no longer make the changes it makes.  {{doc:automations}} explains why that happens.
- A run of an automation that acts as you fails.  You hear about each automation at most once an hour, so one that keeps failing doesn't flood you.
- A synced table you made stops syncing.  You hear once when it starts failing, not for every try.
- A synced table you made is waiting for someone to confirm a sync that would remove more records than usual.

## Reading them

Select a notification to go straight to what it's about: the record with the comment, the database, the automation, or the synced table.  That also marks it read.  To open it in a new tab instead, hold Cmd (Ctrl on Windows and Linux) as you select it.  Unread notifications have a dot, and {{ui:notifications.markAllRead}} marks them all read at once.

Each notification keeps the names things had when it was sent, so it still makes sense after something is renamed.  Notifications are kept for 90 days.  When you have none, the list says "{{ui:notifications.empty.title}}".

## Choosing channels

Go to {{ui:shell.nav.settings}}, then {{ui:notifications.settings.title}}.  The {{ui:notifications.settings.channels}} grid has one row per kind and one column per channel.  Each choice saves immediately.  The bell starts on for every kind.  Push, digests, SMS, Slack, and Teams start off.  Email starts with these choices:

| Switch | Starts |
|---|---|
| {{ui:notifications.settings.mention}} | On |
| {{ui:notifications.settings.share}} | On |
| {{ui:notifications.settings.automationStopped}} | On |
| {{ui:notifications.settings.automationFailed}} | Off |
| {{ui:notifications.settings.calendarEventKept}} | On |
| {{ui:notifications.settings.syncFailed}} | Off |
| {{ui:notifications.settings.syncHeld}} | On |

The ones that start on are the ones you usually have to act on.  Each switch saves as soon as you flip it, and your choices are yours alone.

Email needs the server to be set up to send it.  Until an administrator does that, the page says so, and your choices take effect once it's ready.


## Push on each device

Open [your device settings](/settings/notifications#devices) and choose {{ui:notifications.push.subscribe}}.  Your browser asks for notification permission.  Subscribe separately on each device.  Use {{ui:notifications.push.unsubscribe}} to remove one device without changing the others.  A supported browser, an active service worker, and an HTTPS installation are required.  On phones that require it, install Riosoma on the home screen first.

Push contains only a short, localized title, a summary of the notification kind, and a link.  It never contains record contents, comment excerpts, or names from records.  Selecting a push opens its link in Riosoma.  Expired subscriptions are removed automatically.  Delivery credentials are encrypted, and one VAPID key pair is kept for the installation.

## Daily and weekly digests

Open [your digest schedule](/settings/notifications#digest).  Choose {{ui:notifications.digest.off}}, {{ui:notifications.digest.daily}}, or {{ui:notifications.digest.weekly}}, then set {{ui:notifications.digest.hour}} and {{ui:notifications.digest.timeZone}}.  Weekly digests arrive on Monday.  A skipped daylight-saving hour is delivered at the next available hour that day.  A repeated hour does not send a second digest.

Select the {{ui:notifications.channel.digest}} column for each kind to include.  While the schedule is on, these kinds skip instant email.  Each digest groups notifications that are still unread and were created since the previous digest.  It links to the items without copying record contents.  An empty digest sends no email.  Turning the schedule off restores the normal email choices.

## Direct messages

Choose {{ui:notifications.channel.slack}} or {{ui:notifications.channel.teams}} in [the channel grid](/settings/notifications#channels).  An Integrations administrator connects the organization first.  Your Riosoma account email must match the account that receives your direct messages.  Messages contain a short summary and a link, and delivery checks your current access again.

Slack uses a bot with `users:read.email`, `im:write`, and `chat:write` scopes.  Teams uses the organization's Graph app and a delegated connection with `User.Read`, `User.ReadBasic.All`, `Chat.Create`, `ChatMessage.Send`, and `offline_access`.  A client-credentials token alone cannot send these Teams chat messages.  Messages come from the delegated account.

## Admin SMS

Open [your admin phone settings](/settings/notifications#phone), enter a number with its country code, and choose {{ui:notifications.phone.send}}.  Enter the code and choose {{ui:notifications.phone.verify}}.  Codes expire after 10 minutes, allow five attempts, and can be requested at most three times per hour, at least a minute apart.  Verification cannot be restored by undo.

SMS delivers only security alerts, failed backups, an unreachable notification vault, an unavailable credential store, and failed updates to verified organization administrators.  Twilio sends at most three alert attempts per person per hour across all delivery workers.  Verification texts are counted separately.  Removing the phone or losing the admin role stops SMS.

## Organization controls

Integrations administrators can open [organization channels](/settings/notifications#organization) and turn any channel off for everyone.  Personal preferences are kept.  {{ui:notifications.connection.title}} stores encrypted Slack, Teams, and Twilio credentials.  {{ui:notifications.connection.disconnect}} removes a connection.  Changes are audited, and {{ui:notifications.undo}} restores an unchanged setting when available.  Undo cannot restore a phone verification challenge or replace the installation's permanent push identity.

When the credential vault that holds those connections cannot be reached, the owner and Integrations administrators hear about it through {{ui:notifications.settings.vaultUnavailable}}, at most once an hour while it lasts.  Other administrators don't, since only the owner and Integrations administrators can open this section.  That notification opens this section, so the connections can be checked or replaced.  Slack, Teams, and text messages for that time weren't sent, and each notification stays in the bell.

These choices are available through `/api/notifications/channels` and the validated commands at `/api/notifications/commands`.  An unread notification stays in Riosoma even when an outside delivery fails.  Failed or uncertain sends are not automatically repeated, which avoids duplicate messages.
