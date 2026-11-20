import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { base } from '../base';
import { asOwner, createDatabase, signIn, visit } from '../helpers';

/**
 * A visual check of the receipt's new "Open view" and "Open dashboard" links, across both widths and
 * both color schemes of the nature theme.  The screenshots land under the evidence folder for review.
 */

const EVIDENCE = join(import.meta.dirname, '..', 'test-results', 'rio-aggregates-and-plans');

let receiver: Server;
let address: string;
let proposed: Record<string, unknown>;

test.beforeAll(async () => {
  receiver = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      if (request.method === 'GET') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ models: [{ name: 'fixture' }], data: [{ id: 'fixture' }] }));
        return;
      }
      response.setHeader('content-type', 'text/event-stream');
      // Propose on the first round of a conversation, and reply with text once the plan has run.
      const followUp = body.includes('"role":"tool"');
      const delta = followUp
        ? { content: 'Built the view and dashboard' }
        : {
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: 'function',
                function: { name: 'propose_changes', arguments: JSON.stringify(proposed) },
              },
            ],
          };
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: followUp ? 'stop' : 'tool_calls' }] })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, resolve));
  address = `http://${new URL(base()).hostname}:${(receiver.address() as AddressInfo).port}`;
  mkdirSync(EVIDENCE, { recursive: true });
});

test.afterAll(async () => {
  receiver?.closeAllConnections();
  if (receiver) await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

test('shows receipt links to the view and dashboard across widths and schemes', async ({ browser }) => {
  test.setTimeout(240_000);
  // Seed the database and point Rio at the local model, once.
  const setup = await browser.newContext();
  const setupPage = await setup.newPage();
  await signIn(setupPage);
  const database = await createDatabase(setupPage, 'Sales', [
    {
      name: 'Sales',
      fields: [
        { name: 'Title', type: 'text' },
        { name: 'Format', type: 'singleSelect', choices: ['Blu-ray', 'DVD', 'Digital'] },
        { name: 'Revenue', type: 'number' },
      ],
      records: [
        { Title: 'First', Format: 'Blu-ray', Revenue: 100 },
        { Title: 'Second', Format: 'DVD', Revenue: 60 },
      ],
    },
  ]);
  const table = database.tables.Sales!;
  const settings = await asOwner<{ providers: Array<{ providerId: string; local: boolean }> }>(
    setupPage,
    'GET',
    '/api/ai/settings',
  );
  const providerId = settings.providers.find((provider) => provider.local)!.providerId;
  await asOwner(setupPage, 'PUT', '/api/ai/settings', {
    enabled: true,
    providers: [{ providerId, baseUrl: `${address}/v1` }],
    models: { everyday: { providerId, model: 'fixture' }, power: null },
    autonomy: 'instant',
    monthlyBudgetUsd: null,
  });
  // A stricter personal choice persists across specs and would leave this fixture awaiting approval.
  await asOwner(setupPage, 'PATCH', '/api/me/preferences', { rioAutonomy: 'instant' });
  expect(await asOwner(setupPage, 'GET', '/api/rio/status')).toMatchObject({ autonomy: 'instant' });
  const knowledge = await asOwner<{ libraries: Record<string, unknown> }>(
    setupPage,
    'GET',
    '/api/knowledge/settings',
  );
  // This fixture proposes directly, without library text that would require review.
  await asOwner(setupPage, 'POST', '/api/knowledge/commands', {
    id: randomUUID(),
    kind: 'knowledge.settings',
    settings: {
      ...knowledge,
      libraries: {
        ...knowledge.libraries,
        rules: { public: 'blocked', internal: 'blocked', confidential: 'blocked', restricted: 'blocked' },
      },
    },
  });

  // IDs are left out so the server fills fresh ones; names are unique so each apply creates its own.
  const planFor = (suffix: string): Record<string, unknown> => ({
    databaseId: database.id,
    summary: 'Build the view and dashboard',
    steps: ['Add a chart view and a dashboard'],
    commands: [
      {
        kind: 'view.create',
        view: {
          tableId: table.id,
          name: `Revenue by format ${suffix}`,
          type: 'chart',
          config: {
            chart: {
              chart: 'column',
              groupBy: { fieldId: table.fields.Format, dateBucket: null },
              value: { fn: 'sum', fieldId: table.fields.Revenue },
              sort: 'valueDescending',
            },
          },
        },
      },
      {
        kind: 'dashboard.create',
        dashboard: {
          name: `Sales overview ${suffix}`,
          config: {
            tiles: [
              {
                kind: 'number',
                title: 'Total revenue',
                source: { tableId: table.id, viewId: null, filter: null },
                value: { fn: 'sum', fieldId: table.fields.Revenue },
                place: { x: 0, y: 0, w: 4, h: 2 },
              },
            ],
          },
        },
      },
    ],
  });

  try {
    for (const width of [1440, 390]) {
      for (const scheme of ['grove', 'night-grove']) {
        proposed = planFor(`${width} ${scheme}`);
        // A fresh context each time, so the panel starts closed and the state is clean.
        const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 900 : 844 } });
        try {
          const page = await context.newPage();
          await signIn(page);
          await asOwner(page, 'PATCH', '/api/me/preferences', { theme: 'nature', scheme });
          await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}`);
          await expect(page.locator('html')).toHaveAttribute('data-theme', 'nature');
          const trigger = page.locator('.rio-assistant__trigger button').first();
          if (await trigger.count()) await trigger.click();
          else await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
          const panel = page.locator('.rio-assistant__panel');
          await panel.getByRole('button', { name: 'New conversation', exact: true }).first().click();
          const composer = panel.getByRole('textbox', { name: 'Ask Rio anything about your data' });
          await composer.fill('Build a chart view and a dashboard');
          await composer.press('Enter');
          const receipt = panel
            .locator('.rio-assistant__block')
            .filter({ hasText: 'Build the view and dashboard' });
          await expect(receipt.getByRole('link', { name: 'Open view', exact: true })).toBeVisible();
          await expect(receipt.getByRole('link', { name: 'Open dashboard', exact: true })).toBeVisible();
          await page.screenshot({ path: join(EVIDENCE, `receipt-${width}-${scheme}.png`) });
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    try {
      await asOwner(setupPage, 'POST', '/api/knowledge/commands', {
        id: randomUUID(),
        kind: 'knowledge.settings',
        settings: knowledge,
      });
    } finally {
      await setup.close();
    }
  }
});
