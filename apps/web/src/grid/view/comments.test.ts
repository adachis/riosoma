import { waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { newId, type CommentsPage } from '@riosoma/contracts';
import { FakeServer } from '../../data/testing';
import { settle } from '../../data/testing/relational';
import { openGrid } from '../test-support';

const dispose: Array<() => void> = [];
afterEach(() => {
  for (const close of dispose.splice(0)) close();
  vi.restoreAllMocks();
});

it('retries a failed corner mark read on a later redraw', async () => {
  const server = new FakeServer();
  const fixture = server.createDatabase(1);
  const app = await openGrid(server, fixture);
  dispose.push(app.close);
  const row = app.rows.getRow(0)!;
  const column = app.controller.columns()[0]!;
  const read = vi
    .spyOn(app.session, 'cellComments')
    .mockRejectedValueOnce(new Error('Connection interrupted'))
    .mockResolvedValue({
      comments: [
        {
          id: newId('comment'),
          tableId: fixture.tableId,
          recordId: row.id,
          fieldId: column.id,
          authorId: server.userId,
          body: 'Cell note',
          mentions: [],
          createdAt: new Date().toISOString(),
          editedAt: null,
        },
      ],
    });
  expect(app.controller.host.cellComment!(row, column)).toBeNull();
  await settle();
  expect(read).toHaveBeenCalledOnce();
  expect(app.controller.host.cellComment!(row, column)).toBeNull();
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(app.controller.host.cellComment!(row, column)).not.toBeNull());
  expect(read).toHaveBeenCalledTimes(2);
});

it('shares pending reads and retains comment changes arriving before they finish', async () => {
  const server = new FakeServer();
  const fixture = server.createDatabase(1);
  const app = await openGrid(server, fixture);
  dispose.push(app.close);
  const row = app.rows.getRow(0)!;
  const column = app.controller.columns()[0]!;
  let finish!: (page: CommentsPage) => void;
  const read = vi.spyOn(app.session, 'cellComments').mockImplementation(
    () =>
      new Promise<CommentsPage>((resolve) => {
        finish = resolve;
      }),
  );
  expect(app.controller.host.cellComment!(row, column)).toBeNull();
  await settle();
  expect(app.controller.host.cellComment!(row, column)).toBeNull();
  await settle();
  expect(read).toHaveBeenCalledOnce();
  server.remoteChange(fixture.databaseId, {
    kind: 'comment.created',
    comment: {
      id: newId('comment'),
      tableId: fixture.tableId,
      recordId: row.id,
      fieldId: column.id,
      authorId: server.userId,
      body: 'Just arrived',
      mentions: [],
      createdAt: new Date().toISOString(),
      editedAt: null,
    },
  });
  await settle();
  finish({ comments: [] });
  await settle();
  expect(app.controller.host.cellComment!(row, column)).not.toBeNull();
  expect(read).toHaveBeenCalledOnce();
});
