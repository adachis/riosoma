import { afterEach, describe, expect, it } from 'vitest';
import { FieldSpec, newId } from '@riosoma/contracts';
import { openDatabase } from './session';
import { FakeServer } from './testing';
import { relationalFixture, settle } from './testing/relational';
import type { DatabaseSession } from './types';
import { checkFormula, formulaComputer, formulaDisplay } from './formulas';

const sessions: DatabaseSession[] = [];
afterEach(() => sessions.splice(0).forEach((session) => session.close()));
async function setup() {
  const server = new FakeServer();
  const fixture = relationalFixture(server);
  const session = await openDatabase(fixture.source.databaseId, server.deps());
  sessions.push(session);
  const view = session.openView(fixture.source.viewId);
  const other = session.openView(fixture.viewId);
  await settle();
  return { ...fixture, server, session, view, other };
}

describe('relational sessions', () => {
  it('keeps page names per database, refreshes renamed names, and applies link changes on both sides', async () => {
    const f = await setup();
    expect(f.session.linked.get(f.recordIds[0]!)).toBe('Alpha');
    const isolated = await openDatabase(f.source.databaseId, f.server.deps());
    sessions.push(isolated);
    expect(isolated.linked.size).toBe(0);
    f.server.remoteChange(f.source.databaseId, {
      kind: 'record.linksChanged',
      tableId: f.tableId,
      fieldId: f.inverse.id,
      records: [{ id: f.recordIds[0]!, ids: [f.source.recordId(0)] }],
    });
    f.server.remoteChange(f.source.databaseId, {
      kind: 'record.linksChanged',
      tableId: f.source.tableId,
      fieldId: f.link.id,
      records: [{ id: f.source.recordId(0), ids: [f.recordIds[0]!] }],
    });
    await settle();
    expect(f.other.getRow(0)?.values[f.inverse.id]).toEqual([f.source.recordId(0)]);
    expect(f.view.getRow(0)?.values[f.link.id]).toEqual([f.recordIds[0]]);
    f.server.remote(f.source.databaseId, [
      {
        kind: 'record.update',
        tableId: f.tableId,
        records: [{ id: f.recordIds[0]!, values: { [f.title.id]: 'Renamed' } }],
      },
    ]);
    await settle();
    expect(f.session.linked.get(f.recordIds[0]!)).toBe('Renamed');
  });

  it('asks for the names of linked records it has never read, once each', async () => {
    const server = new FakeServer();
    const f = relationalFixture(server);
    const session = await openDatabase(f.source.databaseId, server.deps());
    sessions.push(session);
    session.openView(f.source.viewId);
    await settle();
    const gamma = f.recordIds[2]!;
    expect(session.linked.has(gamma)).toBe(false);
    // Links the server made to match values arrive as IDs only.
    const link = () =>
      server.remoteChange(f.source.databaseId, {
        kind: 'record.linksChanged',
        tableId: f.source.tableId,
        fieldId: f.link.id,
        records: [{ id: f.source.recordId(0), ids: [gamma] }],
      });
    link();
    await settle();
    expect(session.linked.get(gamma)).toBe('Gamma');
    const asked = () => server.requests.filter((request) => request.path.endsWith('/records/names'));
    expect(asked()).toHaveLength(1);
    expect(asked()[0]!.options.body).toEqual({ ids: [gamma] });
    link();
    await settle();
    expect(asked()).toHaveLength(1);
  });

  it('recomputes formulas synchronously through optimistic changes, rejection, errors, and recovery', async () => {
    const f = await setup();
    expect(f.view.getRow(0)?.values[f.formula.id]).toBe(2);
    f.server.rejectNext('data.value.notNumber');
    const edit = f.session.run([
      {
        kind: 'record.update',
        tableId: f.source.tableId,
        records: [{ id: f.source.recordId(0), values: { [f.source.numberFieldId]: 8 } }],
      },
    ]);
    expect(f.view.getRow(0)?.values[f.formula.id]).toBe(16);
    await edit.done;
    expect(f.view.getRow(0)?.values[f.formula.id]).toBe(2);
    const formula = f.session.getSchema().fieldById.get(f.formula.id)!;
    f.server.remoteChange(f.source.databaseId, {
      kind: 'field.updated',
      field: {
        ...formula,
        ...FieldSpec.parse({
          type: 'formula',
          options: { expression: `10 / {${f.source.numberFieldId}}`, resultType: 'number' },
        }),
      },
      removedChoiceIds: [],
    });
    await settle();
    const zero = f.session.run([
      {
        kind: 'record.update',
        tableId: f.source.tableId,
        records: [{ id: f.source.recordId(0), values: { [f.source.numberFieldId]: 0 } }],
      },
    ]);
    expect(f.view.getRow(0)?.errors?.[f.formula.id]).toBe('formula.runtime.divisionByZero');
    await zero.done;
    const valid = f.session.run([
      {
        kind: 'record.update',
        tableId: f.source.tableId,
        records: [{ id: f.source.recordId(0), values: { [f.source.numberFieldId]: 2 } }],
      },
    ]);
    expect(f.view.getRow(0)?.values[f.formula.id]).toBe(5);
    expect(f.view.getRow(0)?.errors?.[f.formula.id]).toBeUndefined();
    await valid.done;
  });

  it('reloads loaded dependent rows when a linked table changes', async () => {
    const f = await setup();
    const before = f.server.requests.filter((request) =>
      request.path.includes(`/views/${f.source.viewId}/rows`),
    ).length;
    const row = f.database.rows(f.source.tableId).get(f.source.recordId(0))!;
    f.database
      .rows(f.source.tableId)
      .set({ ...row, values: { ...row.values, [f.lookup.id]: [9, 2], [f.rollup.id]: 11 } });
    f.server.remote(f.source.databaseId, [
      {
        kind: 'record.update',
        tableId: f.tableId,
        records: [{ id: f.recordIds[0]!, values: { [f.price.id]: 9 } }],
      },
    ]);
    await settle();
    expect(
      f.server.requests.filter((request) => request.path.includes(`/views/${f.source.viewId}/rows`)).length,
    ).toBeGreaterThan(before);
    expect(f.view.getRow(0)?.values[f.lookup.id]).toEqual([9, 2]);
    expect(f.view.getRow(0)?.values[f.rollup.id]).toBe(11);
  });

  it('resolves stable IDs after renames and detects indirect cycles', async () => {
    const f = await setup();
    const fields = [...f.session.getSchema().fields.get(f.source.tableId)!];
    const numeric = fields.find((field) => field.id === f.source.numberFieldId)!;
    expect(
      formulaDisplay(
        f.formula.type === 'formula' ? f.formula.options.expression : '',
        fields.map((field) => (field.id === numeric.id ? { ...field, name: 'Cost' } : field)),
      ),
    ).toBe('({Cost} * 2)');
    const first = {
      ...f.formula,
      id: newId('field'),
      name: 'First',
      ...FieldSpec.parse({ type: 'formula', options: { expression: '{Second}', resultType: 'number' } }),
    };
    const second = {
      ...first,
      id: newId('field'),
      name: 'Second',
      ...FieldSpec.parse({ type: 'formula', options: { expression: '{First}', resultType: 'number' } }),
    };
    expect(checkFormula('{Second}', [...fields, first, second], first.id)).toMatchObject({
      error: { messageKey: 'formula.field.circular' },
    });
    const dependent = {
      ...first,
      ...FieldSpec.parse({ type: 'formula', options: { expression: '{Double} + 1', resultType: 'number' } }),
    };
    const compute = formulaComputer([...fields, dependent]);
    expect(compute(f.view.getRow(0)!, { now: new Date(), timeZone: 'UTC' }).values[dependent.id]).toBe(3);
  });
});

