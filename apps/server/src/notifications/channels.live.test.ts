/**
 * Direct notifications against the real services, each skipping when its settings are missing:
 *
 * - Slack needs `RIOSOMA_TEST_SLACK_BOT_TOKEN`, `RIOSOMA_TEST_SLACK_RECIPIENT` (a member's email
 *   address), and `RIOSOMA_TEST_BASE_URL`.
 * - Teams needs `RIOSOMA_TEST_TEAMS_TENANT_ID`, `RIOSOMA_TEST_TEAMS_CLIENT_ID`,
 *   `RIOSOMA_TEST_TEAMS_CLIENT_SECRET`, `RIOSOMA_TEST_TEAMS_REFRESH_TOKEN`,
 *   `RIOSOMA_TEST_TEAMS_RECIPIENT` (a member's email address), and `RIOSOMA_TEST_BASE_URL`.
 *
 * Each check sends one notification, leaves it with the recipient, and reads no message history.
 * The transports report failures without quoting credentials or service responses.
 */
import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';
import { sendSlack, sendTeams } from './transports.js';
import { privatePayload } from './messages.js';

const env = (name: string) => process.env[`RIOSOMA_TEST_${name}`]?.trim();
const slackRecipient = env('SLACK_RECIPIENT');
const teamsRecipient = env('TEAMS_RECIPIENT');
const base = env('BASE_URL');
const slack = env('SLACK_BOT_TOKEN');
const tenantId = env('TEAMS_TENANT_ID');
const clientId = env('TEAMS_CLIENT_ID');
const clientSecret = env('TEAMS_CLIENT_SECRET');
const refreshToken = env('TEAMS_REFRESH_TOKEN');
const payload = () => {
  const message = privatePayload({ kind: 'feedbackReply', target: {} }, 'en-US', base!);
  return { ...message, title: `rio_test_${randomUUID()} ${message.title}` };
};

describe.skipIf(!slackRecipient || !base || !slack)('live Slack notification delivery', () => {
  it(
    'delivers a direct notification to the configured test recipient',
    { timeout: 30_000, retry: 0 },
    async () => {
      await sendSlack({ channel: 'slack', token: slack! }, slackRecipient!, payload());
    },
  );
});
describe.skipIf(!teamsRecipient || !base || !tenantId || !clientId || !clientSecret || !refreshToken)(
  'live Teams notification delivery',
  () => {
    it(
      'delivers a direct notification through the delegated Graph connection',
      { timeout: 60_000, retry: 0 },
      async () => {
        await sendTeams(
          {
            channel: 'teams',
            tenantId: tenantId!,
            clientId: clientId!,
            clientSecret: clientSecret!,
            refreshToken: refreshToken!,
          },
          teamsRecipient!,
          payload(),
        );
      },
    );
  },
);
