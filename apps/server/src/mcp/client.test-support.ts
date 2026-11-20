import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

/** An SDK client whose browser authorization is driven by the test's signed-in person. */
export function oauthClient(address: string, redirectUrl: string) {
  let information: OAuthClientInformationMixed | undefined;
  let tokens: OAuthTokens | undefined;
  let verifier = '';
  let destination: URL | undefined;
  const state = crypto.randomUUID();
  const provider: OAuthClientProvider = {
    redirectUrl,
    clientMetadata: {
      client_name: 'Local MCP client',
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'schema.bases:read data.records:read data.records:write',
    },
    state: () => state,
    clientInformation: () => information,
    saveClientInformation: (value) => {
      information = value;
    },
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value;
    },
    codeVerifier: () => verifier,
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    redirectToAuthorization: (value) => {
      destination = value;
    },
  };
  const client = new Client({ name: 'local-mcp-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(address), { authProvider: provider });
  return {
    client,
    authorizationUrl: () => destination,
    connect: async () => {
      // Explicit scope avoids adopting every scope advertised in resource discovery metadata.
      const outcome = await auth(provider, { serverUrl: address, scope: provider.clientMetadata.scope });
      if (outcome === 'REDIRECT') throw new UnauthorizedError();
      await client.connect(transport);
    },
    finish: async (code: string) => {
      await transport.finishAuth(code);
      await client.close();
      await client.connect(new StreamableHTTPClientTransport(new URL(address), { authProvider: provider }));
    },
  };
}