describe('formulas over links in a session', () => {
  /** Orders linked to clients, with a formula over the link's names and no lookup through it. */
  async function orders() {
    const server = new FakeServer();
    const source = server.createDatabase(2);
    const base = server.database(source.databaseId).schema;
    const clients = newId('table');
    const clientView = newId('view');
    const field = (name: string, spec: FieldSpec, tableId = source.tableId) => ({
      ...base.fields[0]!,
      id: newId('field'),
      tableId,
      name,
      ...spec,
    });
    const name = field('Name', FieldSpec.parse({ type: 'text' }), clients);
    const inverseId = newId('field');
    const client = field(
      'Client',
      FieldSpec.parse({ type: 'link', options: { linkedTableId: clients, inverseFieldId: inverseId } }),
    );
    const inverse = {
      ...field(
        'Orders',
        FieldSpec.parse({
          type: 'link',
          options: { linkedTableId: source.tableId, inverseFieldId: client.id },
        }),
        clients,
      ),
      id: inverseId,
    };
    const label = field(
      'Label',
      FieldSpec.parse({
        type: 'formula',
        options: {
          expression: `{${client.id}} & " Order #" & {${source.numberFieldId}}`,
          resultType: 'text',
        },
      }),
    );
    const database = server.seed(
      {
        ...base,
        tables: [
          ...base.tables,
          { ...base.tables[0]!, id: clients, name: 'Clients', primaryFieldId: name.id, position: 1 },
        ],
        views: [...base.views, { ...base.views[0]!, id: clientView, tableId: clients }],
        fields: [...base.fields, name, client, inverse, label],
      },
      new Map([
        [source.tableId, { count: 2, values: (index: number) => ({ [source.numberFieldId]: 420 + index }) }],
        [clients, { count: 1, values: () => ({ [name.id]: 'Forrester Legal Partners' }) }],
      ]),
    );
    const forrester = database.rows(clients).id(0);
    const row = database.rows(source.tableId).get(source.recordId(0))!;
    database.rows(source.tableId).set({ ...row, values: { ...row.values, [client.id]: [forrester] } });
    const session = await openDatabase(source.databaseId, server.deps());
    sessions.push(session);
    const view = session.openView(source.viewId);
    await settle();
    return { server, source, clients, name, forrester, label, session, view };
  }

  it('reads the names, and reloads the rows when a linked record is renamed', async () => {
    const f = await orders();
    expect(f.view.getRow(0)?.values[f.label.id]).toBe('Forrester Legal Partners Order #420');
    expect(f.view.getRow(1)?.values[f.label.id]).toBe(' Order #421');
    const reads = () =>
      f.server.requests.filter((request) => request.path.includes(`/views/${f.source.viewId}/rows`)).length;
    const before = reads();
    f.server.remote(f.source.databaseId, [
      {
        kind: 'record.update',
        tableId: f.clients,
        records: [{ id: f.forrester, values: { [f.name.id]: 'Forrester LLP' } }],
      },
    ]);
    await settle();
    expect(reads()).toBeGreaterThan(before);
    expect(f.view.getRow(0)?.values[f.label.id]).toBe('Forrester LLP Order #420');
  });
});

