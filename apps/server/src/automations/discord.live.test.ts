/**
 * The Discord step against the real Discord.  It runs only when
 * `RIOSOMA_TEST_DISCORD_WEBHOOK_URL` is set to an incoming channel webhook, and skips otherwise.
 *
 * The step fills its message and delivers it through the real outbound client.  Asking the webhook
 * to wait makes its answer name the message it made, without reading any channel history.  The
 * message stays in the channel.  Only one send is allowed, even if the delivery helper asks to retry,
 * and neither the webhook address nor a raw response is quoted in a failure.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { deliverMessage, messageRequest, type MessageStep } from './messaging.js';
import * as outbound from './outbound.js';

const webhook = process.env.RIOSOMA_TEST_DISCORD_WEBHOOK_URL?.trim();

describe.skipIf(!webhook)('a Discord post through the messaging step', () => {
  it(
    'posts a message, and the answer names the message Discord made',
    { timeout: 60_000, retry: 0 },
    async () => {
      const suffix = randomBytes(4).toString('hex');
      const text = `rio_test_discord ${suffix}`;
      const step: MessageStep = {
        id: 'post-to-discord',
        name: '',
        kind: 'discord',
        webhookUrl: '',
        body: 'rio_test_discord {{trigger.body.text}}',
      };
      const request = messageRequest(step, webhook!, () => ({
        text: suffix,
        json: suffix,
        addresses: [],
      }));
      const post = outbound.callOut;
      let attempted = false;
      let sent: outbound.OutboundResponse | undefined;
      const watching = vi.spyOn(outbound, 'callOut').mockImplementation(async (original, options) => {
        if (attempted) throw new Error('The live check already attempted its one message');
        attempted = true;
        const url = new URL(original.url);
        url.searchParams.set('wait', 'true');
        sent = await post({ ...original, url: url.href }, options);
        return sent;
      });
      try {
        const result = await deliverMessage(step, request, {
          resolve: outbound.systemResolve,
          allowPrivate: false,
          timeoutMs: 20_000,
          renew: async () => {},
        });
        expect(result.status).toBe(200);
        expect(result.errorCode).toBeNull();
      } finally {
        watching.mockRestore();
      }
      let answer: { id?: unknown; channel_id?: unknown; webhook_id?: unknown; content?: unknown } = {};
      try {
        answer = JSON.parse(sent!.body) as typeof answer;
      } catch {
        // A malformed response fails the checks without quoting any response text.
      }
      expect(typeof answer.id === 'string' && /^\d+$/.test(answer.id)).toBe(true);
      expect(typeof answer.channel_id === 'string' && /^\d+$/.test(answer.channel_id)).toBe(true);
      expect(answer.webhook_id === new URL(webhook!).pathname.split('/')[3]).toBe(true);
      expect(answer.content === text).toBe(true);
    },
  );
});
