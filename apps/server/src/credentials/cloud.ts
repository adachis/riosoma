import { unavailable } from './envelope.js';
import { createHash, sign } from 'node:crypto';
import { payloadHash, signAwsRequest } from '@riosoma/connectors/s3';
import { object, string, request, json, urlAt, tokenCache } from './http.js';
import type { ProfileOf } from './settings.js';
import type { CredentialVault } from './vault.js';

export function awsAdapter(profile: ProfileOf<'aws'>): CredentialVault {
  const call = async (
    operation: string,
    payload: unknown,
    service = 'secretsmanager',
    endpoint = profile.endpoint,
  ) => {
    const url = new URL(endpoint);
    const body = JSON.stringify(payload);
    const target = service === 'kms' ? `TrentService.${operation}` : `secretsmanager.${operation}`;
    const headers = signAwsRequest({
      method: 'POST',
      url,
      region: profile.region,
      service,
      credentials: profile,
      now: new Date(),
      hash: payloadHash(body),
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target },
    });
    return request(url, { method: 'POST', headers, body });
  };
  return {
    async put(name, value) {
      return string(
        (await call('CreateSecret', { Name: name, SecretString: value, ClientRequestToken: name })).ARN,
      );
    },
    async get(ref) {
      return string((await call('GetSecretValue', { SecretId: ref })).SecretString);
    },
    async remove(ref) {
      await call('DeleteSecret', { SecretId: ref, ForceDeleteWithoutRecovery: true });
    },
    ...(profile.kms
      ? {
          key: (id: string) => {
            const kms = profile.kms!;
            const context = (aad: Buffer) => ({ binding: createHash('sha256').update(aad).digest('hex') });
            return {
              id,
              async wrap(key: Buffer, aad: Buffer) {
                return string(
                  (
                    await call(
                      'Encrypt',
                      {
                        KeyId: kms.keyId,
                        Plaintext: key.toString('base64'),
                        EncryptionContext: context(aad),
                      },
                      'kms',
                      kms.endpoint,
                    )
                  ).CiphertextBlob,
                );
              },
              async unwrap(wrapped: string, aad: Buffer) {
                return Buffer.from(
                  string(
                    (
                      await call(
                        'Decrypt',
                        { KeyId: kms.keyId, CiphertextBlob: wrapped, EncryptionContext: context(aad) },
                        'kms',
                        kms.endpoint,
                      )
                    ).Plaintext,
                  ),
                  'base64',
                );
              },
            };
          },
        }
      : {}),
  };
}

export function googleAdapter(profile: ProfileOf<'google'>): CredentialVault {
  const token = tokenCache(async () => {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${part({ alg: 'RS256', typ: 'JWT', ...(profile.keyId ? { kid: profile.keyId } : {}) })}.${part({ iss: profile.clientEmail, aud: profile.tokenEndpoint, scope: 'https://www.googleapis.com/auth/cloud-platform', iat: now, exp: now + 3600 })}`;
    const assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), profile.privateKey).toString('base64url')}`;
    const answer = await request(profile.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    return { token: string(answer.access_token), seconds: Number(answer.expires_in) };
  });
  const headers = async () => ({ authorization: `Bearer ${await token()}` });
  const path = (ref: string) => urlAt(profile.endpoint, `v1/${ref}`);
  return {
    async put(name, value) {
      const ref = `projects/${profile.project}/secrets/${name}`;
      await request(
        `${path(`projects/${profile.project}/secrets`)}?secretId=${name}`,
        json('POST', { replication: { automatic: {} } }, await headers()),
      );
      const version = await request(
        `${path(ref)}:addVersion`,
        json('POST', { payload: { data: Buffer.from(value).toString('base64') } }, await headers()),
      );
      return string(version.name);
    },
    async get(ref) {
      return Buffer.from(
        string(object((await request(`${path(ref)}:access`, { headers: await headers() })).payload).data),
        'base64',
      ).toString('utf8');
    },
    async remove(ref) {
      await request(path(ref.split('/versions/')[0]!), { method: 'DELETE', headers: await headers() });
    },
  };
}

export function azureAdapter(profile: ProfileOf<'azure'>): CredentialVault {
  const auth = profile.auth;
  const token =
    auth.kind === 'managed'
      ? tokenCache(async () => {
          const url = new URL(auth.identityEndpoint);
          if (
            url.username ||
            url.password ||
            url.hash ||
            (url.protocol !== 'https:' &&
              !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', '169.254.169.254'].includes(url.hostname)))
          )
            throw unavailable();
          url.searchParams.set('api-version', auth.identityHeader ? '2019-08-01' : '2018-02-01');
          url.searchParams.set('resource', 'https://vault.azure.net');
          if (auth.clientId) url.searchParams.set('client_id', auth.clientId);
          const headers: Record<string, string> = auth.identityHeader
            ? { 'x-identity-header': auth.identityHeader }
            : { Metadata: 'true' };
          const answer = await request(url, { headers });
          const seconds =
            answer.expires_in === undefined
              ? Number(answer.expires_on) - Date.now() / 1000
              : Number(answer.expires_in);
          return { token: string(answer.access_token), seconds };
        })
      : tokenCache(async () => {
          const answer = await request(auth.tokenEndpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'client_credentials',
              client_id: auth.clientId,
              client_secret: auth.clientSecret,
              scope: 'https://vault.azure.net/.default',
            }),
          });
          return { token: string(answer.access_token), seconds: Number(answer.expires_in) };
        });
  const headers = async () => ({ authorization: `Bearer ${await token()}` });
  const path = (ref: string) => `${urlAt(profile.endpoint, `secrets/${ref}`)}?api-version=7.4`;
  return {
    async put(name, value) {
      const result = await request(path(name), json('PUT', { value }, await headers()));
      const id = new URL(string(result.id));
      if (id.origin !== new URL(profile.endpoint).origin) throw unavailable();
      return id.pathname.slice('/secrets/'.length);
    },
    async get(ref) {
      return string((await request(path(ref), { headers: await headers() })).value);
    },
    async remove(ref) {
      await request(path(ref.split('/')[0]!), { method: 'DELETE', headers: await headers() });
    },
  };
}
