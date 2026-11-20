import { NodeApiError } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { executeContext } from '../test/fake-context';
import { FakeRiosoma } from '../test/fake-riosoma';
import { describeError, queryString, riosomaRequest, scopeFor, serverAddress } from './api';

describe('requests', () => {
  it('reads the address however it was pasted', () => {
    expect(serverAddress(' https://riosoma.example.com/ ')).toBe('https://riosoma.example.com');
    expect(serverAddress('https://riosoma.example.com/api/v1/')).toBe('https://riosoma.example.com');
    expect(serverAddress('https://example.com/riosoma')).toBe('https://example.com/riosoma');
  });

  it('repeats a key for each item in a list and leaves out what is unset', () => {
    expect(queryString({ records: ['rec1', 'rec2'], shape: 'airtable', view: undefined, pageSize: 5 })).toBe(
      'records=rec1&records=rec2&shape=airtable&pageSize=5',
    );
  });

  it('names the scope each request needs', () => {
    expect(scopeFor('GET', '/databases')).toBe('schema.bases:read');
    expect(scopeFor('GET', '/tables/tbl1/records')).toBe('data.records:read');
    expect(scopeFor('PATCH', '/tables/tbl1/records')).toBe('data.records:write');
    expect(scopeFor('POST', '/databases/db1/webhooks')).toBe('schema.bases:write');
  });
});

describe('errors', () => {
  it('leads with the field and says what to do', () => {
    const { message, description } = describeError(
      422,
      {
        error: {
          code: 'validation_failed',
          messageKey: 'data.value.unknownChoice',
          message: 'The select option is unknown.',
          params: { field: 'Status', value: 'Pending' },
        },
      },
      'POST',
      '/tables/tbl1/records',
    );
    expect(message).toBe('Status: The select option is unknown.');
    expect(description).toContain('Field: "Status".  Value: "Pending".');
    expect(description).toContain('turn on Typecast');
    expect(description).toContain('Riosoma error: data.value.unknownChoice (validation_failed, status 422).');
  });

  it('names the missing scope for the request', () => {
    const { description } = describeError(
      403,
      {
        error: {
          code: 'forbidden',
          messageKey: 'errors.tokenScope',
          message: 'The token does not have the required scope.',
        },
      },
      'POST',
      '/databases/db1/webhooks',
    );
    expect(description).toContain('"Change tables, fields, and views" scope (schema.bases:write)');
  });

  it('points at the address when the answer is not from Riosoma', () => {
    expect(describeError(404, '<html>', 'GET', '/databases').description).toContain('Check the address');
  });

  it('throws an n8n API error carrying the status, message, and item', async () => {
    const api = new FakeRiosoma();
    api.failNext = {
      status: 401,
      body: {
        error: {
          code: 'unauthorized',
          messageKey: 'errors.tokenInvalid',
          message: 'The personal access token is invalid, expired, or revoked.',
        },
      },
    };
    const context = executeContext(api, {});
    const failure = await riosomaRequest(context, 'GET', '/databases', { itemIndex: 2 }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(NodeApiError);
    expect(failure).toMatchObject({
      message: 'The personal access token is invalid, expired, or revoked.',
      httpCode: '401',
    });
    expect((failure as NodeApiError).description).toContain('Personal access tokens');
    expect((failure as NodeApiError).context.itemIndex).toBe(2);
  });

  it('answers null for a missing resource when asked to', async () => {
    const context = executeContext(new FakeRiosoma(), {});
    await expect(
      riosomaRequest(context, 'GET', '/tables/tblMissing0000000/records', { missingOk: true }),
    ).resolves.toBeNull();
  });
});
