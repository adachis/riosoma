import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { flattenAutomationSteps, newId, type AutomationStep } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import {
  apply,
  automate,
  createBase,
  createRecords,
  engine,
  grant,
  runsPage,
  schema,
  send,
  testRun,
  type Base,
} from './automations.test-helpers.js';
import { E164, messageRequest, messageText, webhookAllowed, type MessageStep } from './messaging.js';

let kit: TestPostgres;
let server: ServerFixture;
let base: Base;
let receiver: http.Server;
let baseUrl: string;
const hits: Array<{ body: string; url: string; headers: http.IncomingHttpHeaders }> = [];
let responses: Array<{ status: number; body: string }> = [];
const urls = {
  slack: 'https://hooks.slack.com/services/test/private-token',
  teams: 'https://test.logic.azure.com/workflows/test?sig=private-token',
  discord: 'https://discord.com/api/webhooks/123/private-token',
};
const sid = `AC${'1'.repeat(32)}`;
const sms: MessageStep = {
  id: 'sms001',
  name: '',
  kind: 'sms',
  accountSid: sid,
  authToken: 'private-auth-token',
  from: '+15005550006',
  to: '+15005550009',
  body: 'Message',
};
const hostile = '<!channel> @everyone **bold** _italic_ `code` [link](https://example.org) <b>HTML</b>';

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'messages', { automationsPollMs: 0, automationsAllowPrivateHosts: true });
  base = await createBase(server);
  receiver = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      hits.push({ body: Buffer.concat(chunks).toString(), url: request.url ?? '', headers: request.headers });
      const answer = responses.shift() ?? { status: 200, body: '{}' };
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  engine(server).messagingTestBaseUrls = {
    slack: baseUrl,
    teams: baseUrl,
    studioFlow: baseUrl,
    discord: baseUrl,
    sms: baseUrl,
  };
}, 60_000);

