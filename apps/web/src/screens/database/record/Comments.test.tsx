import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseRole, RecordComment } from '@riosoma/contracts';
import { openDatabase } from '../../../data';
import type { DatabaseSession } from '../../../data';
import { FakeServer } from '../../../data/testing';
import { settle } from '../../../data/testing/relational';
import { CommentsPanel } from './Comments';

const sessions: DatabaseSession[] = [];
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  for (const session of sessions.splice(0)) session.close();
});

const MINUTE = 60_000;
/** Stands in for the signed-in person, whose ID only the server knows. */
const ME = 'me';
/** Two other people: one a comment is written about, one to pick out of a longer offer. */
const SAM = 'usr00000000000002';
const SANA = 'usr00000000000003';
const GONE = 'usr99999999999999';
/** The composer's own name; a matcher collapses its two spaces, so the text is checked directly. */
const BOX = /Add a comment/;
const PLACEHOLDER = 'Add a comment.  Type @ to mention someone.';

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * MINUTE).toISOString();
}

function comment(overrides: Partial<RecordComment> = {}): RecordComment {
  return {
    id: 'cmt00000000000001',
    tableId: 'tbl00000000000001',
    recordId: 'rec00000000000001',
    authorId: SAM,
    body: 'A comment',
    mentions: [],
    createdAt: ago(60),
    editedAt: null,
    ...overrides,
  };
}

interface Mounted {
  server: FakeServer;
  session: DatabaseSession;
  databaseId: string;
  tableId: string;
  recordId: string;
  /** The composer's text area; null for a reader, who has no composer. */
  box: HTMLTextAreaElement;
  /** What the server holds, which is what a thread settles into. */
  stored: () => RecordComment[];
}

async function mount(
  options: { role?: DatabaseRole; comments?: RecordComment[]; cell?: boolean; failRead?: boolean } = {},
): Promise<Mounted> {
  const server = new FakeServer();
  const fixture = server.createDatabase(3);
  const database = server.database(fixture.databaseId);
  database.schema.database.role = options.role ?? 'owner';
  database.schema.collaborators = [
    { id: server.userId, name: 'Alex Rivera', email: 'alex@example.test' },
    { id: SAM, name: 'Sam Lee', email: 'sam@example.test' },
    { id: SANA, name: 'Sana Ali', email: 'sana@example.test' },
  ];
  const recordId = fixture.recordId(0);
  if (options.cell) window.history.replaceState(null, '', `/?cellField=${database.schema.fields[0]!.id}`);
  database.comments = (options.comments ?? []).map((item) => ({
    ...item,
    tableId: fixture.tableId,
    recordId,
    authorId: item.authorId === ME ? server.userId : item.authorId,
  }));
  const session = await openDatabase(fixture.databaseId, server.deps());
  sessions.push(session);
  await settle();
  if (options.failRead) vi.spyOn(session, 'comments').mockRejectedValueOnce(new Error('disconnected'));
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  render(
    <I18nProvider i18n={i18n}>
      <CommentsPanel session={session} tableId={fixture.tableId} recordId={recordId} />
    </I18nProvider>,
  );
  // The thread is drawn once the panel's own read has landed.
  await waitFor(() =>
    expect(
      options.failRead
        ? screen.queryByRole('alert')
        : (screen.queryByRole('list') ?? screen.queryByText('No comments yet.')),
    ).not.toBeNull(),
  );
  const box = screen.queryByRole('textbox', { name: BOX }) as HTMLTextAreaElement | null;
  return {
    server,
    session,
    databaseId: fixture.databaseId,
    tableId: fixture.tableId,
    recordId,
    box: box!,
    stored: () => server.database(fixture.databaseId).comments,
  };
}

