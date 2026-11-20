import { execFileSync } from 'node:child_process';
import { constants, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseProfile } from '@riosoma/contracts';
import type * as AzureIdentity from '@azure/identity';
import type { ClientSecretCredentialOptions } from '@azure/identity';
import { azureServiceToken, passwordSource } from './tokens.js';

const network = vi.hoisted(() => ({
  sendRequest: vi.fn<NonNullable<ClientSecretCredentialOptions['httpClient']>['sendRequest']>(),
}));

// Replace only the HTTP transport: real Azure Identity credentials and MSAL perform discovery,
// construct grants, sign certificate assertions, and parse the token responses.
vi.mock('@azure/identity', async (importOriginal) => {
  const identity = await importOriginal<typeof AzureIdentity>();
  const options = { httpClient: network, retryOptions: { maxRetries: 0 } };
  return {
    ...identity,
    ClientSecretCredential: class extends identity.ClientSecretCredential {
      constructor(
        ...[tenant, client, secret]: ConstructorParameters<typeof identity.ClientSecretCredential>
      ) {
        super(tenant, client, secret, options);
      }
    },
    ClientCertificateCredential: class extends identity.ClientCertificateCredential {
      constructor(
        ...[tenant, client, certificate]: ConstructorParameters<typeof identity.ClientCertificateCredential>
      ) {
        super(tenant, client, certificate, options);
      }
    },
    WorkloadIdentityCredential: class extends identity.WorkloadIdentityCredential {
      constructor(settings?: ConstructorParameters<typeof identity.WorkloadIdentityCredential>[0]) {
        super({ ...settings, ...options });
      }
    },
    ManagedIdentityCredential: class extends identity.ManagedIdentityCredential {
      constructor(settings?: { clientId?: string }) {
        super({ ...settings, ...options });
      }
    },
  };
});

const tenant = '11111111-1111-4111-8111-111111111111';
const client = '22222222-2222-4222-8222-222222222222';
const authority = `https://login.microsoftonline.com/${tenant}`;
const tokenUrl = `${authority}/oauth2/v2.0/token`;
const scope = 'https://ossrdbms-aad.database.windows.net/.default';
let directory: string;
let certificate: string;
let forms: URLSearchParams[];
let denied: boolean;

beforeAll(() => {
  const cache = join(process.cwd(), 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  directory = mkdtempSync(join(cache, 'azure-tokens-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=riosoma.test',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'cert.pem'),
    ],
    { stdio: 'pipe' },
  );
  certificate =
    readFileSync(join(directory, 'key.pem'), 'utf8') + readFileSync(join(directory, 'cert.pem'), 'utf8');
  writeFileSync(join(directory, 'assertion'), 'workload-assertion');
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

beforeEach(() => {
  forms = [];
  denied = false;
  vi.stubEnv('AZURE_TENANT_ID', tenant);
  vi.stubEnv('AZURE_CLIENT_ID', client);
  vi.stubEnv('AZURE_FEDERATED_TOKEN_FILE', '');
  network.sendRequest.mockReset().mockImplementation(async (request) => {
    let status = 200;
    let body: object;
    if (request.url.includes('/.well-known/openid-configuration')) {
      body = {
        issuer: `${authority}/v2.0`,
        authorization_endpoint: `${authority}/oauth2/v2.0/authorize`,
        token_endpoint: tokenUrl,
        jwks_uri: `${authority}/discovery/v2.0/keys`,
      };
    } else if (request.url.startsWith(tokenUrl)) {
      expect(request.method).toBe('POST');
      const form = new URLSearchParams(String(request.body));
      forms.push(form);
      expect(form.get('grant_type')).toBe('client_credentials');
      expect(form.get('client_id')).toBe(client);
      if (denied) {
        status = 400;
        body = { error: 'invalid_client', error_description: 'test credential rejected' };
      } else {
        body = { access_token: `access-${forms.length}`, expires_in: 3600, token_type: 'Bearer' };
      }
    } else {
      throw new Error(`Unexpected Azure request: ${request.method} ${request.url}`);
    }
    return { request, status, headers: request.headers, bodyAsText: JSON.stringify(body) };
  });
});

function source(auth: Record<string, unknown>): () => Promise<string> {
  return passwordSource(
    DatabaseProfile.parse({
      host: 'db.example.test',
      port: 5432,
      database: 'riosoma',
      user: 'app',
      auth: { method: 'azure-entra', tenantId: tenant, clientId: client, ...auth },
    }),
  ) as () => Promise<string>;
}

it('exchanges the service principal secret and refreshes a shared token before expiry', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const token = source({ credential: 'service-principal', clientSecret: 'test-secret' });
  expect(await Promise.all([token(), token()])).toEqual(['access-1', 'access-1']);
  expect(forms).toHaveLength(1);
  expect(forms[0]!.get('client_secret')).toBe('test-secret');
  expect(forms[0]!.get('scope')).toBe(scope);
  vi.setSystemTime(Date.now() + 56 * 60 * 1000);
  expect(await token()).toBe('access-2');
  expect(forms).toHaveLength(2);
});

it('signs a client certificate assertion for the database token endpoint', async () => {
  expect(await source({ credential: 'service-principal', certificatePem: certificate })()).toBe('access-1');
  const form = forms[0]!;
  expect(form.get('client_secret')).toBeNull();
  expect(form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
  const parts = form.get('client_assertion')!.split('.');
  expect(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()).alg).toBe('PS256');
  expect(
    verify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      {
        key: readFileSync(join(directory, 'cert.pem')),
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
      },
      Buffer.from(parts[2]!, 'base64url'),
    ),
  ).toBe(true);
  const assertion = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
  expect(assertion).toMatchObject({ iss: client, sub: client, aud: tokenUrl });
});

