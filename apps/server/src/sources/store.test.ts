import { describe, expect, it } from 'vitest';
import { ConnectorError } from '@riosoma/connectors';
import { connectorCall, messageParams } from './store.js';

describe('source diagnostics', () => {
  it.each([
    ['sources.sync.columnMissing', 'column', '名前🚢'],
    ['sources.sync.objectMissing', 'object', 'موانئ'],
  ])('preserves the source name for %s through the API error', async (messageKey, name, value) => {
    const error = new ConnectorError(messageKey, 'Remote schema changed', { [name]: value });
    expect(messageParams(error)).toEqual({ [name]: value });
    await expect(
      connectorCall(async () => {
        throw error;
      }),
    ).rejects.toMatchObject({
      messageKey,
      params: { [name]: value },
    });
  });

  it('withholds unrelated database diagnostics and unexpected parameters', () => {
    expect(
      messageParams(new ConnectorError('sources.sync.read', undefined, { connection: 'private' })),
    ).toBeUndefined();
    expect(
      messageParams(
        new ConnectorError('sources.sync.columnMissing', undefined, {
          column: 'name',
          connection: 'private',
        }),
      ),
    ).toEqual({ column: 'name' });
    expect(
      messageParams(
        new ConnectorError('sources.sync.columnMissing', undefined, { column: { name: 'name' } }),
      ),
    ).toBeUndefined();
  });

  it('preserves an app object and required permissions through API errors and sync diagnostics', async () => {
    const params = { object: 'tickets', permission: 'tickets-read', hasPermission: true };
    const error = new ConnectorError('sources.app.objectNotAllowed', undefined, params);
    expect(messageParams(error)).toEqual(params);
    await expect(
      connectorCall(async () => {
        throw error;
      }),
    ).rejects.toMatchObject({ messageKey: 'sources.app.objectNotAllowed', params });
  });
});