describe('reading a thread', () => {
  it.each(['updated', 'deleted', 'moved'] as const)(
    'replays a live comment.%s over a slow retry snapshot',
    async (kind) => {
      const { server, session, databaseId, tableId, recordId, stored } = await mount({
        comments: [comment({ body: 'Original comment' })],
        failRead: true,
      });
      const original = stored()[0]!;
      let release!: (page: { comments: RecordComment[] }) => void;
      const pending = new Promise<{ comments: RecordComment[] }>((resolve) => {
        release = resolve;
      });
      const read = vi.spyOn(session, 'comments').mockReturnValueOnce(pending);
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      await act(async () => {
        if (kind === 'updated')
          server.remoteChange(databaseId, {
            kind: 'comment.updated',
            comment: { ...original, body: 'Live edit', editedAt: ago(1) },
          });
        else if (kind === 'deleted')
          server.remoteChange(databaseId, {
            kind: 'comment.deleted',
            tableId,
            recordId,
            commentId: original.id,
          });
        else
          server.remoteChange(databaseId, {
            kind: 'comment.moved',
            tableId,
            comments: [{ ...original, recordId: 'rec00000000000009' }],
            from: { [original.id]: recordId },
          });
        await settle();
      });
      if (kind === 'updated') expect(screen.getByText('Live edit')).toBeTruthy();
      await act(async () => {
        release({ comments: [original] });
        await settle();
      });
      expect(screen.queryByText('Original comment')).toBeNull();
      if (kind === 'updated') expect(screen.getByText('Live edit')).toBeTruthy();
      else expect(screen.getByText('No comments yet.')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    },
  );

  it('hides cached cell comments when their field leaves the visible schema', async () => {
    const { server, session, databaseId, tableId, recordId } = await mount({
      comments: [comment({ body: 'Record note' })],
    });
    const field = session.getSchema().fields.get(tableId)![1]!;
    await act(async () => {
      server.remoteChange(databaseId, {
        kind: 'comment.created',
        comment: comment({
          id: 'cmt00000000000009',
          tableId,
          recordId,
          fieldId: field.id,
          body: 'Private cell note',
        }),
      });
    });
    expect(await screen.findByText('Private cell note')).toBeTruthy();
    await act(async () => {
      server.remoteChange(databaseId, { kind: 'field.trashed', tableId, fieldId: field.id });
    });
    expect(session.getSchema().fieldById.has(field.id)).toBe(false);
    expect(screen.queryByText('Private cell note')).toBeNull();
    expect(screen.getByText('Record note')).toBeTruthy();
    await act(async () => {
      server.remoteChange(databaseId, { kind: 'field.restored', field });
    });
    expect(await screen.findByText('Private cell note')).toBeTruthy();
  });

  it('says when there is nothing to read yet', async () => {
    await mount();
    expect(screen.getByText('No comments yet.')).toBeTruthy();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('shows the thread oldest first, with each author, avatar, and time', async () => {
    const first = ago(120);
    const second = ago(10);
    await mount({
      comments: [
        comment({ id: 'cmt00000000000002', body: 'Second', createdAt: second }),
        comment({ id: 'cmt00000000000001', body: 'First', createdAt: first }),
      ],
    });
    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => within(item).getByText(/First|Second/).textContent)).toEqual([
      'First',
      'Second',
    ]);
    expect(within(items[0]!).getByRole('img', { name: 'SL: Sam Lee' })).toBeTruthy();
    expect(items[0]!.textContent).toContain('2 hours ago');
    expect(items[1]!.textContent).toContain('10 minutes ago');
    expect(items[1]!.querySelector('time')?.getAttribute('datetime')).toBe(second);
  });

  it('marks an edited comment and shows when it changed', async () => {
    const edited = ago(5);
    await mount({ comments: [comment({ body: 'Corrected', createdAt: ago(180), editedAt: edited })] });
    const item = screen.getByRole('listitem');
    expect(item.textContent).toContain('edited');
    expect(item.textContent).toContain('5 minutes ago');
    expect(item.querySelector('time')?.getAttribute('datetime')).toBe(edited);
  });

  it('shows a mention as the person’s current name', async () => {
    await mount({ comments: [comment({ body: `Thanks @[Old Name](${SAM}) and @[Left](${GONE})` })] });
    expect(screen.getByText('@Sam Lee')).toBeTruthy();
    // A person who can no longer read the database keeps the name they were written with.
    expect(screen.getByText('@Left')).toBeTruthy();
    expect(screen.queryByText('@Old Name')).toBeNull();
  });

  it('names an author who is gone', async () => {
    await mount({ comments: [comment({ authorId: GONE })] });
    expect(screen.getByRole('img', { name: 'S: Someone' })).toBeTruthy();
    expect(screen.getByText('Someone')).toBeTruthy();
  });

  it('takes a comment from someone else as it arrives, and its removal', async () => {
    const { server, databaseId, tableId, recordId } = await mount();
    expect(screen.getByText('No comments yet.')).toBeTruthy();
    server.remoteChange(databaseId, {
      kind: 'comment.created',
      comment: comment({ id: 'cmt00000000000007', tableId, recordId, body: 'Just landed' }),
    });
    expect(await screen.findByText('Just landed')).toBeTruthy();
    server.remoteChange(databaseId, {
      kind: 'comment.updated',
      comment: comment({ id: 'cmt00000000000007', tableId, recordId, body: 'Just landed', editedAt: ago(1) }),
    });
    await waitFor(() => expect(screen.getByRole('listitem').textContent).toContain('edited'));
    server.remoteChange(databaseId, {
      kind: 'comment.deleted',
      tableId,
      recordId,
      commentId: 'cmt00000000000007',
    });
    await waitFor(() => expect(screen.queryByText('Just landed')).toBeNull());
  });

  it('takes comments a merge moves here, and lets go of ones it moves away', async () => {
    const other = 'rec00000000000009';
    const { server, databaseId, tableId, recordId } = await mount({
      comments: [comment({ id: 'cmt00000000000001', body: 'Stays here', createdAt: ago(30) })],
    });
    server.remoteChange(databaseId, {
      kind: 'comment.moved',
      tableId,
      comments: [comment({ id: 'cmt00000000000002', tableId, recordId, body: 'From the duplicate' })],
      from: { cmt00000000000002: other },
    });
    const arrived = await screen.findByText('From the duplicate');
    // Oldest first, however the comment got here.
    expect(screen.getAllByRole('listitem')[0]).toBe(arrived.closest('li'));
    server.remoteChange(databaseId, {
      kind: 'comment.moved',
      tableId,
      comments: [comment({ id: 'cmt00000000000002', tableId, recordId: other, body: 'From the duplicate' })],
      from: { cmt00000000000002: recordId },
    });
    await waitFor(() => expect(screen.queryByText('From the duplicate')).toBeNull());
    expect(screen.getByText('Stays here')).toBeTruthy();
  });

  it('says when the thread won’t load, without claiming it is empty', async () => {
    const server = new FakeServer();
    const fixture = server.createDatabase(2);
    const session = await openDatabase(fixture.databaseId, server.deps());
    sessions.push(session);
    await settle();
    server.goOffline();
    const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
    render(
      <I18nProvider i18n={i18n}>
        <CommentsPanel session={session} tableId={fixture.tableId} recordId={fixture.recordId(0)} />
      </I18nProvider>,
    );
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/check your connection/i)).toBeTruthy();
    expect(screen.queryByText('No comments yet.')).toBeNull();
  });

  it('ignores a comment on another record', async () => {
    const { server, databaseId, tableId } = await mount();
    server.remoteChange(databaseId, {
      kind: 'comment.created',
      comment: comment({ id: 'cmt00000000000008', tableId, recordId: 'rec00000000000009' }),
    });
    await settle();
    expect(screen.queryByRole('listitem')).toBeNull();
    expect(screen.getByText('No comments yet.')).toBeTruthy();
  });

  it('retries a failed read and clears its error once the thread loads', async () => {
    const server = new FakeServer();
    const fixture = server.createDatabase(2);
    const session = await openDatabase(fixture.databaseId, server.deps());
    sessions.push(session);
    await settle();
    server.goOffline();
    const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
    render(
      <I18nProvider i18n={i18n}>
        <CommentsPanel session={session} tableId={fixture.tableId} recordId={fixture.recordId(0)} />
      </I18nProvider>,
    );
    expect(await screen.findByRole('alert')).toBeTruthy();
    server.goOnline();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No comments yet.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('who may write', () => {
  it('lets a reader read the thread without a composer', async () => {
    await mount({ role: 'reader', comments: [comment()] });
    expect(screen.getByText('A comment')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('hides edit and delete for a reader who wrote a comment before being demoted', async () => {
    await mount({ role: 'reader', comments: [comment({ authorId: ME })] });
    expect(screen.getByText('A comment')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('closes an active comment edit when the author loses comment access', async () => {
    const { server, session, databaseId } = await mount({ comments: [comment({ authorId: ME })] });
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Edit' }), ' draft');
    await act(async () => {
      server.database(databaseId).schema.database.role = 'reader';
      server.dropSubscriptions(databaseId, 'accessChanged');
      await settle();
    });
    await waitFor(() => expect(session.role()).toBe('reader'));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByText('A comment')).toBeTruthy();
  });

  it.each(['Edit', 'Delete'])('does not reopen %s when comment access returns', async (action) => {
    const { server, session, databaseId } = await mount({ comments: [comment({ authorId: ME })] });
    await userEvent.click(screen.getByRole('button', { name: action }));
    for (const role of ['reader', 'commenter'] as const) {
      await act(async () => {
        server.database(databaseId).schema.database.role = role;
        server.dropSubscriptions(databaseId, 'accessChanged');
        await settle();
      });
      await waitFor(() => expect(session.role()).toBe(role));
    }
    expect(screen.queryByRole('textbox', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Delete this comment?' })).toBeNull();
  });

  it('lets a commenter write but not change what isn’t theirs', async () => {
    await mount({ role: 'commenter', comments: [comment()] });
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('lets an owner delete anyone’s comment, but not edit it', async () => {
    await mount({ comments: [comment()] });
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  it('lets an author edit and delete their own', async () => {
    await mount({ comments: [comment({ id: 'cmt00000000000004', authorId: ME })] });
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
  });
});

describe('writing a comment', () => {
  it('shows the comment at once and settles it when the server answers', async () => {
    const { server, session, databaseId, box, stored } = await mount();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.beforeRequest = async (request) => {
      if (request.path.endsWith('/commands')) await held;
    };
    const user = userEvent.setup();
    await user.type(box, 'On its way');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    // The thread answers before the server does, and says the comment is still on its way.
    const pending = screen.getByRole('listitem');
    expect(pending.textContent).toContain('On its way');
    expect(pending.hasAttribute('data-pending')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(box.value).toBe('');
    expect(session.canUndo()).toBe(false);
    release();
    await waitFor(() => expect(screen.getByRole('listitem').hasAttribute('data-pending')).toBe(false));
    expect(stored()).toHaveLength(1);
    expect(stored()[0]?.authorId).toBe(server.userId);
    expect(server.changes(databaseId).at(-1)?.kind).toBe('comment.created');
    // A comment is a change like any other, but never part of undo.
    expect(session.canUndo()).toBe(false);
  });

  it('sends with the shortcut and keeps Send disabled while empty', async () => {
    const { box, stored } = await mount();
    const user = userEvent.setup();
    expect(box.getAttribute('placeholder')).toBe(PLACEHOLDER);
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send.hasAttribute('disabled')).toBe(true);
    await user.type(box, '   ');
    expect(send.hasAttribute('disabled')).toBe(true);
    await user.clear(box);
    await user.type(box, 'By control{Control>}{Enter}{/Control}');
    await waitFor(() => expect(stored()[0]?.body).toBe('By control'));
    await user.type(box, 'By command');
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() => expect(stored()).toHaveLength(2));
    expect(stored()[1]?.body).toBe('By command');
  });

  it('keeps a plain Enter as a new line', async () => {
    const { box, stored } = await mount();
    await userEvent.type(box, 'Two{Enter}lines');
    expect(box.value).toBe('Two\nlines');
    expect(stored()).toHaveLength(0);
  });

  it('trims what it sends', async () => {
    const { box, stored } = await mount();
    await userEvent.type(box, '  Padded  ');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(stored()[0]?.body).toBe('Padded'));
  });

  it('drops a comment the server refuses', async () => {
    const { server, box, stored } = await mount();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.beforeRequest = async (request) => {
      if (request.path.endsWith('/commands')) await held;
    };
    server.rejectNext('errors.forbidden');
    const user = userEvent.setup();
    await user.type(box, 'Not allowed');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('Not allowed')).toBeTruthy();
    release();
    await waitFor(() => expect(screen.queryByText('Not allowed')).toBeNull());
    expect(stored()).toHaveLength(0);
    expect(screen.getByText('No comments yet.')).toBeTruthy();
  });
});

describe('mentioning someone', () => {
  it('offers the people who match and writes one chosen with the arrow keys', async () => {
    const { box, stored } = await mount();
    const user = userEvent.setup();
    await user.type(box, 'Thanks @sa');
    const offers = screen.getByRole('listbox', { name: 'People to mention' });
    const options = within(offers).getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(within(offers).getByRole('option', { name: /^Sam Lee(?: |$)/ })).toBe(options[0]);
    expect(within(offers).getByRole('option', { name: /^Sana Ali(?: |$)/ })).toBe(options[1]);
    expect(box.getAttribute('aria-controls')).toBe(offers.id);
    expect(options[0]!.hasAttribute('data-active')).toBe(true);
    await user.keyboard('{ArrowDown}');
    expect(options[0]!.hasAttribute('data-active')).toBe(false);
    expect(options[1]!.hasAttribute('data-active')).toBe(true);
    await user.keyboard('{ArrowDown}');
    expect(options[1]!.hasAttribute('data-active')).toBe(true);
    await user.keyboard('{Enter}');
    expect(box.value).toBe(`Thanks @[Sana Ali](${SANA}) `);
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(stored()).toHaveLength(1));
    expect(stored()[0]?.mentions).toEqual([SANA]);
    expect(stored()[0]?.body).toBe(`Thanks @[Sana Ali](${SANA})`);
  });

  it('offers everyone on a bare @ and writes the one clicked', async () => {
    const { box } = await mount();
    const user = userEvent.setup();
    await user.type(box, '@');
    const offers = screen.getByRole('listbox', { name: 'People to mention' });
    expect(within(offers).getAllByRole('option')).toHaveLength(3);
    await user.click(within(offers).getByRole('option', { name: /^Sam Lee(?: |$)/ }));
    expect(box.value).toBe(`@[Sam Lee](${SAM}) `);
    // Choosing with the pointer leaves the caret in the text, ready for the rest of the sentence.
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(box.value.length);
  });

  it('puts the offers away with Escape and keeps the text', async () => {
    const { box } = await mount();
    const user = userEvent.setup();
    await user.type(box, '@sa');
    expect(screen.getByRole('listbox', { name: 'People to mention' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box.value).toBe('@sa');
    await user.type(box, 'n');
    expect(screen.getByRole('listbox', { name: 'People to mention' })).toBeTruthy();
  });

  it('offers nobody for an address or a finished mention', async () => {
    const { box } = await mount();
    const user = userEvent.setup();
    await user.type(box, 'sam@example.test');
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.clear(box);
    // A finished mention holds markup, so the caret after it isn't writing a new one.
    await user.paste(`@[Sam](${SAM})`);
    expect(box.value).toBe(`@[Sam](${SAM})`);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('changing a comment', () => {
  it('edits inline, with a way out', async () => {
    const { server, box, stored } = await mount({
      comments: [comment({ id: 'cmt00000000000004', authorId: ME, body: 'Before' })],
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const edit = screen.getByRole('textbox', { name: 'Edit' }) as HTMLTextAreaElement;
    expect(edit.value).toBe('Before');
    await user.clear(edit);
    await user.type(edit, 'After');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Edit' })).toBeNull();
    expect(screen.getByText('Before')).toBeTruthy();
    expect(stored()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByRole('textbox', { name: 'Edit' }));
    await user.type(screen.getByRole('textbox', { name: 'Edit' }), 'After');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stored()[0]?.body).toBe('After'));
    expect(screen.getByText('After')).toBeTruthy();
    expect(screen.getByRole('listitem').textContent).toContain('edited');
    expect(box).toBeTruthy();
    expect(server.changes(server.databases.keys().next().value!).at(-1)?.kind).toBe('comment.updated');
  });

  it('saves an edit with the shortcut and refuses an empty one', async () => {
    const { stored } = await mount({
      comments: [comment({ id: 'cmt00000000000005', authorId: ME, body: 'Words' })],
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const edit = screen.getByRole('textbox', { name: 'Edit' }) as HTMLTextAreaElement;
    await user.clear(edit);
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    await user.type(edit, 'Shorter{Meta>}{Enter}{/Meta}');
    await waitFor(() => expect(stored()[0]?.body).toBe('Shorter'));
    expect(screen.queryByRole('textbox', { name: 'Edit' })).toBeNull();
  });

  it('deletes after asking', async () => {
    const { stored } = await mount({ comments: [comment({ id: 'cmt00000000000006', body: 'Going' })] });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const ask = screen.getByRole('dialog');
    expect(within(ask).getByRole('heading', { name: 'Delete this comment?' })).toBeTruthy();
    expect(within(ask).getByText('It’s removed for everyone.')).toBeTruthy();
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Going')).toBeTruthy();
    expect(stored()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('Going')).toBeNull());
    expect(stored()).toHaveLength(0);
    expect(screen.getByText('No comments yet.')).toBeTruthy();
  });
});

describe('reaching the thread by keyboard', () => {
  it('moves through every control, each named', async () => {
    await mount({ comments: [comment({ id: 'cmt00000000000009', authorId: ME, body: 'Mine' })] });
    const user = userEvent.setup();
    const box = screen.getByRole('textbox', { name: BOX }) as HTMLTextAreaElement;
    // Send only takes part in the walk once there is something to send.
    await user.type(box, 'A note');
    const stops = [
      screen.getByRole('button', { name: 'Edit' }),
      screen.getByRole('button', { name: 'Delete' }),
      box,
      screen.getByRole('button', { name: 'Send' }),
    ];
    stops[0]!.focus();
    expect(document.activeElement).toBe(stops[0]);
    for (const stop of stops.slice(1)) {
      await user.tab();
      expect(document.activeElement).toBe(stop);
    }
    // Nothing else in the panel takes focus, so the walk ends at the last control.
    await user.tab();
    expect(document.activeElement).not.toBe(box);
  });
});

it('anchors a field thread and labels its comments in the record conversation', async () => {
  const { session, box, stored, tableId, recordId } = await mount({ cell: true });
  const field = session.getSchema().fields.get(tableId)![0]!;
  expect(screen.getByText(`Comments on ${field.name}`)).toBeTruthy();
  const user = userEvent.setup();
  await user.type(box, 'Cell note');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(stored()[0]?.fieldId).toBe(field.id));
  cleanup();
  window.history.replaceState(null, '', '/');
  render(
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
      <CommentsPanel session={session} tableId={tableId} recordId={recordId} />
    </I18nProvider>,
  );
  await waitFor(() => expect(screen.getByText(field.name)).toBeTruthy());
  expect(screen.getByText('Cell note')).toBeTruthy();
});
