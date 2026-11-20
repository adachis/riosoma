---
id: credential-vaults
title: Where credentials live
summary: Choose credential storage, move existing credentials, and rotate wrapping keys.
area: administration
order: 7
level: advanced
related: [connections, single-sign-on, export-and-import]
routes: [/settings/credential-vaults, /settings/*/credential-vaults, /admin/*/credential-vaults]
anchors: [settings.credential.vaults]
sections: [settings.credential.vaults=choose-storage]
---

The organization owner and Security administrators manage credentials in {{ui:shell.nav.settings}} → {{ui:credentials.title}}.  Open `/settings/credential-vaults` directly to return here.

## Choose storage

The default is {{ui:credentials.database}}.  Each credential has a separate random data key.  Its encryption binds the organization, its owner, and its purpose, so copying the sealed value to another row does not make it usable there.

Your server operator configures vault connections as described in [Credential vault setup](../../../install/credential-vaults.md).  Choose a connection under {{ui:credentials.storage}}, then choose {{ui:credentials.preview}}.  The preview counts stored credentials without fetching their values.  Confirm {{ui:credentials.move}} to change storage for new credentials and move existing ones in batches.  A move waits for credential writes already in progress before changing storage, so those credentials are included in the move.

External vaults hold encrypted credential envelopes.  Riosoma keeps authenticated references in its database.  Vault values and references never appear in organization exports, even with an export passphrase.  Exports without credentials do not contact wrapping services.  Moving credentials does not erase historical database backups.  Apply your backup retention policy separately.

## Follow a move

{{ui:credentials.reports}} shows completed work and any failure.  Each report has its own link.  When a vault or external wrapping service cannot be reached, affected connections stop with a plain error.  Data sources remain listed, with an error beside each affected source, and healthy sources remain usable.  The owner and Security administrators receive one notification until storage settings change.  A vault that cannot be reached while Riosoma reads the organization's notification connections alerts the owner and Integrations administrators instead, and that notification opens the organization's channels, as {{doc:notifications}} explains.  Correct the vault connection, then choose {{ui:credentials.resume}} on the report.

Choose {{ui:credentials.database}} and preview again to move credentials back.  {{ui:credentials.undo}} restores the earlier storage and wrapping-key choice using the current credential values.  It does not bring back old passwords.  Keep earlier vault connections available until all credentials have moved.

## Rotate wrapping keys

Choose a {{ui:credentials.wrapping}}, then {{ui:credentials.rotate}}.  The default creates a fresh key protected by the instance key.  Configured Vault Transit and AWS KMS keys also appear here.  Rotation rewraps data keys without decrypting or changing credential values.  A restart resumes from the last committed checkpoint.

Keep the instance key and earlier wrapping keys.  Changing the instance key itself affects the server’s sign-in state and configuration as well as credentials.  The server operator can request rotation on startup without replacing the instance key.

Vault reads are cached in memory for five minutes by default.  The operator can shorten this interval or disable the cache.  An expired cache entry is never used when a vault fails.  Single sign-on checks credential access when sign-in starts and again when the person returns from the provider.  If the vault is unavailable and the credential cache has expired, sign-in stops until access is restored.
