---
id: app-sources
title: App sources
summary: Connect an app with a key or your account and sync its objects into tables.
area: data-sources
order: 18
level: simple
anchors: [sources.app.choose, sources.app.settings, sources.app.key, sources.app.createKey, sources.app.test]
sections: [sources.app.choose=adding-an-app, sources.app.settings=app-settings, sources.app.key=keys, sources.app.createKey=keys, sources.app.test=when-a-test-fails]
related: [connections, synced-tables]
---

An app source connects Riosoma to an app by name.  It supplies the app's object list and reads records for synced tables.  You do not need to write requests or queries.

## Adding an app

Open {{ui:settings.nav.sources}}, choose {{ui:sources.add}}, and choose an app under {{ui:sources.app.group}}.  Use {{ui:sources.app.filter}} to narrow a long list.  App names keep their original spelling.

Give the source a {{ui:sources.field.name}}, fill in its settings, enter its {{ui:sources.app.key}} or choose a {{ui:sources.app.account}}, choose who may sync from it, and use {{ui:sources.test}}.  After a passing test, choose {{ui:sources.save}}.  In a database, choose {{ui:synced.wizard.title}}, select the source, and pick an object.  You can also connect a new app inside that wizard, test it, and choose {{ui:synced.wizard.connectSave}} to pick objects immediately.

## App settings

Each app supplies its own labels, help, required settings, and allowed values.  Text settings can limit length and format.  Address settings require HTTPS on the app's domain, with no credentials, custom port, path, query parameters, or fragment.  Choice settings offer only the app's allowed values.  Errors appear while you fill in the form.

Changing apps before saving clears the settings and key.  A saved source keeps its app.  Add another source to use a different app.

## Keys

A key is a secret that lets Riosoma read the app on your behalf.  Use a key with read access to the objects you intend to sync.  The icon beside {{ui:sources.app.key}} opens {{ui:sources.app.createKey}} in a new tab at the app's own key page.

The list below comes from the same catalog as the form, so new apps bring their key pages with them.

| App | Connection | Guidance |
| --- | --- | --- |
{{app-keys}}

Once saved, the key stays in secret storage and its value never returns to the form.  {{ui:sources.app.keyReplace}} supplies a new key, and {{ui:sources.app.keyRemove}} removes the stored key.  An empty replacement keeps the existing key.  Save changes before testing a saved source, since that test uses its stored settings and key.

## Salesforce credentials

Enable the client credentials flow in your Salesforce external client app, grant the `api` scope, and select a Run As user with read access to the objects you want.  Copy its consumer key and client secret.  Use your instance's HTTPS address on `my.salesforce.com`, including the full Developer Edition host when applicable.

## Zoom scopes

Create and activate a Server-to-Server OAuth app.  Copy its account ID, client ID, and client secret.  Grant `user:read:user:admin` for the key test, `user:read:list_users:admin` for Users and meeting discovery, `group:read:list_groups:admin` for Groups, and `meeting:read:list_meetings:admin` for each user's meetings.  The test reports missing scopes even when no objects are available.

## Zoho CRM refresh tokens

