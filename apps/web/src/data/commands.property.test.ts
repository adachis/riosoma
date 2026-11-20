// @vitest-environment node
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type DatabaseSchema, type RowData, type UndoResult } from '@riosoma/contracts';
import {
  createPropertyDatabase,
  dropPropertyDatabase,
  propertyCommand,
  propertyHistory,
  propertyRequest,
  propertySnapshot,
  propertyUntil,
  PropertySocket,
  startPropertyServer,
} from '../../../server/dist/test/property-fixture.js';
import { openDatabase } from './session';
import { MemoryOutboxStore } from './outbox';
import type { DatabaseSession, CommandInput, ViewRows } from './types';
import type { Clock } from './deps';

const runs = Number(process.env.RIOSOMA_PROPERTY_RUNS ?? 8);
if (!Number.isSafeInteger(runs) || runs < 1)
  throw new Error('RIOSOMA_PROPERTY_RUNS must be a positive integer');
const replay = {
  ...(process.env.RIOSOMA_PROPERTY_SEED ? { seed: Number(process.env.RIOSOMA_PROPERTY_SEED) } : {}),
  ...(process.env.RIOSOMA_PROPERTY_PATH ? { path: process.env.RIOSOMA_PROPERTY_PATH } : {}),
};
let fixture: Awaited<ReturnType<typeof startPropertyServer>>;
beforeAll(async () => {
  fixture = await startPropertyServer();
}, 60_000);
afterAll(async () => {
  await fixture?.close();
});

const kinds = [
  'create',
  'update',
  'delete',
  'move',
  'link',
  'field.create',
  'rename',
  'convert',
  'field.trash',
  'field.restore',
  'trash',
  'restore',
  'view.update',
] as const;
const step = fc.record({
  kind: fc.constantFrom(...kinds),
  target: fc.nat(20),
  value: fc.integer({ min: -100, max: 100 }),
  groupWithPrevious: fc.boolean(),
});

