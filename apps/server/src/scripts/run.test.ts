import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newId, type RowData, type UndoResult } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import * as outbound from '../automations/script-fetch.js';
import { runPanelScript, type PanelRunOptions } from './run.js';
import {
  actorOf,
  apply,
  saveScript,
  scriptBase,
  taskNames,
  TestPanel,
  type ScriptBase,
} from './scripts.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
let base: ScriptBase;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'scriptrun', { automationsPollMs: 0 });
  base = await scriptBase(server);
}, 60_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

/** Runs code as someone, the way the panel's socket does */
async function run(
  source: string,
  panel = new TestPanel(),
  who = base.editor,
  options: Partial<PanelRunOptions> = {},
) {
  const script = await saveScript(server, base, source);
  const groupId = newId('action');
  const result = await runPanelScript(server.app, await actorOf(server, who), script, panel, {
    runId: newId('job'),
    groupId,
    ...options,
  });
  return { result, panel, groupId };
}

const q = (value: string) => JSON.stringify(value);

describe('running a script from the panel', () => {
  it('reads and writes as the person running it, inside their record rules', async () => {
    const { result, panel } = await run(`
      const found = await records.find(${q(base.tasks)}, { limit: 100 })
      await output.text(found.map((row) => row.id).sort().join(','))
      try { await records.update(${q(base.tasks)}, ${q(base.theirs[0]!)}, { ${q(base.f.name)}: 'Taken' }) }
      catch (error) { await output.text(error.message) }
      try { await records.create(${q(base.tasks)}, { ${q(base.f.name)}: 'Nobody’s' }) }
      catch (error) { await output.text(error.message) }
      try { await records.update(${q(base.tasks)}, ${q(base.mine[0]!)}, { ${q(base.f.signature)}: null }) }
      catch (error) { await output.text(error.message) }
      await records.update(${q(base.tasks)}, ${q(base.mine[0]!)}, { ${q(base.f.count)}: 10 })
    `);
    expect(result, JSON.stringify(result)).toMatchObject({ state: 'succeeded', writes: 1 });
    expect(panel.texts).toEqual([
      [...base.mine].sort().join(','),
      'data.access.recordHidden',
      'data.access.recordOutsideRules',
      'data.value.signatureStep',
    ]);
    expect(await taskNames(server, base)).not.toContain('Taken');
    expect(await taskNames(server, base)).not.toContain('Nobody’s');
    // The owner, whom no rule limits, sees and changes every task.
    const owned = await run(
      `await output.text(String((await records.find(${q(base.tasks)}, { limit: 100 })).length))`,
      new TestPanel(),
      server.owner,
    );
    expect(owned.panel.texts[0]).toBe(String((await taskNames(server, base)).length));
  });

  it('streams console messages and every kind of output in the order the script made them', async () => {
    const { result, panel } = await run(`
      console.log('one', { two: 2 })
      await output.text('Plain text')
      console.warn('careful')
      await output.markdown('**Bold** and [a link](https://example.test)')
      await output.table([{ Name: 'Ada', Score: 3 }, { Name: 'Grace', Score: null }])
      console.error('done')
    `);
    expect(result.state).toBe('succeeded');
    expect(panel.events).toEqual([
      { type: 'log', entry: { level: 'log', text: 'one {"two":2}' } },
      { type: 'output', output: { kind: 'text', text: 'Plain text' } },
      { type: 'log', entry: { level: 'warn', text: 'careful' } },
      { type: 'output', output: { kind: 'markdown', text: '**Bold** and [a link](https://example.test)' } },
      {
        type: 'output',
        output: {
          kind: 'table',
          columns: ['Name', 'Score'],
          rows: [
            ['Ada', '3'],
            ['Grace', ''],
          ],
        },
      },
      { type: 'log', entry: { level: 'error', text: 'done' } },
    ]);
  });

  it('asks for text, a button, a table, and a record, and carries on with each answer', async () => {
    const answers: unknown[] = [
      'Hello',
      // An answer the prompt can't take is asked again.
      7,
      1,
      base.notes,
      // A record the person can't read is never handed to the script.
      base.theirs[0],
      base.mine[1],
    ];
    const panel = new TestPanel(() => answers.shift());
    const { result } = await run(
      `
      const text = await input.textAsync('Your greeting')
      const button = await input.buttonsAsync('Pick one', ['First', { label: 'Second', value: { chosen: 2 } }])
      const table = await input.tableAsync('Which table?')
      const record = await input.recordAsync('Which task?', ${q(base.tasks)})
      await output.text(JSON.stringify({ text, button, table, record: record.id, name: record.values[${q(base.f.name)}] }))
    `,
      panel,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ state: 'succeeded' });
    expect(panel.prompts).toEqual([
      { kind: 'text', label: 'Your greeting' },
      { kind: 'buttons', label: 'Pick one', options: ['First', 'Second'] },
      { kind: 'buttons', label: 'Pick one', options: ['First', 'Second'] },
      { kind: 'table', label: 'Which table?' },
      { kind: 'record', label: 'Which task?', tableId: base.tasks },
      { kind: 'record', label: 'Which task?', tableId: base.tasks },
    ]);
    expect(JSON.parse(panel.texts[0]!)).toEqual({
      text: 'Hello',
      button: { chosen: 2 },
      table: { id: base.notes, name: 'Notes' },
      record: base.mine[1],
      name: 'Mine two',
    });
  });

  it('refuses prompts it can’t show, which the script can catch', async () => {
    const { result, panel } = await run(`
      for (const ask of [
        () => input.textAsync('x'.repeat(2000)),
        () => input.buttonsAsync('None', []),
        () => input.recordAsync('Where?', 'tbl00000000000000'),
      ]) {
        try { await ask() } catch (error) { await output.text(error.message) }
      }
    `);
    expect(result.state).toBe('succeeded');
    expect(panel.texts).toEqual(['scripts.call.invalid', 'scripts.call.invalid', 'errors.notFound']);
    expect(panel.prompts).toEqual([]);
  });

  it('stops when the person cancels, whether the script waits on them or spins', async () => {
    for (const source of ['await input.textAsync("Never answered")', 'while (true) {}']) {
      const controller = new AbortController();
      const panel = new TestPanel(() => new Promise(() => {}));
      const running = run(source, panel, base.editor, { signal: controller.signal });
      setTimeout(() => controller.abort(), 300);
      const started = performance.now();
      const { result } = await running;
      expect(result).toMatchObject({ state: 'canceled', error: { messageKey: 'scripts.run.canceled' } });
      // A loop is stopped at once, not at the end of its time limit.
      expect(performance.now() - started).toBeLessThan(20_000);
    }
  });

  it('counts only the script’s own time against its limit, not time waiting for the person', async () => {
    const slow = new TestPanel(() => new Promise((resolve) => setTimeout(() => resolve('late'), 1_500)));
    const waited = await run(
      'const answer = await input.textAsync("Take your time")\nawait output.text(answer)',
      slow,
      base.editor,
      { timeoutMs: 1_000 },
    );
    expect(waited.result, JSON.stringify(waited.result)).toMatchObject({ state: 'succeeded' });
    expect(waited.result.ms).toBeLessThan(1_000);
    expect(slow.texts).toEqual(['late']);
    const busy = await run('while (true) {}', new TestPanel(), base.editor, { timeoutMs: 300 });
    expect(busy.result).toMatchObject({
      state: 'failed',
      error: { messageKey: 'automations.script.timeout' },
    });
  });

  it('ends a script whose built-in operations outlast its time limit', async () => {
    // Each pass is one long built-in operation, and the sandbox looks at the clock only once in a
    // few thousand passes, so only ending the thread stops it.
    const source = `const list = new Array(1000000).fill('abcdefghij')\nfor (let i = 0; i < 3000; i++) list.join('')`;
    const started = performance.now();
    const { result } = await run(source, new TestPanel(), base.editor, { timeoutMs: 300 });
    expect(result).toMatchObject({ state: 'failed', error: { messageKey: 'automations.script.timeout' } });
    // The server ends the thread a second after the limit.  The sandbox alone would let the
    // script go on for many times this long.
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('ends any run that goes on too long in all, waits included', async () => {
    const { result } = await run(
      'await input.textAsync("Nobody answers")',
      new TestPanel(() => new Promise(() => {})),
      base.editor,
      { runMs: 400 },
    );
    expect(result).toMatchObject({ state: 'failed', error: { messageKey: 'scripts.run.tooLong' } });
  });

  it('groups every write of a run into one action that undo takes back at once', async () => {
    const before = await taskNames(server, base);
    const { result, groupId } = await run(`
      const a = await records.create(${q(base.tasks)}, { ${q(base.f.name)}: 'Scripted one', ${q(base.f.owner)}: [${q(base.editor.userId)}] })
      await records.create(${q(base.tasks)}, { ${q(base.f.name)}: 'Scripted two', ${q(base.f.owner)}: [${q(base.editor.userId)}] })
      await records.update(${q(base.tasks)}, a.recordId, { ${q(base.f.name)}: 'Scripted again' })
      await records.create(${q(base.notes)}, { ${q(base.f.note)}: 'A note' })
    `);
    expect(result).toMatchObject({ state: 'succeeded', writes: 4 });
    expect(await taskNames(server, base)).toEqual([...before, 'Scripted again', 'Scripted two']);
    const changes = await query<{ group_id: string; actor_id: string; client_id: string }>(
      server.pool,
      sql`SELECT group_id, actor_id, client_id FROM ${ident(server.schemas.app, 'changes')}
      WHERE group_id = ${groupId}`,
    );
    expect(changes.rows).toHaveLength(4);
    expect(new Set(changes.rows.map((row) => row.actor_id))).toEqual(new Set([base.editor.userId]));
    const audit = await query<{ metadata: Record<string, unknown> }>(
      server.pool,
      sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE action = 'data.records.created' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ scriptId: expect.stringMatching(/^scr/) });
    // Someone else can't undo it, and the person who ran it undoes all of it in one step.
    const undo = (who: typeof base.editor) =>
      server.app.inject({
        method: 'POST',
        url: `/api/databases/${base.databaseId}/undo`,
        headers: who.headers,
        payload: { clientId: newId('client'), groupId, commandId: newId('command') },
      });
    expect((await undo(base.creator)).json<UndoResult>()).toMatchObject({ status: 'rejected' });
    const undone = await undo(base.editor);
    expect(undone.json<UndoResult>()).toMatchObject({ status: 'applied', skipped: 0 });
    expect(await taskNames(server, base)).toEqual(before);
    const notes = await query<{ count: string }>(
      server.pool,
      sql`SELECT count(*) AS count FROM ${ident(server.schemas.data, base.notes)} WHERE __deleted_at IS NULL`,
    );
    expect(Number(notes.rows[0]!.count)).toBe(0);
  });

  it('asks before deleting, and deletes nothing unless the person agrees', async () => {
    const ids = [newId('record'), newId('record')];
    const created = await run(`
      await records.create(${q(base.notes)}, { ${q(base.f.note)}: 'Keep or not' })
    `);
    expect(created.result.state).toBe('succeeded');
    const notes = await query<{ id: string }>(
      server.pool,
      sql`SELECT __id AS id FROM ${ident(server.schemas.data, base.notes)} WHERE __deleted_at IS NULL`,
    );
    ids.splice(0, ids.length, ...notes.rows.map((row) => row.id));
    const script = `
      try { await records.delete(${q(base.notes)}, ${JSON.stringify(ids)}); await output.text('deleted') }
      catch (error) { await output.text(error.message) }
    `;
    const declined = await run(script, new TestPanel(() => false));
    expect(declined.panel.prompts).toEqual([{ kind: 'delete', tableId: base.notes, count: ids.length }]);
    expect(declined.panel.texts).toEqual(['scripts.delete.declined']);
    expect(declined.result.writes).toBe(0);
    const still = await query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.data, base.notes)} WHERE __deleted_at IS NULL`,
    );
    expect(still.rowCount).toBe(ids.length);
    const agreed = await run(script, new TestPanel(() => true));
    expect(agreed.panel.texts).toEqual(['deleted']);
    expect(agreed.result).toMatchObject({ state: 'succeeded', writes: ids.length });
    const left = await query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.data, base.notes)} WHERE __deleted_at IS NULL`,
    );
    expect(left.rowCount).toBe(0);
    // A record outside the person's rules can't be deleted even when they agree.
    const hidden = await run(
      `try { await records.delete(${q(base.tasks)}, ${q(base.theirs[1]!)}) } catch (error) { await output.text(error.message) }`,
      new TestPanel(() => true),
    );
    expect(hidden.panel.texts).toEqual(['data.access.recordHidden']);
  });

  it('keeps the automation step’s sandbox guarantees', async () => {
    const escaped = await run(`await output.text(JSON.stringify([
      typeof globalThis.process, typeof globalThis.require, typeof globalThis.Buffer,
      typeof globalThis.setTimeout, typeof Function('return this')().process,
      typeof output.text.constructor('return this')().require, typeof globalThis.__bridge,
      typeof globalThis.__input, typeof globalThis.postMessage, typeof globalThis.WebAssembly
    ]))`);
    expect(JSON.parse(escaped.panel.texts[0]!)).toEqual(Array(10).fill('undefined'));
    const frozen = await run(`'use strict'
      let refused = 0
      try { records.create = () => null } catch { refused++ }
      try { Object.prototype.polluted = true } catch { refused++ }
      try { input.textAsync = async () => 'forged' } catch { refused++ }
      await output.text(String(refused) + String(({}).polluted))`);
    expect(frozen.panel.texts).toEqual(['3undefined']);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    const cases: Array<[string, string]> = [
      ['const a = []\nwhile (true) a.push(new ArrayBuffer(1024 * 1024))', 'automations.script.memory'],
      ['await import("node:fs")', 'automations.script.thrown'],
      ['await console.log("x".repeat(100000))', 'automations.script.logLimit'],
      ['for (let i = 0; i < 1001; i++) await sleep(0)', 'automations.script.bridgeLimit'],
      ['await fetch("https://127.0.0.1/")', 'automations.script.thrown'],
      ['await fetch("http://example.test/")', 'automations.script.fetchBlocked'],
      ['\nconst =', 'automations.script.syntax'],
    ];
    for (const [source, messageKey] of cases) {
      const { result } = await run(source);
      expect(result.error, source).toMatchObject({ messageKey });
    }
    // Waits that never end, and error getters that spin, still end at the time limit.
    for (const source of [
      'await new Promise(() => {})',
      'await sleep(10000)',
      'throw { get message() { while (true) {} } }',
    ]) {
      const { result } = await run(source, new TestPanel(), base.editor, { timeoutMs: 300 });
      expect(result.error, source).toMatchObject({ messageKey: 'automations.script.timeout' });
    }
    const huge = await run('for (;;) await output.text("x".repeat(60000))');
    expect(huge.result.error).toMatchObject({ messageKey: 'automations.script.outputLimit' });
    const placed = await run('\nthrow new Error("broken")');
    expect(placed.result.error).toEqual({
      messageKey: 'automations.script.thrown',
      detail: 'broken',
      line: 2,
      column: 16,
    });
  });

  it('refuses people who can’t edit records before running anything', async () => {
    const { result, panel } = await run(`await output.text('ran')`, new TestPanel(), base.reader);
    expect(result).toMatchObject({ state: 'failed', error: { messageKey: 'data.access.denied' } });
    expect(panel.events).toEqual([]);
  });

  it('hands a record to the script only as the person reads it', async () => {
    const panel = new TestPanel(() => base.mine[0]);
    const { result } = await run(
      `const record = await input.recordAsync('Pick', { id: ${q(base.tasks)} })\nawait output.text(JSON.stringify(record))`,
      panel,
    );
    expect(result.state).toBe('succeeded');
    const record = JSON.parse(panel.texts[0]!) as RowData;
    expect(record).toMatchObject({ id: base.mine[0], values: { [base.f.name]: 'Mine one' } });
  });
});