it.each([false, true])(
  'exchanges a workload assertion for database or storage access (storage=%s)',
  async (storage) => {
    vi.stubEnv('AZURE_FEDERATED_TOKEN_FILE', join(directory, 'assertion'));
    const token = storage
      ? azureServiceToken('https://storage.azure.com/.default', client)
      : source({ credential: 'workload-identity' });
    expect(await token()).toBe('access-1');
    expect(forms[0]!.get('client_assertion')).toBe('workload-assertion');
    expect(forms[0]!.get('scope')).toBe(storage ? 'https://storage.azure.com/.default' : scope);
  },
);

it('propagates rejected credentials and retries without caching the failure', async () => {
  const token = source({ credential: 'service-principal', clientSecret: 'test-secret' });
  denied = true;
  await expect(token()).rejects.toThrow(/invalid_client/);
  denied = false;
  expect(await token()).toBe('access-2');
});

it.each([false, true])(
  'uses an App Service managed identity for database or storage access (storage=%s)',
  async (storage) => {
    vi.stubEnv('IDENTITY_ENDPOINT', 'https://identity.example.test/token');
    vi.stubEnv('IDENTITY_HEADER', 'test-identity-header');
    network.sendRequest.mockImplementation(async (request) => {
      const url = new URL(request.url);
      expect(url.origin + url.pathname).toBe('https://identity.example.test/token');
      expect(request.method).toBe('GET');
      expect(request.headers.get('x-identity-header')).toBe('test-identity-header');
      expect(url.searchParams.get('client_id')).toBe(client);
      expect(url.searchParams.get('resource')).toBe(
        storage ? 'https://storage.azure.com' : scope.replace('/.default', ''),
      );
      return {
        request,
        status: 200,
        headers: request.headers,
        bodyAsText: JSON.stringify({
          access_token: 'managed-token',
          expires_on: String(Math.floor(Date.now() / 1000) + 3600),
          token_type: 'Bearer',
          resource: url.searchParams.get('resource'),
        }),
      };
    });
    const token = storage
      ? azureServiceToken('https://storage.azure.com/.default', client)
      : source({ credential: 'managed-identity' });
    expect(await token()).toBe('managed-token');
    expect(await token()).toBe('managed-token');
    expect(network.sendRequest).toHaveBeenCalledOnce();
  },
);

it.each(['environment', 'workload'])(
  'keeps SQL Server default credentials noninteractive (%s)',
  async (kind) => {
    vi.stubEnv(
      'AZURE_TOKEN_CREDENTIALS',
      kind === 'environment' ? 'EnvironmentCredential' : 'WorkloadIdentityCredential',
    );
    vi.stubEnv('AZURE_CLIENT_SECRET', kind === 'environment' ? 'test-secret' : '');
    if (kind === 'workload') vi.stubEnv('AZURE_FEDERATED_TOKEN_FILE', join(directory, 'assertion'));
    const { DefaultAzureCredential } = await import('@azure/identity');
    const credential = new DefaultAzureCredential({ httpClient: network, retryOptions: { maxRetries: 0 } });
    expect((await credential.getToken('https://database.windows.net/.default'))?.token).toBe('access-1');
    expect(forms[0]!.get('scope')).toBe('https://database.windows.net/.default');
    expect(forms[0]!.get(kind === 'environment' ? 'client_secret' : 'client_assertion')).toBe(
      kind === 'environment' ? 'test-secret' : 'workload-assertion',
    );
  },
);
