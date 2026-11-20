/**
 * The Teams step against the real Microsoft Teams.  Two parts, each skipping on its own when its
 * settings are missing (see `test/microsoft-live.ts`):
 *
 * - With the test app's settings and `RIOSOMA_TEST_M365_MAILBOX`, it makes sure the tenant has a
 *   team named Riosoma tests, with a channel of the same name, owned by that mailbox's user, and
 *   makes it through Graph when it's missing.  The team stays, for later runs.  The app needs
 *   `Team.Create` and `Team.ReadBasic.All`.
 * - With `RIOSOMA_TEST_TEAMS_WEBHOOK_URL`, it posts a message through the step the way a run does.
 *   The address comes from a Workflows webhook a person made in that channel, since only a person
 *   can make one: in Teams, open the channel's More options, choose Workflows, then "Send webhook
 *   alerts to a channel", and copy the address it shows.  The message stays in the channel, since
 *   deleting a channel's messages takes a permission Microsoft grants only on request.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  eventually,
  liveApp,
  liveMailbox,
  liveRequest,
  liveTeamsWebhook,
  liveToken,
  TEST_PREFIX,
  type MicrosoftLive,
} from '../test/microsoft-live.js';
import { deliverMessage, messageRequest, webhookAllowed, type MessageStep } from './messaging.js';
import { systemResolve } from './outbound.js';

const app = liveApp();
const mailbox = liveMailbox();
const webhook = liveTeamsWebhook();
const GRAPH = 'https://graph.microsoft.com/v1.0';
const TEAM = 'Riosoma tests';

describe.skipIf(!app || !mailbox)('the Riosoma tests team', () => {
  it('is there, made through Graph when it’s missing', { timeout: 300_000 }, async () => {
    const token = await liveToken(app as MicrosoftLive);
    const find = async () => {
      const found = await liveRequest(
        token,
        'GET',
        `${GRAPH}/teams?${new URLSearchParams({ $filter: `displayName eq '${TEAM}'`, $select: 'id,displayName' })}`,
      );
      expect(found.status, found.text).toBe(200);
      return (found.json.value as Array<{ id: string }>)[0]?.id;
    };
    let id = await find();
    if (!id) {
      const made = await liveRequest(token, 'POST', `${GRAPH}/teams`, {
        'template@odata.bind': "https://graph.microsoft.com/v1.0/teamsTemplates('standard')",
        displayName: TEAM,
        description: 'Where Riosoma’s live tests post.  Safe to keep between runs.',
        firstChannelName: TEAM,
        members: [
          {
            '@odata.type': '#microsoft.graph.aadUserConversationMember',
            roles: ['owner'],
            'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${mailbox}')`,
          },
        ],
      });
      expect(made.status, made.text).toBe(202);
      // Teams answers at once and makes the team in the background.
      id = await eventually(find, 240_000, 10_000);
    }
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe.skipIf(!webhook)('posting to Teams through a Workflows webhook', () => {
  it('delivers the step’s message to the channel', { timeout: 60_000 }, async () => {
    expect(
      webhookAllowed('teams', webhook!),
      'RIOSOMA_TEST_TEAMS_WEBHOOK_URL is not a Teams webhook address',
    ).toBe(true);
    const step: MessageStep = {
      id: 'live01',
      name: '',
      kind: 'teams',
      webhookUrl: '',
      body: `${TEST_PREFIX}teams ${randomBytes(4).toString('hex')}: Riosoma checked its Teams step.`,
    };
    const request = messageRequest(step, webhook!, () => ({ text: '', json: null, addresses: [] }));
    const result = await deliverMessage(step, request, {
      resolve: systemResolve,
      allowPrivate: false,
      timeoutMs: 20_000,
      renew: async () => {},
    });
    // Workflows accepts a post with 202 and runs the flow a moment later.
    expect(result.status).toBeGreaterThanOrEqual(200);
    expect(result.status).toBeLessThan(300);
    expect(result.errorCode).toBeNull();
  });
});
