---
id: zapier-clipper
title: Zapier and the browser clipper
summary: Connect Zapier workflows and save web pages to existing tables.
area: administration
order: 46
level: standard
anchors: [oauth.apps]
related: [oauth-apps, oauth-development, rest-api, webhooks]
---

Register each integration under {{ui:oauth.apps}}.  Both use a public OAuth app with PKCE.  Copy the exact redirect address from the integration and allow the scopes it needs.  People choose which databases to approve, and their current field and record permissions still apply.

## Connect Zapier

Allow {{ui:tokens.scope.schemaRead}}, {{ui:tokens.scope.schemaWrite}}, {{ui:tokens.scope.recordsRead}}, and {{ui:tokens.scope.recordsWrite}}.  Managing a webhook also takes the {{ui:share.role.creator}} or {{ui:share.role.owner}} role.  Enter the server origin and client ID in the Zapier connection, then choose the database and table.

New Record and Updated Record use signed webhooks.  New Record in a View fires for a newly created record that matches the view when processed.  It does not report existing records entering a view after an update.  Removed or inaccessible records are omitted.  Each trigger gives an Event ID for the delivery and a Record ID to use in later steps, such as Update Record.

Create Record and Update Record offer fields from the table's schema.  Only supplied fields are written.  Find Records compares a text, numeric, or checkbox field exactly.  Find or Create Record writes the searched value when nothing matches.  Concurrent runs can create duplicates without a uniqueness rule.

The app can be built and tested locally.  Deployment waits for the owner's Zapier account.

## Save a web page

Load the clipper in your browser.  One build works with every Riosoma server.  Its sign-in screen displays the redirect address to register under {{ui:oauth.apps}}.  Allow {{ui:tokens.scope.schemaRead}}, {{ui:tokens.scope.recordsRead}}, and {{ui:tokens.scope.recordsWrite}}.

Enter your Riosoma address and the app's client ID, then sign in.  The address has to use HTTPS.  The first time, your browser asks to let the clipper reach that address, and nothing is sent there until you allow it.  If the clipper closes while the browser asks, open it again and sign in.

Open the clipper while viewing a regular web page.  Choose a database and table, then map the page title, URL, and selected text to three distinct text fields.  To include a screenshot, choose an attachment field and select the screenshot option.  Save the page, then open the new record from the result link.

The screenshot captures the visible page at save time.  It is refused if the original tab or URL has changed.  Failed uploads leave the draft available and do not create a record.  If the network loses a save response, check the table before saving again.

The destination has a link containing its database, table, and field IDs.  The help screen also has its own link.  These links never include tokens or page content.  Controls work with a keyboard and screen reader, and the layout fits narrow screens.  Pressing Enter in a field does not save the page.

Sign out to clear the local session and revoke its grant.  Tokens stay in browser session storage, so restarting the browser requires signing in again.  The clipper uses the closest enabled browser language, defaulting to American English in public builds, and wears Riosoma's default theme.  Publishing to the browser stores waits for the owner.

## Access and history

Both integrations use the existing REST API.  Reads pass through the same access scope as the app.  Record changes use commands, appear in the audit trail, reach affected readers, and support undo through existing record tools.  The resulting records are also available through the existing API, MCP, and Rio tools within the same permissions.
