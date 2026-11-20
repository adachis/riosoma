import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FieldMeta,
  GridConfig,
  SharedViewSettings,
  SharedViewUpdate,
  type FieldType,
  type SharedViewLink,
  type ViewMeta,
} from '@riosoma/contracts';
import { themes } from '../../../preferences';
import { failure, json, renderSharing } from '../share/testing';
import { embedCode, ShareViewDialog } from './ShareViewDialog';

const VIEW_ID = 'viw00000000000001';
const TABLE_ID = 'tbl00000000000001';
const LINK_ID = 'AbCdEfGhIjKlMnOpQrStUv';
const PATH = `/api/views/${VIEW_ID}/shared-view`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function field(name: string, type: FieldType, position: number, options: Record<string, unknown> = {}) {
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
  field('Name', 'text', 1),
  field('Status', 'singleSelect', 2, { choices: [{ id: 'cho00000000000001', name: 'Open', color: 'blue' }] }),
  field('Budget', 'currency', 3),
  field('Notes', 'longText', 4),
  field('Secret', 'text', 5),
];
const [name, status, budget, notes, secret] = fields.map((item) => item.id) as [
  string,
  string,
  string,
  string,
  string,
];

function view(type: ViewMeta['type'] = 'grid', config: Record<string, unknown> = {}): ViewMeta {
  return {
    id: VIEW_ID,
    tableId: TABLE_ID,
    name: 'Launch "plan" <A&B>',
    type,
    config: GridConfig.parse({ hiddenFieldIds: [secret], ...config }),
    position: 0,
    createdBy: null,
    createdAt: '',
    updatedAt: '',
  };
}

function link(
  settings: Partial<SharedViewSettings> = {},
  hasPassword = false,
  suspendedSharer: SharedViewLink['suspendedSharer'] = null,
): SharedViewLink {
  return {
    linkId: LINK_ID,
    viewId: VIEW_ID,
    path: `/v/${LINK_ID}`,
    createdAt: '2026-09-27T12:00:00.000Z',
    createdBy: 'usr00000000000001',
    updatedAt: '2026-09-27T12:00:00.000Z',
    settings: SharedViewSettings.parse(settings),
    hasPassword,
    requiredFieldIds: [name],
    suspendedSharer,
  };
}

/** A server that answers the view's shared-view routes, keeping the link between requests. */
function start(initial: SharedViewLink | null = null, shape: ViewMeta = view()) {
  let current = initial;
  const updates: SharedViewUpdate[] = [];
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url !== PATH) throw new Error(`Unexpected request: ${url}`);
    if (options?.method === 'PUT') {
      // Sharing a shared link again keeps it, and takes it over from a suspended sharer.
      current = current ? { ...current, suspendedSharer: null } : link();
      return json(current);
    }
    if (options?.method === 'DELETE') {
      current = null;
      return new Response(null, { status: 204 });
    }
    if (options?.method === 'PATCH') {
      const update = SharedViewUpdate.parse(JSON.parse(String(options.body)));
      updates.push(update);
      const { password, theme, ...settings } = update;
      // Null goes back to the database's theme, which the server stores as no theme at all.
      const next: Partial<SharedViewSettings> = { ...current!.settings, ...settings };
      if (theme) next.theme = theme;
      else if (theme === null) delete next.theme;
      current = link(next, password === undefined ? current!.hasPassword : password !== null);
      return json(current);
    }
    return json(current);
  });
  vi.stubGlobal('fetch', fetcher);
  const onClose = vi.fn();
  renderSharing(<ShareViewDialog view={shape} fields={fields} primaryFieldId={name} onClose={onClose} />);
  return {
    fetcher,
    updates,
    onClose,
    calls: (method: string) => fetcher.mock.calls.filter(([, o]) => o?.method === method),
  };
}