afterEach(async () => {
  hits.length = 0;
  responses = [];
  server.ctx.config.automationsAllowPrivateHosts = true;
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'orgs')} SET automation_sms_enabled = false`,
  );
});

afterAll(async () => {
  receiver?.closeAllConnections();
  if (receiver) await new Promise<void>((resolve) => receiver.close(() => resolve()));
  await server?.close();
  await kit?.stop();
});

function step(kind: 'slack' | 'teams' | 'discord'): MessageStep {
  return {
    id: `${kind}001`,
    name: '',
    kind,
    webhookUrl: urls[kind],
    body: `Hello {{trigger.record.${base.f.name}}}`,
  };
}
async function create(steps: AutomationStep[]) {
  return automate(
    server,
    base.databaseId,
    { trigger: { kind: 'recordCreated', tableId: base.tasks }, steps },
    { enabled: false },
  );
}
async function run(id: string, text = hostile) {
  const [recordId] = await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: text }]);
  return testRun(server, id, { recordId });
}
async function enableSms() {
  const response = await server.app.inject({
    method: 'PUT',
    url: '/api/admin/automations/messaging',
    headers: server.owner.headers,
    payload: { smsEnabled: true },
  });
  expect(response.statusCode).toBe(200);
}

describe('messaging steps', () => {
  it.each(['slack', 'teams', 'discord'] as const)(
    'sends the %s shape and escapes record markup and mentions',
    async (kind) => {
      const id = await create([step(kind)]);
      const result = await run(id);
      expect(result.run.state).toBe('succeeded');
      expect(hits).toHaveLength(1);
      const body = JSON.parse(hits[0]!.body);
      const text =
        kind === 'slack'
          ? body.text
          : kind === 'discord'
            ? body.content
            : body.attachments[0].content.body[0].text;
      expect(text).toContain('Hello ');
      // Mentions and pings need markup the value can no longer make.  Plain "@everyone" is only
      // text in all three: Slack pings through angle brackets, Teams through mention entities, and
      // Discord's message turns every mention off.
      expect(text).not.toContain('<!channel>');
      expect(text).not.toContain('<b>');
      if (kind === 'slack') expect(text).toContain('&lt;!channel&gt;');
      else expect(text).toContain('\\*\\*bold\\*\\*');
      if (kind === 'discord') expect(body.allowed_mentions.parse).toEqual([]);
      if (kind === 'slack') expect(Object.keys(body)).toEqual(['text']);
      if (kind === 'teams') {
        expect(body.type).toBe('message');
        expect(body.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
        expect(body.attachments[0].content).toMatchObject({
          type: 'AdaptiveCard',
          version: '1.2',
          body: [{ type: 'TextBlock', wrap: true }],
        });
      }
      if (kind === 'discord')
        expect(body.allowed_mentions).toEqual({ parse: [], users: [], roles: [], replied_user: false });
      expect(result.run.steps[0]?.output).toEqual({ status: 200, errorCode: null });
      expect(result.body).not.toContain('private-token');
      expect(result.body).not.toContain(hostile);
    },
  );

  it('seals credentials and keeps them out of schema, changes, and run history', async () => {
    const original = step('slack');
    const id = await create([original, sms]);
    const stored = await query<{ config: unknown; messaging_secrets: Record<string, string> }>(
      server.pool,
      sql`SELECT config, messaging_secrets FROM ${ident(server.schemas.app, 'automations')} WHERE id = ${id}`,
    );
    expect(JSON.stringify(stored.rows)).not.toContain('private-token');
    expect(JSON.stringify(stored.rows)).not.toContain(sms.authToken);
    expect(Object.values(stored.rows[0]!.messaging_secrets).every((value) => value.startsWith('rio2.'))).toBe(
      true,
    );
    const metadata = (await schema(server, base.databaseId)).automations!.find((item) => item.id === id)!;
    expect(metadata.config.steps[0]).toMatchObject({ webhookUrl: '', secretSaved: true });
    expect(metadata.config.steps[1]).toMatchObject({ authToken: '', secretSaved: true });
    expect(JSON.stringify(metadata)).not.toContain('rio1.');
    await apply(server, base.databaseId, [
      {
        kind: 'automation.update',
        automationId: id,
        config: { ...metadata.config, steps: [metadata.config.steps[0]] },
      },
    ]);
    expect((await run(id)).run.state).toBe('succeeded');
    const changes = await query(
      server.pool,
      sql`SELECT body, prev FROM ${ident(server.schemas.app, 'changes')} WHERE database_id = ${base.databaseId}`,
    );
    expect(JSON.stringify(changes.rows)).not.toContain('private-token');
    expect(JSON.stringify(changes.rows)).not.toContain(sms.authToken);
    expect(JSON.stringify(changes.rows)).not.toContain('rio1.');
    expect(JSON.stringify((await runsPage(server, id)).page)).not.toContain('private-token');
    const changed = {
      ...metadata.config,
      steps: [{ ...original, webhookUrl: 'https://hooks.slack.com/services/replacement/token' }],
    };
    await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, config: changed }]);
    await run(id);
    expect(hits.at(-1)?.url).toBe('/services/replacement/token');
  });

  it('ignores a forged saved flag and refuses to reuse another step credential', async () => {
    const id = await create([{ ...step('slack'), webhookUrl: '', secretSaved: true } as MessageStep]);
    const metadata = (await schema(server, base.databaseId)).automations!.find((item) => item.id === id)!;
    expect(metadata.config.steps[0]).toMatchObject({ secretSaved: false });
    expect((await run(id)).run.steps[0]?.error?.messageKey).toBe('automations.messaging.secretRequired');
    expect(hits).toHaveLength(0);
  });

  it.each(['slack', 'teams', 'discord'] as const)('refuses unrelated %s hosts at save time', async (kind) => {
    const results = await send(server, base.databaseId, [
      {
        kind: 'automation.create',
        automation: {
          id: newId('automation'),
          name: 'Invalid',
          config: {
            trigger: { kind: 'webhook' },
            steps: [
              { ...step(kind), body: 'Text', webhookUrl: 'https://example.org/api/webhooks/123/token' },
            ],
          },
        },
      },
    ]);
    expect(results[0]?.status).toBe('rejected');
    expect(results[0]?.error?.messageKey).toBe('automations.messaging.webhook');
  });

  it('keeps the private network rule even with a test endpoint', async () => {
    server.ctx.config.automationsAllowPrivateHosts = false;
    const result = await run(await create([step('discord')]));
    expect(result.run.state).toBe('failed');
    expect(hits).toHaveLength(0);
  });

  it.each(['slack', 'teams', 'discord', 'sms'] as const)(
    'retries %s rate limits and server errors',
    async (kind) => {
      await enableSms();
      responses = [
        { status: 429, body: 'private-token' },
        { status: 503, body: 'private-token' },
        { status: 200, body: '{}' },
      ];
      const result = await run(await create([kind === 'sms' ? sms : step(kind)]));
      expect(result.run.state).toBe('succeeded');
      expect(hits).toHaveLength(3);
      expect(result.body).not.toContain('private-token');
    },
  );

  it.each([
    ['slack', 'channel_not_found', 'channel_not_found'],
    [
      'teams',
      '{"error":{"code":"InvalidRequestContent","message":"private-token"}}',
      'InvalidRequestContent',
    ],
    ['discord', '{"code":10015,"message":"private-token"}', 10015],
    ['sms', '{"code":21610,"message":"private-auth-token"}', 21610],
  ] as const)('records only the %s provider status and error code', async (kind, body, code) => {
    await enableSms();
    responses = [{ status: 400, body }];
    const result = await run(await create([kind === 'sms' ? sms : step(kind)]));
    expect(result.run.steps[0]?.output).toEqual({ status: 400, errorCode: code });
    expect(result.run.state).toBe('failed');
    expect(result.body).not.toContain('private-token');
    expect(result.body).not.toContain('private-auth-token');
    expect(hits).toHaveLength(1);
  });

  it('stops after three rate limited attempts and discards unknown error text', async () => {
    responses = Array.from({ length: 3 }, () => ({
      status: 429,
      body: '{"error":{"code":"private-token"}}',
    }));
    const result = await run(await create([step('teams')]));
    expect(result.run.steps[0]?.output).toEqual({ status: 429, errorCode: null });
    expect(result.run.state).toBe('failed');
    expect(hits).toHaveLength(3);
  });

  it('starts with SMS off and allows only owners and security admins to change the setting', async () => {
    const policy = await server.app.inject({
      method: 'GET',
      url: '/api/admin/automations/messaging',
      headers: server.owner.headers,
    });
    expect(policy.json()).toEqual({ smsEnabled: false });
    const result = await run(await create([sms]));
    expect(result.run.steps[0]?.error?.messageKey).toBe('automations.messaging.smsDisabled');
    expect(hits).toHaveLength(0);
    const member = await server.addMember();
    await grant(server, base.databaseId, member, 'creator');
    const refused = await server.app.inject({
      method: 'PUT',
      url: '/api/admin/automations/messaging',
      headers: member.headers,
      payload: { smsEnabled: true },
    });
    expect(refused.statusCode).toBe(403);
  });

  it('sends form encoded SMS with basic authentication and plain token text', async () => {
    await enableSms();
    const result = await run(await create([{ ...sms, body: `Hello {{trigger.record.${base.f.name}}}` }]));
    expect(result.run.state).toBe('succeeded');
    const hit = hits[0]!;
    expect(hit.url).toBe(`/2010-04-01/Accounts/${sid}/Messages.json`);
    expect(hit.headers.authorization).toBe(
      `Basic ${Buffer.from(`${sid}:${sms.authToken}`).toString('base64')}`,
    );
    expect(hit.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(hit.body))).toEqual({
      From: sms.from,
      To: sms.to,
      Body: `Hello ${hostile}`,
    });
  });

  it('reads an E.164 recipient from a phone field and refuses other field types', async () => {
    const phoneId = newId('field');
    await apply(server, base.databaseId, [
      { kind: 'field.create', tableId: base.tasks, field: { id: phoneId, name: 'Phone', type: 'phone' } },
    ]);
    await enableSms();
    const id = await create([{ ...sms, to: `{{trigger.record.${phoneId}}}` }]);
    const [recordId] = await createRecords(server, base.databaseId, base.tasks, [
      { [phoneId]: '+15005550009' },
    ]);
    expect((await testRun(server, id, { recordId })).run.state).toBe('succeeded');
    expect(new URLSearchParams(hits[0]!.body).get('To')).toBe('+15005550009');
    const rejected = await send(server, base.databaseId, [
      {
        kind: 'automation.update',
        automationId: id,
        config: {
          trigger: { kind: 'recordCreated', tableId: base.tasks },
          steps: [{ ...sms, to: `{{trigger.record.${base.f.name}}}` }],
        },
      },
    ]);
    expect(rejected[0]?.status).toBe('rejected');
    const [invalid] = await createRecords(server, base.databaseId, base.tasks, [{ [phoneId]: '555-0100' }]);
    expect((await testRun(server, id, { recordId: invalid })).run.steps[0]?.error?.messageKey).toBe(
      'automations.messaging.phone',
    );
    expect(hits).toHaveLength(1);
  });

  it('checks the SMS length after expanding tokens', async () => {
    await enableSms();
    const id = await create([{ ...sms, body: `{{trigger.record.${base.f.note}}}` }]);
    const [recordId] = await createRecords(server, base.databaseId, base.tasks, [
      { [base.f.note]: 'x'.repeat(1601) },
    ]);
    const result = await testRun(server, id, { recordId });
    expect(result.run.steps[0]?.error?.messageKey).toBe('automations.messaging.length');
    expect(hits).toHaveLength(0);
  });
});

describe('message validation', () => {
  it('accepts only the service hosts and HTTPS without credentials or alternate ports', () => {
    expect(webhookAllowed('teams', 'https://test.webhook.office.com/webhook/test')).toBe(true);
    // A workflow's address names port 443 outright, which is the one HTTPS uses anyway.
    const workflow =
      'https://default0123abcd.ef.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/0a1b/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=signature';
    expect(webhookAllowed('teams', workflow)).toBe(true);
    expect(webhookAllowed('teams', workflow.replace(':443', ':8443'))).toBe(false);
    expect(webhookAllowed('teams', 'https://environment.api.powerplatform.com/powerautomate')).toBe(false);
    expect(webhookAllowed('teams', 'https://default0123abcd.ef.api.powerplatform.com/powerautomate')).toBe(
      false,
    );
    expect(webhookAllowed('discord', 'https://discordapp.com/api/webhooks/123/token')).toBe(true);
    for (const [kind, url] of Object.entries(urls)) {
      const service = kind as 'slack' | 'teams' | 'discord';
      expect(webhookAllowed(service, url)).toBe(true);
      expect(webhookAllowed(service, url.replace('https:', 'http:'))).toBe(false);
      expect(webhookAllowed(service, url.replace('https://', 'https://user:secret@'))).toBe(false);
      expect(
        webhookAllowed(service, url.replace(new URL(url).host, `${new URL(url).host}.example.org`)),
      ).toBe(false);
      expect(webhookAllowed(service, url.replace(new URL(url).host, `${new URL(url).host}:8443`))).toBe(
        false,
      );
    }
    expect(webhookAllowed('discord', 'https://discord.com/api/other/123/token')).toBe(false);
    expect(webhookAllowed('teams', 'https://logic.azure.com/path')).toBe(false);
  });

  it('validates E.164 numbers and the 1,600 character boundary', () => {
    for (const value of ['5550100', '+0123', '+1 555 0100', '+1234567890123456', ''])
      expect(E164.test(value)).toBe(false);
    expect(E164.test('+15005550006')).toBe(true);
    const resolve = () => ({ text: '', json: null, addresses: [] });
    expect(() => messageRequest({ ...sms, body: 'x'.repeat(1600) }, 'token', resolve)).not.toThrow();
    expect(() => messageRequest({ ...sms, body: 'x'.repeat(1601) }, 'token', resolve)).toThrow();
  });

  it('leaves author markup intact while escaping hostile values', () => {
    const resolve = () => ({ text: hostile, json: hostile, addresses: [] });
    const text = messageText(
      { id: 'step01', name: '', kind: 'discord', webhookUrl: '', body: '**Title** {{now}}' },
      resolve,
    );
    expect(text.startsWith('**Title** ')).toBe(true);
    expect(text).toContain('\\*\\*bold\\*\\*');
    expect(text).toContain('\\<b\\>HTML\\</b\\>');
  });

  it('keeps every character of a value, email addresses included', () => {
    const resolve = () => ({ text: 'mary_ann@example.com & co', json: '', addresses: [] });
    const body = '{{now}}';
    expect(messageText({ id: 'step01', name: '', kind: 'slack', webhookUrl: '', body }, resolve)).toBe(
      'mary_ann@example.com &amp; co',
    );
    expect(
      messageText(
        {
          id: 'step01',
          name: '',
          kind: 'sms',
          to: '',
          from: '',
          accountSid: '',
          authToken: '',
          body,
        } as never,
        resolve,
      ),
    ).toBe('mary_ann@example.com & co');
  });
});

it('posts the flow contract, retries transient failures, and keeps the address sealed', async () => {
  const secret = randomBytes(24).toString('hex');
  const webhookUrl = `${urls.teams.split('?')[0]}?sig=${secret}`;
  const flow: MessageStep = {
    id: 'flow01',
    name: '',
    kind: 'studioFlow',
    webhookUrl,
    body: `Hello {{trigger.record.${base.f.name}}}`,
    title: '{{now}}',
    recipient: '{{trigger.record.' + base.f.name + '}}',
    recordUrl: '{{trigger.record.url}}',
  };
  const id = await create([flow]);
  responses = [
    { status: 429, body: secret },
    { status: 503, body: secret },
    { status: 202, body: '{}' },
  ];
  const result = await run(id, 'person@example.invalid');
  expect(result.run.state).toBe('succeeded');
  expect(hits).toHaveLength(3);
  const payload = JSON.parse(hits[0]!.body);
  expect(payload).toMatchObject({
    message: 'Hello person@example.invalid',
    recipient: 'person@example.invalid',
    title: expect.any(String),
  });
  expect(payload.recordUrl).toContain(`/${base.databaseId}/${base.tasks}/`);
  const saved = await schema(server, base.databaseId);
  expect(JSON.stringify(saved)).not.toContain(secret);
  expect(result.body).not.toContain(secret);
  expect(JSON.stringify(saved)).not.toContain(webhookUrl);
  const preview = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/steps/flow01/test`,
    headers: server.owner.headers,
    payload: { preview: true },
  });
  expect(preview.statusCode).toBe(200);
  expect(preview.json()).toMatchObject({
    source: 'history',
    missing: [],
    inputs: {
      body: payload.message,
      recipient: payload.recipient,
      title: expect.any(String),
      recordUrl: payload.recordUrl,
    },
  });
  expect(preview.body).not.toContain(secret);
  const [recordId] = await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Preview' }]);
  const simulated = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/simulate`,
    headers: server.owner.headers,
    payload: { recordId },
  });
  expect(simulated.statusCode).toBe(200);
  expect(simulated.json().steps[0].sends[0]).toMatchObject({
    kind: 'message',
    channel: 'studioFlow',
    to: 'Preview',
    text: 'Hello Preview',
    title: expect.any(String),
    recordUrl: expect.stringContaining(recordId!),
  });
  expect(simulated.body).not.toContain(secret);
  expect(hits).toHaveLength(3);

  responses = [
    { status: 400, body: JSON.stringify({ error: { code: 'InvalidRequestContent', message: secret } }) },
  ];
  hits.length = 0;
  const failed = await run(id);
  expect(failed.run.state).toBe('failed');
  expect(failed.run.steps[0]?.output).toEqual({ status: 400, errorCode: 'InvalidRequestContent' });
  expect(failed.body).not.toContain(secret);
  expect(hits).toHaveLength(1);
});

function nestedFlow(flow: MessageStep): AutomationStep[] {
  return [
    {
      id: 'branch01',
      name: '',
      kind: 'if',
      conditions: null,
      otherwise: [],
      then: [
        {
          id: 'repeat01',
          name: '',
          kind: 'repeat',
          list: '["first", "second"]',
          steps: [flow],
        },
      ],
    },
  ];
}

it('keeps nested flow credentials sealed and resolves each loop message and record link', async () => {
  const secret = randomBytes(24).toString('hex');
  const flow: MessageStep = {
    id: 'flow01',
    name: '',
    kind: 'studioFlow',
    webhookUrl: `${urls.teams.split('?')[0]}?sig=${secret}`,
    body: 'Message {{index}}',
    title: `{{trigger.record.${base.f.name}}}`,
    recipient: '{{item}}',
    recordUrl: '{{trigger.record.url}}',
  };
  const id = await create(nestedFlow(flow));
  const saved = (await schema(server, base.databaseId)).automations!.find((item) => item.id === id)!;
  expect(flattenAutomationSteps(saved.config.steps).find((step) => step.id === flow.id)).toMatchObject({
    webhookUrl: '',
    secretSaved: true,
  });
  expect(JSON.stringify(saved)).not.toContain(secret);
  const stored = await query<{ messaging_secrets: Record<string, string> }>(
    server.pool,
    sql`SELECT messaging_secrets FROM ${ident(server.schemas.app, 'automations')} WHERE id = ${id}`,
  );
  expect(Object.values(stored.rows[0]!.messaging_secrets)).toEqual([expect.stringMatching(/^rio2\./)]);
  expect(JSON.stringify(stored.rows)).not.toContain(secret);
  const result = await run(id, 'Review');
  expect(result.run.state).toBe('succeeded');
  expect(hits.map((hit) => JSON.parse(hit.body))).toEqual([
    {
      message: 'Message 0',
      title: 'Review',
      recipient: 'first',
      recordUrl: expect.stringContaining(`/${base.grid}/`),
    },
    {
      message: 'Message 1',
      title: 'Review',
      recipient: 'second',
      recordUrl: expect.stringContaining(`/${base.grid}/`),
    },
  ]);
  expect(hits.every((hit) => hit.url.endsWith(secret))).toBe(true);
  expect(result.body).not.toContain(secret);
});

it.each(['webhookUrl', 'body', 'title', 'recipient', 'recordUrl'] as const)(
  'validates the %s of a flow step inside a branch and loop',
  async (field) => {
    const flow: MessageStep = {
      id: 'flow01',
      name: '',
      kind: 'studioFlow',
      webhookUrl: urls.teams,
      body: 'Message',
      title: '',
      recipient: '{{item}}',
      recordUrl: '{{trigger.record.url}}',
      [field]: field === 'webhookUrl' ? urls.slack : '{{steps.missing01.output}}',
    };
    const results = await send(server, base.databaseId, [
      {
        kind: 'automation.create',
        automation: {
          id: newId('automation'),
          name: 'Invalid nested flow',
          config: { trigger: { kind: 'recordCreated', tableId: base.tasks }, steps: nestedFlow(flow) },
        },
      },
    ]);
    expect(results[0]?.status).toBe('rejected');
    expect(results[0]?.error?.messageKey).toBe(
      field === 'webhookUrl' ? 'automations.messaging.webhook' : 'automations.token.unknown',
    );
  },
);

it('uses the Teams host policy for flow triggers and omits empty titles', () => {
  for (const address of [
    urls.teams,
    urls.slack,
    'https://logic.azure.com/',
    'http://test.logic.azure.com/',
    'https://test.logic.azure.com:8443/',
    'https://test.logic.azure.com.evil.invalid/',
  ]) {
    expect(webhookAllowed('studioFlow', address)).toBe(webhookAllowed('teams', address));
  }
  const request = messageRequest(
    {
      id: 'flow01',
      name: '',
      kind: 'studioFlow',
      webhookUrl: '',
      body: 'Message',
      title: '',
      recipient: 'channel:team/channel',
      recordUrl: '',
    },
    urls.teams,
    () => ({ text: '', json: null, addresses: [] }),
  );
  expect(JSON.parse(request.body!)).toEqual({
    message: 'Message',
    recipient: 'channel:team/channel',
    recordUrl: '',
  });
});
