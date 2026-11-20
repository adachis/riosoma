import { CHOICE_COLORS, LIMITS } from '../../../packages/contracts/src/data/fields.js';
import type { RowsPage } from '../../../packages/contracts/src/data/rows.js';
import { call, schemaOf, type DemoSchema, type DemoSession, type SchemaField } from '../demo/seed';
import { newId } from '../helpers';
import { areas, content, sourceCatalog, themeEntries } from './content';

/**
 * Builds the website's own database through the app's API: one database, four tables, and a record
 * for everything the site says.  The copy comes from `content.json` beside this file, the themes
 * from the repository's `themes/` folder, and the data sources from the picker the product shows,
 * so the tables follow all three instead of a copy of any of them.
 *
 * Every step looks for what it would make before making it, and a record is matched by the field
 * that names it, so a second run adds nothing and leaves whatever a person edited alone.
 */

/** Where the app answers, and a request context that carries a signed-in owner's cookie. */
export type WebsiteSession = DemoSession;

export const DATABASE_NAME = 'Riosoma';

/** The database's four tables, by the name each is made with. */
export const TABLES = {
  features: 'Features',
  questions: 'Questions',
  themes: 'Themes',
  sources: 'Data sources',
} as const;

/** The name every table's own grid keeps, which is the one the app gives a new table. */
const GRID_VIEW = 'Grid';
/** The view on Features that files them under their area. */
export const AREA_VIEW = 'By area';
/** A count or a position reads better without digits after the point. */
const WHOLE = { precision: 0 };

/** A field this seed makes: the choices are a select's, in the order a reader meets them. */
export interface FieldPlan {
  name: string;
  type: 'text' | 'longText' | 'number' | 'singleSelect';
  /** Options besides its type's own defaults, such as a number's decimal places */
  options?: Record<string, unknown>;
  choices?: string[];
}

/** A view besides the table's own grid, whose settings are built from the table's field IDs. */
export interface ViewPlan {
  name: string;
  type: string;
  config(fields: Record<string, string>): Record<string, unknown>;
}

export interface TablePlan {
  name: string;
  description: string;
  /** The field its records are matched by, which is also the table's primary field */
  primary: string;
  /** Every field, the primary one first */
  fields: FieldPlan[];
  /** How the table's own grid orders its records */
  sorts: Array<{ field: string; direction: 'asc' | 'desc' }>;
  /** Its records, by field name, with a select's value given as the choice's name */
  rows: Array<Record<string, string | number>>;
  views?: ViewPlan[];
}

/** The four tables, what fills them, and the order a reader wants each of them in. */
export function tablePlans(): TablePlan[] {
  const sources = sourceCatalog();
  const themes = themeEntries();
  return [
    {
      name: TABLES.features,
      description: 'What the site says Riosoma does, in the order its pages show it.',
      primary: 'Name',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Summary', type: 'longText' },
        { name: 'Area', type: 'singleSelect', choices: areas() },
        { name: 'Order', type: 'number', options: WHOLE },
      ],
      sorts: [{ field: 'Order', direction: 'asc' }],
      rows: content.features.map((feature, index) => ({
        Name: feature.name,
        Summary: feature.summary,
        Area: feature.area,
        Order: index + 1,
      })),
      // A list files the features under their area, with each area's own order kept.
      views: [
        {
          name: AREA_VIEW,
          type: 'list',
          config: (fields) => ({
            sorts: [{ fieldId: need(fields.Order, 'the field Order of Features'), direction: 'asc' }],
            list: { groupFieldId: need(fields.Area, 'the field Area of Features') },
          }),
        },
      ],
    },
    {
      name: TABLES.questions,
      description: 'The questions the site answers, in the order its page asks them.',
      primary: 'Question',
      fields: [
        { name: 'Question', type: 'text' },
        { name: 'Answer', type: 'longText' },
        { name: 'Order', type: 'number' },
      ],
      sorts: [{ field: 'Order', direction: 'asc' }],
      rows: content.questions.map((entry, index) => ({
        Question: entry.question,
        Answer: entry.answer,
        Order: index + 1,
      })),
    },
    {
      name: TABLES.themes,
      description: 'Every theme the repository ships, and the color schemes each one lists.',
      primary: 'Name',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Slug', type: 'text' },
        { name: 'Color schemes', type: 'number' },
      ],
      sorts: [{ field: 'Name', direction: 'asc' }],
      rows: themes.map((theme) => ({
        Name: theme.name,
        Slug: theme.slug,
        'Color schemes': theme.schemes,
      })),
    },
    {
      name: TABLES.sources,
      description: 'Every kind of data source the product connects to, in the groups the picker uses.',
      primary: 'Name',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Kind', type: 'singleSelect', choices: sources.groups },
      ],
      sorts: [{ field: 'Name', direction: 'asc' }],
      rows: sources.kinds.map((kind) => ({ Name: kind.name, Kind: kind.group })),
    },
  ];
}

