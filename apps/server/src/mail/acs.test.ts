import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../configuration-error.js';
import { ACS_API_VERSION, ACS_SIGNED_HEADERS, acsHeaders, acsMailer } from './acs.js';
import { MailTransportError } from './http.js';
import { acsConnectionString, type AcsSettings } from './settings.js';
import {
  fakeClock,
  sampleMessage,
  startStandInService,
  type RecordedRequest,
  type StandInService,
} from './test-helpers.js';

/**
 * Azure Communication Services delivery: the access key signature over the string the service
 * documents, the JSON message with its attachment and Unicode subject, the operation that's followed
 * until it ends, and how a busy, refusing, or never-ending send reads.
 */

const ACCESS_KEY = Buffer.from('stand-in-acs-access-key-0123456789', 'utf8').toString('base64');
const FROM = 'Riosoma <sender@example.test>';
const SEND_PATH = `/emails:send?api-version=${ACS_API_VERSION}`;
/** The base64 SHA-256 of nothing, which a call with no body signs. */
const EMPTY_HASH = '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=';

const settings: AcsSettings = {
  from: FROM,
  endpoint: 'https://resource.communication.azure.com',
  accessKey: ACCESS_KEY,
};

let service: StandInService | null = null;

afterEach(async () => {
  await service?.close();
  service = null;
});

async function standIn(): Promise<StandInService> {
  service = await startStandInService();
  return service;
}

/** The signature the service documents, over the path and query exactly as they arrived. */
function signatureOf(request: RecordedRequest, accessKey: string): string {
  const path = request.target;
  const signed = [
    request.method.toUpperCase(),
    path,
    `${request.headers['x-ms-date']};${request.headers.host};${request.headers['x-ms-content-sha256']}`,
  ].join('\n');
  return createHmac('sha256', Buffer.from(accessKey, 'base64')).update(signed, 'utf8').digest('base64');
}

