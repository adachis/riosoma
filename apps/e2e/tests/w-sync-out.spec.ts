import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Route } from '@playwright/test';
import { expect, test, type Page } from '../accessibility';
import { createDatabase, openTable, signIn, type SeededDatabase } from '../helpers';

/**
 * Sync out, driven entirely against mocked routes (`page.route`), so no demo or stand-in host is
 * touched.  It walks the whole flow at 1440 by 900 and 390 by 844, and saves screenshots of the
 * toolbar control, the empty panel, each setup step, a finished, running, and failed sync, and the
 * history, in the nature theme's grove and night-grove color schemes.
 */

test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block' });

const OUT = join(homedir(), 'riosoma-work', 'evidence', 'sync-out-web');
const WIDTHS = [
  { tag: 'desktop', width: 1440, height: 900 },
  { tag: 'phone', width: 390, height: 844 },
];
const SCHEMES = ['grove', 'night-grove'];

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

const STATS = { created: 12, updated: 3, removed: 0, unchanged: 240, failed: 0, ms: 1800 };

function syncFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'osyAAAAAAAAAAAAAA',
    databaseId: 'dbAAAAAAAAAAAAAA',
    tableId: 'tblAAAAAAAAAAAAAA',
    viewId: 'viwAAAAAAAAAAAAAA',
    name: 'Launches to Airtable',
    destination: {
      kind: 'airtable',
      baseId: 'appAAAAAAAAAAAAAA',
      baseName: 'Product',
      table: {
        id: 'tblZZZZZZZZZZZZZZ',
        name: 'Launches',
        created: true,
        url: 'https://airtable.com/app/tbl',
      },
    },
    settings: {
      everyMinutes: 60,
      removeMissing: true,
      createColumns: true,
      timeZone: 'America/Denver',
      locale: 'en-US',
    },
    enabled: true,
    stoppedBecause: null,
    status: {
      state: 'idle',
      lastRunAt: ago(120_000),
      lastSuccessAt: ago(120_000),
      nextRunAt: ahead(58 * 60_000),
      error: null,
      stats: STATS,
      progress: null,
      withheld: [],
    },
    columns: [],
    hiddenColumns: 0,
    creator: { id: 'usrADAADAADAADAAD', name: 'Dana Ortiz' },
    createdAt: ago(86_400_000),
    updatedAt: ago(120_000),
    canEdit: true,
    canDelete: true,
    canRun: true,
    ...overrides,
  };
}

const EMPTY = { syncs: [], canCreate: true, unavailable: null, kinds: ['airtable'] };
const FINISHED = { ...EMPTY, syncs: [syncFixture()] };
const RUNNING = {
  ...EMPTY,
  syncs: [
    syncFixture({
      status: { ...syncFixture().status, state: 'running', progress: { done: 120, total: 240 }, stats: null },
    }),
  ],
};
const FAILED = {
  ...EMPTY,
  syncs: [
    syncFixture({
      status: {
        ...syncFixture().status,
        state: 'failed',
        stats: null,
        error: { messageKey: 'syncOut.destination.unreachable' },
      },
    }),
  ],
};

const PREVIEW = {
  columns: [
    {
      fieldId: 'fldAAAAAAAAAAAAAA',
      fieldName: 'Name',
      fieldType: 'text',
      action: 'create',
      columnName: 'Name',
      columnType: 'singleLineText',
      write: 'typed',
      reason: null,
    },
    {
      fieldId: 'fldBBBBBBBBBBBBBB',
      fieldName: 'Stage',
      fieldType: 'singleSelect',
      action: 'create',
      columnName: 'Stage',
      columnType: 'singleSelect',
      write: 'typed',
      reason: null,
    },
    {
      fieldId: 'fldCCCCCCCCCCCCCC',
      fieldName: 'Owner',
      fieldType: 'user',
      action: 'skip',
      columnName: null,
      columnType: null,
      write: null,
      reason: 'syncOut.skip.readOnly',
    },
  ],
  key: { name: 'Riosoma record ID', action: 'create' },
  withheld: [],
  untouched: [],
  rows: 240,
  problems: [],
};

const RUNS = [
  {
    id: 'jobAAAAAAAAAAAAAA',
    syncId: 'osyAAAAAAAAAAAAAA',
    trigger: 'schedule',
    actor: null,
    startedAt: ago(120_000),
    endedAt: ago(118_000),
    outcome: 'succeeded',
    stats: STATS,
    error: null,
    notes: [],
  },
  {
    id: 'jobBBBBBBBBBBBBBB',
    syncId: 'osyAAAAAAAAAAAAAA',
    trigger: 'manual',
    actor: { id: 'usrADAADAADAADAAD', name: 'Dana Ortiz' },
    startedAt: ago(7_200_000),
    endedAt: ago(7_190_000),
    outcome: 'partial',
    stats: { ...STATS, failed: 2 },
    error: { messageKey: 'syncOut.destination.rateLimited' },
    notes: [{ messageKey: 'syncOut.note.truncated', params: { count: 1 } }],
  },
];

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** A mutable list payload the list route serves, swapped between scenarios. */
let listState: Record<string, unknown> = EMPTY;