/** What one run did with one table, which a second run has to leave all zeroes and empty lists. */
export interface TableReport {
  name: string;
  tableId: string;
  /** False when an earlier run made the table */
  created: boolean;
  fieldsAdded: string[];
  /** The choices added to a select field, as `field: choice` */
  choicesAdded: string[];
  viewsAdded: string[];
  /** The views whose order this run set, which it leaves alone once they have one */
  sortsSet: string[];
  /** How many records the table holds once this run is done */
  records: number;
  /** How many of them this run added */
  added: number;
}

export interface WebsiteReport {
  databaseId: string;
  tables: TableReport[];
  timings: Array<{ step: string; ms: number }>;
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`The website database is missing ${what}.`);
  return value;
}

/** A list in pieces no longer than the server takes in one command. */
function batched<T>(items: T[], size: number): T[][] {
  const found: T[][] = [];
  for (let start = 0; start < items.length; start += size) found.push(items.slice(start, start + size));
  return found;
}

/** Runs database commands as one action, the way the app sends a person's changes. */
export async function runCommands(
  session: WebsiteSession,
  databaseId: string,
  commands: object[],
): Promise<void> {
  if (!commands.length) return;
  const groupId = newId('act');
  const result = await call<{ results: Array<{ status: string; error?: unknown }> }>(
    session,
    'POST',
    `/api/databases/${databaseId}/commands`,
    {
      clientId: newId('cli'),
      commands: commands.map((command) => ({ id: newId('cmd'), groupId, ...command })),
    },
  );
  const refused = result.results.filter((item) => item.status === 'rejected');
  if (refused.length) throw new Error(`The server refused a command: ${JSON.stringify(refused)}`);
}

/** Every record a view shows, a page at a time. */
export async function readRows(
  session: WebsiteSession,
  viewId: string,
): Promise<Array<{ id: string; values: Record<string, unknown>; updatedAt: string }>> {
  const found: Array<{ id: string; values: Record<string, unknown>; updatedAt: string }> = [];
  let offset = 0;
  for (;;) {
    const page = await call<RowsPage>(
      session,
      'GET',
      `/api/views/${viewId}/rows?offset=${offset}&limit=${LIMITS.pageSize}`,
    );
    for (const row of page.rows)
      if (row) found.push({ id: row.id, values: row.values, updatedAt: row.updatedAt });
    offset += page.rows.length;
    if (!page.rows.length || offset >= page.total) return found;
  }
}

/** Whether a view hides records behind a filter of its own, which the shared type doesn't spell out. */
function hidesRecords(view: DemoSchema['views'][number]): boolean {
  return (view.config as { filter?: unknown }).filter != null;
}

/**
 * Every record a table holds, read through a view that hides nothing.  A record this can't see is
 * one the seed would write again, so a filter a person set on one view changes nothing here.
 */
export async function readTable(
  session: WebsiteSession,
  schema: DemoSchema,
  tableId: string,
): Promise<Array<{ id: string; values: Record<string, unknown>; updatedAt: string }>> {
  const views = schema.views.filter((view) => view.tableId === tableId);
  const showing = views.filter((view) => !hidesRecords(view));
  const grid = (list: typeof views) => list.find((view) => view.type === 'grid') ?? list[0];
  const reader = grid(showing) ?? grid(views);
  return reader ? readRows(session, reader.id) : [];
}

/** Choices with a color each, cycling the colors the product offers when there are more. */
function newChoices(names: string[]): Array<{ id: string; name: string; color: string }> {
  return names.map((name, index) => ({
    id: newId('cho'),
    name,
    color: CHOICE_COLORS[index % CHOICE_COLORS.length]!,
  }));
}

/** A new field's payload, with a fresh ID and, for a select, a fresh ID for each of its choices. */
function plannedField(field: FieldPlan): object {
  return {
    id: newId('fld'),
    name: field.name,
    type: field.type,
    options: { ...field.options, ...(field.choices ? { choices: newChoices(field.choices) } : {}) },
  };
}

