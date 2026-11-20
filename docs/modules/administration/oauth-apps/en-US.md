---
id: oauth-apps
title: Reviewing OAuth apps
summary: Register trusted apps, review connections, rotate secrets, and control MCP client registration.
area: administration
order: 44
level: standard
anchors: [oauth.apps, oauth.dynamic, oauth.grants.all, settings.connected.apps, settings.oauth.apps]
related: [oauth-development, mcp, rest-api]
routes: [/settings/connected-apps, /settings/*/connected-apps, /admin/*/connected-apps, /settings/oauth-apps, /settings/*/oauth-apps, /admin/*/oauth-apps]
sections: [settings.connected.apps=connections-and-installations, settings.oauth.apps=review-an-app]
---

Owners and administrators with the Integrations role manage {{ui:oauth.apps}} in settings.  Each app has an identifying name, a local icon, an HTTPS homepage, exact redirect URIs, a client type, and allowed scopes.  An administrator's registration appears as {{ui:oauth.verified}} on the consent screen.  That label describes who registered it, without making a claim about the app's safety.

OAuth needs the server's base URL to use HTTPS, or a loopback address for local testing, since it names the server by that address.  With any other base URL, the settings page says OAuth is unavailable, apps can't connect, and the REST API and MCP answer refused requests exactly as they do for personal access tokens alone.

## Review an app

Check the publisher's homepage, every redirect URI, and whether the app needs each allowed scope.  A redirect URI must be written exactly as a browser reads it, with an ASCII host, so the address an administrator reviews is the address the code goes to.  Non-ASCII and percent-encoded hosts, dot segments, a default port written out, and capital letters in the host are refused.  Punycode hosts, which start with `xn--`, are allowed as written.  Public clients may also return to `http://127.0.0.1`, `http://[::1]`, or `http://localhost` on any port.  Confidential clients may return to `127.0.0.1` or `[::1]` only on the exact port registered.

People still choose what databases the app can reach.  Tokens always act through that person's current permissions, including field and record restrictions.  A connection cannot add access to a database the person cannot open.  Approving an app adds a way into the person's account, so anyone with a second step confirms it's them first, as they do to make a personal access token.

Use a public client for browser, desktop, and mobile software.  Use a confidential client only when a server can keep the secret private.  Copy its secret before closing the registration dialog.  Riosoma stores only the secret's hash.  {{ui:oauth.rotate}} replaces the secret immediately, so update the app when you rotate it.  Existing access tokens remain valid until they expire or the connection is revoked.

## Connections and installations

A connection is one person's consent for one app: its scopes and its databases.  Each time the app signs in as that person, for example on another computer, it gets an installation of its own with its own tokens, and every installation shares the connection.  When the person approves the app again with fewer databases or scopes, the change applies to every installation at once, and the consent screen says so.

The app list includes reviewed registrations and unverified MCP registrations.  {{ui:oauth.grants.all}} shows every connection in the organization, the person, scopes, resources, database choices, how many places it's signed in, and revocation status.  Revoking a connection ends every installation of the app for that person.  An app that revokes one of its own tokens ends only that installation.  {{ui:oauth.app.revoke}} disables the app and revokes every connection to it.  Suspended or removed people lose all connections, whether an administrator or provisioning ends their access, and restoring their account or membership does not restore them.

A webhook an app creates with its token belongs to that installation.  When the installation ends, including when its person is suspended, the webhook turns off and says why.  Anyone who can change the database's schema can turn it back on, and it then keeps running without the app.

People review and revoke their own connections under {{ui:oauth.connectedApps}}.  Registrations with their name, redirect URIs, and scopes, authorization decisions, token issuance, refreshes, credential reuse, secret rotation, setting changes, expirations, and revocations are recorded in the audit log.  A revocation names the app and whoever caused it, or no one when a person's access ended without anyone acting.  Token and secret values are never included.

## Dynamic registration for MCP

{{ui:oauth.dynamic}} is off by default.  Turn it on only when people need MCP clients that register themselves.  Such clients are always public and unverified, and their scopes are limited to reading schema, reading records, and writing records.  They can request the MCP resource only.  Each person must approve the app and its database access.

The switch is stored for the organization.  Because the instance has one public authorization issuer, exactly one organization must have dynamic registration enabled for the public registration endpoint to accept a client.  If more than one enables it, registration fails closed.  Existing registered apps remain bound to their own organization.

Turning the switch off blocks new dynamic registrations and new authorization requests for unverified apps.  It leaves existing connections in place.  Revoke an app or connection to stop existing access.  Each network address may make 5 dynamic registrations a day, and an organization may have 500 active unverified apps.  A registration that receives no tokens within 7 days, or none for 90 days after its last, expires and is revoked, so unused registrations give their places back.  An IPv6 address counts as its /64 network for these limits.

Each network address may also have 20 authorization requests waiting for each app.  A 21st replaces that address's oldest, so no one address can keep others from signing in.

The existing base URL setting supplies the issuer and both resource identifiers.  Keep that origin stable, because tokens issued for one resource URL cannot be used at another.

## Teams agents

See {{doc:power-platform}} for Microsoft Copilot Studio discovery, manual OAuth, custom connectors, private gateway connections, publishing to Teams, and outbound automation messages.