Make a Self Client in the [Zoho API Console](https://api-console.zoho.com/) with `ZohoCRM.modules.READ`, `ZohoCRM.settings.READ`, `ZohoCRM.users.READ`, and `ZohoCRM.org.READ`.  Follow Zoho's [Self Client instructions](https://www.zoho.com/crm/developer/docs/api/v8/auth-request.html#self-client) to exchange its code for a refresh token.  Enter the client ID, client secret, refresh token, and matching data center.  The United States data center is the default.

## Connecting through an account

Apps such as GitHub offer {{ui:sources.app.account}} instead of a key.  Choose your existing account, or use {{ui:sources.app.connectAccount}} to sign in at the provider.  After connecting, choose the account, test the source, and pick objects as usual.  Your password stays with the provider.  The source stores the connection ID, and the server keeps access credentials sealed separately.

Connecting shares the account's permitted app data with the source.  Everyone allowed to sync from that source uses the connecting person's account, including scheduled syncs.  A viewer's own connected account does not change whose data the source reads.  Riosoma only reads app data.

GitHub asks for `repo read:org`.  GitHub OAuth apps have no read-only scope for private repositories, so the authorization grants broader access than Riosoma uses.  Riosoma reads repositories, issues, and pull requests, and never writes to GitHub.  Repository issues include pull requests, identified by the `is_pull_request` column.  Labels, assignees, authors, and milestones appear as names.

An admin registers the provider's OAuth app under {{ui:settings.nav.integrations}}.  Register the exact callback address shown on that page, enter the client ID and client secret, and enable the provider.  For GitHub, create an OAuth app in GitHub's developer settings and use that callback address as its authorization callback URL.  Server operators can instead set `RIOSOMA_GITHUB_OAUTH_CLIENT_ID` and `RIOSOMA_GITHUB_OAUTH_CLIENT_SECRET`, and restart the server.  These server settings take precedence over credentials entered on the admin page.  An unavailable app explains where an admin can set it up.

Riosoma currently keeps one account per person and provider.  {{ui:sources.app.connectAnother}} replaces that account.  Connecting a different account stops sources using the previous account until you edit each source, choose the replacement account, and save it.  Reconnecting the same account keeps existing source references.  Disconnecting warns you and names sources that will stop syncing.  After disconnecting and connecting again, edit each source, choose the reconnected account, and save it.  If access is refused, cannot renew, or belongs to someone who no longer has active organization membership, the error names the person who connected the account and asks them to connect again under {{ui:settings.nav.connectedAccounts}}.

## Objects and syncing

The wizard shows the app's preset object names, plus objects it discovers, such as one object per form or custom objects.  Choose an object to preview records and select fields and record keys, then set the table's sync schedule.  Available objects depend on the app, its account, and the key's permissions.

App sources support scheduled copies.  They read records only.  Edits in Riosoma never write to the app, and an app source does not run custom queries or provide a live table.  Previewing and syncing can use the app's request allowance.  Deleted objects require choosing an available object again.

Intercom’s companies object includes at most 10,000 companies.  Larger workspaces need a separate export for the remaining companies.

## When a test fails

The test checks the address, connection, encryption, sign-in, object discovery, and a sample read.  Read the first failed step and its app-specific advice.  Later steps may be skipped until that failure is fixed.

For an address or encryption failure, check the app setting and ask the server operator to check connectivity and network rules.  For a sign-in failure, open the key page, check read permissions, and replace an expired or revoked key.  For discovery or read failures, check access to the object and whether it still exists.  If the app is limiting requests, wait before testing again.  {{ui:sources.test.details}} can help an operator diagnose the failure.

### Xero

Connect your Xero account, and choose an organization.  A single organization is selected automatically.  The source reads contacts, invoices, credit notes, payments, bank transactions, accounts, items, tax rates, tracking categories, quotes, purchase orders, and manual journals.  Accounts, items, tax rates, and tracking categories arrive as complete lists.  Other objects use pages of 100 records.

Xero requests `openid`, `profile`, `email`, `offline_access`, `accounting.invoices.read`, `accounting.payments.read`, `accounting.banktransactions.read`, `accounting.contacts.read`, `accounting.settings.read`, and `accounting.manualjournals.read`.  Riosoma only reads accounting data.  An admin can register the app under {{ui:settings.nav.integrations}}, or an operator can set `RIOSOMA_XERO_CLIENT_ID` and `RIOSOMA_XERO_CLIENT_SECRET`.

### QuickBooks Online

Connect your QuickBooks Online account, and select the company during consent.  Choose Production for a live company or Sandbox when using development credentials.  Production is the default.  The source reads customers, vendors, employees, items, accounts, invoices, bills, payments, bill payments, estimates, sales receipts, purchase orders, credit memos, journal entries, classes, departments, and tax codes.

QuickBooks Online requests `com.intuit.quickbooks.accounting`, `openid`, `profile`, and `email`.  Intuit's accounting scope allows writes, but Riosoma only sends GET queries to read accounting records.  A refused object is left out with an explanation, and a revoked connection asks you to connect again.  An admin can register the app under {{ui:settings.nav.integrations}}, or an operator can set `RIOSOMA_QUICKBOOKS_CLIENT_ID` and `RIOSOMA_QUICKBOOKS_CLIENT_SECRET`.
