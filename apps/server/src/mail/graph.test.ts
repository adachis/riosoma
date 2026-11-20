import { afterEach, describe, expect, it } from 'vitest';
import { GRAPH_SCOPE, graphMailer, graphTokenUrl } from './graph.js';
import { MailTransportError } from './http.js';
import type { GraphSettings } from './settings.js';
import {
  fakeClock,
  mimeHeader,
  sampleMessage,
  startStandInService,
  unfolded,
  type StandInService,
} from './test-helpers.js';

/**
 * Microsoft Graph delivery: the client credentials token it signs in with, how long that token is
 * kept, the base64 MIME it posts to the mailbox's `sendMail`, and how a busy or refusing Graph reads.
 */

const CLIENT_SECRET = ['stand-in-graph-', 'client-secret'].join('');
const TENANT_ID = '11111111-2222-3333-4444-555555555555';
const SENDER = 'sender@example.test';
const TOKEN = ['stand', '-in-graph-token'].join('');

const settings: GraphSettings = {
  from: 'Riosoma <sender@example.test>',
  tenantId: TENANT_ID,
  clientId: '66666666-7777-8888-9999-aaaaaaaaaaaa',
  clientSecret: CLIENT_SECRET,
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

describe('sending through Microsoft Graph', () => {
  it('addresses the tenant’s own token endpoint, for Graph’s own scope', () => {
    expect(graphTokenUrl(TENANT_ID)).toBe(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`);
    expect(GRAPH_SCOPE).toBe('https://graph.microsoft.com/.default');
  });

  it('signs in with the client credentials and posts the MIME base64-encoded', async () => {
    const stand = await standIn();
    stand.answer({ status: 200, body: tokenAnswer }, { status: 202 });
    const clock = fakeClock();
    await graphMailer(settings, {
      endpoint: stand.url,
      tokenUrl: `${stand.url}/token`,
      now: clock.now,
    }).send(sampleMessage());

    const [token, send] = stand.requests;
    expect(token!.method).toBe('POST');
    expect(token!.target).toBe('/token');
    expect(token!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(token!.body))).toEqual({
      client_id: settings.clientId,
      client_secret: CLIENT_SECRET,
      // Graph's own scope, even with the calls going to a stand-in.
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });

    expect(send!.method).toBe('POST');
    expect(send!.target).toBe(`/v1.0/users/${encodeURIComponent(SENDER)}/sendMail`);
    expect(send!.headers['content-type']).toBe('text/plain');
    expect(send!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const mime = Buffer.from(send!.body, 'base64');
    expect(mimeHeader(mime, 'Subject')).toBe('Résumé für Ñandú Nº 42');
    expect(mimeHeader(mime, 'To')).toBe('recipient@example.test');
    expect(mimeHeader(mime, 'From')).toBe('Riosoma <sender@example.test>');
    expect(unfolded(mime)).toContain('<p>The plain text body.</p>');
    expect(unfolded(mime)).toContain(sampleMessage().attachments![0]!.content.toString('base64'));
    expect(unfolded(mime)).toContain('List-Unsubscribe');
  });

  it('keeps the token until five minutes before it expires', async () => {
    const stand = await standIn();
    stand.answer({ status: 200, body: tokenAnswer }, { status: 202 });
    const clock = fakeClock();
    const mailer = graphMailer(settings, {
      endpoint: stand.url,
      tokenUrl: `${stand.url}/token`,
      now: clock.now,
    });
    await mailer.send(sampleMessage());
    expect(stand.requests.filter((request) => request.target === '/token')).toHaveLength(1);

    // An hour's token, less the five minutes it's renewed early by.
    clock.advance(3_600_000 - 5 * 60 * 1000 - 1_000);
    await mailer.send(sampleMessage());
    expect(stand.requests.filter((request) => request.target === '/token')).toHaveLength(1);

    const renewed = ['renewed', '-graph-token'].join('');
    stand.answer({ status: 200, body: { ...tokenAnswer, access_token: renewed } }, { status: 202 });
    clock.advance(2_000);
    await mailer.send(sampleMessage());
    expect(stand.requests.filter((request) => request.target === '/token')).toHaveLength(2);
    expect(stand.requests.filter((request) => request.target.includes('sendMail'))).toHaveLength(3);
    expect(stand.requests.at(-1)!.headers.authorization).toBe(`Bearer ${renewed}`);
  });

  it('waits out a 429 answer’s Retry-After and then backs off', async () => {
    const stand = await standIn();
    stand.answer(
      { status: 200, body: tokenAnswer },
      { status: 429, headers: { 'retry-after': '9' } },
      { status: 503 },
      { status: 202 },
    );
    const clock = fakeClock();
    await graphMailer(settings, {
      endpoint: stand.url,
      tokenUrl: `${stand.url}/token`,
      now: clock.now,
      wait: clock.wait,
    }).send(sampleMessage());
    expect(clock.waits).toEqual([9_000, 1_000]);
    expect(stand.requests.filter((request) => request.target.includes('sendMail'))).toHaveLength(3);
  });

  it('reports a refusal with Graph’s own code, and nothing from the message', async () => {
    const stand = await standIn();
    stand.answer(
      { status: 200, body: tokenAnswer },
      { status: 403, body: { error: { code: 'ErrorAccessDenied', message: 'The plain text body.' } } },
    );
    const delivery = graphMailer(settings, {
      endpoint: stand.url,
      tokenUrl: `${stand.url}/token`,
    }).send(sampleMessage());
    const error = await delivery.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(MailTransportError);
    expect((error as Error).message).toBe(
      'Microsoft Graph could not send the message: the service answered HTTP 403 ErrorAccessDenied',
    );
    expect((error as Error).message).not.toContain(CLIENT_SECRET);
    expect((error as MailTransportError).transport).toBe('graph');
  });

  it('says when the sign-in itself was refused', async () => {
    const stand = await standIn();
    stand.answer({
      status: 401,
      body: { error: 'invalid_client', error_description: 'the secret is wrong' },
    });
    const delivery = graphMailer(settings, {
      endpoint: stand.url,
      tokenUrl: `${stand.url}/token`,
    }).send(sampleMessage());
    await expect(delivery).rejects.toThrow(
      'Microsoft Graph could not sign in: the service answered HTTP 401 invalid_client',
    );
    expect(stand.requests).toHaveLength(1);
  });

  it('says when a token answer carries no token', async () => {
    const stand = await standIn();
    stand.answer({ status: 200, body: { token_type: 'Bearer' } });
    await expect(
      graphMailer(settings, { endpoint: stand.url, tokenUrl: `${stand.url}/token` }).send(sampleMessage()),
    ).rejects.toThrow('Microsoft Graph could not sign in: the token answer carried no access token');
  });
});
