import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { base } from '../base';
import { signIn, visit } from '../helpers';
import { connection, sql } from '../sql';
import {
  buildDemo,
  call,
  DASHBOARD_NAME,
  DATABASE_NAME,
  ensureDatabase,
  JOINED_NAME,
  schemaOf,
  SOURCE_NAME,
  TABLES,
  tableFor,
  VIEW_NAMES,
  warehouseFromEnvironment,
  type DemoSchema,
  type DemoSession,
  type DemoSource,
} from './seed';
import { STAND_IN_ROWS, STAND_IN_SCHEMA, standInSql } from './stand-in';

/**
 * Builds the home entertainment demo on a fresh local stack, times every step, runs the seed a
 * second time to show it adds nothing, and photographs each screen of the result.
 *
 * It reads the warehouse from `RIOSOMA_DEMO_SNOWFLAKE_ACCOUNT`, `_USER`, `_WAREHOUSE`, `_ROLE`, and
 * `_PRIVATE_KEY_B64` (the PEM private key in base64).  Without them it syncs from a stand-in with
 * the same tables and rows in the local stack's own PostgreSQL, so it needs no warehouse account.
 * To fill an instance that's already running instead of a local stack, set `RIOSOMA_DEMO_BASE_URL`
 * to its address and `RIOSOMA_DEMO_EMAIL` and `RIOSOMA_DEMO_PASSWORD` to its owner's sign-in, along
 * with the warehouse.  Timings, proposed links, and screenshots go to `RIOSOMA_DEMO_EVIDENCE_DIR`,
 * or to the test's own output folder without it.
 */
test.describe.configure({ mode: 'serial' });

const warehouse = warehouseFromEnvironment();
let standIn: Promise<DemoSource> | undefined;

/** The warehouse when the environment names one, and otherwise the stand-in, made once. */
function demoSource(): Promise<DemoSource> {
  if (warehouse) return Promise.resolve(warehouse);
  standIn ??= (async () => {
    await sql(standInSql());
    const address = connection();
    return {
      connection: {
        kind: 'postgres',
        host: address.host,
        port: address.port,
        database: address.database,
        user: address.user,
        tls: { mode: 'disable' },
      },
      // The throwaway cluster trusts every local connection, but a source always stores a password.
      secrets: { password: randomBytes(24).toString('hex') },
      schema: STAND_IN_SCHEMA,
    };
  })();
  return standIn;
}

function evidenceDir(info: TestInfo): string {
  const chosen = process.env.RIOSOMA_DEMO_EVIDENCE_DIR;
  if (!chosen) return info.outputDir;
  return chosen.startsWith('~/') ? join(homedir(), chosen.slice(2)) : chosen;
}

async function keep(info: TestInfo, name: string, value: unknown): Promise<void> {
  const dir = evidenceDir(info);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), JSON.stringify(value, null, 2));
}

/** Signs in as the owner: the suite's own on a local stack, or the one the environment names. */
async function openSession(page: Page): Promise<DemoSession> {
  const email = process.env.RIOSOMA_DEMO_EMAIL;
  const password = process.env.RIOSOMA_DEMO_PASSWORD;
  if (process.env.RIOSOMA_DEMO_BASE_URL && email && password) {
    await visit(page, `${base()}/sign-in`);
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
  } else await signIn(page);
  return { baseURL: base(), request: page.request };
}

/** How many of each thing the demo makes exist, which a second run must leave unchanged. */
async function census(session: DemoSession): Promise<Record<string, number>> {
  const databases = await call<Array<{ id: string; name: string }>>(session, 'GET', '/api/databases');
  const sources = await call<Array<{ name: string }>>(session, 'GET', '/api/sources');
  const databaseId = databases.find((database) => database.name === DATABASE_NAME)!.id;
  const schema = await schemaOf(session, databaseId);
  return {
    databases: databases.filter((database) => database.name === DATABASE_NAME).length,
    sources: sources.filter((source) => source.name === SOURCE_NAME).length,
    tables: schema.tables.length,
    fields: schema.fields.length,
    views: schema.views.length,
    dashboards: schema.dashboards?.length ?? 0,
  };
}

