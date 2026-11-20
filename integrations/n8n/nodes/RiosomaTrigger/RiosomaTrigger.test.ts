import type { IDataObject } from 'n8n-workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { hookContext, webhookContext } from '../../test/fake-context';
import { DATABASE_ID, FakeRiosoma, FIELDS, TABLE_ID } from '../../test/fake-riosoma';
import { sign } from '../../shared/signature';
import { RiosomaTrigger } from './RiosomaTrigger.node';

const URL_HERE = 'https://n8n.example.com/webhook/0f0e/webhook';
const parameters = {
  database: { __rl: true, mode: 'list', value: DATABASE_ID },
  events: ['record.updated', 'record.created'],
  tables: [TABLE_ID],
  options: {},
};

const trigger = new RiosomaTrigger();
const lifecycle = trigger.webhookMethods.default;
let api: FakeRiosoma;
let saved: IDataObject;

beforeEach(() => {
  api = new FakeRiosoma();
  saved = {};
});

describe('registering the webhook', () => {
  it('adds a webhook for the chosen events and tables, keeping its secret', async () => {
    const context = hookContext(api, parameters, saved);
    expect(await lifecycle.checkExists.call(context)).toBe(false);
    expect(await lifecycle.create.call(context)).toBe(true);
    expect(api.webhooks).toHaveLength(1);
    expect(api.webhooks[0]).toMatchObject({
      url: URL_HERE,
      events: ['record.created', 'record.updated'],
      tableIds: [TABLE_ID],
    });
    expect(saved).toEqual({
      webhookId: api.webhooks[0]!.id,
      webhookSecret: 'rio_whsec_1',
      databaseId: DATABASE_ID,
    });
    expect(await lifecycle.checkExists.call(context)).toBe(true);
  });

  it('listens to every table when none are chosen', async () => {
    const context = hookContext(api, { ...parameters, tables: [] }, saved);
    await lifecycle.create.call(context);
    expect(api.webhooks[0]!.tableIds).toBeNull();
  });

  it('replaces a registration whose settings changed or whose secret was lost', async () => {
    await lifecycle.create.call(hookContext(api, parameters, saved));
    const changed = hookContext(api, { ...parameters, events: ['record.deleted'] }, saved);
    expect(await lifecycle.checkExists.call(changed)).toBe(false);
    expect(api.webhooks).toHaveLength(0);
    await lifecycle.create.call(changed);
    const forgetful = hookContext(api, parameters, {});
    expect(await lifecycle.checkExists.call(forgetful)).toBe(false);
    expect(api.webhooks).toHaveLength(0);
  });

  it('turns a webhook that turned itself off back on', async () => {
    const context = hookContext(api, parameters, saved);
    await lifecycle.create.call(context);
    api.webhooks[0]!.enabled = false;
    expect(await lifecycle.checkExists.call(context)).toBe(true);
    expect(api.webhooks[0]!.enabled).toBe(true);
  });

  it('removes the webhook when the workflow is turned off, even one already gone', async () => {
    const context = hookContext(api, parameters, saved);
    await lifecycle.create.call(context);
    expect(await lifecycle.delete.call(context)).toBe(true);
    expect(api.webhooks).toHaveLength(0);
    expect(saved).toEqual({});
    saved.webhookId = 'whk00000000000009';
    saved.databaseId = DATABASE_ID;
    expect(await lifecycle.delete.call(context)).toBe(true);
  });

  it("shows Riosoma's reason when it refuses the address", async () => {
    const context = hookContext(api, parameters, saved, 'http://n8n.internal:5678/webhook/0f0e/webhook');
    await expect(lifecycle.create.call(context)).rejects.toThrow('Webhook addresses must use https.');
  });
});

describe('receiving a call', () => {
  function call(events: object[], secret = 'rio_whsec_1', at = Math.floor(Date.now() / 1000)) {
    const payload = {
      id: 'dlv00000000000001',
      webhookId: 'whk00000000000001',
      databaseId: DATABASE_ID,
      events,
    };
    const raw = JSON.stringify(payload);
    return {
      headers: {
        'riosoma-signature': `t=${at},v1=${sign(secret, at, raw)}`,
        'riosoma-delivery-id': payload.id,
      },
      body: JSON.parse(raw) as unknown,
      rawBody: Buffer.from(raw),
    };
  }
  const event = (kind: string, recordId: string | null, seq: number) => ({
    event: kind,
    databaseId: DATABASE_ID,
    tableId: TABLE_ID,
    recordId,
    fieldIds: [FIELDS.name.id],
    seq,
    at: '2026-10-15T14:30:00.000Z',
  });

  beforeEach(() => {
    saved.webhookSecret = 'rio_whsec_1';
  });

  it('emits one item per event, in order, with each record read', async () => {
    const id = api.add({ [FIELDS.name.id]: 'Crate', [FIELDS.files.id]: ['att00000000000001'] });
    const { context } = webhookContext(
      api,
      parameters,
      saved,
      call([event('record.updated', id, 8), event('record.created', id, 7)]),
    );
    const result = await trigger.webhook.call(context);
    const items = result.workflowData![0]!.map((item) => item.json);
    expect(items.map((item) => [item.event, item.seq])).toEqual([
      ['record.created', 7],
      ['record.updated', 8],
    ]);
    expect(items[0]).toMatchObject({
      deliveryId: 'dlv00000000000001',
      recordId: id,
      record: {
        id,
        Name: 'Crate',
        Files: [{ url: 'https://riosoma.example.com/api/files/att00000000000001/file.pdf' }],
      },
    });
    // The same record is read once for both events.
    expect(api.requests.filter((request) => request.path.includes(`/records/${id}`))).toHaveLength(1);
  });

  it('gives a deleted record as null, and leaves records out when asked', async () => {
    const { context } = webhookContext(
      api,
      parameters,
      saved,
      call([event('record.updated', 'rec00000000000404', 1)]),
    );
    const result = await trigger.webhook.call(context);
    expect(result.workflowData![0]![0]!.json.record).toBeNull();
    const without = webhookContext(
      api,
      { ...parameters, options: { includeRecord: false } },
      saved,
      call([event('field.changed', null, 2)]),
    );
    const fields = await trigger.webhook.call(without.context);
    expect(fields.workflowData![0]![0]!.json).not.toHaveProperty('record');
  });

  it('refuses a call signed with another secret, or long ago, and emits nothing', async () => {
    for (const request of [
      call([event('record.created', null, 1)], 'rio_whsec_other'),
      call([event('record.created', null, 1)], 'rio_whsec_1', Math.floor(Date.now() / 1000) - 600),
      { headers: {}, body: {}, rawBody: Buffer.from('{}') },
    ]) {
      const { context, response } = webhookContext(api, parameters, saved, request);
      const result = await trigger.webhook.call(context);
      expect(result).toEqual({ noWebhookResponse: true });
      expect(response.statusCode).toBe(401);
    }
  });

  it('checks the raw body, so a call whose bytes changed is refused', async () => {
    const request = call([event('record.created', null, 1)]);
    request.rawBody = Buffer.from(request.rawBody.toString().replace('"seq":1', '"seq": 1'));
    const { context, response } = webhookContext(api, parameters, saved, request);
    await trigger.webhook.call(context);
    expect(response.statusCode).toBe(401);
  });
});
