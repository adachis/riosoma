import { expect, test, type Page } from '@playwright/test';
import { base } from '../base';
import { call, schemaOf, type DemoSchema } from '../demo/seed';
import { signIn, visit } from '../helpers';
import { content, sourceCatalog, themeEntries } from './content';
import {
  AREA_VIEW,
  buildWebsite,
  DATABASE_NAME,
  ensureDatabase,
  readTable,
  runCommands,
  TABLES,
  tablePlans,
  type WebsiteSession,
} from './seed';

/**
 * Builds the website's database on a fresh local stack, counts what it holds against the content,
 * the repository's themes, and the product's own list of data sources, and then runs the seed again
 * to show that a second run adds nothing and changes nothing.
 *
 * To fill an instance that's already running instead of a local stack, set
 * `RIOSOMA_WEBSITE_BASE_URL` to its address and `RIOSOMA_WEBSITE_EMAIL` and
 * `RIOSOMA_WEBSITE_PASSWORD` to its owner's sign-in.  The password is only ever typed into the
 * sign-in form: nothing prints it and nothing writes it to a file.
 */
test.describe.configure({ mode: 'serial' });

/** Signs in as the owner: the suite's own on a local stack, or the one the environment names. */
async function openSession(page: Page): Promise<WebsiteSession> {
  const email = process.env.RIOSOMA_WEBSITE_EMAIL;
  const password = process.env.RIOSOMA_WEBSITE_PASSWORD;
  if (process.env.RIOSOMA_WEBSITE_BASE_URL && email && password) {
    await visit(page, `${base()}/sign-in`);
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
  } else await signIn(page);
  return { baseURL: base(), request: page.request };
}

/** How many records each table holds, counted from what the seed reads rather than from the seed. */
function expectedCounts(): Record<string, number> {
  return {
    [TABLES.features]: content.features.length,
    [TABLES.questions]: content.questions.length,
    [TABLES.themes]: themeEntries().length,
    [TABLES.sources]: sourceCatalog().kinds.length,
  };
}

interface TableCensus {
  fields: string[];
  views: string[];
  /** Each record's ID and the moment it last changed, so a rewrite shows up as a difference */
  records: string[];
}

/** What the database holds: every table, with its fields, its views, and its records. */
async function census(session: WebsiteSession): Promise<Record<string, TableCensus>> {
  const databases = await call<Array<{ id: string; name: string }>>(session, 'GET', '/api/databases');
  const named = databases.filter((database) => database.name === DATABASE_NAME);
  expect(named.length, 'no more than one database called Riosoma').toBeLessThanOrEqual(1);
  const found: Record<string, TableCensus> = {};
  const databaseId = named[0]?.id;
  if (!databaseId) return found;
  const schema = await schemaOf(session, databaseId);
  for (const table of schema.tables) {
    const rows = await readTable(session, schema, table.id);
    found[table.name] = {
      fields: schema.fields
        .filter((field) => field.tableId === table.id)
        .map((field) => `${field.name}: ${field.type}`)
        .sort(),
      views: schema.views
        .filter((entry) => entry.tableId === table.id)
        .map((entry) => `${entry.name}: ${entry.type}`)
        .sort(),
      records: rows.map((row) => `${row.id} at ${row.updatedAt}`).sort(),
    };
  }
  return found;
}

function countsOf(found: Record<string, TableCensus>): Record<string, number> {
  return Object.fromEntries(Object.entries(found).map(([name, table]) => [name, table.records.length]));
}

/** The field a list view files its records under, which the shared schema type doesn't spell out. */
function groupFieldOf(view: DemoSchema['views'][number]): string | null {
  return (view.config as { list?: { groupFieldId?: string | null } }).list?.groupFieldId ?? null;
}