/** A new table's payload, with fresh IDs for the table, its fields, its grid, and its choices. */
function plannedTable(plan: TablePlan): { id: string; table: object } {
  const id = newId('tbl');
  return {
    id,
    table: {
      id,
      name: plan.name,
      description: plan.description,
      fields: plan.fields.map(plannedField),
      view: { id: newId('viw'), name: GRID_VIEW },
      records: [],
    },
  };
}

/** The database, made with its first table when it isn't there yet. */
export async function ensureDatabase(
  session: WebsiteSession,
  plans: TablePlan[],
): Promise<{ id: string; created: boolean }> {
  const databases = await call<Array<{ id: string; name: string }>>(session, 'GET', '/api/databases');
  const existing = databases.find((database) => database.name === DATABASE_NAME);
  if (existing) return { id: existing.id, created: false };
  const [first] = plans;
  if (!first) throw new Error('The website seed has no tables to make.');
  const id = newId('db');
  await call(session, 'POST', '/api/databases', {
    id,
    name: DATABASE_NAME,
    icon: null,
    color: 'teal',
    table: plannedTable(first).table,
  });
  return { id, created: true };
}

function fieldNamed(schema: DemoSchema, tableId: string, name: string): SchemaField | undefined {
  return schema.fields.find((field) => field.tableId === tableId && field.name === name);
}

/** The table's fields by name, so a plan can point at one without knowing its ID. */
function fieldIds(schema: DemoSchema, tableId: string): Record<string, string> {
  return Object.fromEntries(
    schema.fields.filter((field) => field.tableId === tableId).map((field) => [field.name, field.id]),
  );
}

/** The choices a select field offers now, which a person may have renamed or added to. */
function choicesOf(field: SchemaField): Array<{ id: string; name: string }> {
  const choices = (field.options as { choices?: Array<{ id: string; name: string }> }).choices;
  return choices ?? [];
}

/** Each of a table's select fields' choices by name, as the table holds them now. */
function choiceIds(schema: DemoSchema, tableId: string, plan: TablePlan): Map<string, Map<string, string>> {
  const found = new Map<string, Map<string, string>>();
  for (const field of plan.fields) {
    if (!field.choices) continue;
    const existing = fieldNamed(schema, tableId, field.name);
    if (existing)
      found.set(field.name, new Map(choicesOf(existing).map((choice) => [choice.name, choice.id])));
  }
  return found;
}

/** A record's values by field ID, with a select's value turned into the choice's own ID. */
function recordValues(
  plan: TablePlan,
  row: Record<string, string | number>,
  fields: Record<string, string>,
  choices: Map<string, Map<string, string>>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(row)) {
    const fieldId = need(fields[name], `a field called ${name} in ${plan.name}`);
    const offered = choices.get(name);
    values[fieldId] = offered
      ? need(offered.get(String(value)), `a choice called ${String(value)} in ${plan.name}.${name}`)
      : value;
  }
  return values;
}

/**
 * One table: itself, its fields, its views, and its records.  A record whose naming field is
 * already there is left exactly as it stands, so what a person wrote or corrected survives a run.
 * The table that came with a database this run made counts as made here too.
 */
