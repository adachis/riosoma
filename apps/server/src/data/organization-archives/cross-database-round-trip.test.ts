import { Readable } from 'node:stream';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { newId, type RowsPage } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { applied, inject, schemaOf } from '../permissions/permissions.test-helpers.js';
import { unpack } from './container.js';
import { SCHEMA_VERSION } from './export.js';
import { exportArchive, importArchive, workDir } from './organization-archives.test-support.js';

let kit: TestPostgres;
beforeAll(async () => {
  kit = await startTestPostgres();
}, 120_000);
afterAll(async () => {
  await kit?.stop();
});

async function database(server: ServerFixture, name: string) {
  const id = newId('database'),
    tableId = newId('table'),
    fieldId = newId('field'),
    recordId = newId('record');
  const response = await inject(server, server.owner, 'POST', '/api/databases', {
    id,
    name,
    table: {
      id: tableId,
      name,
      fields: [{ id: fieldId, name: 'Name', type: 'text' }],
      view: { id: newId('view'), name },
      records: [{ id: recordId, values: { [fieldId]: name } }],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return { id, tableId, fieldId, recordId };
}

it.each([true, false])('round trips an organization with an external link (one-way %s)', async (oneWay) => {
  const origin = await startServer(kit, `org_cross_origin_${oneWay}`);
  const target = await startServer(kit, `org_cross_target_${oneWay}`);
  try {
    const projects = await database(origin, 'Projects');
    const contacts = await database(origin, 'Contacts');
    const linkId = newId('field');
    await applied(origin, origin.owner, projects.id, {
      kind: 'field.create',
      tableId: projects.tableId,
      field: {
        id: linkId,
        name: 'Contact',
        type: 'link',
        options: { linkedTableId: contacts.tableId, oneWay },
      },
    });
    await applied(origin, origin.owner, projects.id, {
      kind: 'record.update',
      tableId: projects.tableId,
      records: [{ id: projects.recordId, values: { [linkId]: [contacts.recordId] } }],
    });
    const exported = await exportArchive(origin, {});
    const { directory, summary } = await unpack(Readable.from([exported.bytes]), SCHEMA_VERSION, workDir);
    try {
      expect(summary.counts.links).toBe(1);
    } finally {
      await directory.close();
    }
    const imported = await importArchive(target, exported.bytes);
    const sourceSchema = await schemaOf(
      target,
      target.owner,
      imported.report!.databases.find((db) => db.name === 'Projects')!.id,
    );
    const targetSchema = await schemaOf(
      target,
      target.owner,
      imported.report!.databases.find((db) => db.name === 'Contacts')!.id,
    );
    const sourceRows = await inject(
      target,
      target.owner,
      'GET',
      `/api/views/${sourceSchema.views[0]!.id}/rows`,
    );
    const targetRows = await inject(
      target,
      target.owner,
      'GET',
      `/api/views/${targetSchema.views[0]!.id}/rows`,
    );
    expect(sourceRows.statusCode, sourceRows.body).toBe(200);
    expect(targetRows.statusCode, targetRows.body).toBe(200);
    const field = sourceSchema.fields.find((item) => item.name === 'Contact')!;
    const sourceRow = sourceRows.json<RowsPage>().rows[0]!;
    const targetRow = targetRows.json<RowsPage>().rows[0]!;
    expect(sourceRow.values[field.id]).toEqual([targetRow.id]);
    expect(field.type === 'link' && field.options.linkedTableId).toBe(targetSchema.tables[0]!.id);
    if (!oneWay) {
      const inverse = targetSchema.fields.find((item) => item.type === 'link')!;
      expect(targetRow.values[inverse.id]).toEqual([sourceRow.id]);
    }
  } finally {
    await origin.close();
    await target.close();
  }
});
