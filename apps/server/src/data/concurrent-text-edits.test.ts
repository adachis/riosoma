import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Command, DatabaseCreate, newId, type CommandBatchResult } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { loadFields } from './metadata.js';
import { fetchRowsById } from './physical/records.js';

let kit: TestPostgres;
let server: ServerFixture;
let address: string;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'text_edits');
  address = await server.app.listen({ port: 0, host: '127.0.0.1' });
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function fixture(type: 'longText' | 'json' = 'longText', value = 'red green blue') {
  const databaseId = newId('database');
  const tableId = newId('table');
  const fieldId = newId('field');
  const recordId = newId('record');
  const input = DatabaseCreate.parse({
    id: databaseId,
    name: 'Concurrent text',
    table: {
      id: tableId,
      name: 'Records',
      fields: [
        { id: newId('field'), name: 'Name', type: 'text' },
        { id: fieldId, name: 'Notes', type, ...(type === 'longText' ? { options: { richText: true } } : {}) },
      ],
      view: { id: newId('view'), name: 'Grid' },
      records: [{ id: recordId, values: { [fieldId]: value } }],
    },
  });
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: input,
  });
  expect(created.statusCode, created.body).toBe(200);
  const seeded = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'record.update',
          tableId,
          records: [{ id: recordId, values: { [fieldId]: value } }],
        },
      ],
    },
  });
  expect(seeded.json<CommandBatchResult>().results[0]!.status).toBe('applied');
  const member = await server.addMember();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')} (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${member.info.org.id}, 'database', ${databaseId}, 'user', ${member.userId}, 'editor')`,
  );
  async function edit(value: string | null, base: string | null | undefined, who = server.owner) {
    const command = Command.parse({
      id: newId('command'),
      groupId: newId('action'),
      kind: 'record.update',
      tableId,
      records: [
        {
          id: recordId,
          values: { [fieldId]: value },
          ...(base !== undefined ? { baseValues: { [fieldId]: base } } : {}),
        },
      ],
    });
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/commands`,
      headers: who.headers,
      payload: { clientId: newId('client'), commands: [command] },
    });
    expect(response.statusCode, response.body).toBe(200);
    return { command, result: response.json<CommandBatchResult>().results[0]! };
  }
  async function stored() {
    const fields = await loadFields(server.pool, server.schemas, [tableId]);
    return (await fetchRowsById(server.pool, server.schemas.data, tableId, fields, [recordId]))[0]!.values[
      fieldId
    ];
  }
  async function undo(groupId: string, who: SignedIn) {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/undo`,
      headers: who.headers,
      payload: { clientId: newId('client'), commandId: newId('command'), groupId },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: 'applied', skipped: 0 });
  }
  return { databaseId, fieldId, recordId, tableId, member, edit, stored, undo };
}