describe('the access key signature', () => {
  // The vectors Microsoft's own SDK for the service checks its signer against: the key `pw==`, a
  // body-less GET, and a fixed date, signed for a path with a query, one without, and a port.
  it.each([
    ['https://example.com/testPath?testQuery=test', 'DGdgwggJWnQyc6EHjR/Vbqg1ES64KpD6U2XwTDDj3tU='],
    ['https://example.com/testPath', '+6tWkg3lNKVjQHHmxkdGQcJjUgzclsWTMebnuCz1ngU='],
    ['https://example.com:8080/testPath', 'zFAbbRWjUmDbcK/DT3cYgnwMyh+kXJxBpC3qlxnPCh0='],
  ])('signs the published vector for %s exactly', (url, signature) => {
    const headers = acsHeaders(
      'GET',
      new URL(url),
      '',
      new Date('2022-04-13T18:09:12.451Z'),
      ['pw', '=='].join(''),
    );
    expect(headers['x-ms-date']).toBe('Wed, 13 Apr 2022 18:09:12 GMT');
    expect(headers['x-ms-content-sha256']).toBe(EMPTY_HASH);
    expect(headers.authorization).toBe(
      `HMAC-SHA256 SignedHeaders=${ACS_SIGNED_HEADERS}&Signature=${signature}`,
    );
  });

  it('signs a query exactly as it is sent, without encoding it again', () => {
    const url = new URL(
      'https://resource.communication.azure.com/emails/operations/a%20b?api-version=2023-03-31&note=a%20b',
    );
    const date = new Date(Date.now() - 60_000);
    const headers = acsHeaders('GET', url, '', date, ACCESS_KEY);
    const signed = `GET\n/emails/operations/a%20b?api-version=2023-03-31&note=a%20b\n${date.toUTCString()};resource.communication.azure.com;${EMPTY_HASH}`;
    expect(headers.authorization).toBe(
      `HMAC-SHA256 SignedHeaders=${ACS_SIGNED_HEADERS}&Signature=${createHmac(
        'sha256',
        Buffer.from(ACCESS_KEY, 'base64'),
      )
        .update(signed, 'utf8')
        .digest('base64')}`,
    );
  });

  it('signs the method, the path with its query, and the date, host, and body hash', () => {
    const url = new URL('https://resource.communication.azure.com/emails:send?api-version=2023-03-31');
    const date = new Date(Date.now() - 60_000);
    const body = JSON.stringify({ senderAddress: 'sender@example.test' });
    const headers = acsHeaders('POST', url, body, date, ACCESS_KEY);
    const hash = createHash('sha256').update(body, 'utf8').digest('base64');
    const signed = `POST\n/emails:send?api-version=2023-03-31\n${date.toUTCString()};resource.communication.azure.com;${hash}`;
    expect(headers['x-ms-date']).toBe(date.toUTCString());
    expect(headers['x-ms-content-sha256']).toBe(hash);
    expect(headers.authorization).toBe(
      `HMAC-SHA256 SignedHeaders=${ACS_SIGNED_HEADERS}&Signature=${createHmac(
        'sha256',
        Buffer.from(ACCESS_KEY, 'base64'),
      )
        .update(signed, 'utf8')
        .digest('base64')}`,
    );
  });

  it('signs a body-less call with the hash of nothing', () => {
    const headers = acsHeaders(
      'GET',
      new URL('https://resource.communication.azure.com/emails/operations/1?api-version=2023-03-31'),
      '',
      new Date(Date.now() - 60_000),
      ACCESS_KEY,
    );
    expect(headers['x-ms-content-sha256']).toBe(EMPTY_HASH);
  });

  it('reads a connection string’s parts by name', () => {
    expect(
      acsConnectionString(
        `accesskey=${ACCESS_KEY};endpoint=https://resource.communication.azure.com/;newpart=ignored`,
      ),
    ).toEqual({ accessKey: ACCESS_KEY, endpoint: 'https://resource.communication.azure.com/' });
    expect(() => acsConnectionString('endpoint=https://resource.communication.azure.com')).toThrow(
      /RIOSOMA_ACS_CONNECTION_STRING is invalid \(names no accesskey\)/,
    );
    expect(() => acsConnectionString(`accesskey=${ACCESS_KEY}`)).toThrow(
      /RIOSOMA_ACS_CONNECTION_STRING is invalid \(names no endpoint\)/,
    );
  });
});

