---
id: mcp
title: Connecting an MCP client
summary: Let apps and tools that speak the Model Context Protocol read and change records, tables, fields, and views with OAuth or a personal access token.
area: administration
order: 2
level: advanced
related: [rest-api, trash-and-favorites]
routes: [/settings/mcp, /settings/*/mcp, /admin/*/mcp]
anchors: [settings.mcp]
sections: [settings.mcp=signing-in-with-oauth]
---

The Model Context Protocol (MCP) is a standard way for apps and tools to work with other services.  Riosoma has an MCP server, so a client that speaks MCP can read and change records, tables, fields, and views in your databases.  It acts as you, with exactly your access, through OAuth or a personal access token.

## Signing in with OAuth

Enter your Riosoma address followed by `/mcp` in a client that supports OAuth.  The client discovers the authorization server from the endpoint's 401 response, opens Riosoma's sign-in and consent screen, and exchanges the approved code with PKCE.  You choose what the app can do and which databases it can reach.  Revoke its connection at any time under {{ui:oauth.connectedApps}}.

An administrator can register the client ahead of time or enable dynamic registration for public MCP clients.  Dynamically registered clients appear as unverified on the consent screen.  See {{doc:oauth-apps}} for administration and {{doc:oauth-development}} for the developer flow.

OAuth clients can request the same scopes as personal access tokens below.  Choose {{ui:tokens.scope.schemaWrite}} for table, field, and view changes.  Schema changes require your {{ui:share.role.creator}} or {{ui:share.role.owner}} role in the database.

## Creating a token

Create a token as {{doc:rest-api}} describes, and choose its scopes by what the client should do:

- {{ui:tokens.scope.schemaRead}} lets it list your databases and read their tables, fields, and views.
- {{ui:tokens.scope.recordsRead}} lets it find, count, and read records.
- {{ui:tokens.scope.recordsWrite}} lets it add, change, and delete records.
- {{ui:tokens.scope.schemaWrite}} lets it create, rename, reorder, and trash tables, fields, and views.  Schema changes also require your {{ui:share.role.creator}} or {{ui:share.role.owner}} role in the database.

Most clients need both read scopes to find their way around.  With {{ui:tokens.databases.chosen}}, the client sees only the databases you pick.

## Connecting

The server is your Riosoma address followed by `/mcp`, and it uses the Streamable HTTP transport, which some clients call HTTP.  The token goes in an `Authorization` header.  Many clients take a configuration like this:

```json
{
  "mcpServers": {
    "riosoma": {
      "type": "http",
      "url": "https://riosoma.example.com/mcp",
      "headers": {
        "Authorization": "Bearer rio_pat_…"
      }
    }
  }
}
```

Use your own address and token.  The server takes only a token, never your password or a browser's sign-in, and it checks the token on every request.  Revoking the token stops the client at once.

## What a client can do

- `list_databases` and `get_schema` find your databases and their tables, fields, select choices, and views.
- `find_records` finds records with conditions that name fields and choices, sorts them, and returns up to 100 at a time, with a cursor for the next page.  `count_records` counts them, and `get_record` reads one.
- `propose_record_update` checks proposed updates without saving them.  Show the proposed values to the person, and call the returned `update_records` tool only after confirmation.  Applying checks permissions and values again.
- `create_records`, `update_records`, and `delete_records` change up to 100 records at a time.  Values take the same readable forms as the REST API.
- `create_table`, `update_table`, and `trash_table` create, rename, describe, reorder, and trash tables.
- `create_field`, `update_field`, and `trash_field` add, rename, describe, convert, configure, and trash fields.  A link field’s target table cannot change.  Create a new link field for a different target.
- `create_view`, `update_view`, and `trash_view` create, rename, reorder, and trash views.  `update_view` also reorders fields in that view using `fieldOrder`.

Schema tools take the target ID as `databaseId`, `tableId`, `fieldId`, or `viewId`.  Create and update tools take the matching REST request body in `input`, as described in {{doc:rest-api}}.  Each returns what changed and an `undoGroupId` for undo in the app.  These tools are marked as changes so clients can request confirmation before running them.  A token with neither write scope gets only tools that read.

Link field creation and updates accept `limitToViewId` or `filter`, plus up to three `displayFieldIds`.  Filters can use `currentFieldId` for a source-record comparison.  The schema tool returns these options, and record changes enforce the same limits as the picker.  See {{doc:linked-records}} and {{doc:rest-api}}.

Changes pass the same checks as edits in the app.  They appear right away for anyone with the database open, and a record's history shows them as yours.  Deleted records stay in the trash for 30 days.  See {{doc:trash-and-favorites}}.

When a call can't work as asked, such as a field that doesn't exist or a choice a field doesn't have, the client gets an answer that says why, so it can try again.

## Limits

The default is **120 calls per minute per token**, counted in a rolling 60-second window across all server replicas.  Each personal token or OAuth installation has its own allowance, which survives reconnects and OAuth token refreshes.  Every authenticated MCP request counts, including initialization, notifications, and requests that return an error.

An owner or Integrations administrator can open {{ui:mcp.settings.title}} in settings, enter {{ui:mcp.settings.callsPerMinute}}, and save with the page’s save bar.  Choose {{ui:mcp.settings.noLimit}} to turn off the limit.  A connected app can inherit the organization limit or use its own number or {{ui:mcp.settings.noLimit}}.  The page shows each connected app’s request count in the last rolling minute and refused requests in the last 24 hours, refreshed every 5 seconds.  Limits are organization-wide, like OAuth app registration settings.

A refused request performs no tool work.  The client receives HTTP **429**, a `Retry-After` header in whole seconds, and a JSON-RPC server error (`-32000`) with `data.code: "rate_limited"`, `data.messageKey: "mcp.rateLimited"`, and `data.params.limit` and `data.params.seconds`.  Its plain message states the limit and when to retry.  Wait that long before retrying.  Refused requests do not extend the admission window.  Audit history records at most one limit event per token in any rolling minute, while the page counts every refused request.

- Each request carries one message, and each call has 30 seconds to finish.  A change that runs out of time may still finish, so check the records before trying it again.
- Record and field rules apply as they do in the app, so a record or field you can't see never reaches the client.

## Teams agents

See {{doc:power-platform}} for Microsoft Copilot Studio discovery, manual OAuth, custom connectors, private gateway connections, publishing to Teams, and outbound automation messages.