describe('concurrent text through the command bus', () => {
  it.each(['rest', 'airtable batch', 'airtable single'] as const)(
    'returns Unicode and large merge notices in the body through %s',
    async (api) => {
      for (const middle of ['🌱', 'a'.repeat(20_000)]) {
        const base = `red ${middle} blue`;
        const value = `RED ${middle} BLUE`;
        const f = await fixture('longText', base);
        await f.edit(`RED ${middle} blue`, base);
        const made = await server.app.inject({
          method: 'POST',
          url: '/api/tokens',
          headers: server.owner.headers,
          payload: {
            name: 'Text writes',
            scopes: ['data.records:read', 'data.records:write'],
            databases: [f.databaseId],
          },
        });
        expect(made.statusCode, made.body).toBe(200);
        const record = {
          id: f.recordId,
          fields: { Notes: `red ${middle} BLUE` },
          baseFields: { Notes: base },
        };
        const path =
          api === 'rest'
            ? `/api/v1/tables/${f.tableId}/records`
            : `/v0/${f.databaseId}/${f.tableId}${api === 'airtable single' ? `/${f.recordId}` : ''}`;
        const response = await new Promise<{ status: number; body: string; headers: unknown }>(
          (resolve, reject) => {
            const outgoing = request(
              new URL(path, address),
              {
                method: 'PATCH',
                headers: {
                  authorization: `Bearer ${made.json<{ token: string }>().token}`,
                  'content-type': 'application/json',
                },
              },
              (incoming) => {
                let body = '';
                incoming.setEncoding('utf8');
                incoming.on('data', (chunk: string) => {
                  body += chunk;
                });
                incoming.on('error', reject);
                incoming.on('end', () =>
                  resolve({ status: incoming.statusCode!, body, headers: incoming.headers }),
                );
              },
            );
            outgoing.on('error', reject);
            outgoing.end(JSON.stringify(api === 'airtable single' ? record : { records: [record] }));
          },
        );
        expect(response.status, response.body).toBe(200);
        expect(JSON.parse(response.body)).toMatchObject({
          textMerges: [{ tableId: f.tableId, recordId: f.recordId, fieldId: f.fieldId, value }],
        });
        expect(JSON.stringify(response.headers)).not.toContain(middle);
        expect(await f.stored()).toBe(value);
      }
    },
  );
  it('keeps two sessions’ independent edits, attributes the merged save, and undoes to the other edit', async () => {
    const f = await fixture();
    expect((await f.edit('RED green blue', 'red green blue')).result.status).toBe('applied');
    const second = await f.edit('red green BLUE', 'red green blue', f.member);
    expect(second.result).toMatchObject({
      status: 'applied',
      output: {
        textMerges: [{ fieldId: f.fieldId, value: 'RED green BLUE', updatedBy: server.owner.userId }],
      },
    });
    expect(await f.stored()).toBe('RED green BLUE');
    const history = await query<{
      actor_id: string;
      prev: { records: Array<{ values: Record<string, unknown> }> };
    }>(
      server.pool,
      sql`SELECT actor_id, prev FROM ${ident(server.schemas.app, 'changes')} WHERE database_id = ${f.databaseId} AND seq = ${second.result.seq}`,
    );
    expect(history.rows[0]!.actor_id).toBe(f.member.userId);
    expect(history.rows[0]!.prev.records[0]!.values[f.fieldId]).toBe('RED green blue');
    await f.undo(second.command.groupId, f.member);
    expect(await f.stored()).toBe('RED green blue');
  });
  it('keeps attribution IDs while hiding names a guest cannot read in merge notices', async () => {
    const f = await fixture();
    await f.edit('RED green blue', 'red green blue', f.member);
    const guest = await server.addMember({ name: 'Scoped editor', kind: 'guest' });
    expect(
      (
        await server.app.inject({
          method: 'PUT',
          url: `/api/databases/${f.databaseId}/grants`,
          headers: server.owner.headers,
          payload: { principal: { kind: 'user', id: guest.userId }, role: 'editor' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await server.app.inject({
          method: 'DELETE',
          url: `/api/databases/${f.databaseId}/grants`,
          headers: server.owner.headers,
          payload: { principal: { kind: 'user', id: f.member.userId } },
        })
      ).statusCode,
    ).toBe(200);
    const merged = await f.edit('red green BLUE', 'red green blue', guest);
    expect(merged.result).toMatchObject({
      status: 'applied',
      output: { textMerges: [{ updatedBy: f.member.userId, name: null, value: 'RED green BLUE' }] },
    });
    expect(await f.stored()).toBe('RED green BLUE');
  });

  it('rejects an overlap without changing storage or history, and lets the person choose against the returned value', async () => {
    const f = await fixture();
    await f.edit('red yellow blue', 'red green blue');
    const count = async () =>
      (
        await query<{ count: string }>(
          server.pool,
          sql`SELECT count(*) FROM ${ident(server.schemas.app, 'changes')} WHERE database_id = ${f.databaseId}`,
        )
      ).rows[0]!.count;
    const before = await count();
    const collision = await f.edit('red purple blue', 'red green blue', f.member);
    expect(collision.result).toMatchObject({
      status: 'rejected',
      error: {
        code: 'conflict',
        conflicts: [
          {
            ours: 'red purple blue',
            theirs: 'red yellow blue',
            updatedBy: server.owner.userId,
            proposal: expect.stringContaining('<<<<<<<'),
          },
        ],
      },
    });
    expect(await f.stored()).toBe('red yellow blue');
    expect(await count()).toBe(before);
    expect(
      (await f.edit('red purple blue', collision.result.error!.conflicts![0]!.theirs, f.member)).result
        .status,
    ).toBe('applied');
    expect(await f.stored()).toBe('red purple blue');
  });
  it('merges JSON by lines and rejects overlapping JSON edits', async () => {
    const f = await fixture('json', '{"a":1,"b":2}');
    await f.edit('{"a":3,"b":2}', '{"a":1,"b":2}');
    expect((await f.edit('{"a":1,"b":4}', '{"a":1,"b":2}', f.member)).result.status).toBe('applied');
    expect(await f.stored()).toBe('{"a":3,"b":4}');
    expect((await f.edit('{"a":9,"b":2}', '{"a":1,"b":2}', f.member)).result.status).toBe('rejected');
    expect(await f.stored()).toBe('{"a":3,"b":4}');
  });
  it('retains legacy last-write-wins when no base is supplied', async () => {
    const f = await fixture();
    await f.edit('first', undefined);
    await f.edit('second', undefined, f.member);
    expect(await f.stored()).toBe('second');
  });
  it('merges the surviving cell when a batch repeats a record ID', async () => {
    const f = await fixture();
    await f.edit('RED green blue', 'red green blue');
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${f.databaseId}/commands`,
      headers: f.member.headers,
      payload: {
        clientId: newId('client'),
        commands: [
          {
            id: newId('command'),
            groupId: newId('action'),
            kind: 'record.update',
            tableId: f.tableId,
            records: [
              {
                id: f.recordId,
                values: { [f.fieldId]: 'overwritten draft' },
                baseValues: { [f.fieldId]: 'red green blue' },
              },
              {
                id: f.recordId,
                values: { [f.fieldId]: 'red green BLUE' },
                baseValues: { [f.fieldId]: 'red green blue' },
              },
            ],
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<CommandBatchResult>().results[0]).toMatchObject({
      status: 'applied',
      output: { textMerges: [{ value: 'RED green BLUE' }] },
    });
    expect(await f.stored()).toBe('RED green BLUE');
  });
  it('accepts optional starting values through REST and Airtable and returns conflict details', async () => {
    const f = await fixture();
    const made = await server.app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: server.owner.headers,
      payload: {
        name: 'Text writes',
        scopes: ['data.records:read', 'data.records:write'],
        databases: [f.databaseId],
      },
    });
    expect(made.statusCode, made.body).toBe(200);
    const headers = { authorization: `Bearer ${made.json<{ token: string }>().token}` };
    await f.edit('RED green blue', 'red green blue');
    const rest = await server.app.inject({
      method: 'PATCH',
      url: `/api/v1/tables/${f.tableId}/records`,
      headers,
      payload: {
        records: [
          { id: f.recordId, fields: { Notes: 'red green BLUE' }, baseFields: { Notes: 'red green blue' } },
        ],
      },
    });
    expect(rest.statusCode, rest.body).toBe(200);
    expect(rest.json()).toMatchObject({ textMerges: [{ value: 'RED green BLUE' }] });
    expect(await f.stored()).toBe('RED green BLUE');
    const overlap = await server.app.inject({
      method: 'PATCH',
      url: `/v0/${f.databaseId}/${f.tableId}/${f.recordId}`,
      headers,
      payload: { fields: { Notes: 'red yellow blue' }, baseFields: { Notes: 'red green blue' } },
    });
    // Independent changes to the middle merge through the compatible API as well.
    expect(overlap.statusCode, overlap.body).toBe(200);
    expect(await f.stored()).toBe('RED yellow BLUE');
    const conflict = await server.app.inject({
      method: 'PATCH',
      url: `/v0/${f.databaseId}/${f.tableId}/${f.recordId}`,
      headers,
      payload: { fields: { Notes: 'red purple blue' }, baseFields: { Notes: 'red green blue' } },
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { type: 'TEXT_CONFLICT', conflicts: [{ theirs: 'RED yellow BLUE' }] },
    });
    expect(await f.stored()).toBe('RED yellow BLUE');
  });
});
