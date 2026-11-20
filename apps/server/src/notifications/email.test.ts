import { describe, expect, it } from 'vitest';
import { newId, type Notification } from '@riosoma/contracts';
import { notificationEmail } from './email.js';

const databaseId = newId('database');
const tableId = newId('table');
const automationId = newId('automation');
const viewId = newId('view');
const reportId = newId('report');

function note(kind: Notification['kind'], extra: Partial<Notification['target']> = {}): Notification {
  return {
    id: newId('notification'),
    kind,
    createdAt: '2026-09-27T12:00:00.000Z',
    readAt: null,
    actor: kind === 'mention' || kind === 'share' ? { id: newId('user'), name: 'Sam Stone' } : null,
    target: { databaseId, databaseName: 'Sales', tableName: 'Leads', tableId, ...extra },
  };
}

const send = (notification: Notification) =>
  notificationEmail(notification, 'reader@example.test', 'en-US', 'https://riosoma.example.test/');

describe('notification emails', () => {
  it('renders notification step text safely and omits an absent link', () => {
    const message = send(
      note('automationNotification', {
        title: 'Review <task>\nNext line',
        message: '<script> & {url}',
        link: '',
      }),
    );
    expect(message.subject).toBe('Review <task> Next line');
    expect(message.html).toContain('&lt;script&gt; &amp; {url}');
    expect(message.html).not.toContain('<script>');
    expect(message.html.match(/<a /g)).toHaveLength(1);
    expect(message.text).toContain('<script> & {url}');
    expect(message.text).not.toContain('Open it in Riosoma:');
    const linked = send(
      note('automationNotification', {
        title: 'Review',
        message: 'Ready',
        link: `/settings/notifications`,
      }),
    );
    expect(linked.text).toContain('/settings/notifications');
  });
  it('tells members about organization role changes and links to their settings', () => {
    const message = send({ ...note('adminRolesChanged'), target: {} });
    expect(message.subject).toBe('Your admin roles changed');
    expect(message.text).toContain('changed your organization admin roles.');
    expect(message.text).toContain('/settings/security');
  });

  it('say plainly what happened and where, with a link to it', () => {
    const automation = { automationId, automationName: 'Weekly digest' };
    expect(
      [
        note('mention', { excerpt: 'Can you check this?' }),
        note('share', { role: 'editor' }),
        note('automationStopped', automation),
        note('automationFailed', automation),
        note('syncFailed'),
        note('syncHeld', { held: { removing: 12, total: 30 } }),
        note('reportStopped', { viewId, reportId, reportName: 'Monday pipeline' }),
      ].map((notification) => {
        const message = send(notification);
        return [message.subject, message.text.split('\n\n')[0], message.text.split('\n\n').at(-2)];
      }),
    ).toEqual([
      [
        'Sam Stone mentioned you in Leads',
        'Sam Stone mentioned you in a comment in Leads, in Sales:',
        `Open it in Riosoma: https://riosoma.example.test/${databaseId}/${tableId}`,
      ],
      [
        'Sam Stone shared Sales with you',
        'Sam Stone shared Sales with you.',
        `Open it in Riosoma: https://riosoma.example.test/${databaseId}`,
      ],
      [
        'Weekly digest turned itself off',
        'Weekly digest, an automation in Sales that acts as you, turned itself off.',
        `Open it in Riosoma: https://riosoma.example.test/${databaseId}/automations/${automationId}`,
      ],
      [
        'Weekly digest failed in Sales',
        'A run of Weekly digest, an automation in Sales that acts as you, didn’t finish.  You’ll hear about its failures at most once an hour.',
        `Open it in Riosoma: https://riosoma.example.test/${databaseId}/automations/${automationId}`,
      ],
      [
        'Leads stopped syncing',
        'Leads, a synced table you made in Sales, couldn’t sync with its source.',
        `Open it in Riosoma: https://riosoma.example.test/${databaseId}/${tableId}`,
      ],
      [
        'Leads is waiting for you',
        'A sync of Leads, a synced table you made in Sales, would remove 12 of its 30 records, so it’s waiting for someone to confirm.',
        `Open it in Riosoma: https://riosoma.example.test/${databaseId}/${tableId}`,
      ],
      [
        'Monday pipeline turned itself off',
        'Monday pipeline, a scheduled report you set up in Sales, turned itself off and won’t be sent until you turn it back on.',
        `Open it in Riosoma: https://riosoma.example.test/${databaseId}/${tableId}/${viewId}`,
      ],
    ]);
  });

  it('quote a reply to feedback, which belongs to no database, and link to what was sent', () => {
    const message = send({
      id: newId('notification'),
      kind: 'feedbackReply',
      createdAt: '2026-09-27T12:00:00.000Z',
      readAt: null,
      actor: { id: newId('user'), name: 'Ada Admin' },
      target: { feedbackId: newId('feedback'), excerpt: 'Fixed in the next version.' },
    });
    expect(message.subject).toBe('Ada Admin replied to your feedback');
    expect(message.text.split('\n\n').slice(0, 3)).toEqual([
      'Ada Admin replied to feedback you sent:',
      '“Fixed in the next version.”',
      'Open it in Riosoma: https://riosoma.example.test/settings/my-feedback',
    ]);
    expect(message.html).toContain('<blockquote>Fixed in the next version.</blockquote>');
  });

  it('escape names in the markup and keep subjects to one short line', () => {
    const message = send({
      ...note('mention', { excerpt: '<b>bold</b> & more' }),
      actor: { id: newId('user'), name: 'Sam <script>' },
      target: {
        databaseId,
        databaseName: 'Sales "West"',
        tableId,
        tableName: `Leads\nBcc: someone@example.test ${'x'.repeat(80)}`,
      },
    });
    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(Array.from(message.subject.split(' in ').at(-1)!)).toHaveLength(60);
    expect(message.html).toContain('Sam &lt;script&gt;');
    expect(message.html).toContain('Sales &quot;West&quot;');
    expect(message.html).not.toContain('<script>');
    // A mention with nothing quoted still reads, and someone unknown is "Someone".
    const plain = send({ ...note('mention'), actor: null });
    expect(plain.subject).toBe('Someone mentioned you in Leads');
    expect(plain.html).not.toContain('blockquote');
  });

  it('tell a webhook’s person that a post failed and where it’s kept, with nothing it said', () => {
    const message = send({
      ...note('webhookFailed'),
      target: { sourceId: newId('source'), sourceName: 'Orders' },
    });
    expect(message.subject).toBe('A post to Orders couldn’t be written');
    expect(message.text.split('\n\n')[0]).toBe(
      'Orders, a webhook source you set up, accepted a post that couldn’t be written to its tables after an hour of tries.  It’s kept in the webhook’s delivery log.',
    );
    expect(message.text).toContain('https://riosoma.example.test/settings/sources');
  });

  it('tell the owner and Integrations administrators that a custom domain lost its verification', () => {
    const message = send({ ...note('customDomainUnverified'), target: { domain: 'forms.example.test' } });
    expect(message.subject).toBe('forms.example.test is no longer verified');
    expect(message.text.split('\n\n')[0]).toContain('public pages');
    expect(message.text).toContain('https://riosoma.example.test/settings/custom-domains');
  });
});

