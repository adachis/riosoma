import { createHash, createHmac } from 'node:crypto';
import { signAwsRequest } from '@riosoma/connectors/s3';
import { afterEach, describe, expect, it } from 'vitest';
import { MailTransportError } from './http.js';
import { sesEndpoint, sesMailer, SES_SEND_PATH } from './ses.js';
import type { SesSettings } from './settings.js';
import {
  fakeClock,
  mimeHeader,
  sampleMessage,
  startStandInService,
  unfolded,
  type StandInService,
} from './test-helpers.js';

/**
 * Amazon SES delivery: the request's exact shape, its Signature Version 4 signature checked against
 * a published AWS test vector and then recomputed over what the service stand-in actually got, the
 * raw MIME it carries, and how a busy or refusing service reads.
 */

const ACCESS_KEY_ID = ['AKIA', 'RIOSOMAEXAMPLE'].join('');
const SECRET_ACCESS_KEY = ['riosoma-stand-in-', 'secret-key-0123456789'].join('');
const REGION = 'us-east-1';
const FROM = 'Riosoma <sender@example.test>';

const settings: SesSettings = {
  from: FROM,
  region: REGION,
  accessKeyId: ACCESS_KEY_ID,
  secretAccessKey: SECRET_ACCESS_KEY,
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

/**
 * The Signature Version 4 signature of a request the stand-in got, worked out from scratch over the
 * headers its own Authorization line says were signed.
 */
function signatureOf(
  request: { method: string; url: URL; headers: Record<string, string> },
  body: string,
  service_: string,
  secret: string,
): string {
  const stamp = request.headers['x-amz-date']!;
  const day = stamp.slice(0, 8);
  const names = /SignedHeaders=([^,]+),/.exec(request.headers.authorization ?? '')?.[1]?.split(';') ?? [];
  const canonical = [
    request.method,
    request.url.pathname,
    '',
    names.map((name) => `${name}:${request.headers[name]!.trim()}\n`).join(''),
    names.join(';'),
    createHash('sha256').update(body, 'utf8').digest('hex'),
  ].join('\n');
  const scope = `${day}/${REGION}/${service_}/aws4_request`;
  const toSign = [
    'AWS4-HMAC-SHA256',
    stamp,
    scope,
    createHash('sha256').update(canonical, 'utf8').digest('hex'),
  ].join('\n');
  const hmac = (key: Buffer | string, text: string) =>
    createHmac('sha256', key).update(text, 'utf8').digest();
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), REGION), service_), 'aws4_request');
  return createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
}

