import { generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../configuration-error.js';
import { GMAIL_SEND_SCOPE, gmailAssertion, gmailMailer, readServiceAccount } from './gmail.js';
import { MailTransportError } from './http.js';
import type { GmailSettings } from './settings.js';
import {
  fakeClock,
  mimeHeader,
  sampleMessage,
  startStandInService,
  unfolded,
  type StandInService,
} from './test-helpers.js';
import { serviceAccount } from '../service-account.test-helpers.js';

/**
 * Gmail delivery: the assertion a service account signs with its own RSA key, the token Google hands
 * back for it, the raw base64url MIME the API takes, and how a busy or refusing Gmail reads.
 */

const SENDER = 'sender@example.test';
const CLIENT_EMAIL = 'riosoma-mail@stand-in-project.iam.gserviceaccount.com';
const TOKEN = ['stand', '-in-gmail-token'].join('');

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccountJson = JSON.stringify(
  serviceAccount({
    project_id: 'stand-in-project',
    private_key_id: 'stand-in-key-id',
    private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    client_email: CLIENT_EMAIL,
    token_uri: 'https://oauth2.googleapis.com/token',
  }),
);

const settings: GmailSettings = {
  from: 'Riosoma <sender@example.test>',
  serviceAccountJson,
  sender: SENDER,
};

const tokenAnswer = { access_token: TOKEN, expires_in: 3_600, token_type: 'Bearer' };

let service: StandInService | null = null;

afterEach(async () => {
  await service?.close();
  service = null;
});

async function standIn(): Promise<StandInService> {
  service = await startStandInService();
  return service;
}

/** An assertion's three parts, decoded, with its signature checked against the account's key. */
function partsOf(assertion: string): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  const [header, claims, signature] = assertion.split('.');
  const signed = `${header}.${claims}`;
  const valid = verifySignature(
    'RSA-SHA256',
    Buffer.from(signed),
    pair.publicKey,
    Buffer.from(signature!, 'base64url'),
  );
  expect(valid).toBe(true);
  return {
    header: JSON.parse(Buffer.from(header!, 'base64url').toString('utf8')) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(claims!, 'base64url').toString('utf8')) as Record<string, unknown>,
  };
}

describe('the service account assertion', () => {
  it('reads the account’s key file', () => {
    const account = readServiceAccount(serviceAccountJson);
    expect(account.clientEmail).toBe(CLIENT_EMAIL);
    expect(account.keyId).toBe('stand-in-key-id');
    expect(account.privateKey.asymmetricKeyType).toBe('rsa');
  });

  it.each([
    ['is not JSON', 'not json at all'],
    ['names no client_email', JSON.stringify({ private_key: 'x' })],
    ['holds no private key that reads', JSON.stringify({ client_email: CLIENT_EMAIL, private_key: 'x' })],
  ])('refuses a key file that %s', (detail, json) => {
    expect(() => readServiceAccount(json)).toThrow(ConfigurationError);
    expect(() => readServiceAccount(json)).toThrow(
      `RIOSOMA_GMAIL_SERVICE_ACCOUNT_JSON is invalid (${detail})`,
    );
  });

  it('refuses a key that is not an RSA one', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const json = JSON.stringify({
      client_email: CLIENT_EMAIL,
      private_key: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    });
    expect(() => readServiceAccount(json)).toThrow(
      'RIOSOMA_GMAIL_SERVICE_ACCOUNT_JSON is invalid (holds a key that is not an RSA one)',
    );
  });

  it('names the mailbox it acts for and an hour of life', () => {
    const issuedAt = Math.floor(Date.now() / 1_000) - 60;
    const assertion = gmailAssertion(
      readServiceAccount(serviceAccountJson),
      GMAIL_SEND_SCOPE,
      'https://oauth2.googleapis.com/token',
      SENDER,
      issuedAt,
    );
    const { header, claims } = partsOf(assertion);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'stand-in-key-id' });
    expect(claims).toEqual({
      iss: CLIENT_EMAIL,
      scope: GMAIL_SEND_SCOPE,
      sub: SENDER,
      aud: 'https://oauth2.googleapis.com/token',
      iat: issuedAt,
      exp: issuedAt + 3_600,
    });
  });
});

