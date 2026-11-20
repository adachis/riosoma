import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { KeyEncryptionKey } from './envelope.js';
import { object, string, json, request, urlAt, tokenCache } from './http.js';
import type { ProfileOf } from './settings.js';

export interface CredentialVault {
  put(name: string, value: string): Promise<string>;
  get(reference: string): Promise<string>;
  remove(reference: string): Promise<void>;
  key?: (id: string) => KeyEncryptionKey;
}

export function vaultAdapter(profile: ProfileOf<'vault' | 'openbao'>): CredentialVault {
  const namespace: Record<string, string> = profile.namespace
    ? { 'x-vault-namespace': profile.namespace }
    : {};
  const token = tokenCache(async () => {
    const auth = profile.auth;
    if (auth.kind === 'token') return { token: auth.token, seconds: 3600 };
    const payload =
      auth.kind === 'approle'
        ? { role_id: auth.roleId, secret_id: auth.secretId }
        : { role: auth.role, jwt: (await readFile(auth.jwtFile, 'utf8')).trim() };
    const answer = object(
      (
        await request(
          urlAt(profile.endpoint, `v1/auth/${auth.mount}/login`),
          json('POST', payload, namespace),
        )
      ).auth,
    );
    return { token: string(answer.client_token), seconds: Number(answer.lease_duration) };
  });
  const headers = async (): Promise<Record<string, string>> => ({
    ...namespace,
    'x-vault-token': await token(),
  });
  const path = (kind: string, ref: string) =>
    urlAt(profile.endpoint, `v1/${profile.mount}/${kind}/${encodeURIComponent(ref)}`);
  return {
    async put(name, value) {
      await request(
        path('data', name),
        json('POST', { options: { cas: 0 }, data: { value } }, await headers()),
      );
      return name;
    },
    async get(ref) {
      return string(
        object(object((await request(path('data', ref), { headers: await headers() })).data).data).value,
      );
    },
    async remove(ref) {
      await request(path('metadata', ref), { method: 'DELETE', headers: await headers() });
    },
    ...(profile.transit
      ? {
          key: (id: string): KeyEncryptionKey => {
            const transit = profile.transit!;
            const call = async (operation: string, payload: unknown) =>
              object(
                (
                  await request(
                    urlAt(profile.endpoint, `v1/${transit.mount}/${operation}/${transit.key}`),
                    json('POST', payload, await headers()),
                  )
                ).data,
              );
            const context = (aad: Buffer) => createHash('sha256').update(aad).digest('base64');
            return {
              id,
              async wrap(key, aad) {
                return string(
                  (
                    await call('encrypt', {
                      plaintext: key.toString('base64'),
                      context: context(aad),
                      associated_data: aad.toString('base64'),
                    })
                  ).ciphertext,
                );
              },
              async unwrap(wrapped, aad) {
                return Buffer.from(
                  string(
                    (
                      await call('decrypt', {
                        ciphertext: wrapped,
                        context: context(aad),
                        associated_data: aad.toString('base64'),
                      })
                    ).plaintext,
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