async function ensureTable(
  session: WebsiteSession,
  databaseId: string,
  plan: TablePlan,
  cameWithDatabase = false,
): Promise<TableReport> {
  const report: TableReport = {
    name: plan.name,
    tableId: '',
    created: cameWithDatabase,
    fieldsAdded: [],
    choicesAdded: [],
    viewsAdded: [],
    sortsSet: [],
    records: 0,
    added: 0,
  };
  let schema = await schemaOf(session, databaseId);
  let table = schema.tables.find((entry) => entry.name === plan.name);
  if (!table) {
    const created = plannedTable(plan);
    await runCommands(session, databaseId, [{ kind: 'table.create', table: created.table }]);
    report.created = true;
    schema = await schemaOf(session, databaseId);
    table = need(
      schema.tables.find((entry) => entry.id === created.id),
      `the table ${plan.name} it just made`,
    );
  }
  const tableId = table.id;
  report.tableId = tableId;

  // Fields the table doesn't have, whether it was made before them or a person removed one.
  const missing = plan.fields.filter((field) => !fieldNamed(schema, tableId, field.name));
  if (missing.length) {
    await runCommands(
      session,
      databaseId,
      missing.map((field) => ({ kind: 'field.create', tableId, field: plannedField(field) })),
    );
    report.fieldsAdded.push(...missing.map((field) => field.name));
    schema = await schemaOf(session, databaseId);
  }

  // Choices the content names that a select field doesn't offer yet.  An update drops every choice
  // it leaves out, so the ones already there go back along with the new ones.
  for (const field of plan.fields) {
    if (!field.choices) continue;
    const existing = fieldNamed(schema, tableId, field.name);
    if (!existing || existing.type !== 'singleSelect') continue;
    const choices = choicesOf(existing);
    const offered = new Set(choices.map((choice) => choice.name));
    const added = field.choices.filter((name) => !offered.has(name));
    if (!added.length) continue;
    await runCommands(session, databaseId, [
      {
        kind: 'field.update',
        fieldId: existing.id,
        options: { ...existing.options, choices: [...choices, ...newChoices(added)] },
      },
    ]);
    report.choicesAdded.push(...added.map((name) => `${field.name}: ${name}`));
    schema = await schemaOf(session, databaseId);
  }

  // Every table gets a grid: the one it was made with, or one this seed adds back when it's gone.
  let grid = schema.views.find((view) => view.tableId === tableId && view.type === 'grid');
  if (!grid) {
    const id = newId('viw');
    await runCommands(session, databaseId, [
      { kind: 'view.create', view: { id, tableId, name: GRID_VIEW, type: 'grid', config: {} } },
    ]);
    report.viewsAdded.push(GRID_VIEW);
    schema = await schemaOf(session, databaseId);
    grid = need(
      schema.views.find((view) => view.id === id),
      `the grid of ${plan.name} it just made`,
    );
  }
  // A grid keeps whatever order a person gave it, and takes the reader's order while it has none.
  if (plan.sorts.length && !grid.config.sorts.length) {
    const fields = fieldIds(schema, tableId);
    await runCommands(session, databaseId, [
      {
        kind: 'view.update',
        viewId: grid.id,
        config: {
          sorts: plan.sorts.map((sort) => ({
            fieldId: need(fields[sort.field], `the field ${sort.field} of ${plan.name}`),
            direction: sort.direction,
          })),
        },
      },
    ]);
    report.sortsSet.push(grid.name);
  }
  for (const view of plan.views ?? []) {
    const there = schema.views.some(
      (entry) => entry.tableId === tableId && entry.name === view.name && entry.type === view.type,
    );
    if (there) continue;
    await runCommands(session, databaseId, [
      {
        kind: 'view.create',
        view: {
          id: newId('viw'),
          tableId,
          name: view.name,
          type: view.type,
          config: view.config(fieldIds(schema, tableId)),
        },
      },
    ]);
    report.viewsAdded.push(view.name);
  }

  // Records, matched by the field that names them, so a second run leaves every one alone.
  const fields = fieldIds(schema, tableId);
  const primary = need(fields[plan.primary], `the field ${plan.primary} of ${plan.name}`);
  const choices = choiceIds(schema, tableId, plan);
  const rows = await readTable(session, schema, tableId);
  const written = new Set(
    rows.map((row) => (row.values[primary] == null ? '' : String(row.values[primary]))),
  );
  const wanted = plan.rows.filter((row) => !written.has(String(row[plan.primary] ?? '')));
  await runCommands(
    session,
    databaseId,
    batched(wanted, LIMITS.recordsPerCommand).map((chunk) => ({
      kind: 'record.create',
      tableId,
      records: chunk.map((row) => ({
        id: newId('rec'),
        values: recordValues(plan, row, fields, choices),
      })),
    })),
  );
  report.added = wanted.length;
  report.records = rows.length + wanted.length;
  return report;
}

/**
 * Every step in order, timed.  Safe to run again: it finds what's there and makes only what's
 * missing, so a run against a database a person has been editing adds nothing and changes nothing.
 */
export async function buildWebsite(
  session: WebsiteSession,
  onProgress: (line: string) => void = () => undefined,
): Promise<WebsiteReport> {
  const timings: WebsiteReport['timings'] = [];
  const stamp = async <T>(step: string, work: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      return await work();
    } finally {
      const ms = Date.now() - started;
      timings.push({ step, ms });
      onProgress(`${step}: ${ms} ms`);
    }
  };
  const plans = tablePlans();
  const database = await stamp(`Make the database ${DATABASE_NAME}`, () => ensureDatabase(session, plans));
  const tables: TableReport[] = [];
  for (const [index, plan] of plans.entries()) {
    // The database comes with its first table, which this run made just as much as the others.
    const report = await stamp(`Fill ${plan.name}`, () =>
      ensureTable(session, database.id, plan, database.created && index === 0),
    );
    tables.push(report);
    onProgress(`${plan.name}: ${report.records} records, ${report.added} of them new`);
  }
  return { databaseId: database.id, tables, timings };
}
