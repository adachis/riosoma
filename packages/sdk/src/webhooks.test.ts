import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  RioClientError,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  parseWebhookSignature,
  readWebhookPayload,
  verifyWebhookSignature,
} from './index.js';
import { hmacSha256Hex } from './encoding.js';
import { startApiServer, type TestApiServer } from './test/server.js';

/**
 * Checking a webhook call.  The unit cases sign a body here, with a secret made for the test, and
 * the last case takes a delivery from the real server's worker, which is the only way to be sure
 * the verifier reads the header the way the sender writes it.
 */

let api: TestApiServer;

beforeAll(async () => {
  api = await startApiServer({ prefix: 'sdkhooks', config: { webhooksPollMs: 0 } });
}, 120_000);

afterAll(async () => {
  await api?.close();
});

/** A secret made for one test, never one written down where it could be read later. */
const secret = () => `rio_whsec_${randomBytes(24).toString('base64url')}`;
const body = JSON.stringify({ id: 'dlv00000000000001', webhookId: 'whk00000000000001', events: [] });
const at = (seconds: number) => Math.floor(Date.now() / 1_000) + seconds;

async function signed(value: string, key: string, timestamp: number): Promise<string> {
  return `t=${timestamp},v1=${await hmacSha256Hex(key, `${timestamp}.${value}`)}`;
}

describe('a signature header', () => {
  it('reads the time and every signature in it', () => {
    expect(parseWebhookSignature('t=1760538600,v1=aa,v1=bb')).toEqual({
      timestamp: 1_760_538_600,
      signatures: [],
    });
    expect(parseWebhookSignature(`t=1760538600,v1=${'a'.repeat(64)}`)).toEqual({
      timestamp: 1_760_538_600,
      signatures: ['a'.repeat(64)],
    });
    expect(parseWebhookSignature(null)).toBeNull();
    expect(parseWebhookSignature('   ')).toBeNull();
    // A header that carries nothing readable is still a header, and reads as one with nothing in it.
    expect(parseWebhookSignature('nonsense')).toEqual({ timestamp: Number.NaN, signatures: [] });
  });

  it('accepts a call signed with this secret over this body', async () => {
    const key = secret();
    const timestamp = at(0);
    const header = await signed(body, key, timestamp);
    expect(await verifyWebhookSignature({ payload: body, signature: header, secret: key })).toEqual({
      valid: true,
      timestamp,
    });
    // Hex from a sender that writes it in capitals is the same signature.
    const upper = header.replace(/v1=(.*)$/, (_match, value: string) => `v1=${value.toUpperCase()}`);
    expect((await verifyWebhookSignature({ payload: body, signature: upper, secret: key })).valid).toBe(true);
    // A body that arrived as bytes is checked the same way.
    const bytes = new TextEncoder().encode(body);
    expect((await verifyWebhookSignature({ payload: bytes, signature: header, secret: key })).valid).toBe(
      true,
    );
  });

  it('accepts either signature while a replaced secret still signs', async () => {
    const current = secret();
    const previous = secret();
    const timestamp = at(-10);
    const header = [
      `t=${timestamp}`,
      `v1=${await hmacSha256Hex(current, `${timestamp}.${body}`)}`,
      `v1=${await hmacSha256Hex(previous, `${timestamp}.${body}`)}`,
    ].join(',');
    expect((await verifyWebhookSignature({ payload: body, signature: header, secret: current })).valid).toBe(
      true,
    );
    expect((await verifyWebhookSignature({ payload: body, signature: header, secret: previous })).valid).toBe(
      true,
    );
    expect((await verifyWebhookSignature({ payload: body, signature: header, secret: secret() })).valid).toBe(
      false,
    );
  });

  it('refuses a body, a secret, or a header that isn’t the one it was signed with', async () => {
    const key = secret();
    const timestamp = at(0);
    const header = await signed(body, key, timestamp);
    expect(
      await verifyWebhookSignature({ payload: `${body} `, signature: header, secret: key }),
    ).toMatchObject({ valid: false, problem: 'unsigned' });
    expect(
      await verifyWebhookSignature({ payload: body, signature: header, secret: secret() }),
    ).toMatchObject({ valid: false, problem: 'unsigned' });
    expect(await verifyWebhookSignature({ payload: body, signature: null, secret: key })).toMatchObject({
      valid: false,
      problem: 'missing',
    });
    expect(await verifyWebhookSignature({ payload: body, signature: 't=abc', secret: key })).toMatchObject({
      valid: false,
      problem: 'malformed',
    });
    expect(
      await verifyWebhookSignature({ payload: body, signature: `t=${timestamp}`, secret: key }),
    ).toMatchObject({ valid: false, problem: 'malformed' });
    await expect(verifyWebhookSignature({ payload: body, signature: header, secret: '' })).rejects.toThrow(
      RioClientError,
    );
  });

  it('refuses a call signed too long ago, so a copied one can’t be replayed', async () => {
    const key = secret();
    const stale = await signed(body, key, at(-301));
    expect(await verifyWebhookSignature({ payload: body, signature: stale, secret: key })).toMatchObject({
      valid: false,
      problem: 'stale',
    });
    // A receiver that knows a call is old, and wants it anyway, says how old it may be.
    expect(
      await verifyWebhookSignature({ payload: body, signature: stale, secret: key, toleranceSeconds: 600 }),
    ).toMatchObject({ valid: true });
    // A time in the future is just as much a replay, and just as refused.
    const future = await signed(body, key, at(301));
    expect(await verifyWebhookSignature({ payload: body, signature: future, secret: key })).toMatchObject({
      valid: false,
      problem: 'stale',
    });
    expect(
      await verifyWebhookSignature({ payload: body, signature: future, secret: key, toleranceSeconds: -1 }),
    ).toMatchObject({ valid: true });
  });
});

