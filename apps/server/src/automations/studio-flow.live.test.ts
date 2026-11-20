import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { deliverMessage, messageRequest, webhookAllowed, type MessageStep } from './messaging.js';
import { systemResolve } from './outbound.js';

const address = process.env.RIOSOMA_TEST_COPILOT_FLOW_URL;

it.skipIf(!address)(
  'posts to the approved Teams flow trigger',
  async () => {
    expect(webhookAllowed('studioFlow', address!)).toBe(true);
    const step: MessageStep = {
      id: 'live01',
      name: '',
      kind: 'studioFlow',
      webhookUrl: '',
      title: '',
      recipient: process.env.RIOSOMA_TEST_FLOW_RECIPIENT ?? 'test',
      recordUrl: '',
      body: `Riosoma flow delivery test ${randomBytes(8).toString('hex')}`,
    };
    const request = messageRequest(step, address!, () => ({ text: '', json: null, addresses: [] }));
    const response = await deliverMessage(step, request, {
      resolve: systemResolve,
      allowPrivate: false,
      timeoutMs: 20_000,
      renew: async () => {},
    });
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    expect(response.errorCode).toBeNull();
  },
  60_000,
);
