import {
  DatabaseCreate,
  DatabaseSchema,
  newId,
  type AutomationRun,
  type AutomationRunsPage,
  type CommandBatchResult,
  type DatabaseRole,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import type { ServerFixture, SignedIn } from '../test/fixture.js';
import type { AutomationEngine } from './engine.js';
import type { RunRow } from './store.js';

/**
 * A database for automation tests: a Tasks table with most kinds of field, a Log table that links
 * to it, a view of finished tasks, and a form for adding tasks.
 */
export interface Base {
  databaseId: string;
  tasks: string;
  log: string;
  grid: string;
  doneView: string;
  form: string;
  todo: string;
  done: string;
  logTodo: string;
  logDone: string;
  f: {
    name: string;
    status: string;
    count: string;
    email: string;
    owner: string;
    due: string;
    note: string;
    double: string;
    summary: string;
    logStatus: string;
    logCount: string;
    logTask: string;
    logNote: string;
  };
}

const clientId = newId('client');

export function engine(server: ServerFixture): AutomationEngine {
  if (!server.ctx.automations) throw new Error('the automation engine is not installed');
  return server.ctx.automations;
}

export async function send(
  server: ServerFixture,
  databaseId: string,
  commands: Array<Record<string, unknown>>,
  who: SignedIn = server.owner,
  groupId = newId('action'),
): Promise<CommandBatchResult['results']> {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: who.headers,
    payload: {
      clientId,
      commands: commands.map((command) => ({ id: newId('command'), groupId, ...command })),
    },
  });
  if (response.statusCode !== 200)
    throw new Error(`commands failed: ${response.statusCode} ${response.body}`);
  return response.json<CommandBatchResult>().results;
}

/** Sends commands that must all apply. */
export async function apply(
  server: ServerFixture,
  databaseId: string,
  commands: Array<Record<string, unknown>>,
  who: SignedIn = server.owner,
  groupId = newId('action'),
): Promise<void> {
  const results = await send(server, databaseId, commands, who, groupId);
  const rejected = results.find((result) => result.status !== 'applied');
  if (rejected) throw new Error(`command rejected: ${JSON.stringify(rejected)}`);
}

export async function schema(server: ServerFixture, databaseId: string, who: SignedIn = server.owner) {
  const response = await server.app.inject({
    method: 'GET',
    url: `/api/databases/${databaseId}/schema`,
    headers: who.headers,
  });
  if (response.statusCode !== 200) throw new Error(`schema failed: ${response.statusCode} ${response.body}`);
  return DatabaseSchema.parse(response.json());
}

