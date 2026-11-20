import { describe, expect, it } from 'vitest';
import { deliverMessage, messageRequest, type MessageStep } from './messaging.js';
import { systemResolve } from './outbound.js';

const accountSid = process.env.RIOSOMA_TEST_TWILIO_ACCOUNT_SID;
const authToken = process.env.RIOSOMA_TEST_TWILIO_AUTH_TOKEN;
const from = process.env.RIOSOMA_TEST_TWILIO_FROM;
const to = process.env.RIOSOMA_TEST_TWILIO_TO;

// Opting in sends one real text message and can incur provider charges.
describe.skipIf(!accountSid || !authToken || !from || !to)('live text messaging', () => {
  it('submits a text message to the configured recipient', async () => {
    const step: MessageStep = {
      id: 'live01',
      name: '',
      kind: 'sms',
      accountSid: accountSid!,
      authToken: '',
      from: from!,
      to: to!,
      body: 'Riosoma messaging test',
    };
    const request = messageRequest(step, authToken!, () => ({ text: '', json: null, addresses: [] }));
    const result = await deliverMessage(step, request, {
      resolve: systemResolve,
      allowPrivate: false,
      timeoutMs: 10_000,
      renew: async () => {},
    });
    expect(result.status).toBe(201);
    expect(result.errorCode).toBeNull();
  });
});
