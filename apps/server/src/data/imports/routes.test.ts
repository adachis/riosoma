import { request as httpRequest } from 'node:http';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ErrorBody,
  IMPORT_RECORDS_PAGE,
  ImportRecordsPage,
  SPREADSHEET_LIMITS,
  SheetRow,
  SpreadsheetLine,
  newId,
  type CommandBatchResult,
  type DatabaseRole,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { eicar, standIn, unreachableScanner } from '../files/scan-test-support.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'imports');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function workbook(build: (book: ExcelJS.Workbook) => void): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  build(book);
  return Buffer.from(await book.xlsx.writeBuffer());
}

function upload(payload: Buffer, headers: Record<string, string> = server.owner.headers) {
  return server.app.inject({
    method: 'POST',
    url: '/api/imports/spreadsheet',
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    payload,
  });
}

/** The answer's lines, each checked against the contract. */
function lines(body: string): Array<SpreadsheetLine | SheetRow> {
  expect(body.endsWith('\n')).toBe(true);
  return body
    .trimEnd()
    .split('\n')
    .map((text) => {
      const value: unknown = JSON.parse(text);
      return Array.isArray(value) ? SheetRow.parse(value) : SpreadsheetLine.parse(value);
    });
}

async function table() {
  const databaseId = newId('database');
  const tableId = newId('table');
  const nameId = newId('field');
  const totalId = newId('field');
  const viewId = newId('view');
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'Imports',
      table: {
        id: tableId,
        name: 'People',
        fields: [
          { id: nameId, name: 'Name', type: 'text' },
          { id: totalId, name: 'Total', type: 'number' },
        ],
        view: { id: viewId, name: 'Grid' },
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return { databaseId, tableId, nameId, totalId, viewId };
}

async function addRecords(context: Awaited<ReturnType<typeof table>>, count: number) {
  const ids: string[] = [];
  for (let start = 0; start < count; start += 1_000) {
    const records = Array.from({ length: Math.min(1_000, count - start) }, (_, index) => {
      const id = newId('record');
      ids.push(id);
      return {
        id,
        values: { [context.nameId]: `Person ${start + index}`, [context.totalId]: start + index },
      };
    });
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${context.databaseId}/commands`,
      headers: server.owner.headers,
      payload: {
        clientId: newId('client'),
        commands: [
          {
            id: newId('command'),
            groupId: newId('action'),
            kind: 'record.create',
            tableId: context.tableId,
            records,
          },
        ],
      },
    });
    expect(response.json<CommandBatchResult>().results[0]?.status, response.body).toBe('applied');
  }
  return ids;
}

function records(tableId: string, body: unknown, who: SignedIn = server.owner) {
  return server.app.inject({
    method: 'POST',
    url: `/api/tables/${tableId}/import/records`,
    headers: who.headers,
    payload: body as Record<string, unknown>,
  });
}

async function grant(databaseId: string, who: SignedIn, role: DatabaseRole) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${who.info.org.id}, 'database', ${databaseId}, 'user', ${who.userId}, ${role})`,
  );
}

describe('uploading a spreadsheet', () => {
  it('checks files before parsing, fails closed during an outage, and still works with the scanner off', async () => {
    const scanner = await standIn();
    const orgId = server.owner.info.org.id;
    const set = (enabled: boolean, address: string) =>
      query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'orgs')}
      SET settings = jsonb_set(settings, '{fileScanner}', ${JSON.stringify({ enabled, address, oversizedPolicy: 'quarantine' })}::jsonb)
      WHERE id = ${orgId}`,
      );
    const clean = await workbook((book) => book.addWorksheet('Notes').addRow(['Synthetic note']));
    // A ZIP comment keeps the harmless test string visible to the scanner stand-in and the workbook readable.
    const infected = Buffer.concat([clean, eicar]);
    infected.writeUInt16LE(eicar.length, clean.length - 2);
    server.config.clamavApprovedUrls = [scanner.url];
    try {
      await set(true, scanner.url);
      expect((await upload(clean)).statusCode).toBe(200);
      const refused = await upload(infected);
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.json().error.messageKey).toBe('files.checks.infected');
      expect(scanner.received.at(-1)).toEqual(infected);
      const missing = await unreachableScanner();
      server.config.clamavApprovedUrls.push(missing);
      await set(true, missing);
      const outage = await upload(clean);
      expect(outage.statusCode, outage.body).toBe(503);
      expect(outage.json().error.messageKey).toBe('files.checks.scannerUnavailable');
      await set(false, missing);
      expect((await upload(infected)).statusCode).toBe(200);
    } finally {
      await set(false, scanner.url);
      delete server.config.clamavApprovedUrls;
      await scanner.close();
    }
  });
  it('answers each sheet and its rows, one JSON value per line', async () => {
    const bytes = await workbook((book) => {
      const people = book.addWorksheet('People');
      people.addRows([
        ['Name', 'Born'],
        ['Ada', new Date(Date.UTC(1990, 0, 2))],
      ]);
      book.addWorksheet('Totals').addRows([['Total'], [12.5], [{ formula: 'A2*2', result: 25 }]]);
    });
    const response = await upload(bytes);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    expect(lines(response.body)).toEqual([
      { sheet: 'People', position: 0 },
      [1, 'Name', 'Born'],
      [2, 'Ada', { date: '1990-01-02' }],
      { rows: 2, total: 2 },
      { sheet: 'Totals', position: 1 },
      [1, 'Total'],
      [2, 12.5],
      [3, 25],
      { rows: 3, total: 3 },
      { done: true },
    ]);
  });

  it('reads back a workbook that downloading a view wrote', async () => {
    const context = await table();
    await addRecords(context, 3);
    const exported = await server.app.inject({
      url: `/api/views/${context.viewId}/export?format=xlsx&timeZone=UTC&locale=en-US`,
      headers: server.owner.headers,
    });
    expect(exported.statusCode, exported.body).toBe(200);
    const response = await upload(exported.rawPayload);
    expect(response.statusCode, response.body).toBe(200);
    expect(lines(response.body)).toEqual([
      { sheet: 'Grid', position: 0 },
      [1, 'Name', 'Total'],
      [2, 'Person 0', 0],
      [3, 'Person 1', 1],
      [4, 'Person 2', 2],
      { rows: 4, total: 4 },
      { done: true },
    ]);
  });

  it('refuses a file that isn’t a spreadsheet with a message the person can act on', async () => {
    const text = await upload(Buffer.from('Name,Total\nAda,12\n'));
    expect(text.statusCode).toBe(422);
    expect(ErrorBody.parse(text.json()).error).toMatchObject({
      messageKey: 'import.spreadsheet.notSpreadsheet',
      userFault: true,
    });
    const legacy = await upload(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(508)]));
    expect(legacy.json<ErrorBody>().error.messageKey).toBe('import.spreadsheet.legacy');
  });

  it('checks a workbook against its upload name and stated type', async () => {
    const bytes = await workbook((book) => book.addWorksheet('Notes').addRow(['Synthetic note']));
    const named = await upload(bytes, { ...server.owner.headers, 'x-file-name': 'note.pdf' });
    expect(named.statusCode, named.body).toBe(422);
    expect(named.json().error.messageKey).toBe('files.checks.typeMismatch');
    const stated = await server.app.inject({
      method: 'POST',
      url: '/api/imports/spreadsheet',
      headers: { ...server.owner.headers, 'content-type': 'image/png' },
      payload: bytes,
    });
    expect(stated.statusCode, stated.body).toBe(422);
    expect(stated.json().error.messageKey).toBe('files.checks.typeMismatch');
  });

  it('refuses a workbook past the size limit', async () => {
    const response = await upload(Buffer.alloc(SPREADSHEET_LIMITS.uploadBytes + 1, 0x50));
    expect(response.statusCode).toBe(413);
    expect(response.json<ErrorBody>().error).toMatchObject({
      messageKey: 'import.spreadsheet.tooLarge',
      params: { megabytes: 50 },
    });
  });

  it('reads two workbooks at a time and asks another to wait', async () => {
    const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
    // Two uploads still arriving hold both places.  A first piece bigger than the connection can
    // buffer only drains once the server is reading it, so each is known to hold its place.
    const stalled = await Promise.all(
      [0, 1].map(async () => {
        const request = httpRequest(`${address}/api/imports/spreadsheet`, {
          method: 'POST',
          headers: { ...server.owner.headers, 'content-type': 'application/octet-stream' },
        });
        const status = new Promise<number>((resolve, reject) => {
          request.on('response', (response) => {
            response.resume();
            response.on('end', () => resolve(response.statusCode ?? 0));
          });
          request.on('error', reject);
        });
        if (!request.write(Buffer.alloc(20 * 1024 * 1024)))
          await new Promise((resolve) => request.once('drain', resolve));
        return { request, status };
      }),
    );
    const bytes = await workbook((book) => {
      book.addWorksheet('People').addRow(['Ada']);
    });
    const third = await upload(bytes);
    expect(third.statusCode).toBe(429);
    expect(third.json<ErrorBody>().error.messageKey).toBe('import.spreadsheet.busy');
    // Once they've arrived, however they end, their places are free again.
    for (const { request } of stalled) request.end();
    expect(await Promise.all(stalled.map(({ status }) => status))).toEqual([422, 422]);
    expect((await upload(bytes)).statusCode).toBe(200);
  });

  it('needs a signed-in person and the page’s own token', async () => {
    const bytes = await workbook((book) => {
      book.addWorksheet('People').addRow(['Ada']);
    });
    expect((await upload(bytes, {})).statusCode).toBe(401);
    expect((await upload(bytes, { ...server.owner.headers, 'x-csrf-token': 'wrong' })).statusCode).toBe(403);
  });
});

describe('reading records to match an import against', () => {
  it('pages through every record in the order they were added', async () => {
    const context = await table();
    const ids = await addRecords(context, IMPORT_RECORDS_PAGE + 1);
    const first = await records(context.tableId, { fieldIds: [context.nameId] });
    expect(first.statusCode, first.body).toBe(200);
    const page = ImportRecordsPage.parse(first.json());
    expect(page.records).toHaveLength(IMPORT_RECORDS_PAGE);
    expect(page.records[0]).toEqual({ id: ids[0], values: { [context.nameId]: 'Person 0' } });
    expect(page.next).toEqual(expect.any(String));
    const second = ImportRecordsPage.parse(
      (
        await records(context.tableId, { fieldIds: [context.nameId, context.totalId], after: page.next })
      ).json(),
    );
    expect(second).toEqual({
      records: [
        {
          id: ids.at(-1),
          values: {
            [context.nameId]: `Person ${IMPORT_RECORDS_PAGE}`,
            [context.totalId]: IMPORT_RECORDS_PAGE,
          },
        },
      ],
      next: null,
    });
  });

  it('answers just the records named, leaving out deleted ones', async () => {
    const context = await table();
    const ids = await addRecords(context, 3);
    const trashed = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${context.databaseId}/commands`,
      headers: server.owner.headers,
      payload: {
        clientId: newId('client'),
        commands: [
          {
            id: newId('command'),
            groupId: newId('action'),
            kind: 'record.trash',
            tableId: context.tableId,
            recordIds: [ids[1]],
          },
        ],
      },
    });
    expect(trashed.statusCode).toBe(200);
    const response = await records(context.tableId, { fieldIds: [context.totalId], recordIds: ids });
    expect(ImportRecordsPage.parse(response.json())).toEqual({
      records: [
        { id: ids[0], values: { [context.totalId]: 0 } },
        { id: ids[2], values: { [context.totalId]: 2 } },
      ],
      next: null,
    });
  });

  it('refuses unknown fields, and people who can’t edit the table', async () => {
    const context = await table();
    expect((await records(context.tableId, { fieldIds: [newId('field')] })).statusCode).toBe(404);
    expect((await records(context.tableId, { fieldIds: [] })).statusCode).toBe(422);
    const member = await server.addMember();
    expect((await records(context.tableId, { fieldIds: [context.nameId] }, member)).statusCode).toBe(404);
    await grant(context.databaseId, member, 'reader');
    const reader = await records(context.tableId, { fieldIds: [context.nameId] }, member);
    expect(reader.statusCode).toBe(403);
    expect(reader.json<ErrorBody>().error.messageKey).toBe('data.access.denied');
  });
});