async function installRoutes(page: Page) {
  await page.route('**/api/views/*/sync-out', (route) => fulfill(route, listState));
  await page.route('**/api/views/*/sync-out/places', (route) =>
    fulfill(route, {
      level: 'base',
      places: [
        { id: 'appAAAAAAAAAAAAAA', name: 'Product', group: 'My workspace', canWrite: true, canCreate: true },
      ],
    }),
  );
  await page.route('**/api/views/*/sync-out/preview', (route) => fulfill(route, PREVIEW));
  await page.route('**/api/sync-out/*/runs', (route) => fulfill(route, { runs: RUNS }));
  await page.route('**/api/databases/*/sync-out/commands', (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      id: string;
      action: { kind: string; input?: { name: string } };
    };
    const action = body.action;
    if (action.kind === 'create') {
      const sync = syncFixture({
        name: action.input?.name ?? 'Launches to Airtable',
        status: {
          ...syncFixture().status,
          state: 'queued',
          lastRunAt: null,
          lastSuccessAt: null,
          nextRunAt: null,
          stats: null,
        },
      });
      listState = { ...EMPTY, syncs: [sync] };
      return fulfill(route, { id: body.id, status: 'applied', sync });
    }
    const current = (listState.syncs as Array<Record<string, unknown>>)[0];
    return fulfill(route, { id: body.id, status: 'applied', sync: current ?? null });
  });
}

async function useScheme(page: Page, scheme: string) {
  await page.evaluate(
    async ({ scheme }) => {
      const session = await (await fetch('/api/auth/session')).json();
      await fetch('/api/me/preferences', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
        body: JSON.stringify({ theme: 'nature', scheme }),
      });
    },
    { scheme },
  );
}

async function readyForCapture(page: Page) {
  await expect(page.locator('.rio-feature-loading')).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

async function shot(page: Page, name: string) {
  await readyForCapture(page);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

/** Opens the Sync out panel, whether its control is a toolbar button or has gone to the More menu. */
async function openSyncOut(page: Page) {
  const toolbar = page.getByRole('toolbar', { name: 'View controls' });
  const direct = toolbar.getByRole('button', { name: 'Sync out' });
  if (await direct.isVisible().catch(() => false)) {
    await direct.click();
  } else {
    await toolbar.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Sync out' }).click();
  }
  await expect(page.getByRole('dialog')).toBeVisible();
}

test('drives Sync out against mocked routes and captures every state', async ({ page }) => {
  // One serial walk of every state in two schemes at two widths, with an accessibility scan on
  // each, needs more than the default per-test budget.
  test.setTimeout(360_000);
  mkdirSync(OUT, { recursive: true });
  await signIn(page);
  await installRoutes(page);
  const database: SeededDatabase = await createDatabase(page, 'Launch Bay', [
    {
      name: 'Launches',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Stage', type: 'singleSelect', choices: ['Planned', 'Shipped'] },
        { name: 'Owner', type: 'text' },
      ],
      records: [
        { Name: 'Orbit', Stage: 'Planned', Owner: 'Dana' },
        { Name: 'Relay', Stage: 'Shipped', Owner: 'Lee' },
      ],
    },
  ]);

  for (const scheme of SCHEMES) {
    await useScheme(page, scheme);
    for (const { tag, width, height } of WIDTHS) {
      await page.setViewportSize({ width, height });
      const label = `${scheme}-${tag}`;

      // The toolbar control.
      listState = EMPTY;
      await openTable(page, database, 'Launches');
      await expect(page.locator('html')).toHaveAttribute('data-scheme', scheme);
      await shot(page, `toolbar-${label}`);

      // The empty panel.
      await openSyncOut(page);
      await expect(page.getByText('This view isn’t synced anywhere yet.')).toBeVisible();
      await shot(page, `empty-${label}`);

      // Setup, step by step.
      await page.getByRole('button', { name: 'Set up a sync' }).click();
      await expect(page.getByText('Step 1 of 4')).toBeVisible();
      await shot(page, `setup-1-destination-${label}`);
      await page.getByRole('button', { name: 'Continue' }).click();

      await expect(page.getByText('Step 2 of 4')).toBeVisible();
      await page.getByLabel('Airtable personal access token').fill('patTESTTESTTESTTEST');
      await page.getByRole('button', { name: 'Find bases' }).click();
      await page.getByRole('option', { name: /Product/ }).click();
      await expect(page.getByRole('textbox', { name: 'Table name' })).toBeVisible();
      await shot(page, `setup-2-connect-${label}`);
      await page.getByRole('button', { name: 'Continue' }).click();

      await expect(page.getByText('Riosoma will create these columns, in the view’s order.')).toBeVisible();
      await shot(page, `setup-3-columns-${label}`);
      await page.getByRole('button', { name: 'Continue' }).click();

      await expect(page.getByText('Step 4 of 4')).toBeVisible();
      await shot(page, `setup-4-schedule-${label}`);
      await page.getByRole('button', { name: 'Start syncing' }).click();
      await expect(page.getByText('Waiting to start…')).toBeVisible();

      // A finished sync.
      listState = FINISHED;
      await openTable(page, database, 'Launches');
      await openSyncOut(page);
      await expect(page.getByText(/12 added, 3 updated/)).toBeVisible();
      await shot(page, `finished-${label}`);

      // Its history.
      await page.getByRole('button', { name: 'More for Launches to Airtable' }).click();
      await page.getByRole('menuitem', { name: 'History' }).click();
      await expect(page.getByText('The last 50 syncs are kept.')).toBeVisible();
      await shot(page, `history-${label}`);

      // A running sync.
      listState = RUNNING;
      await openTable(page, database, 'Launches');
      await openSyncOut(page);
      await expect(page.getByText('Syncing… 120 of 240 rows')).toBeVisible();
      await shot(page, `running-${label}`);

      // A failed sync.
      listState = FAILED;
      await openTable(page, database, 'Launches');
      await openSyncOut(page);
      await expect(page.getByText('The last sync didn’t finish.')).toBeVisible();
      await shot(page, `failed-${label}`);
    }
  }
});
