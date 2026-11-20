import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FieldMeta,
  FormSettings as FormConfig,
  type FieldType,
  type PublicFormLink,
  type ThemePick,
} from '@riosoma/contracts';
import { useSchema } from '../../../../data/hooks';
import { openDatabase } from '../../../../data/session';
import { FakeServer } from '../../../../data/testing';
import { syncedFixture } from '../../../../data/testing/synced';
import type { DatabaseSession } from '../../../../data/types';
import { celebrations, type Celebration } from '../../../../features/celebrations/engine';
import { json, renderSharing } from '../../share/testing';
import { FormSettings } from './index';
import { PublicFormShare } from './PublicFormShare';
import { themes } from '../../../../preferences';

const VIEW_ID = 'viw00000000000001';
const TABLE_ID = 'tbl00000000000001';
const FORM_ID = 'AbCdEfGhIjKlMnOpQrStUv';
const PATH = `/api/views/${VIEW_ID}/public-form`;

const sessions: DatabaseSession[] = [];
afterEach(() => {
  cleanup();
  sessions.splice(0).forEach((session) => session.close());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function field(name: string, type: FieldType, options: Record<string, unknown> = {}, position = 0) {
  return FieldMeta.parse({
    id: `fld${String(position).padStart(14, '0')}`,
    tableId: TABLE_ID,
    name,
    type,
    options,
    description: '',
    position,
    createdAt: '',
    updatedAt: '',
  });
}

const fields = [
  field('Name', 'text', {}, 1),
  field('Owner', 'user', {}, 2),
  field('Photo', 'attachment', {}, 3),
  field('Related', 'link', { linkedTableId: TABLE_ID }, 4),
  field('Total', 'formula', { expression: '1 + 1', resultType: 'number' }, 5),
  field('Rating', 'rating', {}, 6),
];

function link(
  submissions = 0,
  formId = FORM_ID,
  suspendedSharer: PublicFormLink['suspendedSharer'] = null,
): PublicFormLink {
  return {
    formId,
    viewId: VIEW_ID,
    path: `/f/${formId}`,
    createdAt: '2026-09-27T12:00:00.000Z',
    createdBy: 'usr00000000000001',
    submissions,
    omittedFieldIds: [],
    suspendedSharer,
  };
}

/** A server that answers the view's public-form routes, keeping the link between requests. */
function start(
  initial: PublicFormLink | null = null,
  questions: Array<{ fieldId: string; label?: string }> = fields.map((f) => ({ fieldId: f.id })),
) {
  let current = initial;
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url !== PATH) throw new Error(`Unexpected request: ${url}`);
    if (options?.method === 'PUT') {
      // Sharing a paused form again keeps its address, and a new share makes a new one.
      current = current ? { ...current, suspendedSharer: null } : link(0, 'ZyXwVuTsRqPoNmLkJiHgFe');
      return json(current);
    }
    if (options?.method === 'DELETE') {
      current = null;
      return new Response(null, { status: 204 });
    }
    return json(current);
  });
  vi.stubGlobal('fetch', fetcher);
  const { client } = renderSharing(
    <PublicFormShare
      viewId={VIEW_ID}
      questions={FormConfig.parse({ questions }).questions}
      fields={fields}
    />,
  );
  return {
    fetcher,
    calls: (method: string) => fetcher.mock.calls.filter(([, o]) => o?.method === method),
    /** Changes the link on the server, as people answering the form do, and reads it again. */
    refetch: async (next: PublicFormLink | null) => {
      current = next;
      await act(() => client.invalidateQueries({ queryKey: ['views', VIEW_ID, 'publicForm'] }));
    },
  };
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Share publicly' }));
  const dialog = await screen.findByRole('dialog', { name: 'Share publicly' });
  await waitFor(() =>
    expect(within(dialog).getByRole('switch', { name: 'Share publicly' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  return dialog;
}

describe('sharing a form publicly', () => {
  it('picks the public page’s own theme, which saves with the form', async () => {
    vi.spyOn(themes, 'list').mockResolvedValue([
      {
        id: 'bauhaus',
        name: 'Bauhaus',
        css: '',
        manifest: '',
        defaultScheme: 'werkbund',
        schemeCount: 1,
        modes: [],
      },
    ]);
    vi.spyOn(themes, 'manifest').mockResolvedValue({
      id: 'bauhaus',
      name: 'Bauhaus',
      css: '',
      defaultScheme: 'werkbund',
      schemes: [{ id: 'werkbund', name: 'Werkbund', appearance: 'light' }],
      modes: [],
      defaultMode: null,
      surfaces: [],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url !== PATH) throw new Error(`Unexpected request: ${url}`);
        return json(link());
      }),
    );
    const onTheme = vi.fn();
    // The form's settings come back with each pick, as the view's config does.
    function Host() {
      const [theme, setTheme] = useState<ThemePick | null>(null);
      return (
        <PublicFormShare
          viewId={VIEW_ID}
          questions={[]}
          fields={fields}
          theme={theme}
          onTheme={(next) => {
            onTheme(next);
            setTheme(next);
          }}
        />
      );
    }
    renderSharing(<Host />);
    const user = userEvent.setup();
    const dialog = await open(user);
    const theme = await within(dialog).findByRole('button', { name: /Page theme/ });
    expect(theme.textContent).toContain('Same as the database');
    await waitFor(() => expect(theme.hasAttribute('disabled')).toBe(false));
    await user.click(theme);
    await user.click(await screen.findByRole('option', { name: 'Bauhaus' }));
    expect(onTheme).toHaveBeenLastCalledWith({ id: 'bauhaus', scheme: 'werkbund' });
    // Choosing the database's clears it.
    await user.click(await within(dialog).findByRole('button', { name: /Page theme/ }));
    await user.click(await screen.findByRole('option', { name: 'Same as the database' }));
    expect(onTheme).toHaveBeenLastCalledWith(null);
  });

  it('restores focus lost when publishing disables the switch', async () => {
    const { fetcher } = start();
    const user = userEvent.setup();
    const dialog = await open(user);
    let finish!: () => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = () => resolve(json(link()));
        }),
    );
    const toggle = within(dialog).getByRole('switch', { name: 'Share publicly' }) as HTMLInputElement;
    await user.click(toggle);
    await waitFor(() => expect(toggle.disabled).toBe(true));
    finish();
    await waitFor(() => expect(toggle.disabled).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(toggle));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Share publicly' })).toBeNull());
  });

  it('publishes with the switch, then shows the full link, its count, and a copy button', async () => {
    const { calls } = start();
    const user = userEvent.setup();
    const dialog = await open(user);
    expect(dialog.textContent).toContain('Anyone with the link can add a record, without signing in.');
    const toggle = within(dialog).getByRole('switch', { name: 'Share publicly' }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(within(dialog).queryByRole('textbox', { name: 'Public link' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Stop sharing' })).toBeNull();

    await user.click(toggle);
    const field = (await within(dialog).findByRole('textbox', { name: 'Public link' })) as HTMLInputElement;
    const url = `${window.location.origin}/f/ZyXwVuTsRqPoNmLkJiHgFe`;
    expect(field.value).toBe(url);
    expect(field.hasAttribute('readonly')).toBe(true);
    expect(toggle.checked).toBe(true);
    expect(calls('PUT')).toHaveLength(1);
    expect(within(dialog).getByText('0 responses')).toBeDefined();

    expect(within(dialog).getByRole('status').textContent).toBe('');
    await user.click(within(dialog).getByRole('button', { name: 'Copy link' }));
    expect(await navigator.clipboard.readText()).toBe(url);
    expect(within(dialog).getByRole('status').textContent).toBe('Copied the link');
  });

  it('returns keyboard focus to the switch after an immediate publish response', async () => {
    const { calls } = start();
    const user = userEvent.setup();
    const dialog = await open(user);
    const toggle = within(dialog).getByRole('switch', { name: 'Share publicly' });
    toggle.focus();
    await user.keyboard(' ');
    await within(dialog).findByRole('textbox', { name: 'Public link' });
    expect(calls('PUT')).toHaveLength(1);
    await waitFor(() => expect(document.activeElement).toBe(toggle));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(dialog.isConnected).toBe(false));
  });

  it('keeps keyboard focus in the dialog while publishing and returns it to the switch', async () => {
    const { fetcher } = start();
    const user = userEvent.setup();
    const dialog = await open(user);
    const toggle = within(dialog).getByRole('switch', { name: 'Share publicly' });
    let complete!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => (complete = resolve)));
    toggle.focus();
    await user.keyboard(' ');
    try {
      await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(true));
      expect(document.activeElement).toBe(dialog);
    } finally {
      complete(json(link()));
    }
    await within(dialog).findByRole('textbox', { name: 'Public link' });
    await waitFor(() => expect(document.activeElement).toBe(toggle));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(dialog.isConnected).toBe(false));
  });

  it('returns keyboard focus to the switch when the browser drops it to the page while publishing', async () => {
    const { fetcher } = start();
    const user = userEvent.setup();
    const dialog = await open(user);
    const toggle = within(dialog).getByRole('switch', { name: 'Share publicly' });
    let complete!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => (complete = resolve)));
    toggle.focus();
    await user.keyboard(' ');
    // The frame after settling can run before the switch is enabled again, so only the render that
    // enables it can bring focus back.
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    try {
      await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(true));
      (document.activeElement as HTMLElement | null)?.blur();
      expect(document.activeElement).toBe(document.body);
      complete(json(link()));
      await within(dialog).findByRole('textbox', { name: 'Public link' });
      await waitFor(() => expect(document.activeElement).toBe(toggle));
    } finally {
      frame.mockRestore();
    }
    await user.keyboard('{Escape}');
    await waitFor(() => expect(dialog.isConnected).toBe(false));
  });

  it('shows an existing link with its responses', async () => {
    start(link(1));
    const user = userEvent.setup();
    const dialog = await open(user);
    expect(
      ((await within(dialog).findByRole('textbox', { name: 'Public link' })) as HTMLInputElement).value,
    ).toBe(`${window.location.origin}/f/${FORM_ID}`);
    expect(within(dialog).getByText('1 response')).toBeDefined();
    cleanup();
    start(link(12));
    await open(user);
    expect(await screen.findByText('12 responses')).toBeDefined();
  });

  it('shows a form its suspended sharer paused, and shares it again at the same address', async () => {
    const { calls } = start(link(2, FORM_ID, { id: 'usr00000000000002', name: 'Pat Jones' }));
    const user = userEvent.setup();
    const dialog = await open(user);
    const address = `${window.location.origin}/f/${FORM_ID}`;
    expect(
      ((await within(dialog).findByRole('textbox', { name: 'Public link' })) as HTMLInputElement).value,
    ).toBe(address);
    expect(dialog.textContent).toContain('This form is paused');
    expect(dialog.textContent).toContain('Pat Jones, who shared it, is suspended');
    await user.click(within(dialog).getByRole('button', { name: 'Share again' }));
    await waitFor(() => expect(dialog.textContent).not.toContain('This form is paused'));
    expect(calls('PUT')).toHaveLength(1);
    expect((within(dialog).getByRole('textbox', { name: 'Public link' }) as HTMLInputElement).value).toBe(
      address,
    );
  });

  it('stops sharing only after confirming, from the button or the switch', async () => {
    const { calls } = start(link(3));
    const user = userEvent.setup();
    const dialog = await open(user);
    await within(dialog).findByRole('textbox', { name: 'Public link' });

    await user.click(within(dialog).getByRole('button', { name: 'Stop sharing' }));
    let question = await screen.findByRole('dialog', { name: 'Stop sharing this form?' });
    expect(question.textContent).toContain(
      'The link stops working at once.  Sharing again makes a new link.',
    );
    await user.click(within(question).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Stop sharing this form?' })).toBeNull());
    expect(calls('DELETE')).toHaveLength(0);

    const toggle = within(dialog).getByRole('switch', { name: 'Share publicly' }) as HTMLInputElement;
    await user.click(toggle);
    question = await screen.findByRole('dialog', { name: 'Stop sharing this form?' });
    expect(toggle.checked).toBe(true);
    expect(calls('DELETE')).toHaveLength(0);
    await user.click(within(question).getByRole('button', { name: 'Stop sharing' }));
    await waitFor(() => expect(within(dialog).queryByRole('textbox', { name: 'Public link' })).toBeNull());
    expect(calls('DELETE')).toHaveLength(1);
    expect(toggle.checked).toBe(false);
    expect(within(dialog).queryByText('3 responses')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(toggle));
  });

  it('names the questions a public form leaves out, and why', async () => {
    const user = userEvent.setup();
    start(null, [
      { fieldId: fields[0]!.id },
      { fieldId: fields[1]!.id, label: 'Your manager' },
      { fieldId: fields[2]!.id },
      { fieldId: fields[3]!.id },
      { fieldId: fields[4]!.id },
      { fieldId: fields[5]!.id },
    ]);
    let dialog = await open(user);
    expect(dialog.textContent).toContain('These questions can’t be asked publicly:');
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Your manager', 'Photo', 'Related', 'Total']);
    expect(dialog.textContent).toContain(
      'People, linked records, attachments, and calculated fields stay private.',
    );
    cleanup();
    start(null, [{ fieldId: fields[0]!.id }, { fieldId: fields[2]!.id }]);
    dialog = await open(user);
    expect(dialog.textContent).toContain('This question can’t be asked publicly:');
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Photo']);
    cleanup();
    start(null, [{ fieldId: fields[0]!.id }, { fieldId: fields[5]!.id }]);
    dialog = await open(user);
    expect(dialog.textContent).not.toContain('asked publicly');
    expect(within(dialog).queryByRole('list')).toBeNull();
  });

  it('shows why the server refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options?: RequestInit) =>
        options?.method === 'PUT'
          ? json({ error: { code: 'forbidden', messageKey: 'data.access.denied', userFault: true } }, 403)
          : json(null),
      ),
    );
    renderSharing(<PublicFormShare viewId={VIEW_ID} questions={[]} fields={fields} />);
    const user = userEvent.setup();
    const dialog = await open(user);
    await user.click(within(dialog).getByRole('switch', { name: 'Share publicly' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert').textContent).toContain('You don’t have access'),
    );
    expect((within(dialog).getByRole('switch', { name: 'Share publicly' }) as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it('labels every control and reaches them all by keyboard', async () => {
    start(link(2));
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Share publicly' }));
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Share publicly' });
    await within(dialog).findByRole('textbox', { name: 'Public link' });
    const reached = new Set<Element>();
    for (let i = 0; i < 8; i += 1) {
      await user.tab();
      if (document.activeElement && dialog.contains(document.activeElement))
        reached.add(document.activeElement);
    }
    for (const control of [
      within(dialog).getByRole('switch', { name: 'Share publicly' }),
      within(dialog).getByRole('textbox', { name: 'Public link' }),
      within(dialog).getByRole('button', { name: 'Copy link' }),
      within(dialog).getByRole('button', { name: 'Stop sharing' }),
    ])
      expect(reached.has(control)).toBe(true);
    for (const button of within(dialog).getAllByRole('button'))
      expect(button.textContent || button.getAttribute('aria-label')).toBeTruthy();
  });
});

describe('a form’s first response', () => {
  let shown: Celebration[] = [];
  let stop: () => void = () => undefined;
  beforeEach(() => {
    localStorage.clear();
    shown = [];
    stop = celebrations.subscribe((celebration) => shown.push(celebration));
  });
  afterEach(() => {
    stop();
    localStorage.clear();
  });

  it('celebrates once, from the count, when a form seen with none gets its first', async () => {
    const { refetch } = start(link(0));
    const user = userEvent.setup();
    const dialog = await open(user);
    await within(dialog).findByText('0 responses');
    expect(shown).toEqual([]);

    await refetch(link(1));
    const count = await within(dialog).findByText('1 response');
    expect(shown.map((celebration) => [celebration.name, celebration.key, celebration.cause])).toEqual([
      ['formFirstResponse', VIEW_ID, 'others'],
    ]);
    expect(shown[0]!.anchor).toBe(count);

    await refetch(link(2));
    await within(dialog).findByText('2 responses');
    expect(shown).toHaveLength(1);
  });

  it('never celebrates a form that already had responses when first seen', async () => {
    const { refetch } = start(link(1));
    const user = userEvent.setup();
    const dialog = await open(user);
    await within(dialog).findByText('1 response');
    await refetch(link(2));
    await within(dialog).findByText('2 responses');
    expect(shown).toEqual([]);
  });
});

describe('the form view’s sharing controls', () => {
  async function settings(canEdit: boolean, synced = false) {
    const setup = synced ? syncedFixture(0) : null;
    const server = setup?.server ?? new FakeServer();
    const fixture = setup?.fixture ?? server.createDatabase(0);
    const database = server.database(fixture.databaseId);
    const view = database.schema.views[0]!;
    view.type = 'form';
    view.config.form = FormConfig.parse({ questions: [{ fieldId: fixture.textFieldId }] });
    const session = await openDatabase(fixture.databaseId, server.deps());
    sessions.push(session);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(null)),
    );
    function Host() {
      const schema = useSchema(session)!;
      return (
        <FormSettings
          session={session}
          table={schema.tableById.get(fixture.tableId)!}
          view={schema.viewById.get(view.id)!}
          fields={schema.fields.get(fixture.tableId)!}
          format={{ locale: 'en-US', timeZone: 'UTC', collaborators: schema.collaborators }}
          canEdit={canEdit}
          onConfig={vi.fn()}
          onExpand={vi.fn()}
        />
      );
    }
    renderSharing(<Host />);
  }

  it('shows the controls only to people who can change views', async () => {
    await settings(true);
    expect(screen.getByRole('button', { name: 'Share publicly' })).toBeDefined();
    cleanup();
    await settings(false);
    expect(screen.queryByRole('button', { name: 'Share publicly' })).toBeNull();
  });

  it('leaves them out for a synced table, which takes records only from its source', async () => {
    await settings(true, true);
    expect(screen.queryByRole('button', { name: 'Share publicly' })).toBeNull();
  });
});
