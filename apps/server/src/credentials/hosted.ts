import { object, string, request, json, urlAt, tokenCache } from './http.js';
import { unavailable } from './envelope.js';
import type { ProfileOf } from './settings.js';
import type { CredentialVault } from './vault.js';

export function infisicalAdapter(profile: ProfileOf<'infisical'>): CredentialVault {
  const token = tokenCache(async () => {
    const answer = await request(
      urlAt(profile.endpoint, 'api/v1/auth/universal-auth/login'),
      json('POST', { clientId: profile.clientId, clientSecret: profile.clientSecret }),
    );
    return { token: string(answer.accessToken), seconds: Number(answer.expiresIn) };
  });
  const headers = async () => ({ authorization: `Bearer ${await token()}` });
  const scope = {
    projectId: profile.projectId,
    environment: profile.environment,
    secretPath: profile.secretPath,
    type: 'shared',
  };
  const path = (ref: string) => urlAt(profile.endpoint, `api/v4/secrets/${encodeURIComponent(ref)}`);
  return {
    async put(name, value) {
      await request(
        path(name),
        json('POST', { ...scope, secretValue: value, skipMultilineEncoding: true }, await headers()),
      );
      return name;
    },
    async get(ref) {
      return string(
        object(
          (
            await request(
              `${path(ref)}?${new URLSearchParams({ ...scope, expandSecretReferences: 'false' })}`,
              { headers: await headers() },
            )
          ).secret,
        ).secretValue,
      );
    },
    async remove(ref) {
      await request(path(ref), json('DELETE', scope, await headers()));
    },
  };
}

export function dopplerAdapter(profile: ProfileOf<'doppler'>): CredentialVault {
  const headers = { authorization: `Bearer ${profile.token}` };
  const scope = { project: profile.project, config: profile.config };
  return {
    async put(name, value) {
      const ref = name.replaceAll('-', '_').toUpperCase();
      await request(
        urlAt(profile.endpoint, 'v3/configs/config/secrets'),
        json('POST', { ...scope, secrets: { [ref]: value } }, headers),
      );
      return ref;
    },
    async get(ref) {
      return string(
        object(
          (
            await request(
              `${urlAt(profile.endpoint, 'v3/configs/config/secret')}?${new URLSearchParams({ ...scope, name: ref })}`,
              { headers },
            )
          ).value,
        ).raw,
      );
    },
    async remove(ref) {
      await request(
        `${urlAt(profile.endpoint, 'v3/configs/config/secret')}?${new URLSearchParams({ ...scope, name: ref })}`,
        { method: 'DELETE', headers },
      );
    },
  };
}

export function onepasswordAdapter(profile: ProfileOf<'onepassword'>): CredentialVault {
  const headers = { authorization: `Bearer ${profile.token}` };
  const path = (ref = '') =>
    urlAt(profile.endpoint, `v1/vaults/${profile.vaultId}/items${ref ? `/${encodeURIComponent(ref)}` : ''}`);
  return {
    async put(name, value) {
      const answer = await request(
        path(),
        json(
          'POST',
          {
            vault: { id: profile.vaultId },
            title: name,
            category: 'API_CREDENTIAL',
            fields: [{ id: 'credential', label: 'credential', type: 'CONCEALED', value }],
          },
          headers,
        ),
      );
      return string(answer.id);
    },
    async get(ref) {
      const answer = await request(path(ref), { headers });
      if (!Array.isArray(answer.fields)) throw unavailable();
      const field = answer.fields.map(object).find((field) => field.id === 'credential');
      return string(field?.value);
    },
    async remove(ref) {
      await request(path(ref), { method: 'DELETE', headers });
    },
  };
}
