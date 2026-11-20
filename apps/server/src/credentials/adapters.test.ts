import { generateKeyPairSync, hkdfSync, randomBytes, randomUUID, verify } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeVault, type Received } from './http.test-support.js';
import { vaultFor } from './adapters.js';
import { VaultProfile } from './settings.js';
import { decryptField, encryptField } from './bitwarden.js';

const secret = () => randomBytes(24).toString('hex');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function server(answer: Parameters<typeof fakeVault>[0]) {
  const fake = await fakeVault(answer);
  cleanups.push(fake.close);
  return fake;
}

describe('vault request formats', () => {
  for (const kind of ['vault', 'openbao'] as const)
    for (const authKind of ['token', 'approle', 'kubernetes'] as const)
      it(`${kind} uses KV v2 with ${authKind} authentication and authenticated Transit wrapping`, async () => {
        const token = secret(),
          value = secret(),
          roleId = secret(),
          secretId = secret(),
          jwt = secret();
        const folder = await mkdtemp(join(tmpdir(), 'credential-vaults-'));
        cleanups.push(() => rm(folder, { recursive: true, force: true }));
        const jwtFile = join(folder, 'identity');
        await writeFile(jwtFile, jwt);
        const calls: Received[] = [];
        const fake = await server((call) => {
          calls.push(call);
          if (call.path.includes('/login'))
            return { body: { auth: { client_token: token, lease_duration: 300 } } };
          if (call.path.includes('/encrypt/'))
            return {
              body: { data: { ciphertext: Buffer.from(JSON.stringify(call.body)).toString('base64') } },
            };
          if (call.path.includes('/decrypt/')) {
            const stored = JSON.parse(Buffer.from(String(call.body.ciphertext), 'base64').toString());
            if (stored.context !== call.body.context || stored.associated_data !== call.body.associated_data)
              return { status: 400 };
            return { body: { data: { plaintext: stored.plaintext } } };
          }
          if (call.method === 'GET') return { body: { data: { data: { value } } } };
          return { body: { data: { version: 1 } } };
        });
        const auth =
          authKind === 'token'
            ? { kind: authKind, token }
            : authKind === 'approle'
              ? { kind: authKind, roleId, secretId }
              : { kind: authKind, role: 'reader', jwtFile };
        const adapter = vaultFor(
          VaultProfile.parse({
            id: 'primary',
            kind,
            endpoint: fake.endpoint,
            auth,
            transit: { key: 'wrapping' },
          }),
        );
        const ref = await adapter.put('entry', value);
        expect(await adapter.get(ref)).toBe(value);
        await adapter.remove(ref);
        const write = calls.find((call) => call.path === '/v1/secret/data/entry' && call.method === 'POST')!;
        expect(write.body).toEqual({ options: { cas: 0 }, data: { value } });
        expect(write.headers['x-vault-token']).toBe(token);
        if (authKind !== 'token')
          expect(calls[0]!.body).toEqual(
            authKind === 'approle' ? { role_id: roleId, secret_id: secretId } : { role: 'reader', jwt },
          );
        expect(
          calls.some((call) => call.method === 'DELETE' && call.path === '/v1/secret/metadata/entry'),
        ).toBe(true);
        const key = adapter.key!('key'),
          data = randomBytes(32),
          aad = randomBytes(24);
        const wrapped = await key.wrap(data, aad);
        expect(await key.unwrap(wrapped, aad)).toEqual(data);
        await expect(key.unwrap(wrapped, randomBytes(24))).rejects.toThrow();
      });

  it('signs Secrets Manager and KMS calls with SigV4 and an encryption context', async () => {
    const value = secret(),
      accessKeyId = secret(),
      secretAccessKey = secret(),
      sessionToken = secret();
    const fake = await server((call) => {
      switch (call.headers['x-amz-target']) {
        case 'secretsmanager.CreateSecret':
          return { body: { ARN: 'entry' } };
        case 'secretsmanager.GetSecretValue':
          return { body: { SecretString: value } };
        case 'TrentService.Encrypt':
          return { body: { CiphertextBlob: secret() } };
        case 'TrentService.Decrypt':
          return { body: { Plaintext: Buffer.alloc(32).toString('base64') } };
        default:
          return { body: {} };
      }
    });
    const adapter = vaultFor(
      VaultProfile.parse({
        id: 'primary',
        kind: 'aws',
        endpoint: fake.endpoint,
        region: 'us-east-1',
        accessKeyId,
        secretAccessKey,
        sessionToken,
        kms: { endpoint: fake.endpoint, keyId: 'key' },
      }),
    );
    const name = `rio-${secret()}`;
    const ref = await adapter.put(name, value);
    expect(await adapter.get(ref)).toBe(value);
    await adapter.remove(ref);
    expect(fake.calls[0]!.body).toEqual({ Name: name, SecretString: value, ClientRequestToken: name });
    expect(fake.calls[0]!.headers.authorization).toContain(`Credential=${accessKeyId}/`);
    expect(fake.calls[0]!.headers.authorization).toContain('/us-east-1/secretsmanager/aws4_request');
    expect(fake.calls[0]!.headers['x-amz-security-token']).toBe(sessionToken);
    const key = adapter.key!('wrapping'),
      aad = randomBytes(10);
    await key.unwrap(await key.wrap(randomBytes(32), aad), aad);
    expect(fake.calls[3]!.body.EncryptionContext).toEqual(fake.calls[4]!.body.EncryptionContext);
    expect(fake.calls[3]!.headers.authorization).toContain('/kms/aws4_request');
  });

  it('exchanges a signed service account assertion and uses secret versions', async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 }),
      value = secret(),
      token = secret();
    const fake = await server((call) => {
      if (call.path === '/token') return { body: { access_token: token, expires_in: 3600 } };
      if (call.path.endsWith(':addVersion'))
        return { body: { name: 'projects/project/secrets/entry/versions/1' } };
      if (call.path.endsWith(':access'))
        return { body: { payload: { data: Buffer.from(value).toString('base64') } } };
      return { body: {} };
    });
    const adapter = vaultFor(
      VaultProfile.parse({
        id: 'primary',
        kind: 'google',
        endpoint: fake.endpoint,
        tokenEndpoint: `${fake.endpoint}/token`,
        project: 'project',
        clientEmail: secret(),
        privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      }),
    );
    const ref = await adapter.put('entry', value);
    expect(await adapter.get(ref)).toBe(value);
    await adapter.remove(ref);
    const parts = String(fake.calls[0]!.body.assertion).split('.');
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(parts.slice(0, 2).join('.')),
        pair.publicKey,
        Buffer.from(parts[2]!, 'base64url'),
      ),
    ).toBe(true);
    expect(fake.calls[1]!.body).toEqual({ replication: { automatic: {} } });
    expect(fake.calls[2]!.body).toEqual({ payload: { data: Buffer.from(value).toString('base64') } });
    expect(fake.calls[3]!.headers.authorization).toBe(`Bearer ${token}`);
  });

  it('uses client credentials and versioned Azure secret identifiers', async () => {
    const value = secret(),
      token = secret(),
      clientId = secret(),
      clientSecret = secret();
    const fake = await server((call) => {
      if (call.path === '/token') return { body: { access_token: token, expires_in: 3600 } };
      if (call.method === 'PUT') return { body: { id: `${fake.endpoint}/secrets/entry/1` } };
      return { body: { value } };
    });
    const adapter = vaultFor(
      VaultProfile.parse({
        id: 'primary',
        kind: 'azure',
        endpoint: fake.endpoint,
        auth: { kind: 'client', clientId, clientSecret, tokenEndpoint: `${fake.endpoint}/token` },
      }),
    );
    const ref = await adapter.put('entry', value);
    expect(ref).toBe('entry/1');
    expect(await adapter.get(ref)).toBe(value);
    await adapter.remove(ref);
    expect(fake.calls[0]!.body).toEqual({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://vault.azure.net/.default',
    });
    expect(fake.calls[1]!.body).toEqual({ value });
    expect(fake.calls[2]!.path).toBe('/secrets/entry/1?api-version=7.4');
  });

  it('uses universal authentication and the Infisical project and environment', async () => {
    const value = secret(),
      token = secret(),
      clientId = secret(),
      clientSecret = secret();
    const fake = await server((call) =>
      call.path.includes('/login')
        ? { body: { accessToken: token, expiresIn: 3600 } }
        : { body: { secret: { secretValue: value } } },
    );
    const adapter = vaultFor(
      VaultProfile.parse({
        id: 'primary',
        kind: 'infisical',
        endpoint: fake.endpoint,
        projectId: 'project',
        environment: 'testing',
        clientId,
        clientSecret,
      }),
    );
    const ref = await adapter.put('entry', value);
    expect(await adapter.get(ref)).toBe(value);
    await adapter.remove(ref);
    expect(fake.calls[0]!.body).toEqual({ clientId, clientSecret });
    expect(fake.calls[1]!.body).toEqual({
      projectId: 'project',
      environment: 'testing',
      secretPath: '/',
      type: 'shared',
      secretValue: value,
      skipMultilineEncoding: true,
    });
    expect(new URL(fake.calls[2]!.path, fake.endpoint).searchParams.get('expandSecretReferences')).toBe(
      'false',
    );
  });

  it('scopes Doppler requests to one project and configuration', async () => {
    const value = secret(),
      token = secret();
    const fake = await server(() => ({ body: { value: { raw: value } } }));
    const adapter = vaultFor(
      VaultProfile.parse({
        id: 'primary',
        kind: 'doppler',
        endpoint: fake.endpoint,
        project: 'project',
        config: 'testing',
        token,
      }),
    );
    const ref = await adapter.put('rio-entry', value);
    expect(await adapter.get(ref)).toBe(value);
    await adapter.remove(ref);
    expect(fake.calls[0]!.body).toEqual({
      project: 'project',
      config: 'testing',
      secrets: { RIO_ENTRY: value },
    });
    expect(fake.calls[0]!.headers.authorization).toBe(`Bearer ${token}`);
    expect(fake.calls[2]!.method).toBe('DELETE');
    expect(Object.fromEntries(new URL(fake.calls[2]!.path, fake.endpoint).searchParams)).toEqual({
      project: 'project',
      config: 'testing',
      name: ref,
    });
    expect(fake.calls[2]!.body).toEqual({});
  });

  it('uses a concealed field in 1Password Connect', async () => {
    const value = secret(),
      token = secret();
    const fake = await server(() => ({ body: { id: 'entry', fields: [{ id: 'credential', value }] } }));
    const adapter = vaultFor(
      VaultProfile.parse({
        id: 'primary',
        kind: 'onepassword',
        endpoint: fake.endpoint,
        vaultId: 'vault',
        token,
      }),
    );
    const ref = await adapter.put('entry', value);
    expect(await adapter.get(ref)).toBe(value);
    await adapter.remove(ref);
    expect(fake.calls[0]!.path).toBe('/v1/vaults/vault/items');
    expect(fake.calls[0]!.body).toEqual({
      vault: { id: 'vault' },
      title: 'entry',
      category: 'API_CREDENTIAL',
      fields: [{ id: 'credential', label: 'credential', type: 'CONCEALED', value }],
    });
  });

  it('decrypts the Bitwarden organization key and authenticates every encrypted field', async () => {
    const seed = randomBytes(16),
      key = randomBytes(64),
      value = secret(),
      token = secret(),
      clientSecret = secret(),
      clientId = randomUUID();
    const wrapping = Buffer.from(hkdfSync('sha256', seed, 'bitwarden-accesstoken', 'sm-access-token', 64));
    const fake = await server((call) => {
      if (call.path === '/connect/token')
        return {
          body: {
            access_token: token,
            expires_in: 3600,
            encrypted_payload: encryptField(
              wrapping,
              JSON.stringify({ encryptionKey: key.toString('base64') }),
            ),
          },
        };
      return { body: { id: 'entry', organizationId: 'organization', value: encryptField(key, value) } };
    });
    const adapter = vaultFor(
      VaultProfile.parse({
        id: 'primary',
        kind: 'bitwarden',
        endpoint: fake.endpoint,
        identityEndpoint: fake.endpoint,
        organizationId: 'organization',
        projectId: 'project',
        accessToken: `0.${clientId}.${clientSecret}:${seed.toString('base64')}`,
      }),
    );
    const ref = await adapter.put('entry', value);
    expect(await adapter.get(ref)).toBe(value);
    await adapter.remove(ref);
    expect(fake.calls[0]!.body).toEqual({
      grant_type: 'client_credentials',
      scope: 'api.secrets',
      client_id: clientId,
      client_secret: clientSecret,
    });
    expect(fake.calls[1]!.path).toBe('/organizations/organization/secrets');
    expect(decryptField(key, String(fake.calls[1]!.body.value))).toBe(value);
    const cipher = String(fake.calls[1]!.body.value);
    expect(() => decryptField(key, cipher.slice(0, -5))).toThrow();
    expect(() => decryptField(randomBytes(64), cipher)).toThrow();
    expect(fake.calls[3]!.body).toEqual({ ids: ['entry'] });
  });
});