describe('sending through Azure Communication Services', () => {
  it('posts the message as JSON, signed, and follows the operation', async () => {
    const stand = await standIn();
    const operationId = '8540c0de-899f-5cce-acb5-3ec493af3800';
    stand.answer(
      { status: 202, headers: { 'operation-location': `${stand.url}/emails/operations/${operationId}` } },
      { status: 200, body: { id: operationId, status: 'Running' } },
      { status: 200, body: { id: operationId, status: 'Succeeded' } },
    );
    const clock = fakeClock();
    await acsMailer({ ...settings, endpoint: stand.url }, { now: clock.now, wait: clock.wait }).send(
      sampleMessage(),
    );
    // The operation asked for no wait, so it's asked again a second later.
    expect(clock.waits).toEqual([1_000]);

    expect(stand.requests.map((request) => request.target)).toEqual([
      SEND_PATH,
      `/emails/operations/${operationId}`,
      `/emails/operations/${operationId}`,
    ]);
    const [sent, poll] = stand.requests as [RecordedRequest, RecordedRequest];
    expect(sent.method).toBe('POST');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.headers.authorization).toBe(
      `HMAC-SHA256 SignedHeaders=${ACS_SIGNED_HEADERS}&Signature=${signatureOf(sent, ACCESS_KEY)}`,
    );
    expect(sent.headers['x-ms-content-sha256']).toBe(
      createHash('sha256').update(sent.body, 'utf8').digest('base64'),
    );

    const body = JSON.parse(sent.body) as Record<string, unknown>;
    expect(body).toEqual({
      senderAddress: 'sender@example.test',
      recipients: { to: [{ address: 'recipient@example.test' }] },
      content: {
        subject: 'Résumé für Ñandú Nº 42',
        plainText: 'The plain text body.',
        html: '<p>The plain text body.</p>',
      },
      attachments: [
        {
          name: 'report.csv',
          contentType: 'text/csv',
          contentInBase64: sampleMessage().attachments![0]!.content.toString('base64'),
        },
      ],
      headers: { 'List-Unsubscribe': '<mailto:list@example.test?subject=unsubscribe>' },
    });

    // The poll signs too, with the hash of its empty body.
    expect(poll.method).toBe('GET');
    expect(poll.headers['x-ms-content-sha256']).toBe(EMPTY_HASH);
    expect(poll.headers.authorization).toBe(
      `HMAC-SHA256 SignedHeaders=${ACS_SIGNED_HEADERS}&Signature=${signatureOf(poll, ACCESS_KEY)}`,
    );
  });

  it('keeps a name beside an address it sends to', async () => {
    const stand = await standIn();
    stand.answer({ status: 202, headers: { 'operation-location': `${stand.url}/emails/operations/1` } });
    const clock = fakeClock();
    const delivery = acsMailer(
      { ...settings, endpoint: stand.url },
      { now: clock.now, pollTimeoutMs: 0 },
    ).send(sampleMessage({ to: 'Ñandú <recipient@example.test>' }));
    // The send is accepted, and the operation it's told to follow times out at once.
    await expect(delivery).rejects.toThrow(MailTransportError);
    expect((JSON.parse(stand.requests[0]!.body) as { recipients: unknown }).recipients).toEqual({
      to: [{ address: 'recipient@example.test', displayName: 'Ñandú' }],
    });
  });

  it('carries a managed identity token when there is no access key', async () => {
    const stand = await standIn();
    stand.answer({ status: 202, headers: { 'operation-location': `${stand.url}/emails/operations/1` } });
    const delivery = acsMailer(
      { from: 'sender@example.test', endpoint: stand.url },
      { token: async () => 'stand-in-managed-identity-token', pollTimeoutMs: 0 },
    ).send(sampleMessage());
    await expect(delivery).rejects.toThrow(MailTransportError);
    const sent = stand.requests[0]!;
    expect(sent.headers.authorization).toBe('Bearer stand-in-managed-identity-token');
    expect(sent.headers['x-ms-date']).toBeUndefined();
    expect(sent.headers['x-ms-content-sha256']).toBeUndefined();
  });

  it('follows an operation whose address carries an encoded query, signed as it is sent', async () => {
    const stand = await standIn();
    stand.answer(
      {
        status: 202,
        headers: {
          'operation-location': `${stand.url}/emails/operations/1?api-version=${ACS_API_VERSION}&note=a%20b`,
        },
      },
      { status: 200, body: { id: '1', status: 'Succeeded' } },
    );
    await acsMailer({ ...settings, endpoint: stand.url }).send(sampleMessage());
    const poll = stand.requests[1]!;
    expect(poll.target).toBe(`/emails/operations/1?api-version=${ACS_API_VERSION}&note=a%20b`);
    expect(poll.headers.authorization).toBe(
      `HMAC-SHA256 SignedHeaders=${ACS_SIGNED_HEADERS}&Signature=${signatureOf(poll, ACCESS_KEY)}`,
    );
  });

  it('reads an operation named by its path alone against the endpoint', async () => {
    const stand = await standIn();
    stand.answer(
      {
        status: 202,
        headers: { 'operation-location': `/emails/operations/1?api-version=${ACS_API_VERSION}` },
      },
      { status: 200, body: { id: '1', status: 'Succeeded' } },
    );
    await acsMailer({ ...settings, endpoint: stand.url }).send(sampleMessage());
    expect(stand.requests.map((request) => request.target)).toEqual([
      SEND_PATH,
      `/emails/operations/1?api-version=${ACS_API_VERSION}`,
    ]);
  });

  it('says the sign-in failed when the managed identity gives no token', async () => {
    const stand = await standIn();
    const delivery = acsMailer(
      { from: 'sender@example.test', endpoint: stand.url },
      {
        token: async () => {
          throw new Error('ManagedIdentityCredential: no identity endpoint at 169.254.169.254');
        },
      },
    ).send(sampleMessage());
    const error = await delivery.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(MailTransportError);
    expect((error as Error).message).toBe(
      'Azure Communication Services could not sign in: the managed identity gave no token for the email service',
    );
    expect((error as MailTransportError).code).toBe('no_token');
    expect(stand.requests).toHaveLength(0);
  });

  it('waits out a 429 answer’s Retry-After and then backs off', async () => {
    const stand = await standIn();
    stand.answer(
      { status: 429, headers: { 'retry-after': '3' } },
      { status: 500 },
      { status: 202, headers: { 'operation-location': `${stand.url}/emails/operations/1` } },
    );
    const clock = fakeClock();
    const delivery = acsMailer(
      { ...settings, endpoint: stand.url },
      { now: clock.now, wait: clock.wait, pollTimeoutMs: 0 },
    ).send(sampleMessage());
    await expect(delivery).rejects.toThrow(MailTransportError);
    expect(clock.waits).toEqual([3_000, 1_000]);
    expect(stand.requests).toHaveLength(4);
  });

  it('reports a refusal with the service’s own code', async () => {
    const stand = await standIn();
    stand.answer({
      status: 403,
      headers: { 'x-ms-error-code': 'Unauthorized' },
      body: { error: { code: 'Unauthorized', message: 'The access key is wrong.' } },
    });
    const delivery = acsMailer({ ...settings, endpoint: stand.url }).send(sampleMessage());
    const error = await delivery.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(MailTransportError);
    expect((error as Error).message).toBe(
      'Azure Communication Services could not send the message: the service answered HTTP 403 Unauthorized',
    );
    expect((error as MailTransportError).transport).toBe('acs');
    expect((error as MailTransportError).status).toBe(403);
    expect(stand.requests).toHaveLength(1);
  });

  it('reports a send the service failed, with its code', async () => {
    const stand = await standIn();
    stand.answer(
      { status: 202, headers: { 'operation-location': `${stand.url}/emails/operations/1` } },
      {
        status: 200,
        body: { id: '1', status: 'Failed', error: { code: 'InvalidSender', message: 'not a domain' } },
      },
    );
    const clock = fakeClock();
    const delivery = acsMailer(
      { ...settings, endpoint: stand.url },
      { now: clock.now, wait: clock.wait },
    ).send(sampleMessage());
    await expect(delivery).rejects.toThrow(
      'Azure Communication Services could not send the message: the service reported the send as failed InvalidSender',
    );
    const error = await delivery.catch((thrown: unknown) => thrown);
    expect((error as MailTransportError).code).toBe('operation_failed');
  });

  it('follows the operation for a minute at most, waiting out what it asks for', async () => {
    const stand = await standIn();
    stand.answer(
      { status: 202, headers: { 'operation-location': `${stand.url}/emails/operations/1` } },
      { status: 200, body: { id: '1', status: 'Running' }, headers: { 'retry-after': '20' } },
    );
    const clock = fakeClock();
    const delivery = acsMailer(
      { ...settings, endpoint: stand.url },
      { now: clock.now, wait: clock.wait },
    ).send(sampleMessage());
    await expect(delivery).rejects.toThrow(
      'Azure Communication Services could not send the message: the send was still running after 60 seconds',
    );
    const timedOut = await delivery.catch((thrown: unknown) => thrown);
    expect((timedOut as MailTransportError).code).toBe('operation_timeout');
    // Each poll waits the 20 seconds the answer asks for, until the minute it's allowed is up.
    expect(clock.waits).toEqual([20_000, 20_000, 20_000]);
    expect(stand.requests).toHaveLength(5);
  });

  it('refuses to start for a sender the service can’t use', () => {
    expect(() =>
      acsMailer({ from: 'not an address', endpoint: 'https://resource.communication.azure.com' }),
    ).toThrow(ConfigurationError);
    expect(() =>
      acsMailer({ from: 'not an address', endpoint: 'https://resource.communication.azure.com' }),
    ).toThrow(/RIOSOMA_MAIL_FROM/);
  });
});
