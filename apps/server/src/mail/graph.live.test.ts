/**
 * Sending mail through the real Microsoft Graph.  It runs only when the test app's settings and
 * `RIOSOMA_TEST_M365_MAILBOX` are set (see `test/microsoft-live.ts`), and skips otherwise.
 *
 * The mailbox sends one message to itself, never to anyone else, the way a server set up with
 * `RIOSOMA_MAIL_TRANSPORT=graph` would.  The suite then reads the mailbox until the message
 * arrives, checks what arrived, and deletes the message from the inbox and from Sent Items.  The
 * app needs `Mail.Send` to send, which is all a server needs, and `Mail.ReadWrite` for the suite's
 * own reading and deleting.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  eventually,
  liveApp,
  liveMailbox,
  liveRequest,
  liveToken,
  TEST_PREFIX,
  type MicrosoftLive,
} from '../test/microsoft-live.js';
import { graphMailer } from './graph.js';

const app = liveApp();
const mailbox = liveMailbox();
const GRAPH = 'https://graph.microsoft.com/v1.0';

describe.skipIf(!app || !mailbox)('mail through the real Microsoft Graph', () => {
  const subject = `${TEST_PREFIX}mail ${randomBytes(4).toString('hex')}`;
  let token = '';

  /** The copies of the suite's message the mailbox holds, in any folder. */
  async function copies(): Promise<Array<Record<string, unknown>>> {
    const found = await liveRequest(
      token,
      'GET',
      `${GRAPH}/users/${encodeURIComponent(mailbox!)}/messages?${new URLSearchParams({
        $filter: `subject eq '${subject}'`,
        $select: 'id,subject,from,toRecipients,parentFolderId,body',
      })}`,
    );
    expect(found.status, found.text).toBe(200);
    return found.json.value as Array<Record<string, unknown>>;
  }

  afterAll(async () => {
    if (!token) return;
    for (const message of await copies())
      await liveRequest(
        token,
        'DELETE',
        `${GRAPH}/users/${encodeURIComponent(mailbox!)}/messages/${String(message.id)}`,
      );
  }, 60_000);

  it(
    'sends from the mailbox to itself, and the message arrives as it was sent',
    { timeout: 180_000 },
    async () => {
      const live = app as MicrosoftLive;
      await graphMailer({
        from: mailbox!,
        sender: mailbox!,
        tenantId: live.tenantId,
        clientId: live.clientId,
        clientSecret: live.clientSecret,
      }).send({
        to: mailbox!,
        subject,
        text: 'Riosoma sent this to check mail through Microsoft Graph.  It deletes it on its own.',
        html: '<p>Riosoma sent this to check mail through Microsoft Graph.  It deletes it on its own.</p>',
        headers: { 'X-Riosoma-Test': subject },
      });
      token = await liveToken(live);
      const inbox = await liveRequest(
        token,
        'GET',
        `${GRAPH}/users/${encodeURIComponent(mailbox!)}/mailFolders/inbox?$select=id`,
      );
      expect(inbox.status, inbox.text).toBe(200);
      // Delivery takes a few seconds, sometimes a minute.
      const arrived = await eventually(async () => {
        const found = (await copies()).find((message) => message.parentFolderId === inbox.json.id);
        return found;
      }, 150_000);
      expect(arrived.subject).toBe(subject);
      const from = (arrived.from as { emailAddress: { address: string } }).emailAddress.address;
      expect(from.toLowerCase()).toBe(mailbox!.toLowerCase());
      const to = (arrived.toRecipients as Array<{ emailAddress: { address: string } }>).map((entry) =>
        entry.emailAddress.address.toLowerCase(),
      );
      expect(to).toEqual([mailbox!.toLowerCase()]);
      expect(JSON.stringify(arrived.body)).toContain('Riosoma sent this to check mail');
    },
  );
});