test('builds the demo and times every step', async ({ page }, info) => {
  const session = await openSession(page);
  const report = await buildDemo(session, await demoSource(), (line) => console.log(line));
  await keep(info, 'timings.json', report.timings);
  await keep(info, 'links.json', { beforeNaming: report.linksBeforeNaming, afterNaming: report.links });
  await keep(info, 'tables.json', report.tables);
  await keep(info, 'renames.json', report.renames);
  await keep(info, 'report.json', {
    check: report.check,
    joinedRecords: report.joinedRecords,
    tiles: report.tiles,
    census: await census(session),
  });
  expect(report.renames.refused).toEqual([]);
  // Discovery finds every link a person would draw, under the warehouse's names and the friendly ones.
  expect(report.linksBeforeNaming?.missing).toEqual([]);
  expect(report.links.missing).toEqual([]);
  expect(Object.values(report.tiles).filter((kind) => kind.startsWith('error'))).toEqual([]);
  expect(Object.fromEntries(report.tables.map((table) => [table.object, table.records]))).toEqual(
    STAND_IN_ROWS,
  );
  // Every sale keeps its row, whether or not its product, title, account, and territory are found.
  expect(report.joinedRecords).toBe(STAND_IN_ROWS.WEEKLY_POS_SALES);
});

test('adds nothing when it runs again', async ({ page }, info) => {
  const session = await openSession(page);
  const before = await census(session);
  const again = await buildDemo(session, await demoSource());
  expect(again.tables.filter((table) => table.created)).toEqual([]);
  expect(again.renames).toEqual({ renamed: [], refused: [] });
  expect(await census(session)).toEqual(before);
  expect(before).toMatchObject({ databases: 1, sources: 1, tables: 8, views: 11, dashboards: 1 });
  await keep(info, 'second-run-timings.json', again.timings);
});

