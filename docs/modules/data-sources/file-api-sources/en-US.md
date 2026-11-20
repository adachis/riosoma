---
id: file-api-sources
title: File servers, GraphQL, and OData
summary: Read files and API records with reusable source connections.
area: data-sources
order: 17
level: advanced
anchors: [sources]
related: [connections]
---

Open {{ui:settings.nav.sources}} and choose {{ui:sources.add}}.  Each connection has its own address in the browser, including an unsaved source selected by kind.  {{ui:sources.remote.help}} keeps the form available while you read help.

Saving and deleting these sources offers {{ui:sources.undo}} in the confirmation message.  Undo checks current permissions and refuses to overwrite later changes or remove a source used by a synced table.  Restoring a source also checks its address against the current network policy, including resolved file server addresses and the plain FTP rule.  Turning on an imported source applies these checks too.

## File servers

Choose {{ui:sources.kind.sftp}}, {{ui:sources.kind.ftp}}, {{ui:sources.kind.ftps}}, or {{ui:sources.kind.webdav}}.  Files use the same CSV, TSV, JSON, NDJSON, Parquet, and Excel readers as storage buckets.  {{ui:sources.field.format}} overrides the extension, and {{ui:sources.field.sheet}} selects an Excel worksheet.

Enter a file or glob in {{ui:sources.remote.path.label}}.  A relative path starts in the sign-in directory.  An asterisk matches one folder level, and a double asterisk includes nested folders.  Select one listed file or a group of files with the same format when creating a synced table.  Listings are bounded to 1,000 files and 100 folders.  File size and modification time detect unchanged files when the server supplies both.

For SFTP, enter the host, port, and user.  Enter only a host name or IP address in {{ui:sources.field.host}}, with the port in its own field.  Choose a password or {{ui:sources.remote.key}}.  Paste the public host key confirmed by the server administrator into {{ui:sources.remote.hostKey.label}}.  A changed key stops the connection.  An encrypted private key can also use a passphrase.

FTP uses passive connections.  FTPS upgrades the control connection with explicit TLS and encrypts data connections.  Its certificate must be trusted and match the configured host.  The server must expose its passive ports.  FTP sends credentials without encryption, so Riosoma allows it only to localhost while private hosts are allowed, matching the plain HTTP rule.  This rule also applies when testing or syncing a saved source.  Use FTPS when the server supports it.

A file server's host meets the same private-network rule web files follow.  A loopback, private, link-local, or metadata address is refused when the source is saved or tested, and so is a name that resolves to one, since every address a name resolves to has to pass.  Each connection resolves the name again, so a host that moves to a private address later is refused then.  The operator's `RIOSOMA_AUTOMATIONS_ALLOW_PRIVATE_HOSTS=true` allows private hosts for webhooks, automations, and other sources.  It does not allow plain FTP to remote hosts.  File server lookups stop after five seconds when saving.  A name that doesn't resolve when the source is saved is left to {{ui:sources.test}}, which reports resolution as a step of its own.

WebDAV uses a folder address, basic authentication or a bearer token, and a path relative to that folder.  Nextcloud and ownCloud WebDAV folder addresses work, including encoded spaces.  Riosoma lists with PROPFIND and downloads with GET through the same network checks as web file sources.

## GraphQL

Choose {{ui:sources.kind.graphql}} and enter the endpoint address.  Authentication supports the same headers and OAuth client credentials as a web API source.

Write one read-only query in {{ui:sources.graphql.query.label}}, and enter its variables in {{ui:sources.graphql.variables.label}}.  {{ui:sources.graphql.records.label}} points to the response list, including the outer data property.  {{ui:sources.graphql.suggest}} lists fields exposed by introspection.  Some services disable introspection, so a working query can still be used without suggestions.  Save changed connection credentials before requesting suggestions for an existing source.

Choose a cursor or offset under {{ui:sources.graphql.paging.label}}.  Supply the pagination variable and {{ui:sources.graphql.pageInfo.label}}.  Both modes require hasNextPage.  Cursor mode also requires endCursor.  Offset mode advances by the number of rows returned and sends the selected page size.  Repeated cursors, missing pagination information, and query errors stop the read so a partial result cannot silently replace a table.

## OData v4

Choose {{ui:sources.kind.odata}} and enter the service root.  Riosoma reads entity sets, typed properties, and keys from XML metadata.  Int64 and Decimal fields begin as text to preserve their digits.  Every nextLink page is read from the same origin.

Live tables send selected columns, row limits, supported filters, and ordering through the OData query options.  Text, numeric, and checkbox filters are supported where their source types match.  Unsupported view conditions are reported in the live table notice.  Record rules that cannot be translated prevent access.  OData sorting follows the service’s null ordering and text collation.

## Diagnostics

Use {{ui:sources.test}} before saving.  The ladder identifies address resolution, connection, authentication, reading, format parsing, and pagination failures.  A file server may allow reading a specific file while refusing folder listings.  SFTP can read a direct path with that restriction.  FTP and WebDAV need listing permission for the selected folder.

## SMB availability

SMB is not included in this release.  The reviewed maintained client is still alpha, and the older candidates do not establish the signing and encryption guarantees needed here.  No SMB dependency was added.  The isolated file-source test profile includes Samba for future compatibility testing.