describe('signing for an AWS service', () => {
  it('signs the published test vector’s request exactly', () => {
    const headers = signAwsRequest({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      region: 'us-east-1',
      service: 'service',
      credentials: {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: ['wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE', 'KEY'].join(''),
      },
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    // Only S3 wants the payload's hash as a header, and every other service signs it and sends none.
    expect(headers['x-amz-content-sha256']).toBeUndefined();
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
  });

  // More of the same published suite: a signed body with its content type, and a session token.
  const vector = {
    region: 'us-east-1',
    service: 'service',
    credentials: {
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: ['wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE', 'KEY'].join(''),
    },
    now: new Date('2015-08-30T12:36:00Z'),
  };

  it('signs the published test vector’s form post exactly', () => {
    const headers = signAwsRequest({
      ...vector,
      method: 'POST',
      url: new URL('https://example.amazonaws.com/'),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      hash: createHash('sha256').update('Param1=value1', 'utf8').digest('hex'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-date, ' +
        'Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a',
    );
  });

  it('signs the published test vector’s session token exactly', () => {
    const sessionToken = [
      'AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/',
      'qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==',
    ].join('');
    const headers = signAwsRequest({
      ...vector,
      method: 'POST',
      url: new URL('https://example.amazonaws.com/'),
      credentials: { ...vector.credentials, sessionToken },
    });
    expect(headers['x-amz-security-token']).toBe(sessionToken);
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date;x-amz-security-token, ' +
        'Signature=85d96828115b5dc0cfc3bd16ad9e210dd772bbebba041836c64533a82be05ead',
    );
  });

  it('signs a role’s session token into the request', () => {
    const headers = signAwsRequest({
      method: 'POST',
      url: new URL('https://email.us-east-1.amazonaws.com/v2/email/outbound-emails'),
      region: REGION,
      service: 'ses',
      credentials: {
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY,
        sessionToken: 'stand-in-session-token',
      },
      headers: { 'content-type': 'application/json' },
      now: new Date('2015-08-30T12:36:00Z'),
      hash: createHash('sha256').update('{}', 'utf8').digest('hex'),
    });
    expect(headers['x-amz-security-token']).toBe('stand-in-session-token');
    expect(headers.authorization).toContain(
      'SignedHeaders=content-type;host;x-amz-date;x-amz-security-token',
    );
    expect(headers.authorization).toContain(`/${REGION}/ses/aws4_request`);
  });

  it('addresses the region’s own service', () => {
    expect(sesEndpoint('eu-west-1')).toBe('https://email.eu-west-1.amazonaws.com');
  });
});

describe('sending through Amazon SES', () => {
  it('posts the message as signed raw MIME to the region’s endpoint', async () => {
    const stand = await standIn();
    stand.answer({ status: 200, body: { MessageId: 'message-1' } });
    const clock = fakeClock();
    await sesMailer(settings, { endpoint: stand.url, now: clock.now }).send(sampleMessage());

    expect(stand.requests).toHaveLength(1);
    const request = stand.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.target).toBe(SES_SEND_PATH);
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    // S3's payload header stays out of a call to another service, and so does the host, which the
    // HTTP client sends itself.
    expect(request.headers['x-amz-content-sha256']).toBeUndefined();

    const sent = JSON.parse(request.body) as {
      Content: { Raw: { Data: string } };
      Destination: { ToAddresses: string[] };
      FromEmailAddress: string;
    };
    expect(sent.Destination.ToAddresses).toEqual(['recipient@example.test']);
    // The call names bare addresses, and the name people see rides in the MIME's own From.
    expect(sent.FromEmailAddress).toBe('sender@example.test');
    const mime = Buffer.from(sent.Content.Raw.Data, 'base64');
    expect(mimeHeader(mime, 'From')).toBe(FROM);
    expect(mimeHeader(mime, 'To')).toBe('recipient@example.test');
    expect(mimeHeader(mime, 'Subject')).toBe('Résumé für Ñandú Nº 42');
    expect(mimeHeader(mime, 'List-Unsubscribe')).toBe('<mailto:list@example.test?subject=unsubscribe>');
    expect(new Date(mimeHeader(mime, 'Date')).getTime()).toBe(clock.now());
    expect(unfolded(mime)).toContain('Content-Type: text/csv; name=report.csv');
    expect(unfolded(mime)).toContain('Content-Disposition: attachment; filename=report.csv');
    expect(unfolded(mime)).toContain(sampleMessage().attachments![0]!.content.toString('base64'));
    expect(unfolded(mime)).toContain('The plain text body.');

    const scope = `${request.headers['x-amz-date']!.slice(0, 8)}/${REGION}/ses/aws4_request`;
    expect(request.headers.authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY_ID}/${scope}, ` +
        'SignedHeaders=accept;content-type;host;x-amz-date, ' +
        `Signature=${signatureOf(request, request.body, 'ses', SECRET_ACCESS_KEY)}`,
    );
  });

  it('names bare addresses to SES, so a name outside ASCII can’t be refused', async () => {
    const stand = await standIn();
    stand.answer({ status: 200, body: { MessageId: 'message-5' } });
    await sesMailer({ ...settings, from: 'Ñandú Mail <sender@example.test>' }, { endpoint: stand.url }).send(
      sampleMessage({ to: 'Résumé Reader <recipient@example.test>' }),
    );
    const sent = JSON.parse(stand.requests[0]!.body) as {
      Content: { Raw: { Data: string } };
      Destination: { ToAddresses: string[] };
      FromEmailAddress: string;
    };
    expect(sent.FromEmailAddress).toBe('sender@example.test');
    expect(sent.Destination.ToAddresses).toEqual(['recipient@example.test']);
    const mime = Buffer.from(sent.Content.Raw.Data, 'base64');
    expect(mimeHeader(mime, 'From')).toBe('Ñandú Mail <sender@example.test>');
    expect(mimeHeader(mime, 'To')).toBe('Résumé Reader <recipient@example.test>');
  });

  it('signs each attempt again, so a retry carries its own time', async () => {
    const stand = await standIn();
    stand.answer({ status: 503 }, { status: 200, body: { MessageId: 'message-2' } });
    const clock = fakeClock();
    // A signature carries whole seconds, so the clock moves a second at a time here.
    const wait = async (ms: number) => {
      clock.waits.push(ms);
      clock.advance(Math.max(ms, 1_000));
    };
    await sesMailer(settings, { endpoint: stand.url, now: clock.now, wait }).send(sampleMessage());
    expect(stand.requests).toHaveLength(2);
    expect(stand.requests[1]!.headers['x-amz-date']).not.toBe(stand.requests[0]!.headers['x-amz-date']);
    expect(clock.waits).toEqual([500]);
  });

  it('waits out a 429 answer’s Retry-After and then backs off', async () => {
    const stand = await standIn();
    stand.answer(
      {
        status: 429,
        headers: { 'retry-after': '7' },
        body: { message: 'slow down', __type: 'TooManyRequests' },
      },
      { status: 500 },
      { status: 502 },
      { status: 200, body: { MessageId: 'message-3' } },
    );
    const clock = fakeClock();
    await sesMailer(settings, { endpoint: stand.url, now: clock.now, wait: clock.wait }).send(
      sampleMessage(),
    );
    expect(stand.requests).toHaveLength(4);
    expect(clock.waits).toEqual([7_000, 1_000, 2_000]);
  });

  it('gives up after three retries with the transport and the status in the error', async () => {
    const stand = await standIn();
    stand.answer({ status: 503 });
    const clock = fakeClock();
    const delivery = sesMailer(settings, { endpoint: stand.url, now: clock.now, wait: clock.wait }).send(
      sampleMessage(),
    );
    await expect(delivery).rejects.toThrow(
      'Amazon SES could not send the message: the service answered HTTP 503',
    );
    const error = await delivery.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(MailTransportError);
    expect((error as MailTransportError).transport).toBe('ses');
    expect((error as MailTransportError).status).toBe(503);
    expect((error as MailTransportError).code).toBe('http_503');
    expect(stand.requests).toHaveLength(4);
  });

  it('reports a refusal with the service’s own code and nothing from the message or the keys', async () => {
    const stand = await standIn();
    stand.answer({
      status: 400,
      headers: { 'x-amzn-errortype': 'MessageRejected' },
      body: { message: 'recipient@example.test is not verified', __type: 'MessageRejected' },
    });
    const delivery = sesMailer(settings, { endpoint: stand.url }).send(sampleMessage());
    const error = await delivery.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(MailTransportError);
    expect((error as Error).message).toBe(
      'Amazon SES could not send the message: the service answered HTTP 400 MessageRejected',
    );
    expect((error as Error).message).not.toContain(SECRET_ACCESS_KEY);
    expect((error as Error).message).not.toContain('The plain text body');
    // A log line that carries only a code still says what kind of failure it was.
    expect((error as MailTransportError).code).toBe('http_400');
  });

  it('names the transport when the server has no keys to sign with', async () => {
    const stand = await standIn();
    const delivery = sesMailer(
      { from: FROM, region: REGION },
      {
        endpoint: stand.url,
        env: { AWS_EC2_METADATA_DISABLED: 'true' },
        metadataUrl: stand.url,
      },
    ).send(sampleMessage());
    await expect(delivery).rejects.toThrow(
      'Amazon SES could not send the message: the server has no AWS keys to sign with',
    );
    expect(stand.requests).toHaveLength(0);
  });

  it('says why there are no keys, in words that name no key', async () => {
    const stand = await standIn();
    stand.answer({ status: 403, body: 'Forbidden' });
    const delivery = sesMailer(
      { from: FROM, region: REGION },
      { endpoint: stand.url, env: { AWS_CONTAINER_CREDENTIALS_FULL_URI: `${stand.url}/credentials` } },
    ).send(sampleMessage());
    await expect(delivery).rejects.toThrow(
      'Amazon SES could not send the message: the server has no AWS keys to sign with (the container credentials endpoint answered HTTP 403)',
    );
    expect(((await delivery.catch((thrown: unknown) => thrown)) as MailTransportError).code).toBe(
      'no_credentials',
    );
  });

  it('sends with the keys a role hands out', async () => {
    const stand = await standIn();
    stand.answer(
      {
        status: 200,
        body: {
          AccessKeyId: 'role-access-key',
          SecretAccessKey: 'role-secret-key',
          Token: 'role-session-token',
          Expiration: new Date(Date.now() + 3_600_000).toISOString(),
        },
      },
      { status: 200, body: { MessageId: 'message-4' } },
    );
    await sesMailer(
      { from: FROM, region: REGION },
      {
        endpoint: stand.url,
        env: { AWS_CONTAINER_CREDENTIALS_FULL_URI: `${stand.url}/credentials` },
      },
    ).send(sampleMessage());
    const sent = stand.requests[1]!;
    expect(sent.headers['x-amz-security-token']).toBe('role-session-token');
    expect(sent.headers.authorization).toContain('Credential=role-access-key/');
    expect(sent.headers.authorization).toContain(
      `Signature=${signatureOf(sent, sent.body, 'ses', 'role-secret-key')}`,
    );
  });
});