describe('sending through the Gmail API', () => {
  it('trades a signed assertion for a token and posts the raw MIME', async () => {
    const stand = await standIn();
    stand.answer({ status: 200, body: tokenAnswer }, { status: 200, body: { id: '1', threadId: '1' } });
    const clock = fakeClock();
    const tokenUrl = `${stand.url}/token`;
    await gmailMailer(settings, { endpoint: stand.url, tokenUrl, now: clock.now }).send(sampleMessage());

    const [token, send] = stand.requests;
    expect(token!.method).toBe('POST');
    expect(token!.target).toBe('/token');
    expect(token!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = Object.fromEntries(new URLSearchParams(token!.body));
    expect(form.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const { header, claims } = partsOf(form.assertion!);
    expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT', kid: 'stand-in-key-id' });
    expect(claims).toMatchObject({ iss: CLIENT_EMAIL, scope: GMAIL_SEND_SCOPE, sub: SENDER, aud: tokenUrl });
    expect(claims.iat).toBe(Math.floor(clock.now() / 1_000));

    expect(send!.method).toBe('POST');
    expect(send!.target).toBe(`/gmail/v1/users/${encodeURIComponent(SENDER)}/messages/send`);
    expect(send!.headers['content-type']).toBe('application/json');
    expect(send!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const posted = JSON.parse(send!.body) as { raw: string };
    expect(Object.keys(posted)).toEqual(['raw']);
    // The API wants base64url, which carries no padding and no plus or slash.
    expect(posted.raw).not.toMatch(/[+/=]/);
    const mime = Buffer.from(posted.raw, 'base64url');
    expect(mimeHeader(mime, 'Subject')).toBe('Résumé für Ñandú Nº 42');
    expect(mimeHeader(mime, 'To')).toBe('recipient@example.test');
    expect(unfolded(mime)).toContain('Content-Type: text/csv; name=report.csv');
    expect(unfolded(mime)).toContain(sampleMessage().attachments![0]!.content.toString('base64'));
  });

  it('waits out a 429 answer’s Retry-After and then backs off', async () => {
    const stand = await standIn();
    stand.answer(
      { status: 200, body: tokenAnswer },
      { status: 429, headers: { 'retry-after': '4' } },
      { status: 500 },
      { status: 200, body: { id: '2' } },
    );
    const clock = fakeClock();
    await gmailMailer(settings, {
      endpoint: stand.url,
      tokenUrl: `${stand.url}/token`,
      now: clock.now,
      wait: clock.wait,
    }).send(sampleMessage());
    expect(clock.waits).toEqual([4_000, 1_000]);
    expect(stand.requests).toHaveLength(4);
  });

  it('reports a refusal with Google’s own short name, and nothing from the message', async () => {
    const stand = await standIn();
    stand.answer(
      { status: 200, body: tokenAnswer },
      {
        status: 403,
        body: {
          error: { code: 403, message: 'The plain text body.', status: 'PERMISSION_DENIED' },
        },
      },
    );
    const delivery = gmailMailer(settings, {
      endpoint: stand.url,
      tokenUrl: `${stand.url}/token`,
    }).send(sampleMessage());
    const error = await delivery.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(MailTransportError);
    expect((error as Error).message).toBe(
      'Gmail could not send the message: the service answered HTTP 403 PERMISSION_DENIED',
    );
    expect((error as MailTransportError).status).toBe(403);
  });

  it('says when Google refused the assertion', async () => {
    const stand = await standIn();
    stand.answer({ status: 400, body: { error: 'invalid_grant', error_description: 'not delegated' } });
    await expect(
      gmailMailer(settings, { endpoint: stand.url, tokenUrl: `${stand.url}/token` }).send(sampleMessage()),
    ).rejects.toThrow('Gmail could not sign in: the service answered HTTP 400 invalid_grant');
  });
});
