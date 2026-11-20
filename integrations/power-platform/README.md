# Riosoma and Power Platform

The `riosoma-api` connector exposes eight REST operations: list databases, list tables, list views, find records, get a record, create records, update records, and delete records.  The `riosoma-mcp` connector wraps `/mcp` with `x-ms-agentic-protocol: mcp-streamable-1.0`.  Use either connector as tools in Microsoft Copilot Studio.  Direct MCP onboarding is also available for a public HTTPS instance.

## Prepare the files

1. Copy the chosen connector folder to a working directory outside source control.  The checked-in files are templates, with a reserved example address and no credentials.
2. In `apiDefinition.swagger.json`, add `host` with your Riosoma server's host and optional port, without a scheme or path.  Keep `schemes` as `https` and `basePath` as `/`.
3. Replace the example origin in both OAuth URLs in `securityDefinitions.oauth2` and in `apiProperties.json`.  The authorization URL must include a URL-encoded `resource` query parameter: the full Riosoma origin followed by `/api/v1` for REST or `/mcp` for MCP.  The token and refresh URLs both end in `/oauth/token`.
4. Register a confidential app in Riosoma's OAuth apps settings.  Choose `schema.bases:read` and `data.records:read`, adding `data.records:write` for record changes and `schema.bases:write` for MCP schema changes.  Enter the app's client ID in `apiProperties.json`, and set its `scopes` array to exactly those allowed scopes.  Enter its secret in the maker portal's Security page after import, never in committed files.
5. For a public connection, remove `properties.connectionParameters.gateway`.  For a private connection, keep the gateway parameter and configure the gateway as described below.

Riosoma requires S256 PKCE, including for confidential apps.  The templates select the generic PKCE provider, `oauth2pkce`, which generates a fresh challenge and verifier and sends the client secret in the token request body.  The ordinary `oauth2` provider can omit PKCE and cannot be substituted.  Some maker portal versions do not expose the PKCE provider in their menu, so preserve it with the CLI steps below.  Confirm this provider is available in the target environment during the planned live validation.  Do not use a fixed challenge or disable PKCE.

## Import with the Power Platform CLI

Install and authenticate the Power Platform CLI using your organization's approved process.  Select the intended environment with `pac auth create --environment "$POWER_PLATFORM_ENVIRONMENT"`, then run from the directory containing this package:

```sh
pac connector create --api-definition-file ./riosoma-api/apiDefinition.swagger.json --api-properties-file ./riosoma-api/apiProperties.json
pac connector create --api-definition-file ./riosoma-mcp/apiDefinition.swagger.json --api-properties-file ./riosoma-mcp/apiProperties.json
```

Run only the command for the connector you need, using your prepared copies.  Find its ID with `pac connector list`.  To replace an existing definition, use `pac connector update --connector-id "$CONNECTOR_ID" --api-definition-file ./riosoma-api/apiDefinition.swagger.json --api-properties-file ./riosoma-api/apiProperties.json`, substituting the MCP paths when appropriate.

Open the imported connector in the maker portal.  Set its OAuth secret, save, and copy the exact per-connector Redirect URL from Security into the Riosoma app's registered redirect URIs.  If an initial redirect was needed to create the app, replace it before connecting.  Keep `redirectMode` as `GlobalPerConnector`.  Do not register a wildcard or drop the path after `/redirect/`.

## Import with the maker portal

1. Select the intended environment in Power Apps or Power Automate.
2. Open Custom connectors, choose New custom connector, and choose Import an OpenAPI file.
3. Name it `riosoma-api` or `riosoma-mcp`, and select the corresponding prepared `apiDefinition.swagger.json`.
4. In General, enter the host, HTTPS scheme, and `/` base URL.  For a gateway connection, enable the on-premises data gateway option.
5. In Security, choose OAuth 2.0 and configure the generic provider.  Enter the client ID, secret, authorization URL with its resource query, token URL, refresh URL, and space-separated scopes from `apiProperties.json`.
6. Save the connector, copy its generated Redirect URL, and register that exact address in Riosoma.
7. Preserve PKCE before making a connection.  For a solution-aware connector, download its generated properties with `pac connector download --connector-id "$CONNECTOR_ID" --outputDirectory ./downloaded`.  In that downloaded `apiProperties.json`, set `properties.connectionParameters.token.oAuthSettings.identityProvider` to `oauth2pkce`, keeping its environment-specific `redirectUrl`, client ID, secret reference, scopes, and endpoint settings.  Run `pac connector update --connector-id "$CONNECTOR_ID" --api-properties-file ./downloaded/apiProperties.json`.  Download it again to confirm the provider stayed set.  Use the same step for a connector created by the MCP wizard's Manual option if it chose ordinary generic OAuth.
8. In Test, create a connection, sign in to Riosoma, and approve the requested databases.  Test List databases and a read.  Test a mutation only on an approved test record.
9. In the agent's Tools page, add the REST connector operations or the MCP connector, and select the connection.  Configure end-user credentials so each person connects as themselves.

## Private instances and the on-premises data gateway

Install the standard on-premises data gateway on a machine that can resolve and reach the private Riosoma HTTPS address and trusts its certificate.  Register it in the intended tenant and region, share access with the connection owner, and select it when creating the connector connection.  Set the connector's host to the private address reachable from that gateway.  The `gatewaySetting` parameter in `apiProperties.json` supplies the gateway selector.

A gateway routes API calls.  It does not make a private OAuth issuer reachable from Microsoft's cloud or the person's browser.  The authorization page must be reachable by the browser, and token and refresh endpoints must be reachable by the connector's authentication service.  Use one stable issuer origin and arrange approved routing to those endpoints.  Check your environment's support for OAuth with gateway connections before import.  If the combination is unavailable, use an approved public HTTPS reverse proxy or an administrator-managed authentication bridge.  A gateway does not remove Riosoma's bearer-token requirement, and API-key authentication is not supported by the standard on-premises custom connector path.

The direct MCP wizard calls from Microsoft's cloud.  A loopback, local, or VPN-only address does not work there.  Use a publicly reachable HTTPS `/mcp` endpoint or the supported connector and gateway path.

## Generated REST definition

From the repository root, after building the server:

```sh
node tools/power_platform.mjs
```

The script reads the generated OpenAPI 3.1 contract from the built server and writes Swagger 2.0 without additional dependencies.  The normal server test suite regenerates it from the source contract, checks operation coverage and local references, and validates the supported Swagger schema forms.

Record operations always request `shape=airtable`.  Responses contain `records` with `id`, `createdTime`, and `fields`, plus `offset` when another page exists.  Pass that offset as `cursor`.  Query `filter` and `sort` values are JSON strings.  Array parameters use repeated query keys.  Mixed JSON values and field-type unions remain flexible, with union details retained in `x-riosoma-union`.  Riosoma validates values, access, and mutations at runtime.

## Outbound messages

See [Build the outbound flow](flows/README.md) and its [trigger schema](flows/trigger.schema.json).  In-app help opens through `?help=power-platform`.

## References

- [Generic PKCE provider configuration](https://troystaylor.com/power%20platform/custom%20connectors/2026-08-07-update-custom-connector-oauth-identity-providers-pac-cli.html)
- [Connect an existing MCP server](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent)
- [Custom connector lifecycle](https://learn.microsoft.com/en-us/connectors/custom-connectors/)
- [Connector authentication and gateway limitations](https://learn.microsoft.com/en-us/connectors/custom-connectors/faq)
- [Power Platform CLI connector commands](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/connector)
- [Connector connection properties](https://github.com/microsoft/PowerPlatformConnectors/blob/dev/schemas/paconn-apiProperties.schema.json)
