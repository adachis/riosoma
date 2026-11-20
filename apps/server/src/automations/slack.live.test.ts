/**
 * The Slack step's message against the real Slack.  It runs only when
 * `RIOSOMA_TEST_SLACK_BOT_TOKEN` and `RIOSOMA_TEST_SLACK_CHANNEL` (a channel ID the bot can post to)
 * are both set, and skips otherwise.  The bot needs `chat:write`.
 *
 * The step uses an incoming webhook in a run.  Here its request is sent through `chat.postMessage`
 * with the test bot and channel, so Slack answers with the message it made.  The step still fills
 * its message and delivers it through the real outbound client.  Only that one send is allowed,
 * even if the delivery helper asks to retry.  The message stays in the channel, no history is read,
 * and neither the token nor a raw response is quoted in a failure.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { deliverMessage, messageRequest, type MessageStep } from './messaging.js';
import * as outbound from './outbound.js';

const token = process.env.RIOSOMA_TEST_SLACK_BOT_TOKEN?.trim();
const channel = process.env.RIOSOMA_TEST_SLACK_CHANNEL?.trim();

describe.skipIf(!token || !channel)('a Slack post through the messaging step', () => {
  it(
    'posts a message, and the answer names the message Slack made',
    { timeout: 60_000, retry: 0 },
    async () => {
      const suffix = randomBytes(4).toString('hex');
      const text = `rio_test_slack ${suffix}`;
      const step: MessageStep = {
        id: 'post-to-slack',
        name: '',
        kind: 'slack',
        webhookUrl: '',
        body: 'rio_test_slack {{trigger.body.text}}',
      };
      // This address only lets the step build its webhook payload, and is never contacted.
      const request = messageRequest(step, 'https://hooks.slack.com/', () => ({
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
        sent = await post(
          {
            ...original,
            url: 'https://slack.com/api/chat.postMessage',
            headers: { ...original.headers, authorization: `Bearer ${token!}` },
            body: JSON.stringify({ ...JSON.parse(original.body!), channel: channel! }),
          },
          options,
        );
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
      let answer: {
        ok?: unknown;
        channel?: unknown;
        ts?: unknown;
        message?: { text?: unknown; ts?: unknown };
      } = {};
      try {
        answer = JSON.parse(sent!.body) as typeof answer;
      } catch {
        // A malformed response fails the checks without quoting any response text.
      }
      expect(answer.ok === true).toBe(true);
      expect(answer.channel === channel).toBe(true);
      expect(typeof answer.ts === 'string' && /^\d+\.\d+$/.test(answer.ts)).toBe(true);
      expect(answer.message?.ts === answer.ts).toBe(true);
      expect(answer.message?.text === text).toBe(true);
    },
  );
});