it.each(['field.created', 'field.updated'] as const)(
  'loads server-computed formula values after %s',
  async (kind) => {
    const f = await setup();
    const total = {
      ...f.formula,
      id: kind === 'field.created' ? newId('field') : f.formula.id,
      ...FieldSpec.parse({
        type: 'formula',
        options: {
          expression: `SUMIFS(${f.tableId}[${f.price.id}], ${f.tableId}[${f.price.id}], ">0")`,
          resultType: 'number',
        },
      }),
    };
    const row = f.database.rows(f.source.tableId).get(f.source.recordId(0))!;
    f.database.rows(f.source.tableId).set({ ...row, values: { ...row.values, [total.id]: 6 } });
    f.server.remoteChange(
      f.source.databaseId,
      kind === 'field.created'
        ? { kind, field: total, views: [] }
        : { kind, field: total, removedChoiceIds: [] },
    );
    await settle();
    expect(f.view.getRow(0)?.values[total.id]).toBe(6);
  },
);

it('refreshes structured formulas after a change to an unlinked table and keeps the server result', async () => {
  const server = new FakeServer();
  const source = server.createDatabase(2);
  const base = server.database(source.databaseId).schema;
  const otherTable = newId('table');
  const amount = {
    ...base.fields[0]!,
    id: newId('field'),
    tableId: otherTable,
    name: 'Amount',
    ...FieldSpec.parse({ type: 'number' }),
  };
  const total = {
    ...base.fields[0]!,
    id: newId('field'),
    name: 'Total',
    ...FieldSpec.parse({
      type: 'formula',
      options: {
        expression: `SUMIFS(${otherTable}[${amount.id}], ${otherTable}[${amount.id}], ">0")`,
        resultType: 'number',
      },
    }),
  };
  const database = server.seed(
    {
      ...base,
      tables: [
        ...base.tables,
        { ...base.tables[0]!, id: otherTable, name: 'Items', primaryFieldId: amount.id },
      ],
      fields: [...base.fields, amount, total],
    },
    new Map([
      [source.tableId, { count: 2, values: () => ({ [total.id]: 5 }) }],
      [otherTable, { count: 1, values: () => ({ [amount.id]: 5 }) }],
    ]),
  );
  const session = await openDatabase(source.databaseId, server.deps());
  sessions.push(session);
  const view = session.openView(source.viewId);
  await settle();
  expect(view.getRow(0)?.values[total.id]).toBe(5);
  const before = server.requests.filter((request) =>
    request.path.includes(`/views/${source.viewId}/rows`),
  ).length;
  const row = database.rows(source.tableId).get(source.recordId(0))!;
  database.rows(source.tableId).set({ ...row, values: { ...row.values, [total.id]: 9 } });
  server.remote(source.databaseId, [
    {
      kind: 'record.update',
      tableId: otherTable,
      records: [{ id: database.rows(otherTable).id(0), values: { [amount.id]: 9 } }],
    },
  ]);
  await settle();
  expect(
    server.requests.filter((request) => request.path.includes(`/views/${source.viewId}/rows`)).length,
  ).toBeGreaterThan(before);
  expect(view.getRow(0)?.values[total.id]).toBe(9);
});
