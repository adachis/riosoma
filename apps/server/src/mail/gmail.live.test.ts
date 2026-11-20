/**
 * Sending mail through the real Gmail API.  It runs only when `RIOSOMA_TEST_GOOGLE_SA_KEY` and
 * `RIOSOMA_TEST_GMAIL_SENDER` are both set (see `test/google-live.ts`), and skips otherwise.
 *
 * The service account sends one message to the mailbox it acts for, and to nobody else, the way a
 * server set up with `RIOSOMA_MAIL_TRANSPORT=gmail` would.  The suite keeps the answer Gmail gave
 * the transport and checks it names a message, and checks the MIME the transport posted carried that
 * one address.
 *
 * Reading the message back needs a delegation of its own, and a domain usually delegates the send
 * scope only, which is all a server needs, so the read-back test skips when Google refuses an
 * assertion for `gmail.modify`.  When it does read back, it checks what arrived and puts the message
 * in the trash, which leaves the mailbox as it was.  Nothing here prints the key: a failure quotes
 * Gmail's own answer, never the request that carried the assertion.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eventually, liveGmailSender, liveGoogleKey, TEST_PREFIX } from '../test/google-live.js';
import { GMAIL_TOKEN_URL, GMAIL_URL, gmailAssertion, gmailMailer, readServiceAccount } from './gmail.js';
import { mimeHeader } from './test-helpers.js';

const keyJson = liveGoogleKey();
const sender = liveGmailSender();

/** Reading a mailbox and trashing one message, which the send scope alone doesn't cover. */
const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

describe.skipIf(!keyJson || !sender)('mail through the real Gmail API', () => {
  const subject = `${TEST_PREFIX}mail ${randomBytes(4).toString('hex')}`;
  const body = `${subject}: Riosoma sent this to check mail through the Gmail API.  It trashes its own copy.`;

  /** The send the transport made and what Gmail answered it with, kept for the checks that follow. */
  interface Sent {
    status: number;
    /** The message ID Gmail gave the message, which the read-back looks up */
    id: string;
    /** The base64url MIME the transport posted */
    raw: string;
  }
  let sent: Sent | null = null;
  /** The read-back token, kept so the message can be trashed even when a check fails */
  let readToken = '';

  /** The real fetch, with the send request and its answer kept on the way past. */
  const watching: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('/messages/send')) return response;
    const copy = response.clone();
    let answer: { id?: unknown } = {};
    try {
      answer = (await copy.json()) as { id?: unknown };
    } catch {
      // An answer that isn't JSON says its own status below.
    }
    const posted = typeof init?.body === 'string' ? (JSON.parse(init.body) as { raw?: string }) : {};
    sent = {
      status: response.status,
      id: typeof answer.id === 'string' ? answer.id : '',
      raw: posted.raw ?? '',
    };
    return response;
  };

  /**
   * A token that may read the mailbox, or an empty string when the domain delegates sending only,
   * which Google refuses an assertion for.  The refusal is never quoted, since an answer about an
   * assertion is one place a key could come back.
   */
  async function readBackToken(): Promise<string> {
    const account = readServiceAccount(keyJson!);
    const assertion = gmailAssertion(
      account,
      READ_SCOPE,
      GMAIL_TOKEN_URL,
      sender!,
      Math.floor(Date.now() / 1_000),
    );
    const response = await fetch(GMAIL_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    if (!response.ok) return '';
    try {
      const answer = (await response.json()) as { access_token?: unknown };
      return typeof answer.access_token === 'string' ? answer.access_token : '';
    } catch {
      return '';
    }
  }

  /** One call to the Gmail API with a token, answered with its status and body. */
  async function gmail(
    token: string,
    method: 'GET' | 'POST',
    path: string,
  ): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
    const response = await fetch(`${GMAIL_URL}/gmail/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // An answer that isn't JSON keeps its text.
    }
    return { status: response.status, json, text };
  }

  const messagePath = () => `/users/${encodeURIComponent(sender!)}/messages/${encodeURIComponent(sent!.id)}`;

  afterAll(async () => {
    if (!readToken || !sent?.id) return;
    // The mailbox keeps nothing from this suite when the delegation let it read back.
    await gmail(readToken, 'POST', `${messagePath()}/trash`);
  }, 60_000);

  it('sends from the mailbox to itself, and Gmail accepts the message', { timeout: 180_000 }, async () => {
    await gmailMailer(
      { from: sender!, serviceAccountJson: keyJson!, sender: sender! },
      { fetch: watching },
    ).send({
      to: sender!,
      subject,
      text: body,
      html: `<p>${body}</p>`,
      headers: { 'X-Riosoma-Test': subject },
    });
    expect(sent, 'the transport posted no message').not.toBeNull();
    expect(sent!.status).toBe(200);
    // Gmail answers a send it took with the message's own ID, which the read-back looks up.
    expect(sent!.id.length).toBeGreaterThan(7);
    const mime = Buffer.from(sent!.raw, 'base64url');
    expect(mimeHeader(mime, 'To')).toBe(sender);
    expect(mimeHeader(mime, 'Cc')).toBe('');
    expect(mimeHeader(mime, 'Bcc')).toBe('');
    expect(mimeHeader(mime, 'Subject')).toBe(subject);
  });

  it(
    'reads the message back, when the delegation covers more than sending',
    { timeout: 180_000 },
    async (ctx) => {
      const token = await readBackToken();
      if (!token) {
        // A domain that delegates the send scope only, which is all a server needs, can't read back.
        ctx.skip();
        return;
      }
      readToken = token;
      if (!sent?.id) throw new Error('the message to read back was never sent');
      const wanted = new URLSearchParams({ format: 'metadata' });
      for (const name of ['Subject', 'From', 'To']) wanted.append('metadataHeaders', name);
      // A message is readable at once, but the labels Gmail puts on it settle a moment later.
      const message = await eventually(async () => {
        const found = await gmail(token, 'GET', `${messagePath()}?${wanted}`);
        const labels = found.json.labelIds;
        return found.status === 200 && Array.isArray(labels) && labels.includes('SENT')
          ? found.json
          : undefined;
      }, 90_000);
      const headers = ((message.payload as { headers?: Array<{ name: string; value: string }> })?.headers ??
        []) as Array<{ name: string; value: string }>;
      const header = (name: string) =>
        headers.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.value ?? '';
      expect(header('Subject')).toBe(subject);
      expect(header('To').toLowerCase()).toBe(sender!.toLowerCase());
      expect(header('From').toLowerCase()).toContain(sender!.toLowerCase());
      expect(message.labelIds as string[]).toContain('SENT');
    },
  );
});
