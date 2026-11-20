---
id: connected-accounts
title: Connecting cloud drives
summary: Connect Dropbox, Box, or Google Drive to add attachments from them, and disconnect them again.
area: account
order: 3
level: simple
related: [attachments]
routes: [/settings/connected-accounts, /settings/*/connected-accounts, /admin/*/connected-accounts]
anchors: [settings.connected.accounts]
sections: [settings.connected.accounts=connecting]
---

When your organization has set up Dropbox, Box, or Google Drive, you can add attachments straight from them.  Each person connects their own account, so a drive shows you only what you can see there.  {{doc:attachments}} explains how to pick files once you're connected.

## Connecting

Riosoma asks you to connect the first time you add files from a drive.  You can also connect ahead of time: go to {{ui:shell.nav.settings}}, then {{ui:settings.nav.connectedAccounts}}, and choose the drive's connect button.  The drive asks you to sign in there and to let Riosoma read your files.  Your password goes only to the drive, never to Riosoma.

With Google Drive, Riosoma can open only the files you pick in Google's picker, and nothing else in your drive.  With Dropbox and Box, Riosoma lists your folders so you can find files, and copies only the ones you pick.

## Seeing and disconnecting your accounts

{{ui:settings.nav.connectedAccounts}} lists each drive, whose account is connected, and when.  Choose {{ui:drives.accounts.disconnect}} to remove one.  Riosoma forgets its access and asks the drive to forget it too.  Files you already added stay where they are.

If a drive stops accepting Riosoma's access, for example because you changed your password there or removed Riosoma from your account's connected apps, the account says so.  Choose {{ui:drives.accounts.reconnect}} to connect it again.  If an admin turns a drive off, it leaves the attachment panel, and your account for it stays listed until you disconnect it.

### Accounting app sources

Xero and QuickBooks Online accounts can sign in app sources for scheduled accounting reads.  Connect an account in the source setup form.  For Xero, choose an organization when the account shares several.  A single organization is selected automatically.  For QuickBooks Online, choose the company during consent, and use Sandbox in source settings when connecting with development credentials.

Xero requests `openid`, `profile`, `email`, `offline_access`, `accounting.invoices.read`, `accounting.payments.read`, `accounting.banktransactions.read`, `accounting.contacts.read`, `accounting.settings.read`, and `accounting.manualjournals.read`.  QuickBooks Online requests `com.intuit.quickbooks.accounting`, `openid`, `profile`, and `email`.  Riosoma only reads accounting records.  QuickBooks Online's accounting scope also allows writes at the provider, and Riosoma does not use them.

If a provider refuses access, connect the account again.  Sources keep the account owner's connection for scheduled syncs, and they do not store its credentials.