export async function grant(
  server: ServerFixture,
  databaseId: string,
  who: SignedIn,
  role: DatabaseRole | null,
) {
  await query(
    server.pool,
    sql`DELETE FROM ${ident(server.schemas.app, 'grants')}
    WHERE resource_kind = 'database' AND resource_id = ${databaseId} AND principal_id = ${who.userId}`,
  );
  if (role)
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${who.info.org.id}, 'database', ${databaseId}, 'user', ${who.userId}, ${role})`,
    );
}

export async function createBase(server: ServerFixture, who: SignedIn = server.owner): Promise<Base> {
  const ids = {
    tasks: newId('table'),
    log: newId('table'),
    grid: newId('view'),
    logGrid: newId('view'),
    doneView: newId('view'),
    form: newId('view'),
    todo: newId('choice'),
    done: newId('choice'),
    logTodo: newId('choice'),
    logDone: newId('choice'),
  };
  const f = {
    name: newId('field'),
    status: newId('field'),
    count: newId('field'),
    email: newId('field'),
    owner: newId('field'),
    due: newId('field'),
    note: newId('field'),
    double: newId('field'),
    summary: newId('field'),
    logStatus: newId('field'),
    logCount: newId('field'),
    logTask: newId('field'),
    logNote: newId('field'),
  };
  const databaseId = newId('database');
  const input = DatabaseCreate.parse({
    id: databaseId,
    name: 'Automations',
    table: {
      id: ids.tasks,
      name: 'Tasks',
      fields: [
        { id: f.name, name: 'Name', type: 'text' },
        {
          id: f.status,
          name: 'Status',
          type: 'singleSelect',
          options: {
            choices: [
              { id: ids.todo, name: 'Todo', color: 'gray' },
              { id: ids.done, name: 'Done', color: 'green' },
            ],
          },
        },
        { id: f.count, name: 'Count', type: 'number' },
        { id: f.email, name: 'Email', type: 'email' },
        { id: f.owner, name: 'Owner', type: 'user' },
        { id: f.due, name: 'Due', type: 'date' },
        { id: f.note, name: 'Note', type: 'longText' },
      ],
      view: { id: ids.grid, name: 'Grid' },
    },
  });
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: who.headers,
    payload: input,
  });
  if (response.statusCode !== 200)
    throw new Error(`database failed: ${response.statusCode} ${response.body}`);
  await apply(
    server,
    databaseId,
    [
      {
        kind: 'field.create',
        tableId: ids.tasks,
        field: { id: f.double, name: 'Double', type: 'formula', options: { expression: '{Count} * 2' } },
      },
      {
        kind: 'table.create',
        table: {
          id: ids.log,
          name: 'Log',
          fields: [
            { id: f.summary, name: 'Summary', type: 'text' },
            {
              id: f.logStatus,
              name: 'Status',
              type: 'singleSelect',
              options: {
                choices: [
                  { id: ids.logTodo, name: 'Todo', color: 'gray' },
                  { id: ids.logDone, name: 'Done', color: 'green' },
                ],
              },
            },
            { id: f.logCount, name: 'Count', type: 'number' },
            { id: f.logNote, name: 'Note', type: 'longText' },
          ],
          view: { id: ids.logGrid, name: 'Grid' },
        },
      },
      {
        kind: 'field.create',
        tableId: ids.log,
        field: { id: f.logTask, name: 'Task', type: 'link', options: { linkedTableId: ids.tasks } },
      },
      {
        kind: 'view.create',
        view: {
          id: ids.doneView,
          tableId: ids.tasks,
          name: 'Done',
          type: 'grid',
          config: {
            filter: {
              conjunction: 'and',
              conditions: [{ id: 'c1', fieldId: f.status, operator: 'is', value: ids.done }],
            },
          },
        },
      },
      {
        kind: 'view.create',
        view: {
          id: ids.form,
          tableId: ids.tasks,
          name: 'Intake',
          type: 'form',
          config: { form: { questions: [{ fieldId: f.name }, { fieldId: f.count }] } },
        },
      },
    ],
    who,
  );
  return {
    databaseId,
    tasks: ids.tasks,
    log: ids.log,
    grid: ids.grid,
    doneView: ids.doneView,
    form: ids.form,
    todo: ids.todo,
    done: ids.done,
    logTodo: ids.logTodo,
    logDone: ids.logDone,
    f,
  };
}

/** Creates an automation from a configuration, turned on unless asked otherwise, and returns its ID. */
export async function automate(
  server: ServerFixture,
  databaseId: string,
  config: Record<string, unknown>,
  options: { enabled?: boolean; who?: SignedIn; name?: string } = {},
): Promise<string> {
  const id = newId('automation');
  const who = options.who ?? server.owner;
  await apply(
    server,
    databaseId,
    [{ kind: 'automation.create', automation: { id, name: options.name ?? 'Automation', config } }],
    who,
  );
  if (options.enabled ?? true)
    await apply(server, databaseId, [{ kind: 'automation.update', automationId: id, enabled: true }], who);
  return id;
}

export async function createRecords(
  server: ServerFixture,
  databaseId: string,
  tableId: string,
  records: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
  who: SignedIn = server.owner,
): Promise<string[]> {
  const rows = records.map((values) => ({ id: newId('record'), values }));
  await apply(server, databaseId, [{ kind: 'record.create', tableId, records: rows, ...extra }], who);
  return rows.map((row) => row.id);
}

export async function updateRecord(
  server: ServerFixture,
  databaseId: string,
  tableId: string,
  recordId: string,
  values: Record<string, unknown>,
  who: SignedIn = server.owner,
  groupId = newId('action'),
): Promise<void> {
  await apply(
    server,
    databaseId,
    [{ kind: 'record.update', tableId, records: [{ id: recordId, values }] }],
    who,
    groupId,
  );
}

export async function runRows(server: ServerFixture, automationId: string): Promise<RunRow[]> {
  const result = await query<RunRow>(
    server.pool,
    sql`SELECT * FROM ${ident(server.schemas.app, 'automation_runs')} WHERE automation_id = ${automationId} ORDER BY seq`,
  );
  return result.rows;
}

export async function records(server: ServerFixture, tableId: string) {
  const result = await query<Record<string, unknown> & { __id: string }>(
    server.pool,
    sql`SELECT * FROM ${ident(server.schemas.data, tableId)} WHERE __deleted_at IS NULL ORDER BY __rid`,
  );
  return result.rows;
}

export async function runsPage(
  server: ServerFixture,
  automationId: string,
  who: SignedIn = server.owner,
  cursor?: string,
): Promise<{ status: number; page: AutomationRunsPage }> {
  const response = await server.app.inject({
    method: 'GET',
    url: `/api/automations/${automationId}/runs${cursor ? `?cursor=${cursor}` : ''}`,
    headers: who.headers,
  });
  return { status: response.statusCode, page: response.json<AutomationRunsPage>() };
}

export async function testRun(
  server: ServerFixture,
  automationId: string,
  body: Record<string, unknown> = {},
  who: SignedIn = server.owner,
): Promise<{ status: number; run: AutomationRun; body: string }> {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${automationId}/test`,
    headers: who.headers,
    payload: body,
  });
  return { status: response.statusCode, run: response.json<AutomationRun>(), body: response.body };
}
