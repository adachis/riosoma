import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page, type Request } from '../accessibility';
import { asOwner, createDatabase, openTable, signIn, type SeededDatabase } from '../helpers';

/**
 * Every "Show me" demo plays once, start to finish, over a real table.  Each one has to point at
 * its controls, run to its end, and leave the database, the server, and the page as they were: no
 * request that changes anything leaves the browser while it plays.
 */

const MODULES = resolve(import.meta.dirname, '../../../docs/modules');

function demoModules(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return demoModules(path);
    return name === 'demo.json' ? [(JSON.parse(readFileSync(path, 'utf8')) as { id: string }).id] : [];
  });
}
const DEMOS = demoModules(MODULES).sort();

/** Reads that travel as POST, which a demo may still make */
const READS = [
  /\/search$/,
  /\/data$/,
  /\/aggregate$/,
  /\/records$/,
  /\/records\/names$/,
  /\/conversion-preview$/,
];

function writes(requests: Request[]): string[] {
  return requests
    .filter((request) => new URL(request.url()).pathname.startsWith('/api/'))
    .filter((request) => request.method() !== 'GET' && request.method() !== 'HEAD')
    .filter((request) => {
      const path = new URL(request.url()).pathname;
      return !(request.method() === 'POST' && READS.some((pattern) => pattern.test(path)));
    })
    .map((request) => `${request.method()} ${new URL(request.url()).pathname}`);
}

async function schemaOf(page: Page, database: SeededDatabase): Promise<unknown> {
  const schema = await asOwner<{ tables: unknown; database: unknown }>(
    page,
    'GET',
    `/api/databases/${database.id}/schema`,
  );
  return { tables: schema.tables, database: schema.database };
}

async function rowsOf(page: Page, database: SeededDatabase): Promise<unknown> {
  const page0 = await asOwner<{ total: number; rows: unknown[] }>(
    page,
    'GET',
    `/api/views/${database.tables.Tasks!.viewId}/rows?offset=0&limit=50&tz=UTC`,
  );
  return { total: page0.total, rows: page0.rows };
}

/** Nothing in this suite may reach the system voice, whatever the browser and its switches. */
function silence(): void {
  const synth = window.speechSynthesis;
  if (!synth) return;
  synth.speak = () => undefined;
  synth.cancel();
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ context }) => {
  await context.addInitScript(silence);
});

let database: SeededDatabase;
const timings: Record<string, number> = {};

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.addInitScript(silence);
  await signIn(page);
  database = await createDatabase(page, 'Harbor Office', [
    {
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'singleSelect', choices: ['To do', 'Doing', 'Done'] },
        { name: 'Hours', type: 'number' },
      ],
      records: [
        { Name: 'Paint the dock', Status: 'To do', Hours: 3 },
        { Name: 'Order rope', Status: 'Doing', Hours: 1 },
      ],
    },
    { name: 'Projects', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Summer season' }] },
  ]);
  await page.close();
});

test.afterAll(() => {
  // Printed so a run shows how long each demo takes.
  for (const [id, ms] of Object.entries(timings)) console.log(`show-me ${id}: ${(ms / 1000).toFixed(1)} s`);
});

test('ten or more help modules have a demo', () => {
  expect(DEMOS.length).toBeGreaterThanOrEqual(10);
});

for (const id of DEMOS) {
  test(`the ${id} demo plays to its end and changes nothing`, async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    await openTable(page, database, 'Tasks');
    const before = await schemaOf(page, database);
    const records = await rowsOf(page, database);

    await page.goto(`${page.url()}?help=${id}`);
    const help = page.getByRole('complementary', { name: 'Help', exact: true });
    const showMe = help.getByRole('button', { name: 'Show me' });
    await expect(showMe).toBeVisible();

    const requests: Request[] = [];
    const record = (request: Request) => requests.push(request);
    page.on('request', record);
    const started = Date.now();
    await showMe.click();
    const demo = page.getByRole('region', { name: 'Demo' });
    await expect(demo).toBeVisible();
    // The demo points at real controls with its outline, and takes the keyboard to its own buttons.
    await expect(page.locator('.rio-demo-highlight')).toBeVisible();
    await expect(demo.getByRole('button', { name: 'Pause' })).toBeFocused();
    await expect(page.locator('[role="status"]', { hasText: 'The demo is over' })).toHaveCount(1, {
      timeout: 150_000,
    });
    timings[id] = Date.now() - started;
    page.off('request', record);
    await expect(demo).toBeHidden();
    await expect(page.getByRole('alert')).toHaveCount(0);

    // Nothing left the browser that could change anything, and the database is as it was.
    expect(writes(requests)).toEqual([]);
    expect(await schemaOf(page, database)).toEqual(before);
    expect(await rowsOf(page, database)).toEqual(records);
    // Whatever the demo opened is closed again, and focus is back on the button that started it.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(showMe).toBeFocused();
    expect(new URL(page.url()).searchParams.get('help')).toBe(id);
  });
}
