import { randomBytes } from 'node:crypto';
import { registerAppCatalog, SourceConnection } from '@riosoma/contracts';
import { expect, it } from 'vitest';
import { checkSecrets } from './store.js';

it('requires every sealed app value and identifies the missing field without exposing credentials', () => {
  registerAppCatalog([
    {
      id: 'frame-validation',
      name: 'Example',
      settings: [],
      secret: {
        name: 'clientSecret',
        helpMessageId: 'sources.app.key',
        deniedMessageId: 'sources.app.authenticate',
      },
      additionalSecrets: [
        {
          name: 'refreshToken',
          labelMessageId: 'sources.app.refreshToken',
          helpMessageId: 'sources.app.key',
        },
      ],
      keyUrl: 'https://example.test/keys',
    },
  ]);
  const connection = SourceConnection.parse({ kind: 'app', app: 'frame-validation' });
  const clientSecret = randomBytes(24).toString('hex');
  const refreshToken = randomBytes(24).toString('hex');
  expect(() => checkSecrets(connection, { clientSecret })).toThrowError(
    expect.objectContaining({
      messageKey: 'sources.app.secretMissing',
      params: { fieldMessageId: 'sources.app.refreshToken' },
      fields: { refreshToken: 'sources.app.secretMissing' },
    }),
  );
  expect(() => checkSecrets(connection, { clientSecret, refreshToken })).not.toThrow();
});
