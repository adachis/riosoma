import {
  CURRENT_PERSON,
  newId,
  type CommandBatchResult,
  type CommandResult,
  type DatabaseRole,
  type ScriptPrompt,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { actorFor } from '../automations/run.js';
import type { PanelOutput, ScriptLog } from '../automations/script.js';
import { dataStore } from '../data/context.js';
import type { Actor } from '../http/policy.js';
import type { ServerFixture, SignedIn } from '../test/fixture.js';
import type { PanelIo } from './run.js';
import { loadScript, type StoredScript } from './store.js';

/**
 * A database for script tests: a Tasks table whose editors see only the tasks they own, a Notes
 * table with no rule, and a creator, an editor, and a reader beside the owner.
 */
export interface ScriptBase {
  databaseId: string;
  tasks: string;
  notes: string;
  f: { name: string; owner: string; count: string; signature: string; note: string };
  /** Tasks the editor owns, and tasks they don't */
  mine: string[];
  theirs: string[];
  creator: SignedIn;
  editor: SignedIn;
  reader: SignedIn;
}

export async function send(
  server: ServerFixture,
  who: SignedIn,
  databaseId: string,
  commands: Array<Record<string, unknown>>,
  groupId = newId('action'),
): Promise<CommandResult[]> {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: who.headers,
    payload: {
      clientId: newId('client'),
      commands: commands.map((command) => ({ id: newId('command'), groupId, ...command })),
    },
  });
  if (response.statusCode !== 200)
    throw new Error(`commands failed: ${response.statusCode} ${response.body}`);
  return response.json<CommandBatchResult>().results;
}

export async function apply(
  server: ServerFixture,
  who: SignedIn,
  databaseId: string,
  commands: Array<Record<string, unknown>>,
  groupId?: string,
): Promise<void> {
  const rejected = (await send(server, who, databaseId, commands, groupId)).find(
    (result) => result.status !== 'applied',
  );
  if (rejected) throw new Error(`command rejected: ${JSON.stringify(rejected)}`);
}

export async function grant(server: ServerFixture, databaseId: string, who: SignedIn, role: DatabaseRole) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${who.userId}, ${role})`,
  );
}

export async function scriptBase(server: ServerFixture): Promise<ScriptBase> {
  const databaseId = newId('database');
  const tasks = newId('table');
  const notes = newId('table');
  const f = {
    name: newId('field'),
    owner: newId('field'),
    count: newId('field'),
    signature: newId('field'),
    note: newId('field'),
  };
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'Scripts',
      table: {
        id: tasks,
        name: 'Tasks',
        fields: [
          { id: f.name, name: 'Name', type: 'text' },
          { id: f.owner, name: 'Owner', type: 'user' },
          { id: f.count, name: 'Count', type: 'number' },
          { id: f.signature, name: 'Signed', type: 'signature' },
        ],
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    },
  });
  if (created.statusCode !== 200) throw new Error(`database failed: ${created.body}`);
  const creator = await server.addMember({ name: 'Creator' });
  const editor = await server.addMember({ name: 'Editor' });
  const reader = await server.addMember({ name: 'Reader' });
  await grant(server, databaseId, creator, 'creator');
  await grant(server, databaseId, editor, 'editor');
  await grant(server, databaseId, reader, 'reader');
  await apply(server, server.owner, databaseId, [
    {
      kind: 'table.create',
      table: {
        id: notes,
        name: 'Notes',
        fields: [{ id: f.note, name: 'Note', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    },
  ]);
  const mine = [newId('record'), newId('record')];
  const theirs = [newId('record'), newId('record')];
  await apply(server, server.owner, databaseId, [
    {
      kind: 'record.create',
      tableId: tasks,
      records: [
        { id: mine[0], values: { [f.name]: 'Mine one', [f.owner]: [editor.userId], [f.count]: 1 } },
        { id: mine[1], values: { [f.name]: 'Mine two', [f.owner]: [editor.userId], [f.count]: 2 } },
        { id: theirs[0], values: { [f.name]: 'Theirs one', [f.owner]: [creator.userId], [f.count]: 3 } },
        { id: theirs[1], values: { [f.name]: 'Theirs two', [f.count]: 4 } },
      ],
    },
  ]);
  const rules = await server.app.inject({
    method: 'PUT',
    url: `/api/tables/${tasks}/record-rules`,
    headers: server.owner.headers,
    payload: {
      rules: [
        {
          id: newId('recordRule'),
          roles: ['editor'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'mine', fieldId: f.owner, operator: 'hasAnyOf', value: [CURRENT_PERSON] }],
          },
        },
      ],
    },
  });
  if (rules.statusCode !== 200) throw new Error(`rules failed: ${rules.body}`);
  return { databaseId, tasks, notes, f, mine, theirs, creator, editor, reader };
}

/** Saves a script as the owner, and returns it as the server stores it. */
export async function saveScript(
  server: ServerFixture,
  base: ScriptBase,
  source: string,
  name = 'A script',
): Promise<StoredScript> {
  const id = newId('script');
  await apply(server, server.owner, base.databaseId, [
    { kind: 'script.create', script: { id, name, description: '', source } },
  ]);
  const { pool, schemas } = dataStore(server.ctx);
  return (await loadScript(pool, schemas, id))!;
}

export async function actorOf(server: ServerFixture, who: SignedIn): Promise<Actor> {
  const { pool, schemas } = dataStore(server.ctx);
  const found = await actorFor(pool, schemas, who.userId, who.info.org.id);
  if (!found) throw new Error('no such person');
  const { locale: _locale, ...actor } = found;
  return actor;
}

/**
 * The panel as a test sees it: what the run showed, in order, and the prompts it asked, each
 * answered by `answer`.  An answer that never settles leaves the prompt open.
 */
export class TestPanel implements PanelIo {
  readonly events: Array<
    | { type: 'log'; entry: ScriptLog }
    | { type: 'output'; output: PanelOutput }
    | { type: 'prompt'; prompt: ScriptPrompt }
    | { type: 'wrote'; writes: number }
  > = [];

  constructor(private readonly answer: (prompt: ScriptPrompt, asked: number) => unknown = () => undefined) {}

  get prompts(): ScriptPrompt[] {
    return this.events.flatMap((event) => (event.type === 'prompt' ? [event.prompt] : []));
  }

  get outputs(): PanelOutput[] {
    return this.events.flatMap((event) => (event.type === 'output' ? [event.output] : []));
  }

  get texts(): string[] {
    return this.outputs.flatMap((output) => (output.kind === 'table' ? [] : [output.text]));
  }

  log(entry: ScriptLog): void {
    this.events.push({ type: 'log', entry });
  }

  output(output: PanelOutput): void {
    this.events.push({ type: 'output', output });
  }

  wrote(writes: number): void {
    this.events.push({ type: 'wrote', writes });
  }

  async ask(prompt: ScriptPrompt): Promise<unknown> {
    this.events.push({ type: 'prompt', prompt });
    return this.answer(prompt, this.prompts.length);
  }
}

/** The tasks' names as the owner sees them, live ones only */
export async function taskNames(server: ServerFixture, base: ScriptBase): Promise<string[]> {
  const result = await query<{ name: string | null }>(
    server.pool,
    sql`SELECT ${ident(base.f.name)} AS name FROM ${ident(server.schemas.data, base.tasks)}
    WHERE __deleted_at IS NULL ORDER BY __rid`,
  );
  return result.rows.map((row) => row.name ?? '');
}