test('photographs each screen of the demo', async ({ page }, info) => {
  const session = await openSession(page);
  const databaseId = await ensureDatabase(session);
  const schema = await schemaOf(session, databaseId);
  const dir = evidenceDir(info);
  await mkdir(dir, { recursive: true });
  const shot = (name: string) => page.screenshot({ path: join(dir, `${name}.png`) });
  const settle = async () => {
    await expect(page.locator('.rio-feature-loading')).toHaveCount(0);
    await page.waitForLoadState('networkidle');
  };
  const firstView = (tableId: string) => schema.views.find((view) => view.tableId === tableId)!;
  const open = async (tableId: string, viewId: string) => {
    await visit(page, `${base()}/${databaseId}/${tableId}/${viewId}`);
    await settle();
  };

  // The warehouse's tables, as the sync dialog lists them.
  const titles = tableFor(schema, 'TITLE_MASTER')!;
  await open(titles.id, firstView(titles.id).id);
  await page.getByRole('button', { name: 'Add a table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sync from a data source', exact: true }).click();
  const sync = page.getByRole('dialog', { name: 'Sync from a data source' });
  await sync.getByRole('button', { name: /Choose a data source/ }).click();
  await page.getByRole('option', { name: SOURCE_NAME, exact: true }).click();
  await sync.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(sync.getByRole('option', { name: 'WEEKLY_POS_SALES', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await shot('01-source-tables');
  await sync.getByRole('option', { name: 'WEEKLY_POS_SALES', exact: true }).click();
  await sync.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(sync.getByRole('group', { name: 'Key columns' })).toBeVisible({ timeout: 60_000 });
  await shot('02-source-fields-weekly-sales');
  await sync.getByRole('group', { name: 'Key columns' }).scrollIntoViewIfNeeded();
  await shot('02-source-keys-weekly-sales');
  await page.keyboard.press('Escape');

  // Each synced table's grid.
  for (const [index, plan] of TABLES.entries()) {
    const table = tableFor(schema, plan.object)!;
    await open(table.id, firstView(table.id).id);
    await expect(page.getByRole('grid', { name: 'Grid' }).getByRole('gridcell').first()).toBeVisible();
    await settle();
    await shot(`${String(index + 3).padStart(2, '0')}-table-${plan.name.toLowerCase().replaceAll(' ', '-')}`);
  }

  // The links discovery proposes for the weekly sales.
  const sales = tableFor(schema, 'WEEKLY_POS_SALES')!;
  await open(sales.id, firstView(sales.id).id);
  await page.getByRole('button', { name: 'Find links', exact: true }).click();
  const links = page.getByRole('dialog', { name: 'Suggested links', exact: true });
  await expect(links.getByRole('meter').first()).toBeVisible({ timeout: 30_000 });
  await shot('10-discovered-links');
  await links.getByRole('button', { name: 'Close', exact: true }).click();

  // The joined table and its views.
  const joined = schema.tables.find((table) => table.joined && table.name === JOINED_NAME)!;
  const view = (name: string) => viewNamed(schema, joined.id, name);
  await open(joined.id, view(VIEW_NAMES.all));
  await expect(page.getByRole('grid', { name: VIEW_NAMES.all }).getByRole('gridcell').first()).toBeVisible();
  await settle();
  await shot('11-joined-sales-by-title');
  await open(joined.id, view(VIEW_NAMES.grid));
  await expect(page.getByRole('treegrid', { name: VIEW_NAMES.grid })).toBeVisible();
  await settle();
  await shot('12-view-by-format');
  await open(joined.id, view(VIEW_NAMES.chart));
  await expect(page.locator('.rio-chart-view').first()).toBeVisible();
  await settle();
  await shot('13-view-revenue-by-month');
  await open(joined.id, view(VIEW_NAMES.pivot));
  await expect(page.locator('.rio-pivot').getByRole('table')).toBeVisible();
  await settle();
  await shot('14-view-territory-by-format');

  // The dashboard.
  const dashboard = schema.dashboards!.find((entry) => entry.name === DASHBOARD_NAME)!;
  await visit(page, `${base()}/${databaseId}/dashboards/${dashboard.id}`);
  for (const title of ['Total revenue', 'Revenue by format', 'Units by territory', 'Top titles'])
    await expect(page.getByRole('article', { name: title, exact: true })).toBeVisible();
  await settle();
  await shot('15-dashboard');
});

test('photographs the chart and the dashboard in both color schemes, on a desktop and a phone', async ({
  page,
}, info) => {
  const session = await openSession(page);
  const databaseId = await ensureDatabase(session);
  const schema = await schemaOf(session, databaseId);
  const dir = evidenceDir(info);
  await mkdir(dir, { recursive: true });
  const joined = schema.tables.find((table) => table.joined && table.name === JOINED_NAME)!;
  const dashboard = schema.dashboards!.find((entry) => entry.name === DASHBOARD_NAME)!;
  // The owner's own theme comes back afterward, whichever it was.
  const { preferences } = await call<{ preferences: { theme?: string; scheme?: string } }>(
    session,
    'GET',
    '/api/auth/session',
  );
  const before = { theme: preferences.theme ?? 'nature', scheme: preferences.scheme ?? 'grove' };
  try {
    for (const scheme of ['grove', 'night-grove'])
      for (const [width, height] of [
        [1440, 900],
        [390, 844],
      ] as const) {
        await page.setViewportSize({ width, height });
        await call(session, 'PATCH', '/api/me/preferences', { theme: 'nature', scheme });
        await visit(
          page,
          `${base()}/${databaseId}/${joined.id}/${viewNamed(schema, joined.id, VIEW_NAMES.chart)}`,
        );
        await expect(page.locator('html')).toHaveAttribute('data-scheme', scheme);
        await expect(page.locator('.rio-chart-view canvas, .rio-chart-view svg').first()).toBeVisible();
        await page.waitForLoadState('networkidle');
        await page.screenshot({ path: join(dir, `20-chart-${scheme}-${width}.png`) });
        // Nothing runs off the side of the page at either width.
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
          true,
        );
        await visit(page, `${base()}/${databaseId}/dashboards/${dashboard.id}`);
        await expect(page.getByRole('article', { name: 'Units by territory', exact: true })).toBeVisible();
        await page.waitForLoadState('networkidle');
        await page.screenshot({ path: join(dir, `21-dashboard-${scheme}-${width}.png`) });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
          true,
        );
      }
  } finally {
    await call(session, 'PATCH', '/api/me/preferences', before);
  }
});

function viewNamed(schema: DemoSchema, tableId: string, name: string): string {
  return schema.views.find((view) => view.tableId === tableId && view.name === name)!.id;
}
