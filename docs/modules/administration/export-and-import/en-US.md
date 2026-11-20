---
id: export-and-import
title: Export and import an organization
summary: Keep an offline organization archive or move your organization to another server.
area: administration
order: 8
level: advanced
related: []
routes: [/settings/export-and-import, /settings/*/export-and-import, /admin/*/export-and-import]
anchors: [settings.export.and.import]
sections: [settings.export.and.import=export]
---

Only the organization owner can open {{ui:organizationArchive.title}} in settings.  An export includes every database, including databases in the trash, along with records, field settings, views, permissions, folders, groups, people, templates, and organization settings.  Theme selections come with those settings.

The archive also carries {{ui:bookings.title}}, AI field prompts and triggers, {{ui:sql.title}} access settings, incoming-source mappings, and the apps administrators registered under {{ui:oauth.apps}} that haven't been revoked.  SQL settings include allowed roles, time limits, and row limits.  SQL logins, passwords, and server roles do not travel.  Incoming sources keep their settings, but their addresses and queued posts do not travel.

Knowledge libraries for the organization, units, and databases travel with their extracted document text and organization guidance.  Approve each library before its documents under {{ui:organizationArchive.reviewTitle}} to rebuild embeddings with the destination’s settings.  Personal libraries, personal documents, personal guidance, and private notes stay in their original organization.  Choose {{ui:organizationArchive.dismissKnowledge}} to permanently erase unwanted pending knowledge, including a library’s pending documents when dismissing that library.

## Export

Choose {{ui:organizationArchive.files}} to include attachment contents.  Turn it off to keep only file metadata.  Choose {{ui:organizationArchive.audit}} if the archive should include the audit log.

Credentials are left out unless you enter an {{ui:organizationArchive.exportPassphrase}} of at least 12 characters.  With a passphrase the archive also carries an HMAC over its manifest, so the importing server can prove it's unchanged since export.  Keep the passphrase separately from the archive.  The server never stores it.  Passwords, passkeys, sessions, people's access tokens, sign-in provider secrets, AI provider keys, and the server's own mail settings are never exported.

OAuth client secrets, grants, consent records, authorization codes, tokens, connected cloud drive accounts, and SCIM tokens never travel, even with a passphrase.  Automatically registered OAuth clients and webhooks owned by OAuth grants stay behind.  Domain verification, {{ui:customDomains.title}}, and directory provisioning must be set up again on the new server.

Private calendar subscriptions stay behind, since each person's subscription address is private to them.  After joining, each person makes a new one with {{ui:calendarFeeds.menu}}.  The organization's {{ui:calendarFeeds.policy.enabled}} setting travels, and comes in off.

Historical snapshots, change and undo history, older automation versions, automation test runs, run and delivery history, cached results, unfinished uploads, and background jobs stay behind.  Each person's report schedules, notification choices, favorites, conversations, and feedback history stay behind too.  Recreate report schedules and their recipients after the people who own them have joined.

Sent signature requests do not travel.  Neither do their field placements, their delivery history, or anything about their signers, such as names, email addresses, IP addresses, and browsers.  Placements belong to individual sent requests—there is no separate reusable signature template to restore.  With {{ui:organizationArchive.audit}}, the audit log keeps each signer's steps but leaves out their IP address and browser.  Signed documents already attached to records follow {{ui:organizationArchive.files}}, like other attachments, and each one's certificate still lists its signers' names, email addresses, IP addresses, and browsers, since it's part of the document.

Anything that could hold a credential under another name is treated as one: every web address in an automation step, a data source's settings, or a webhook, every header value an automation step sends, and every value in a JSON body whose name says it's a key, token, signature, or password.  With a passphrase they travel encrypted.  Without one they're left out, apart from each address's scheme and host, which the review shows, and each needs entering again before it's turned on.

Choose {{ui:organizationArchive.startExport}}.  You can leave the page while the export runs, then return to {{ui:organizationArchive.download}}.  Downloads remain available for seven days.  {{ui:organizationArchive.delete}} removes a completed archive sooner.

## Import

The destination must be an empty organization with only its importing owner.  During setup, create your owner account and choose {{ui:organizationArchive.setupImport}}.  On an existing empty organization, open {{ui:organizationArchive.title}}.