describe('a delivery from the server', () => {
  /** A receiver on this machine that keeps every call it gets. */
  interface Receiver {
    url: string;
    hits: Array<{ body: string; signature: string | null; deliveryId: string | null }>;
    close(): Promise<void>;
  }

  async function startReceiver(): Promise<Receiver> {
    const receiver: Receiver = { url: '', hits: [], close: async () => undefined };
    const listener: Server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        receiver.hits.push({
          body: Buffer.concat(chunks).toString('utf8'),
          signature: (request.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()] as string | undefined) ?? null,
          deliveryId: (request.headers[WEBHOOK_DELIVERY_HEADER.toLowerCase()] as string | undefined) ?? null,
        });
        response.end('ok');
      });
    });
    await new Promise<void>((settle) => listener.listen(0, '127.0.0.1', settle));
    const port = (listener.address() as AddressInfo).port;
    receiver.url = `http://127.0.0.1:${port}/hook`;
    receiver.close = async () => {
      listener.closeAllConnections();
      await new Promise<void>((settle) => listener.close(() => settle()));
    };
    return receiver;
  }

  it('arrives signed, and the verifier says so', async () => {
    const receiver = await startReceiver();
    // A webhook may only point at a private address while the server isn't in production, which a
    // test's own server is by default.
    api.server.ctx.config.production = false;
    const client = api.client();
    try {
      const webhook = await client.webhooks.create(api.databaseId, {
        url: receiver.url,
        events: ['record.created', 'record.updated'],
      });
      expect(webhook.secret).toMatch(/^rio_whsec_/);
      expect(webhook.id).toMatch(/^whk[0-9A-Za-z]{14}$/);

      const created = await client.records.create(api.tableId, [{ fields: { Name: 'Watched' } }]);
      await api.drainWebhooks();
      expect(receiver.hits).toHaveLength(1);
      const hit = receiver.hits[0]!;

      expect(
        await verifyWebhookSignature({ payload: hit.body, signature: hit.signature, secret: webhook.secret }),
      ).toMatchObject({
        valid: true,
      });
      const payload = await readWebhookPayload({
        payload: hit.body,
        signature: hit.signature,
        secret: webhook.secret,
        deliveryId: hit.deliveryId,
      });
      expect(payload.id).toBe(hit.deliveryId);
      expect(payload.webhookId).toBe(webhook.id);
      expect(payload.databaseId).toBe(api.databaseId);
      expect(payload.events).toHaveLength(1);
      expect(payload.events[0]).toMatchObject({
        event: 'record.created',
        tableId: api.tableId,
        recordId: created.ids[0],
      });
      expect(payload.events[0]!.fieldIds).toContain(api.fields.Name!.id);

      // A body one byte different from the one that arrived is not the one that was signed.  A
      // call names the change and never its values, so what's tampered with here is an ID.
      const tampered = hit.body.replace(payload.id, 'dlv00000000000002');
      expect(tampered).not.toBe(hit.body);
      expect(
        await verifyWebhookSignature({ payload: tampered, signature: hit.signature, secret: webhook.secret }),
      ).toMatchObject({ valid: false, problem: 'unsigned' });
      await expect(
        readWebhookPayload({
          payload: tampered,
          signature: hit.signature,
          secret: webhook.secret,
        }),
      ).rejects.toThrow(RioClientError);

      // The deliveries a webhook has had, and a secret replaced through the API, both work.
      const deliveries = await client.webhooks.deliveries(api.databaseId, webhook.id);
      expect(deliveries.deliveries.map((entry) => entry.id)).toContain(hit.deliveryId);
      expect(deliveries.deliveries[0]!.state).toBe('succeeded');
      const seen: string[] = [];
      for await (const delivery of client.webhooks.iterateDeliveries(api.databaseId, webhook.id))
        seen.push(delivery.id);
      expect(seen).toContain(hit.deliveryId);

      const rotated = await client.webhooks.rotateSecret(api.databaseId, webhook.id);
      expect(rotated.secret).not.toBe(webhook.secret);
      expect(Date.parse(rotated.previousExpiresAt)).toBeGreaterThan(Date.now());
      // A call signed with the secret it replaced still checks out until that time passes.
      expect(
        (
          await verifyWebhookSignature({
            payload: hit.body,
            signature: hit.signature,
            secret: webhook.secret,
          })
        ).valid,
      ).toBe(true);

      const listed = await client.webhooks.list(api.databaseId);
      expect(listed.map((entry) => entry.id)).toContain(webhook.id);
      const changed = await client.webhooks.update(api.databaseId, webhook.id, { enabled: false });
      expect(changed.enabled).toBe(false);
      await client.webhooks.delete(api.databaseId, webhook.id);
      expect((await client.webhooks.list(api.databaseId)).map((entry) => entry.id)).not.toContain(webhook.id);
    } finally {
      api.server.ctx.config.production = true;
      await receiver.close();
    }
  });
});
