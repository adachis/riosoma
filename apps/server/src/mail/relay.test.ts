import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MailTransportError } from './http.js';
import {
  RELAY_SIGNATURE_HEADER,
  RELAY_SIGNATURE_PREFIX,
  RELAY_TIMESTAMP_HEADER,
  relayMailer,
  relaySignature,
} from './relay.js';
import type { RelaySettings } from './settings.js';
import {
  fakeClock,
  sampleMessage,
  startStandInService,
  type RecordedRequest,
  type StandInService,
} from './test-helpers.js';

/**
 * The relay transport: the JSON it posts, the signature over the timestamp and the exact body bytes,
 * how a retry signs again, and how a busy or refusing relay reads.
 */

const SECRET = ['stand-in-relay-', 'signing-secret'].join('');
const FROM = 'Riosoma <sender@example.test>';

let service: StandInService | null = null;

afterEach(async () => {
  await service?.close();
  service = null;
});

async function standIn(): Promise<{ stand: StandInService; settings: RelaySettings }> {
  service = await startStandInService();
  return { stand: service, settings: { from: FROM, url: `${service.url}/outbound/mail`, secret: SECRET } };
}

/** The signature a relay recomputes: over the timestamp, a period, and the body it received. */
function signatureOf(request: RecordedRequest): string {
  return createHmac('sha256', Buffer.from(SECRET, 'utf8'))
    .update(`${request.headers[RELAY_TIMESTAMP_HEADER]}.${request.body}`, 'utf8')
    .digest('hex');
}

describe('posting to a relay', () => {
  it('signs the timestamp and the body with the shared secret', () => {
    expect(relaySignature('secret', '1700000000', '{"to":"a"}')).toBe(
      `${RELAY_SIGNATURE_PREFIX}${createHmac('sha256', 'secret').update('1700000000.{"to":"a"}').digest('hex')}`,
    );
  });

  it('posts the message as JSON with its attachment and headers', async () => {
    const { stand, settings } = await standIn();
    stand.answer({ status: 202 });
    await relayMailer(settings).send(sampleMessage());

    expect(stand.requests).toHaveLength(1);
    const request = stand.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.target).toBe('/outbound/mail');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['user-agent']).toBe('Riosoma-Mail');

    const timestamp = Number(request.headers[RELAY_TIMESTAMP_HEADER]);
    expect(timestamp).toBeGreaterThan(Date.now() / 1_000 - 60);
    expect(timestamp).toBeLessThan(Date.now() / 1_000 + 60);
    expect(request.headers[RELAY_SIGNATURE_HEADER]).toBe(`${RELAY_SIGNATURE_PREFIX}${signatureOf(request)}`);

    expect(JSON.parse(request.body)).toEqual({
      from: FROM,
      to: 'recipient@example.test',
      subject: 'Résumé für Ñandú Nº 42',
      text: 'The plain text body.',
      html: '<p>The plain text body.</p>',
      headers: { 'List-Unsubscribe': '<mailto:list@example.test?subject=unsubscribe>' },
      attachments: [
        {
          filename: 'report.csv',
          contentType: 'text/csv',
          content: sampleMessage().attachments![0]!.content.toString('base64'),
        },
      ],
    });
  });

  it('leaves out the parts a message doesn’t have', async () => {
    const { stand, settings } = await standIn();
    stand.answer({ status: 200 });
    await relayMailer(settings).send(sampleMessage({ attachments: [], headers: {} }));
    expect(JSON.parse(stand.requests[0]!.body)).toEqual({
      from: FROM,
      to: 'recipient@example.test',
      subject: 'Résumé für Ñandú Nº 42',
      text: 'The plain text body.',
      html: '<p>The plain text body.</p>',
    });
  });

  it('waits out a 429 answer’s Retry-After and signs the retry again', async () => {
    const { stand, settings } = await standIn();
    stand.answer({ status: 429, headers: { 'retry-after': '6' } }, { status: 204 });
    const clock = fakeClock();
    await relayMailer(settings, {
      now: clock.now,
      wait: async (ms) => {
        clock.waits.push(ms);
        clock.advance(Math.max(ms, 1_000));
      },
    }).send(sampleMessage());

    expect(clock.waits).toEqual([6_000]);
    expect(stand.requests).toHaveLength(2);
    const [first, second] = stand.requests as [RecordedRequest, RecordedRequest];
    expect(second.headers[RELAY_TIMESTAMP_HEADER]).not.toBe(first.headers[RELAY_TIMESTAMP_HEADER]);
    expect(second.headers[RELAY_SIGNATURE_HEADER]).toBe(`${RELAY_SIGNATURE_PREFIX}${signatureOf(second)}`);
  });

  it('gives up after three retries and says which transport failed', async () => {
    const { stand, settings } = await standIn();
    stand.answer({ status: 502 });
    const clock = fakeClock();
    const delivery = relayMailer(settings, { now: clock.now, wait: clock.wait }).send(sampleMessage());
    const error = await delivery.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(MailTransportError);
    expect((error as Error).message).toBe(
      'The mail relay could not send the message: the service answered HTTP 502',
    );
    expect((error as MailTransportError).transport).toBe('relay');
    expect(stand.requests).toHaveLength(4);
    expect(clock.waits).toEqual([500, 1_000, 2_000]);
  });

  it('reports a relay that refuses the message at once', async () => {
    const { stand, settings } = await standIn();
    stand.answer({ status: 400, body: { error: 'bad_request' } });
    const delivery = relayMailer(settings).send(sampleMessage());
    await expect(delivery).rejects.toThrow(
      'The mail relay could not send the message: the service answered HTTP 400 bad_request',
    );
    expect(stand.requests).toHaveLength(1);
  });

  it('reports a relay that never answers', async () => {
    const { stand, settings } = await standIn();
    stand.answer({ dropConnection: true });
    const clock = fakeClock();
    const delivery = relayMailer(settings, { now: clock.now, wait: clock.wait }).send(sampleMessage());
    await expect(delivery).rejects.toThrow(
      /The mail relay could not send the message: the service could not be reached/,
    );
    expect(((await delivery.catch((thrown: unknown) => thrown)) as MailTransportError).code).toBe(
      'unreachable',
    );
    expect(stand.requests).toHaveLength(4);
  });
});
