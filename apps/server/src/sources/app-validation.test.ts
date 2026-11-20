import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerAppCatalog, SourceConnection, SourceCreate } from '@riosoma/contracts';
import { parse } from '../http/validate.js';
import { checkSecrets } from './store.js';

describe('app source request validation', () => {
  registerAppCatalog([
    {
      id: 'validation-example',
      name: 'Example',
      settings: [
        {
          key: 'account',
          required: true,
          type: 'address',
          domain: 'example.test',
          labelMessageId: 'sources.app.settingRequired',
          helpMessageId: 'sources.app.address',
        },
        {
          key: 'region',
          required: true,
          type: 'choice',
          values: ['us', 'eu'],
          labelMessageId: 'sources.app.settingRequired',
          helpMessageId: 'sources.app.settingInvalid',
        },
      ],
      secret: {
        name: 'password',
        helpMessageId: 'sources.app.secretMissing',
        deniedMessageId: 'sources.app.authenticate',
      },
      keyUrl: 'https://example.test/settings',
    },
  ]);
  it.each([
    [{ kind: 'app', app: 'missing', settings: {} }, 'connection.app', 'sources.app.unknown'],
    [
      { kind: 'app', app: 'hubspot', settings: { extra: 'value' } },
      'connection.settings.extra',
      'sources.app.undeclaredSetting',
    ],
  ])('preserves the app message and field for %s', (connection, field, messageKey) => {
    expect(() => parse(SourceCreate, { name: 'CRM', connection, secrets: {} })).toThrowError(
      expect.objectContaining({
        code: 'validation_failed',
        messageKey,
        fields: { [field]: messageKey },
      }),
    );
  });

  it.each([
    [{}, 'connection.settings.account', 'sources.app.settingRequired'],
    [
      { account: 'https://elsewhere.test', region: 'us' },
      'connection.settings.account',
      'sources.app.address',
    ],
    [
      { account: 'https://example.test', region: 'other' },
      'connection.settings.region',
      'sources.app.settingInvalid',
    ],
  ])('preserves preset setting validation for %s', (settings, field, messageKey) => {
    let error: unknown;
    try {
      parse(SourceCreate, {
        name: 'CRM',
        connection: { kind: 'app', app: 'validation-example', settings },
        secrets: {},
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'validation_failed', messageKey, fields: { [field]: messageKey } });
  });

  it('keeps arbitrary custom validation messages out of request errors', () => {
    const schema = z.string().superRefine((_value, ctx) => {
      ctx.addIssue({ code: 'custom', message: 'sources.app.untrusted' });
    });
    expect(() => parse(schema, 'value')).toThrowError(
      expect.objectContaining({
        messageKey: 'errors.validationFailed',
        fields: { _: 'validation.custom' },
      }),
    );
  });

  it.each(['hubspot', 'pipedrive'])('names a missing app key before executing %s', (app) => {
    const connection = SourceConnection.parse({ kind: 'app', app });
    expect(() => checkSecrets(connection, {})).toThrowError(
      expect.objectContaining({ code: 'validation_failed', messageKey: 'sources.app.secretMissing' }),
    );
  });
});