Select the archive under {{ui:organizationArchive.choose}}.  The server checks the manifest, every entry name, every byte count, and every SHA-256 hash, and reads every line, template, and setting it would restore, before showing a preview.  The preview lists counts, the people it found and how each will be invited, and everything that reaches outside the organization, with where each one sends or takes data.

Hashes catch damage, not deliberate changes.  An archive without a passphrase can't be checked, and the preview says so: import it only if you trust where it came from.  For an archive with a passphrase, enter it under {{ui:organizationArchive.importPassphrase}} and choose {{ui:organizationArchive.verify}}.  The preview says the archive is unchanged only once the passphrase proves it.  A wrong passphrase, or an archive changed since export, imports nothing.  To bring in the data without the passphrase, leave the field empty: it imports unauthenticated, and without credentials of any kind, even ones written into the archive in the clear.  An archive exported without a passphrase isn't signed, so a passphrase entered for it is refused: leave the field empty to import it unchecked.  Choose {{ui:organizationArchive.confirm}} after reviewing the preview.

Every database receives new identifiers.  References in fields, formulas, lookups, views, permissions, and other settings follow those identifiers.  Text and web addresses keep every character, so an identifier from another service in an address, or a name in an email, comes back as it was.  So do a script's contents: a script that names a table or field by its identifier needs the new one entered.  Files go through the same checks as an upload: their type is read from their contents, they wait for the virus scanner when the server has one, and their previews are made again.  The organization imports in one transaction, so a failed import leaves no partial databases or settings.

Only organization settings are restored.  Sign-in and security settings, such as sign-in providers and two-step sign-in requirements, stay as this server has them.  AI settings come in off, with only their model choices kept.

Imported audit events keep their history but are marked as imported: each is dated when it came in, credited to nobody here, and carries when it first happened and who did it.  An archive with an event dated in the future is refused.

## Review

After the import, {{ui:organizationArchive.reviewTitle}} lists everyone the archive found and everything that reaches outside the organization.  Nothing on it talks to anyone until you act.

Nobody is invited during the import.  Everyone is invited as a member, or as a guest if they were one, with no admin roles, and you're the organization's only owner.  Choose people, then {{ui:organizationArchive.sendInvitations}}.  Someone whose email matches yours keeps your account.  Each person joins their groups, and keeps their shares and authorship, when they accept.

Data sources, webhooks, incoming webhooks, feeds, automations, public links, public forms, booking pages, OAuth apps, calendar feeds, cloud drive apps, and feedback sent to a repository all come in off, whatever the passphrase.  Each shows where it sends or takes data, such as a source's server or a webhook's address.  Choose {{ui:organizationArchive.turnOn}} when you've checked it.  Only this list turns them on: while one waits here, turning it on anywhere else is refused, and a paused data source reads nothing, not even for a live table, and takes no posts.  Something whose credential or address didn't come with the archive must have it entered again first.  For an automation, enter it on the step and publish the draft, since turning it on turns on the published version.  An automation comes in with its published version and its draft, but not the earlier versions it kept.  Public links and forms get new addresses, and a webhook source makes a new incoming address, shown once.

Every booking page is listed as a {{ui:organizationArchive.kind.bookingPage}}, including pages that were already off.  Turning one on gives it a new address, shown once, and it runs as the owner who turns it on.  Check its fields and settings before choosing {{ui:organizationArchive.turnOn}}.

{{ui:organizationArchive.kind.calendarFeeds}} is the organization's {{ui:calendarFeeds.policy.enabled}} setting.  Turning it on lets people subscribe again.  No subscription comes with the archive, so nothing reaches a calendar app until each person makes a new address.

Each registration from {{ui:oauth.apps}} is listed as an {{ui:organizationArchive.kind.oauthClient}}, with a new client ID.  Until it's turned on here, {{ui:oauth.apps}} shows it as {{ui:oauth.paused}}, and it signs nobody in.  A confidential app needs a new secret first: an administrator opens {{ui:oauth.apps}}, chooses {{ui:oauth.rotate}}, and saves the new secret in the connecting app.  The registration stays paused until you choose {{ui:organizationArchive.turnOn}} here.  A public client keeps its type and needs no secret.  Everyone must approve the app's access again.