it('renders every ingest kind in email and digests using counts and reasons without row values', async () => {
  const { NOTIFICATION_KINDS, DEFAULT_NOTIFICATION_EMAIL } = await import('@riosoma/contracts');
  const { digestEmail, privatePayload, KIND_COPY } = await import('./messages.js');
  const notifications = NOTIFICATION_KINDS.filter((kind) => kind.startsWith('ingest.')).map((kind) =>
    note(kind, {
      ingestCounts: { added: 2, updated: 3, identical: 4, flagged: 5, refused: 6 },
      reason: { messageKey: 'notifications.ingest.held.reason' },
      excerpt: 'private row values',
      message: 'private row values',
    }),
  );
  expect(notifications).toHaveLength(6);
  for (const notification of notifications) {
    expect(KIND_COPY[`notifications.kind.${notification.kind}`]).toMatchObject({
      id: `notifications.kind.${notification.kind}`,
    });
    expect(DEFAULT_NOTIFICATION_EMAIL[notification.kind]).toBe(notification.kind !== 'ingest.file.read');
    const email = send(notification);
    expect(email.subject).not.toContain('{');
    expect(email.text).not.toContain('{');
    expect(email.text + email.html).not.toContain('private row values');
    expect(privatePayload(notification, 'en-US', 'https://riosoma.example.test').body).not.toContain(
      'private row values',
    );
    if (notification.kind === 'ingest.file.read')
      expect(email.text).toContain('Added: 2, updated: 3, identical: 4, flagged: 5, and refused: 6.');
    if (notification.kind === 'ingest.file.held')
      expect(email.text).toContain('Open the table to review the reason.');
  }
  const digest = digestEmail(notifications, 'reader@example.test', 'en-US', 'https://riosoma.example.test');
  expect(digest.text + digest.html).not.toContain('private row values');
});

it('localizes a catalog reason for a held file', () => {
  const message = send(note('ingest.file.held', { reason: { messageKey: 'ingest.fields.locked' } }));
  expect(message.text).toContain('A file is held on Leads.  Ask Rio to change this field.');
});

it('keeps row text out of held reasons, even when a reason supplies text parameters', () => {
  const email = send(
    note('ingest.file.held', {
      reason: { messageKey: 'api.schema.invalidRequest', params: { detail: 'private row values' } },
    }),
  );
  expect(email.text + email.html).not.toContain('private row values');
  expect(email.text).toContain('Open the table to review the reason.');
});