describe('command properties', () => {
  it(
    'restores every prior state when undoing a generated sequence, and every after state on redo',
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(step, { maxLength: 14 }), async (steps) => {
          const { server } = fixture;
          const { input, linkedTable, linkId } = await createPropertyDatabase(server);
          try {
            const tableId = input.table.id,
              primary = input.table.fields[0]!.id;
            const live = input.table.records.slice(0, 3).map(({ id }) => id);
            const trashed = [input.table.records[3]!.id];
            const activeFields = [input.table.fields[1]!.id];
            const trashedFields = [input.table.fields[2]!.id];
            const types = new Map<string, 'text' | 'number'>(
              input.table.fields.slice(1).map(({ id }) => [id, 'text']),
            );
            await propertyCommand(server, input.id, { kind: 'record.trash', tableId, recordIds: trashed });
            await propertyCommand(server, input.id, { kind: 'field.trash', fieldId: trashedFields[0] });
            const checkpoints = [await propertySnapshot(server, input.id)];
            const groups: string[] = [];
            for (const [index, operation] of steps.entries()) {
              const { kind, target, value } = operation;
              const recordId = live[target % live.length]!;
              const fieldId = activeFields[target % activeFields.length];
              let command: Record<string, unknown> | undefined;
              switch (kind) {
                case 'create': {
                  const id = newId('record');
                  command = {
                    kind: 'record.create',
                    tableId,
                    records: [{ id, values: { [primary]: String(value) } }],
                  };
                  live.push(id);
                  break;
                }
                case 'update':
                  command = {
                    kind: 'record.update',
                    tableId,
                    records: [{ id: recordId, values: { [primary]: String(value) } }],
                  };
                  break;
                case 'delete':
                case 'trash':
                  if (live.length > 2) {
                    command = { kind: 'record.trash', tableId, recordIds: [recordId] };
                    live.splice(live.indexOf(recordId), 1);
                    trashed.push(recordId);
                  }
                  break;
                case 'restore':
                  if (trashed.length) {
                    const id = trashed.splice(target % trashed.length, 1)[0]!;
                    command = { kind: 'record.restore', tableId, recordIds: [id] };
                    live.push(id);
                  }
                  break;
                case 'move':
                  command = {
                    kind: 'record.move',
                    tableId,
                    viewId: input.table.view.id,
                    recordIds: [recordId],
                    place:
                      value < 0
                        ? { before: live[(target + 1) % live.length] }
                        : { after: live[(target + 1) % live.length] },
                  };
                  break;
                case 'link':
                  command = {
                    kind: 'record.update',
                    tableId,
                    records: [
                      {
                        id: recordId,
                        values: {
                          [linkId]: linkedTable.records
                            .filter((_, index) => target & (1 << index))
                            .map(({ id }) => id)
                            .reverse(),
                        },
                      },
                    ],
                  };
                  break;
                case 'field.create': {
                  const id = newId('field');
                  command = {
                    kind,
                    tableId,
                    field: { id, name: `Created ${index}`, type: 'text' },
                    placement: { viewId: input.table.view.id, index: target % 4 },
                  };
                  activeFields.push(id);
                  types.set(id, 'text');
                  break;
                }
                case 'rename':
                  if (fieldId) command = { kind: 'field.update', fieldId, name: `Renamed ${index} ${value}` };
                  break;
                case 'convert':
                  if (fieldId) {
                    const type = types.get(fieldId) === 'text' ? 'number' : 'text';
                    command = { kind: 'field.convert', fieldId, to: { type } };
                    types.set(fieldId, type);
                  }
                  break;
                case 'field.trash':
                  if (fieldId) {
                    command = { kind, fieldId };
                    activeFields.splice(activeFields.indexOf(fieldId), 1);
                    trashedFields.push(fieldId);
                  }
                  break;
                case 'field.restore':
                  if (trashedFields.length) {
                    const id = trashedFields.splice(target % trashedFields.length, 1)[0]!;
                    command = { kind, fieldId: id };
                    activeFields.push(id);
                  }
                  break;
                case 'view.update':
                  command = {
                    kind,
                    viewId: input.table.view.id,
                    name: `View ${value}`,
                    config: {
                      columnWidths: { [primary]: 100 + target },
                      rowHeight: value < 0 ? 'tall' : 'short',
                    },
                  };
                  break;
              }
              // State-dependent commands have the same preconditions after an array shrinks.
              if (!command) continue;
              const previousGroup = operation.groupWithPrevious ? groups.at(-1) : undefined;
              const applied = await propertyCommand(server, input.id, {
                ...command,
                groupId: previousGroup ?? newId('action'),
              });
              const snapshot = await propertySnapshot(server, input.id);
              if (previousGroup) checkpoints[checkpoints.length - 1] = snapshot;
              else {
                groups.push(applied.groupId);
                checkpoints.push(snapshot);
              }
            }
            const originalHistory = await propertyHistory(server, input.id);
            // Only undo and redo change history here.  Carry each observed result into the next
            // comparison instead of reading the same state again between consecutive requests.
            let history = originalHistory;
            for (const direction of ['undo', 'redo'] as const) {
              const ordered = direction === 'undo' ? [...groups.keys()].reverse() : [...groups.keys()];
              for (const index of ordered) {
                const groupId = groups[index]!;
                const beforeHistory = history;
                const result = await propertyRequest<UndoResult>(
                  server,
                  `/api/databases/${input.id}/${direction}`,
                  {
                    method: 'POST',
                    body: { clientId: newId('client'), commandId: newId('command'), groupId },
                  },
                );
                expect(['applied', 'nothing']).toContain(result.status);
                expect(result).toMatchObject({
                  skipped: 0,
                  state: direction === 'undo' ? 'undone' : 'done',
                });
                const expected = checkpoints[index + (direction === 'redo' ? 1 : 0)]!;
                expect((await propertySnapshot(server, input.id, expected.identity)).state).toEqual(
                  expected.state,
                );
                history = await propertyHistory(server, input.id);
                expect(history.changes.slice(0, beforeHistory.changes.length)).toEqual(beforeHistory.changes);
                expect(
                  history.records.filter(
                    (entry) => Number(entry.seq) <= Number(beforeHistory.changes.at(-1)!.seq),
                  ),
                ).toEqual(beforeHistory.records);
                const added = history.changes.slice(beforeHistory.changes.length);
                expect(added.length).toBeGreaterThan(0);
                expect(
                  added.every(
                    (entry) =>
                      entry.group_id === groupId &&
                      entry.undo_of === (direction === 'undo' ? groupId : null) &&
                      entry.redo_of === (direction === 'redo' ? groupId : null),
                  ),
                ).toBe(true);
                expect(history.groups.find((entry) => entry.group_id === groupId)?.state).toBe(
                  direction === 'undo' ? 'undone' : 'done',
                );
              }
            }
            const redoneHistory = history;
            expect(redoneHistory.changes.slice(0, originalHistory.changes.length)).toEqual(
              originalHistory.changes,
            );
            expect(redoneHistory.groups).toEqual(originalHistory.groups);
          } finally {
            await dropPropertyDatabase(server, input.id);
          }
        }),
        {
          numRuns: runs,
          ...replay,
          examples: [[kinds.map((kind) => ({ kind, target: 0, value: -1, groupWithPrevious: false }))]],
        },
      );
    },
    Math.max(60_000, runs * 5_000),
  );

  it(
    'converges two or three clients with concurrent writes, shuffled echoes, duplicates, and reconnects',
    async () => {
      const round = fc.record({
        target: fc.nat(2),
        value: fc.integer({ min: -100, max: 100 }),
        schema: fc.boolean(),
        delivery: fc.array(fc.nat(100), { minLength: 3, maxLength: 3 }),
        reconnect: fc.integer({ min: -1, max: 2 }),
      });
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 3 }),
          fc.array(round, { minLength: 1, maxLength: 6 }),
          async (count, rounds) => {
            const { server } = fixture;
            const { input } = await createPropertyDatabase(server);
            const sessions: DatabaseSession[] = [],
              sockets: PropertySocket[][] = [];
            const views: ViewRows[] = [];
            let requestFailure: unknown;
            const clock: Clock = {
              now: () => Date.now(),
              random: () => 0,
              setTimeout: (callback, ms) => setTimeout(callback, ms),
              clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
            };
            try {
              for (let index = 0; index < count; index++) {
                sockets.push([]);
                const session = await openDatabase(input.id, {
                  http: async <T>(url: string, options = {}) => {
                    try {
                      return await propertyRequest<T>(server, url, options);
                    } catch (error) {
                      requestFailure = error;
                      throw error;
                    }
                  },
                  webSocketFactory: () => {
                    const socket = new PropertySocket(server);
                    sockets[index]!.push(socket);
                    return socket;
                  },
                  clock,
                  outbox: new MemoryOutboxStore(),
                  clientId: newId('client'),
                  userId: server.owner.userId,
                  csrfToken: () => server.owner.info.csrfToken,
                });
                sessions.push(session);
                const view = session.openView(input.table.view.id);
                views.push(view);
                view.ensureRows(0, 4);
                await propertyUntil(
                  () =>
                    !view.loading() &&
                    input.table.records.every((record) => session.cachedRecord(input.table.id, record.id)) &&
                    sockets[index]!.at(-1)!.received.some((message) => message.type === 'caughtUp'),
                );
              }
              for (const [roundIndex, operation] of rounds.entries()) {
                for (const clientSockets of sockets) clientSockets.at(-1)!.held = true;
                const actions = sessions.map((session, index) => {
                  const command: CommandInput = operation.schema
                    ? {
                        kind: 'field.update',
                        fieldId: input.table.fields[1]!.id,
                        name: `Field ${roundIndex} ${index} ${operation.value}`,
                      }
                    : {
                        kind: 'record.update',
                        tableId: input.table.id,
                        records: [
                          {
                            id: input.table.records[operation.target]!.id,
                            values: {
                              [input.table.fields[0]!.id]: `${roundIndex}:${index}:${operation.value}`,
                            },
                          },
                        ],
                      };
                  return session.run([command]).done;
                });
                let results: Array<{ applied: number; rejected: number }> | undefined;
                void Promise.all(actions).then(
                  (answers) => {
                    results = answers;
                  },
                  (error) => {
                    requestFailure = error;
                  },
                );
                await propertyUntil(() => {
                  if (requestFailure) throw requestFailure;
                  return results !== undefined;
                });
                expect(results).toEqual(sessions.map(() => ({ applied: 1, rejected: 0 })));
                const schema = await propertyRequest<DatabaseSchema>(
                  server,
                  `/api/databases/${input.id}/schema`,
                );
                await propertyUntil(() =>
                  sockets.every((clientSockets) =>
                    clientSockets
                      .at(-1)!
                      .received.some(
                        (message) => message.type === 'change' && message.change.seq === schema.seq,
                      ),
                  ),
                );
                for (const [index, clientSockets] of sockets.entries()) {
                  const socket = clientSockets.at(-1)!;
                  if (index === operation.reconnect) {
                    socket.close();
                    // A gap remains while this client reconnects; its subscription must replay it.
                    await propertyUntil(() => clientSockets.length > 1 && clientSockets.at(-1) !== socket);
                    continue;
                  }
                  const pending = socket.pending.splice(0);
                  const key = operation.delivery[index]!;
                  pending.sort((a, b) => {
                    const rank = (message: typeof a) =>
                      message.type === 'change' ? (message.change.seq * (key + 1)) % 7 : -1;
                    return rank(a) - rank(b);
                  });
                  for (const message of pending) {
                    socket.deliver(message);
                    socket.deliver(message);
                  }
                  socket.held = false;
                  for (const message of socket.pending.splice(0)) socket.deliver(message);
                }
                await propertyUntil(() =>
                  sessions.every(
                    (session, index) =>
                      session.getSchema().seq === schema.seq &&
                      session.saveState().status === 'saved' &&
                      !views[index]!.loading() &&
                      input.table.records.every((record) => session.cachedRecord(input.table.id, record.id)),
                  ),
                );
                for (const session of sessions) {
                  for (const table of schema.tables) {
                    expect(session.getSchema().fields.get(table.id)).toEqual(
                      schema.fields.filter((field) => field.tableId === table.id),
                    );
                    expect(session.getSchema().views.get(table.id)).toEqual(
                      schema.views.filter((view) => view.tableId === table.id),
                    );
                  }
                  for (const record of input.table.records) {
                    const expected = await propertyRequest<RowData>(
                      server,
                      `/api/tables/${input.table.id}/records/${record.id}`,
                    );
                    expect(session.cachedRecord(input.table.id, record.id)?.values).toEqual(expected.values);
                  }
                }
              }
            } finally {
              for (const session of sessions) session.close();
              for (const clientSockets of sockets) for (const socket of clientSockets) socket.close();
              await dropPropertyDatabase(server, input.id);
            }
          },
        ),
        {
          numRuns: runs,
          ...replay,
          examples: [
            [2, [{ target: 0, value: 0, schema: false, delivery: [0, 1, 2], reconnect: 0 }]],
            [3, [{ target: 0, value: 0, schema: true, delivery: [2, 1, 0], reconnect: 2 }]],
          ],
        },
      );
    },
    Math.max(120_000, runs * 20_000),
  );
});
