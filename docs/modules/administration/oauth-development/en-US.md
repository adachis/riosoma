---
id: oauth-development
title: Registering an OAuth app
summary: Connect a REST API or MCP client through approval, PKCE, and resource-bound access tokens.
area: administration
order: 45
level: advanced
anchors: [oauth.apps, oauth.consent.title]
related: [oauth-apps, rest-api, mcp, javascript-sdk, command-line-tool]
---

Ask an administrator with the Integrations role to open {{ui:oauth.apps}} in settings and choose {{ui:oauth.register}}.  Supply the app name, a local icon, an HTTPS homepage, exact redirect URIs, the client type, and the scopes it needs.  Public clients cannot keep a secret.  Confidential clients receive a secret once and authenticate with HTTP Basic or `client_secret_post` at the token and revocation endpoints.

Redirects require HTTPS.  Register the complete URI, including any port and query string, written exactly as a browser's URL parser writes it back: a lowercase ASCII host, punycode for an international name, no default port, and no `.` or `..` segments.  Riosoma refuses a URI that parses to anything other than itself, so the consent screen shows exactly where the code goes.  Matching is exact.  Fragments, credentials, and wildcard addresses are refused.

A public client, such as a desktop app, may also register an HTTP loopback redirect on `127.0.0.1`, `[::1]`, or `localhost`, with or without a port.  As [RFC 8252, section 7.3](https://www.rfc-editor.org/rfc/rfc8252#section-7.3) describes, its authorization requests may then name any port on that host, with the registered path and query.  A confidential client may register a loopback IP address too, but its requests must use the exact port registered.

## Discover and request access

Read `/.well-known/oauth-authorization-server` from the configured Riosoma origin.  It advertises authorization code and refresh grants, S256 PKCE, client authentication methods, and revocation.  Dynamic registration appears only when an administrator enables it.

Use one resource per grant:

- REST API: the origin followed by `/api/v1`
- MCP: the origin followed by `/mcp`

The protected resource metadata documents live at `/.well-known/oauth-protected-resource/api/v1` and `/.well-known/oauth-protected-resource/mcp`, and each names its own resource, as [RFC 9728, section 3.3](https://www.rfc-editor.org/rfc/rfc9728#section-3.3) requires.  The origin itself is not a resource, so it has no document.  Any other address under `/.well-known/` answers 404 in JSON.  An unauthenticated request to either resource returns 401 with its document in `WWW-Authenticate`, so an MCP client can discover the authorization server and its registration endpoint.  OAuth needs the server's base URL to use HTTPS, or a loopback address for local testing.  Otherwise the 401 carries no pointer, and the authorization endpoints answer `temporarily_unavailable`.

Send the person to `/oauth/authorize` with `response_type=code`, `client_id`, the exact `redirect_uri`, `scope`, a fresh `state`, `resource`, a fresh PKCE `code_challenge`, and `code_challenge_method=S256`.  Keep the verifier and state in that person's client session.  Password and implicit grants, plain PKCE, duplicate parameters, and missing state or resource are refused.

Riosoma signs the person in using its normal sign-in flow and shows the app, its review status, the host the code goes to on a line of its own, the full redirect URI, the requested scopes, and the available databases.  The person can approve every database they can open, now and later, or a fixed selection.  Approve works only after the screen has been visible and focused for a second, so a page can't swap it in under a double-click.  Someone with a second step confirms it's them before approving, as they do to make a personal access token.

A person's consent for an app is one record, shared by every installation of the app that signs in as them.  When the scope set matches what they approved before, the screen starts from their saved database choice.  Whatever they approve replaces the consent for every installation at once, so a narrower choice narrows tokens the app already holds.  Each authorization is its own installation with its own refresh tokens.

## Example public client

This server-side JavaScript example builds a public client's authorization request and exchanges the callback code.  Supply the instance origin, registered client ID, and exact registered callback URI.  Keep the returned flow in the person's session, and remove it before processing a callback so it cannot be replayed.

```js
import { createHash, randomBytes } from 'node:crypto'

function start(issuer, clientId, redirectUri) {
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(32).toString('base64url')
  const resource = new URL('/api/v1', issuer).href
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'schema.bases:read data.records:read',
    state,
    resource,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  })
  return {
    url: `${issuer}/oauth/authorize?${query}`,
    flow: { issuer, clientId, redirectUri, resource, verifier, state },
  }
}

async function finish(callbackUrl, flow) {
  const query = new URL(callbackUrl).searchParams
  if (query.getAll('state').length !== 1 || query.get('state') !== flow.state ||
      query.getAll('iss').length !== 1 || query.get('iss') !== flow.issuer ||
      query.has('error') || query.getAll('code').length !== 1) {
    throw new Error('invalid_callback')
  }
  const response = await fetch(`${flow.issuer}/oauth/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: flow.clientId,
      redirect_uri: flow.redirectUri,
      code: query.get('code'),
      code_verifier: flow.verifier,
    }),
  })
  if (!response.ok) throw new Error('exchange_failed')
  return response.json()
}
```

The token request may leave out `resource`, since the authorization named exactly one, or repeat it exactly.  The response contains an access token, its one-hour lifetime, a refresh token, the resource, and the granted scopes.  A dynamically registered client receives refresh tokens only if its registered grant types include `refresh_token`.  Send the access token only in `Authorization: Bearer` to that resource.  It does not authenticate the app's browser-session routes or the compatibility API.

## Refresh and revoke

Post an `application/x-www-form-urlencoded` request to `/oauth/token` with `grant_type=refresh_token`, `client_id`, and `refresh_token`.  `resource` is optional and, if sent, must be the original one.  Confidential clients also authenticate.  A refresh may send `scope` to ask for fewer scopes than were granted, and the new access token then has only those, while the new refresh token keeps the whole grant.  Asking for a scope that wasn't granted is refused.  Serialize refreshes and replace the stored refresh token on every success.  A refresh token expires after 30 days without being exchanged.  Reusing an exchanged refresh token revokes that installation's grant, including every access token and later refresh token.  Reusing an authorization code has the same effect.  Codes expire after five minutes, and consent requests expire after ten minutes.

Post `token` and client authentication to `/oauth/revoke` to end the installation a live access token or refresh token belongs to.  Other installations of the app keep working.  Public clients send their `client_id`.  Unknown tokens, expired access tokens, refresh tokens already exchanged, and tokens belonging to another client receive the same successful response without revoking anything, as [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009) allows.  People can also revoke a connection in {{ui:oauth.connectedApps}}, which ends every installation of the app for them.

A webhook the app creates with its token belongs to that installation, and turns off when the installation ends.

## Standards and implementation

The authorization server uses platform crypto and database transactions without an additional dependency.  Opaque credentials let revocation take effect on the next request, and code consumption, refresh rotation, and audit events commit together.

The flow follows [OAuth 2.1](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1), [PKCE](https://www.rfc-editor.org/rfc/rfc7636), [authorization server metadata](https://www.rfc-editor.org/rfc/rfc8414), [protected resource metadata](https://www.rfc-editor.org/rfc/rfc9728), [dynamic registration](https://www.rfc-editor.org/rfc/rfc7591), [revocation](https://www.rfc-editor.org/rfc/rfc7009), [resource indicators](https://www.rfc-editor.org/rfc/rfc8707), [the security best practice](https://www.rfc-editor.org/rfc/rfc9700), and [MCP authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization).  Registration uses pre-registered clients or dynamic registration, without fetching client metadata documents from outside addresses.