it('records a validation refusal from a script without changing the cell', async () => {
  const { applied } = await import('../data/permissions/permissions.test-helpers.js');
  await applied(server, server.owner, base.databaseId, {
    kind: 'field.update',
    fieldId: base.f.count,
    options: { validation: { min: { value: 0 } } },
  });
  const { result } = await run(
    `await records.update(${q(base.tasks)}, ${q(base.mine[0]!)}, { ${q(base.f.count)}: -1 })`,
  );
  expect(result).toMatchObject({ state: 'failed', writes: 0 });
  expect(JSON.stringify(result)).toContain('data.validation.failed');
});

it('runs a button script for its selected record and audits the button context', async () => {
  const script = await saveScript(
    server,
    base,
    `const clicked = await input.buttonRecordAsync()
    await records.update(clicked.tableId, clicked.recordId, { ${q(base.f.count)}: 71 })`,
  );
  const fieldId = newId('field');
  await apply(server, server.owner, base.databaseId, [
    {
      kind: 'field.create',
      tableId: base.tasks,
      field: {
        id: fieldId,
        name: 'Run selected',
        type: 'button',
        options: { action: { kind: 'runScript', scriptId: script.id } },
      },
    },
  ]);
  const button = { tableId: base.tasks, recordId: base.mine[1]!, fieldId };
  const runId = newId('job');
  const result = await runPanelScript(
    server.app,
    await actorOf(server, base.editor),
    script,
    new TestPanel(),
    { runId, groupId: newId('action'), button },
  );
  expect(result, JSON.stringify(result)).toMatchObject({ state: 'succeeded', writes: 1 });
  const rows = await query<{ metadata: Record<string, unknown> }>(
    server.pool,
    sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')} WHERE metadata ->> 'scriptRunId' = ${runId}`,
  );
  expect(rows.rows).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ button }) })]);
  const hidden = await runPanelScript(
    server.app,
    await actorOf(server, base.editor),
    script,
    new TestPanel(),
    { runId: newId('job'), groupId: newId('action'), button: { ...button, recordId: base.theirs[0]! } },
  );
  expect(hidden).toMatchObject({ state: 'failed', writes: 0 });
});
it.each(['maskGuests', 'noExport', 'noExternalSharing'] as const)(
  'applies %s to member script external actions',
  async (rule) => {
    const govern = async (action: object) => {
      const response = await server.app.inject({
        method: 'POST',
        url: '/api/admin/governance/commands',
        headers: server.owner.headers,
        payload: { kind: 'governance.apply', id: newId('command'), action },
      });
      expect(response.json().status, response.body).toBe('applied');
    };

    await govern({
      kind: 'classification.labels',
      labels: [{ id: 'outbound', name: 'Outbound', color: 'blue', description: '', rules: { [rule]: true } }],
    });
    await govern({
      kind: 'classification.assign',
      target: { kind: 'field', databaseId: base.databaseId, fieldId: base.f.name },
      labelId: 'outbound',
    });
    const fetch = vi
      .spyOn(outbound, 'scriptFetch')
      .mockResolvedValue({ status: 200, headers: {}, body: 'Delivered' });
    try {
      const { result, panel } = await run(
        `const response = await fetch('https://example.test/hook')
await output.text(await response.text())`,
        new TestPanel(),
        server.owner,
      );
      expect(result.state, JSON.stringify(result)).toBe(rule === 'maskGuests' ? 'succeeded' : 'failed');
      expect(fetch).toHaveBeenCalledTimes(rule === 'maskGuests' ? 1 : 0);
      if (rule === 'maskGuests') expect(panel.texts).toEqual(['Delivered']);
      else {
        expect(result.error?.messageKey).toBe('automations.script.thrown');
        expect(JSON.stringify(result)).toContain('governance.classificationDenied');
      }
    } finally {
      fetch.mockRestore();
      await govern({
        kind: 'classification.assign',
        target: { kind: 'field', databaseId: base.databaseId, fieldId: base.f.name },
        labelId: null,
      });
    }
  },
);
