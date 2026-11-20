import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AutomationRunsPage } from '../../../packages/contracts/src/data/automations';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, newId, openTable, runCommands, signIn, visit } from '../helpers';
import { invite, mailTo, share } from '../people';

test.use({ serviceWorkers: 'block' });

let receiver: Server;
let address: string;
let status = 200;
const posted: string[] = [];

test.beforeAll(async () => {
  receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      posted.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ accepted: status === 200 }));
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  address = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/receive`;
});

test.beforeEach(() => {
  status = 200;
  posted.length = 0;
});

test.afterAll(async () => {
  receiver.closeAllConnections();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

test('simulates common steps without effects, then tests them and shows their inputs and outputs', async ({
  page,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Dispatch samples', [
    {
      name: 'Requests',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'text' },
      ],
      records: [{ Name: '東京 🧭 مرحبا', Status: 'New' }],
    },
    { name: 'Log', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const requests = database.tables.Requests!;
  const log = database.tables.Log!;
  const automationId = newId('aut');
  const recipient = `${automationId}@example.test`;
  const name = `{{trigger.record.${requests.fields.Name}}}`;
  await runCommands(page, database.id, [
    {
      kind: 'automation.create',
      automation: {
        id: automationId,
        name: 'Dispatch samples',
        config: {
          trigger: { kind: 'recordCreated', tableId: requests.id },
          steps: [
            {
              id: 'update01',
              kind: 'updateRecord',
              tableId: requests.id,
              record: 'trigger',
              values: { [requests.fields.Status!]: 'Triaged' },
            },
            { id: 'create01', kind: 'createRecord', tableId: log.id, values: { [log.fields.Name!]: name } },
            { id: 'search01', kind: 'findRecords', tableId: log.id, filter: null, limit: 10 },
            { id: 'email001', kind: 'sendEmail', to: [recipient], subject: 'Dispatch review', body: name },
            {
              id: 'request1',
              kind: 'callWebhook',
              url: address,
              method: 'POST',
              headers: {},
              body: JSON.stringify({ name }),
            },
            {
              id: 'script01',
              kind: 'script',
              script: 'console.log(input.name); await output(input)',
              input: { name },
            },
          ],
        },
      },
    },
  ]);
  const token = await asOwner<{ token: string }>(page, 'POST', '/api/tokens', {
    name: 'Automation reader',
    scopes: ['schema.bases:read'],
    databases: [database.id],
  });
  const read = await page.request.post(`${base()}/mcp`, {
    headers: { authorization: `Bearer ${token.token}`, accept: 'application/json, text/event-stream' },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_automation', arguments: { databaseId: database.id, id: automationId } },
    },
  });
  expect(read.ok()).toBe(true);
  const details = await read.json();
  expect(details.result?.isError).not.toBe(true);
  expect(details.result?.structuredContent).toMatchObject({ id: automationId });
  expect(JSON.stringify(details)).not.toContain(recipient);
  expect(JSON.stringify(details)).not.toContain(address);
  expect(JSON.stringify(details)).not.toContain('console.log');
  await openTable(page, database, 'Requests');
  await page.getByRole('link', { name: 'Dispatch samples', exact: true }).click();
  await page.getByRole('button', { name: 'Simulate', exact: true }).click();
  const simulation = page.getByRole('region', { name: 'Simulate', exact: true });
  await simulation.getByRole('button', { name: 'Run to the end', exact: true }).click();
  await expect(simulation).toContainText('Every step ran.');
  expect(posted).toEqual([]);
  expect(mailTo(recipient)).toEqual([]);
  await simulation.getByRole('button', { name: 'Close the simulation', exact: true }).click();
  await page.getByRole('button', { name: 'Test the whole automation', exact: true }).click();
  const result = page.getByRole('region', { name: 'Test run', exact: true });
  await expect(result.getByText('Done', { exact: true }).first()).toBeVisible();
  await expect.poll(() => posted).toEqual([JSON.stringify({ name: '東京 🧭 مرحبا' })]);
  await expect.poll(() => mailTo(recipient).map((mail) => mail.subject)).toEqual(['Dispatch review']);
  expect(mailTo(recipient)[0]!.text).toContain('東京 🧭 مرحبا');
  await expect(result).toContainText('東京 🧭 مرحبا');
  await page.getByRole('tab', { name: 'Runs', exact: true }).click();
  const history = page.getByRole('tabpanel', { name: 'Runs', exact: true });
  await history.getByRole('button').filter({ hasText: 'Done' }).first().click();
  await history.getByText('Input', { exact: true }).first().click();
  await expect(history).toContainText('Triaged');
  await expect(history).toContainText('Dispatch review');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(history.getByText('Run a script', { exact: true })).toBeVisible();
});

test('resumes a failed webhook run without repeating earlier writes and reruns from the start', async ({
  page,
}) => {
  await signIn(page);
  await page.route('**/api/rio/status', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        tiers: ['everyday'],
        autonomy: 'previewBig',
        paused: false,
        diagnose: true,
        routines: false,
        routineRunLimitUsd: 1,
      },
    }),
  );
  await page.route('**/api/automations/*/runs/*/diagnose', (route) =>
    route.fulfill({
      json: {
        runId: new URL(route.request().url()).pathname.split('/').at(-2),
        cause: 'badAddress',
        explanation: 'The local receiver refused this request.',
        fix: null,
        redacted: false,
        usage: { providerId: 'local', model: '', inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0 },
      },
    }),
  );
  const database = await createDatabase(page, 'Recovery desk', [
    { name: 'Log', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const log = database.tables.Log!;
  const automationId = newId('aut');
  await runCommands(page, database.id, [
    {
      kind: 'automation.create',
      automation: {
        id: automationId,
        name: 'Recover requests',
        config: {
          trigger: { kind: 'webhook' },
          steps: [
            {
              id: 'create01',
              kind: 'createRecord',
              tableId: log.id,
              values: { [log.fields.Name!]: 'Received {{trigger.body.name}}' },
            },
            {
              id: 'request1',
              kind: 'callWebhook',
              url: address,
              method: 'POST',
              headers: {},
              body: '{{trigger.body.name}}',
            },
          ],
        },
      },
    },
    { kind: 'automation.update', automationId, enabled: true },
  ]);
  await openTable(page, database, 'Log');
  await page.getByRole('link', { name: 'Recover requests', exact: true }).click();
  const hook = await page.getByRole('textbox', { name: 'Webhook address', exact: true }).inputValue();
  status = 400;
  expect((await page.request.post(hook, { data: { name: 'Dock' } })).status()).toBe(202);
  await expect
    .poll(
      async () =>
        (await asOwner<AutomationRunsPage>(page, 'GET', `/api/automations/${automationId}/runs`)).runs[0]
          ?.state,
    )
    .toBe('failed');
  await page.getByRole('tab', { name: 'Runs', exact: true }).click();
  const history = page.getByRole('tabpanel', { name: 'Runs', exact: true });
  await history.getByRole('button').filter({ hasText: 'Failed' }).first().click();
  await expect(history.getByRole('button', { name: 'Resume from here', exact: true })).toBeVisible();
  await history.getByRole('button', { name: 'Diagnose', exact: true }).click();
  await expect(history).toContainText('Cause: A wrong or unreachable address');
  await expect(history).toContainText('The local receiver refused this request.');
  status = 200;
  await history.getByRole('button', { name: 'Resume from here', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await asOwner<AutomationRunsPage>(page, 'GET', `/api/automations/${automationId}/runs`)).runs[0]
          ?.state,
    )
    .toBe('succeeded');
  await history.getByRole('button').filter({ hasText: 'Resumed' }).first().click();
  await expect(history).toContainText('Kept from the earlier run');
  await history.getByRole('button', { name: 'Rerun', exact: true }).first().click();
  await expect
    .poll(
      async () =>
        (await asOwner<AutomationRunsPage>(page, 'GET', `/api/automations/${automationId}/runs`)).runs[0]
          ?.state,
    )
    .toBe('succeeded');
  const runs = await asOwner<AutomationRunsPage>(page, 'GET', `/api/automations/${automationId}/runs`);
  expect(runs.runs).toHaveLength(3);
  expect(runs.runs[1]!.steps[0]).toMatchObject({ stepId: 'create01', reused: true });
  await page.getByRole('link', { name: 'Log', exact: true }).click();
  await expect(page.getByRole('gridcell', { name: 'Received Dock', exact: true })).toHaveCount(2);
});

test('syncs draft edits between two people and enforces automation editing roles', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const database = await createDatabase(page, 'Shared desk', [
    { name: 'Requests', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Original' }] },
  ]);
  await openTable(page, database, 'Requests');
  await page.getByRole('button', { name: 'Add an automation' }).click();
  await page.getByRole('button', { name: 'Add a step', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Find records', exact: true }).click();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Draft: not live yet')).toBeHidden();
  const url = page.url();
  const automationId = new URL(url).pathname.split('/').at(-1)!;
  const person = await invite(page, browser, 'Casey reviewer', 'guest');
  try {
    const denied = await person.page.request.get(`${base()}/api/automations/${automationId}/runs`);
    expect(denied.status()).toBe(404);
    await share(page, database.id, person, 'creator');
    await visit(person.page, url);
    await expect(
      person.page.getByRole('button', { name: 'Test the whole automation', exact: true }),
    ).toBeVisible();
    await person.page.getByRole('spinbutton', { name: 'Maximum records', exact: true }).fill('7');
    await expect(page.getByRole('spinbutton', { name: 'Maximum records', exact: true })).toHaveValue('7');
    await expect(page.getByText('Draft: not live yet')).toBeVisible();
    await person.page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByText('Draft: not live yet')).toBeHidden();
    for (const role of ['editor', 'commenter', 'reader'] as const) {
      await share(page, database.id, person, role);
      await person.page.reload();
      await expect(person.page.getByRole('switch', { name: 'Off', exact: true })).toBeDisabled();
      await expect(
        person.page.getByRole('button', { name: 'Test the whole automation', exact: true }),
      ).toHaveCount(0);
      expect((await person.page.request.get(`${base()}/api/automations/${automationId}/runs`)).ok()).toBe(
        true,
      );
      const session = await asOwner<{ csrfToken: string }>(person.page, 'GET', '/api/auth/session');
      const refused = await person.page.request.post(`${base()}/api/automations/${automationId}/test`, {
        headers: { 'x-csrf-token': session.csrfToken },
        data: {},
      });
      expect(refused.status()).toBe(403);
    }
  } finally {
    await person.context.close();
  }
});