test('builds the website database and fills every table', async ({ page }) => {
  const session = await openSession(page);
  const report = await buildWebsite(session, (line) => console.log(line));
  expect(report.tables.map((table) => table.name)).toEqual(Object.values(TABLES));
  for (const table of report.tables) {
    expect(table.created, `${table.name} was already there`).toBe(true);
    expect(table.fieldsAdded, 'a new table comes with its fields').toEqual([]);
    expect(table.choicesAdded, 'a new select comes with its choices').toEqual([]);
    expect(table.sortsSet, 'a new grid has no order of its own yet').toEqual(['Grid']);
  }
  // The features also get a list that files them under their area, and only they do.
  expect(Object.fromEntries(report.tables.map((table) => [table.name, table.viewsAdded]))).toEqual({
    [TABLES.features]: [AREA_VIEW],
    [TABLES.questions]: [],
    [TABLES.themes]: [],
    [TABLES.sources]: [],
  });
  const found = await census(session);
  expect(countsOf(found)).toEqual(expectedCounts());
  expect(Object.fromEntries(report.tables.map((table) => [table.name, table.added]))).toEqual(
    expectedCounts(),
  );
  expect(found[TABLES.features]!.views).toEqual(['By area: list', 'Grid: grid']);
  expect(found[TABLES.features]!.fields).toEqual([
    'Area: singleSelect',
    'Name: text',
    'Order: number',
    'Summary: longText',
  ]);

  // Each grid orders its records the way a reader wants them, and the features' list files them
  // under their area.
  const schema = await schemaOf(session, report.databaseId);
  const tableId = (name: string) => schema.tables.find((table) => table.name === name)!.id;
  const fieldId = (table: string, name: string) =>
    schema.fields.find((field) => field.tableId === tableId(table) && field.name === name)!.id;
  const grid = (table: string) =>
    schema.views.find((view) => view.tableId === tableId(table) && view.type === 'grid')!;
  expect(grid(TABLES.features).config.sorts.map((sort) => sort.fieldId)).toEqual([
    fieldId(TABLES.features, 'Order'),
  ]);
  expect(grid(TABLES.questions).config.sorts.map((sort) => sort.fieldId)).toEqual([
    fieldId(TABLES.questions, 'Order'),
  ]);
  expect(grid(TABLES.themes).config.sorts.map((sort) => sort.fieldId)).toEqual([
    fieldId(TABLES.themes, 'Name'),
  ]);
  expect(grid(TABLES.sources).config.sorts.map((sort) => sort.fieldId)).toEqual([
    fieldId(TABLES.sources, 'Name'),
  ]);
  const byArea = schema.views.find(
    (view) => view.tableId === tableId(TABLES.features) && view.name === AREA_VIEW,
  )!;
  expect(byArea.type).toBe('list');
  expect(groupFieldOf(byArea)).toBe(fieldId(TABLES.features, 'Area'));
});

test('adds nothing and changes nothing when it runs again', async ({ page }) => {
  const session = await openSession(page);
  const before = await census(session);
  expect(countsOf(before)).toEqual(expectedCounts());
  const again = await buildWebsite(session);
  for (const table of again.tables) {
    expect(table.created, `${table.name} was made again`).toBe(false);
    expect(table.added, `${table.name} grew`).toBe(0);
    expect(table.fieldsAdded).toEqual([]);
    expect(table.choicesAdded).toEqual([]);
    expect(table.viewsAdded).toEqual([]);
    expect(table.sortsSet, 'a grid keeps the order it already has').toEqual([]);
  }
  expect(await census(session)).toEqual(before);
});

test('leaves alone what a person edited', async ({ page }) => {
  // The check writes a record to see whether the seed puts it back, which is fine on a stack the
  // suite started and not something to do to an instance a person is running.
  test.skip(Boolean(process.env.RIOSOMA_WEBSITE_BASE_URL), 'a running instance keeps its own copy');
  const session = await openSession(page);
  const { id: databaseId } = await ensureDatabase(session, tablePlans());
  const schema = await schemaOf(session, databaseId);
  const table = schema.tables.find((entry) => entry.name === TABLES.features)!;
  const fields = Object.fromEntries(
    schema.fields.filter((field) => field.tableId === table.id).map((field) => [field.name, field.id]),
  );
  const feature = content.features[0]!;
  const rows = await readTable(session, schema, table.id);
  const row = rows.find((entry) => entry.values[fields.Name!] === feature.name)!;
  const written = row.values[fields.Summary!];
  const edit = 'Someone who runs the site wrote this instead.';
  const save = async (value: unknown) =>
    runCommands(session, databaseId, [
      {
        kind: 'record.update',
        tableId: table.id,
        records: [{ id: row.id, values: { [fields.Summary!]: value } }],
      },
    ]);
  try {
    await save(edit);
    await buildWebsite(session);
    const after = await readTable(session, schema, table.id);
    expect(after.find((entry) => entry.id === row.id)?.values[fields.Summary!]).toBe(edit);
  } finally {
    await save(written ?? null);
  }
  // The copy is back, and the record holds what the content says again.
  const restored = await readTable(session, schema, table.id);
  expect(restored.find((entry) => entry.id === row.id)?.values[fields.Summary!]).toBe(feature.summary);
});