async function opened() {
  const dialog = await screen.findByRole('dialog', { name: 'Share view' });
  await waitFor(() =>
    expect(within(dialog).getByRole('switch', { name: 'Share by link' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  return dialog;
}

describe('sharing a view by link', () => {
  it('picks the page’s own theme and scheme, and goes back to the database’s', async () => {
    vi.spyOn(themes, 'list').mockResolvedValue([
      {
        id: 'bauhaus',
        name: 'Bauhaus',
        css: '',
        manifest: '',
        defaultScheme: 'werkbund',
        schemeCount: 2,
        modes: [],
      },
    ]);
    vi.spyOn(themes, 'manifest').mockResolvedValue({
      id: 'bauhaus',
      name: 'Bauhaus',
      css: '',
      defaultScheme: 'werkbund',
      schemes: [
        { id: 'werkbund', name: 'Werkbund', appearance: 'light' },
        { id: 'midnight', name: 'Midnight', appearance: 'dark' },
      ],
      modes: [],
      defaultMode: null,
      surfaces: [],
    });
    const { updates } = start(link());
    const user = userEvent.setup();
    const dialog = await opened();
    const theme = await within(dialog).findByRole('button', { name: /Page theme/ });
    expect(theme.textContent).toContain('Same as the database');
    await waitFor(() => expect(theme.hasAttribute('disabled')).toBe(false));
    await user.click(theme);
    await user.click(await screen.findByRole('option', { name: 'Bauhaus' }));
    await waitFor(() => expect(updates.at(-1)).toEqual({ theme: { id: 'bauhaus', scheme: 'werkbund' } }));
    await user.click(await within(dialog).findByRole('button', { name: /Color scheme/ }));
    await user.click(await screen.findByRole('option', { name: 'Midnight' }));
    await waitFor(() => expect(updates.at(-1)).toEqual({ theme: { id: 'bauhaus', scheme: 'midnight' } }));
    await user.click(within(dialog).getByRole('button', { name: /Page theme/ }));
    await user.click(await screen.findByRole('option', { name: 'Same as the database' }));
    await waitFor(() => expect(updates.at(-1)).toEqual({ theme: null }));
    expect(within(dialog).queryByRole('button', { name: /Color scheme/ })).toBeNull();
  });

  it('publishes with the switch, then shows the link and copies it', async () => {
    const { calls } = start();
    const user = userEvent.setup();
    const dialog = await opened();
    expect(dialog.textContent).toContain('Anyone with the link can see this view without signing in.');
    const toggle = within(dialog).getByRole('switch', { name: 'Share by link' }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(within(dialog).queryByRole('textbox', { name: 'Link' })).toBeNull();
    await user.click(toggle);
    const url = `${window.location.origin}/v/${LINK_ID}`;
    const box = (await within(dialog).findByRole('textbox', { name: 'Link' })) as HTMLInputElement;
    expect(box.value).toBe(url);
    expect(box.hasAttribute('readonly')).toBe(true);
    expect(calls('PUT')).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'Copy link' }));
    expect(await navigator.clipboard.readText()).toBe(url);
    expect(within(dialog).getByRole('status').textContent).toBe('Copied the link');
    // Everything starts private.
    expect(
      (
        within(dialog).getByRole('switch', {
          name: 'Allow copying and downloading as CSV',
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(
      (within(dialog).getByRole('switch', { name: 'Ask for a password' }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (within(dialog).getByRole('switch', { name: 'Allow embedding on other sites' }) as HTMLInputElement)
        .checked,
    ).toBe(false);
  });

  it('shares every field the view shows, or only the ones picked, never leaving out what the view needs', async () => {
    const { updates } = start(link());
    const user = userEvent.setup();
    const dialog = await opened();
    await within(dialog).findByRole('textbox', { name: 'Link' });
    expect(
      (within(dialog).getByRole('radio', { name: 'Every field the view shows' }) as HTMLInputElement).checked,
    ).toBe(true);
    await user.click(within(dialog).getByRole('radio', { name: 'Only the fields I pick' }));
    await waitFor(() => expect(updates).toEqual([{ fieldIds: [status, budget, notes] }]));
    const group = await within(dialog).findByRole('group', { name: 'Shared fields' });
    const boxes = within(group).getAllByRole('checkbox') as HTMLInputElement[];
    // The view hides Secret, so it isn't offered at all.
    expect(boxes.map((box) => box.closest('label')?.textContent)).toEqual([
      'Name',
      'Status',
      'Budget',
      'Notes',
    ]);
    const required = within(group).getByRole('checkbox', { name: /Name/ }) as HTMLInputElement;
    expect(required.checked).toBe(true);
    expect(required.disabled).toBe(true);
    expect(group.textContent).toContain('Always shared, since the view needs it');
    await user.click(within(group).getByRole('checkbox', { name: 'Budget' }));
    await waitFor(() => expect(updates.at(-1)).toEqual({ fieldIds: [status, notes] }));
    await user.click(within(dialog).getByRole('radio', { name: 'Every field the view shows' }));
    await waitFor(() => expect(updates.at(-1)).toEqual({ fieldIds: null }));
  });

  it('names fields a kanban needs even when its cards hide them', async () => {
    start(
      link({ fieldIds: [] }),
      view('kanban', {
        hiddenFieldIds: [secret, status],
        kanban: { ...GridConfig.parse({}).kanban, stackFieldId: status },
      }),
    );
    const dialog = await opened();
    await within(dialog).findByRole('textbox', { name: 'Link' });
    expect(dialog.textContent).toContain('Also shared, since the view needs them: Status');
  });

  it('allows copying, sets and removes a password, and never shows one', async () => {
    const { updates } = start(link());
    const user = userEvent.setup();
    const dialog = await opened();
    await within(dialog).findByRole('textbox', { name: 'Link' });
    await user.click(within(dialog).getByRole('switch', { name: 'Allow copying and downloading as CSV' }));
    await waitFor(() => expect(updates).toEqual([{ allowCopy: true }]));

    await user.click(within(dialog).getByRole('switch', { name: 'Ask for a password' }));
    const password = within(dialog).getByLabelText('Password');
    await user.type(password, 'short');
    await user.click(within(dialog).getByRole('button', { name: 'Save password' }));
    expect(await within(dialog).findByText('Use at least 6 characters.')).toBeTruthy();
    expect(updates).toHaveLength(1);
    await user.clear(password);
    await user.type(password, 'garden gate 42');
    await user.click(within(dialog).getByRole('button', { name: 'Save password' }));
    await waitFor(() => expect(updates.at(-1)).toEqual({ password: 'garden gate 42' }));
    const replacement = await within(dialog).findByLabelText('New password');
    expect((replacement as HTMLInputElement).value).toBe('');
    expect(dialog.textContent).toContain('A password is set.');
    expect(dialog.textContent).not.toContain('garden gate');
    await user.click(within(dialog).getByRole('switch', { name: 'Ask for a password' }));
    await waitFor(() => expect(updates.at(-1)).toEqual({ password: null }));
    await waitFor(() => expect(within(dialog).queryByLabelText('New password')).toBeNull());
  });

  it('allows embedding, on the listed sites only, with an embed code to copy', async () => {
    const { updates } = start(link());
    const user = userEvent.setup();
    const dialog = await opened();
    await within(dialog).findByRole('textbox', { name: 'Link' });
    await user.click(within(dialog).getByRole('switch', { name: 'Allow embedding on other sites' }));
    await waitFor(() => expect(updates).toEqual([{ embed: { enabled: true, sites: [] } }]));
    const code = (await within(dialog).findByRole('textbox', { name: 'Embed code' })) as HTMLTextAreaElement;
    const url = `${window.location.origin}/v/${LINK_ID}`;
    expect(code.value).toBe(embedCode(url, 'Launch "plan" <A&B>'));
    expect(code.value).toContain('title="Launch &quot;plan&quot; &lt;A&amp;B&gt;"');
    await user.click(within(dialog).getByRole('button', { name: 'Copy embed code' }));
    expect(await navigator.clipboard.readText()).toBe(code.value);
    expect(within(dialog).getByRole('status').textContent).toBe('Copied the embed code');

    const sites = within(dialog).getByRole('textbox', { name: 'Sites that may embed it' });
    await user.type(sites, 'https://blog.example.test{Enter}javascript:alert(1)');
    await user.click(within(dialog).getByRole('button', { name: 'Save sites' }));
    expect(await within(dialog).findByText('This isn’t a web address: javascript:alert(1)')).toBeTruthy();
    expect(updates).toHaveLength(1);
    await user.clear(sites);
    await user.type(sites, 'https://Blog.Example.test{Enter}https://docs.example.test');
    await user.click(within(dialog).getByRole('button', { name: 'Save sites' }));
    await waitFor(() =>
      expect(updates.at(-1)).toEqual({
        embed: { enabled: true, sites: ['https://blog.example.test', 'https://docs.example.test'] },
      }),
    );
  });

  it('stops sharing only after confirming', async () => {
    const { calls } = start(link({ allowCopy: true }));
    const user = userEvent.setup();
    const dialog = await opened();
    await within(dialog).findByRole('textbox', { name: 'Link' });
    await user.click(within(dialog).getByRole('button', { name: 'Stop sharing' }));
    const question = await screen.findByRole('dialog', { name: 'Stop sharing this view?' });
    expect(question.textContent).toContain('The link and every embed stop working at once.');
    await user.click(within(question).getByRole('button', { name: 'Stop sharing' }));
    await waitFor(() => expect(within(dialog).queryByRole('textbox', { name: 'Link' })).toBeNull());
    expect(calls('DELETE')).toHaveLength(1);
    expect((within(dialog).getByRole('switch', { name: 'Share by link' }) as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it('lets someone the rules limit stop a link they can’t read', async () => {
    let stopped = false;
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'DELETE') {
        stopped = true;
        return new Response(null, { status: 204 });
      }
      return stopped ? json(null) : failure('data.access.linkLimited', 403);
    });
    vi.stubGlobal('fetch', fetcher);
    renderSharing(<ShareViewDialog view={view()} fields={fields} primaryFieldId={name} onClose={vi.fn()} />);
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'Share view' });
    await waitFor(() =>
      expect(within(dialog).getByRole('alert').textContent).toContain('Someone else shared this view'),
    );
    // Nothing of the link shows, and the switch can't share over it.
    expect(within(dialog).queryByRole('textbox', { name: 'Link' })).toBeNull();
    expect(within(dialog).getByRole('switch', { name: 'Share by link' }).hasAttribute('disabled')).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Stop sharing' }));
    const question = await screen.findByRole('dialog', { name: 'Stop sharing this view?' });
    await user.click(within(question).getByRole('button', { name: 'Stop sharing' }));
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'Stop sharing' })).toBeNull());
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(1);
    // With the link gone, the view is theirs to share like any other.
    expect(within(dialog).getByRole('alert').textContent).toBe('');
    const publish = within(dialog).getByRole('switch', { name: 'Share by link' }) as HTMLInputElement;
    expect(publish.hasAttribute('disabled')).toBe(false);
    expect(publish.checked).toBe(false);
  });

  it('shows a link its suspended sharer paused, and shares it again at the same address', async () => {
    const { calls } = start(link({}, false, { id: 'usr00000000000002', name: 'Pat Jones' }));
    const user = userEvent.setup();
    const dialog = await opened();
    const box = (await within(dialog).findByRole('textbox', { name: 'Link' })) as HTMLInputElement;
    const address = box.value;
    expect(dialog.textContent).toContain('This link is paused');
    expect(dialog.textContent).toContain('Pat Jones, who shared it, is suspended');
    await user.click(within(dialog).getByRole('button', { name: 'Share again' }));
    await waitFor(() => expect(dialog.textContent).not.toContain('This link is paused'));
    expect(calls('PUT')).toHaveLength(1);
    expect((within(dialog).getByRole('textbox', { name: 'Link' }) as HTMLInputElement).value).toBe(address);
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
    renderSharing(<ShareViewDialog view={view()} fields={fields} primaryFieldId={name} onClose={vi.fn()} />);
    const user = userEvent.setup();
    const dialog = await opened();
    await user.click(within(dialog).getByRole('switch', { name: 'Share by link' }));
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).not.toBe(''));
  });
});
