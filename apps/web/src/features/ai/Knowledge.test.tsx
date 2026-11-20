import { renderSharing as renderDatabase } from '../../screens/database/share/testing';
import { renderSettings as renderSharing } from '../../screens/settings/testing';
import { Block } from '../rio/Blocks';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { KnowledgeSettings, type AiSettingsView, type MemoryNote } from '@riosoma/contracts';
import { json } from '../../screens/database/share/testing';
import { DatabaseMemories, KnowledgeAdmin, SimilarRecords, PersonalMemories } from './Knowledge';

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => undefined,
  useParams: () => ({ databaseId: 'dbAAAAAAAAAAAAAA' }),
  useSearch: () => ({ database: 'dbAAAAAAAAAAAAAA' }),
  useNavigate: () => vi.fn(),
}));
const clients: Array<() => void> = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
});

it('edits a note with the keyboard and offers undo after deletion', async () => {
  let notes: MemoryNote[] = [
    {
      id: crypto.randomUUID(),
      databaseId: 'dbAAAAAAAAAAAAAA',
      visibility: 'database',
      text: 'Plant in spring',
      updatedAt: new Date().toISOString(),
    },
  ];
  const original = structuredClone(notes);
  const commands: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/schema'))
        return json({ database: { role: 'creator' }, tables: [], fields: [], views: [] });
      if (url.startsWith('/api/knowledge/memories')) return json(notes);
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      commands.push(body);
      if (body.kind === 'knowledge.undo') notes = original;
      else if (body.text === null) notes = [];
      else notes = [{ ...notes[0]!, text: String(body.text), updatedAt: new Date().toISOString() }];
      return json({ status: 'applied', actionId: body.id });
    }),
  );
  const rendered = renderDatabase(<DatabaseMemories />);
  clients.push(() => rendered.client.clear());
  const user = userEvent.setup();
  const input = await screen.findByRole('textbox', { name: 'Note' });
  await user.clear(input);
  await user.type(input, 'Plant in fall');
  await user.keyboard('{Enter}');
  await waitFor(() =>
    expect(commands[0]).toMatchObject({ kind: 'memory.save', visibility: 'database', text: 'Plant in fall' }),
  );
  await user.click(await screen.findByRole('button', { name: 'Delete' }));
  expect(await screen.findByText('No notes saved yet.')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Undo last change' }));
  expect(await screen.findByDisplayValue('Plant in spring')).toBeTruthy();
});

it('shows shared notes without editing controls to a reader', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/schema')
        ? json({ database: { role: 'reader' }, tables: [], fields: [], views: [] })
        : json([
            { id: crypto.randomUUID(), text: 'Shared planting note', updatedAt: new Date().toISOString() },
          ]),
    ),
  );
  const rendered = renderDatabase(<DatabaseMemories />);
  clients.push(() => rendered.client.clear());
  expect(await screen.findByText('Shared planting note')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
});

it('saves admin switches through the command endpoint and displays rejected changes', async () => {
  const commands: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/knowledge/settings') return json(KnowledgeSettings.parse({}));
      commands.push(JSON.parse(String(options?.body)));
      return json({
        status: 'rejected',
        error: { code: 'forbidden', messageKey: 'errors.adminOnly', userFault: true },
      });
    }),
  );
  const view = { providers: [], settings: { providers: [] } } as unknown as AiSettingsView;
  const rendered = renderSharing(<KnowledgeAdmin view={view} />);
  clients.push(() => rendered.client.clear());
  const user = userEvent.setup();
  await user.click(await screen.findByRole('switch', { name: 'Use saved memories' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(commands[0]).toMatchObject({ kind: 'knowledge.settings', settings: { memory: false } }),
  );
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByText('Saved')).toBeNull();
});

it('restores saved admin switches when their change is undone', async () => {
  let settings = KnowledgeSettings.parse({});
  const original = structuredClone(settings);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/knowledge/settings') return json(settings);
      const command = JSON.parse(String(options?.body)) as {
        kind: string;
        id: string;
        settings?: KnowledgeSettings;
      };
      settings = command.kind === 'knowledge.undo' ? original : command.settings!;
      return json({ status: 'applied', actionId: command.id });
    }),
  );
  const view = { providers: [], settings: { providers: [] } } as unknown as AiSettingsView;
  const rendered = renderSharing(<KnowledgeAdmin view={view} />);
  clients.push(() => rendered.client.clear());
  const user = userEvent.setup();
  await user.click(await screen.findByRole('switch', { name: 'Use saved memories' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(settings.memory).toBe(false));
  await user.click(await screen.findByRole('button', { name: 'Undo last change' }));
  await waitFor(() =>
    expect((screen.getByRole('switch', { name: 'Use saved memories' }) as HTMLInputElement).checked).toBe(
      true,
    ),
  );
});

it('renders source titles as text and refuses executable addresses', () => {
  const source = new URL('/reference', window.location.href);
  source.protocol = 'https:';
  const rendered = renderSharing(
    <Block
      block={{
        kind: 'sources',
        sources: [
          { title: '<b>Source</b>', url: source.href, text: '' },
          { title: 'Relative', url: '/relative', text: '' },
          { title: 'Executable', url: 'javascript:alert(1)', text: '' },
        ],
      }}
      session={null}
      disabled={false}
      onAnswer={() => undefined}
      onReplace={() => undefined}
      onReceipt={() => undefined}
      onError={() => undefined}
    />,
  );
  clients.push(() => rendered.client.clear());
  expect(screen.getByRole('heading', { name: 'Sources' })).toBeTruthy();
  expect(screen.getAllByRole('link')).toHaveLength(1);
  const link = screen.getByRole('link', { name: '<b>Source</b> Opens in a new tab' });
  expect(link.getAttribute('href')).toBe(source.href);
  expect(link.querySelector('b')).toBeNull();
});

it('discards an in-flight search after switching tables and permits a new search', async () => {
  const first = 'tbAAAAAAAAAAAAAA';
  const second = 'tbBBBBBBBBBBBBBB';
  let finishFirst!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finishFirst = resolve;
  });
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/schema'))
      return json({
        database: { role: 'creator' },
        tables: [
          { id: first, name: 'Plants', primaryFieldId: 'name' },
          { id: second, name: 'Boats', primaryFieldId: 'name' },
        ],
        fields: [],
        views: [
          { id: 'viewPlants', tableId: first },
          { id: 'viewBoats', tableId: second },
        ],
      });
    if (url.startsWith('/api/knowledge/tables'))
      return json([
        { tableId: first, enabled: true },
        { tableId: second, enabled: true },
      ]);
    const body = JSON.parse(String(options?.body)) as { tableId: string };
    return body.tableId === first
      ? pending
      : json({ records: [{ id: 'boat', values: { name: 'Sailboat' } }] });
  });
  vi.stubGlobal('fetch', fetcher);
  const rendered = renderDatabase(<SimilarRecords />);
  clients.push(() => rendered.client.clear());
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /Table/ }));
  await user.click(screen.getByRole('option', { name: 'Plants' }));
  await user.type(screen.getByRole('textbox', { name: 'Find records about' }), 'orchard');
  await user.click(screen.getByRole('button', { name: 'Find records' }));
  await user.click(screen.getByRole('button', { name: /Table/ }));
  await user.click(screen.getByRole('option', { name: 'Boats' }));
  await act(async () => finishFirst(json({ records: [{ id: 'plant', values: { name: 'Old orchard' } }] })));
  expect(screen.queryByRole('link', { name: 'Old orchard' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Find records' }));
  const result = await screen.findByRole('link', { name: 'Sailboat' });
  expect(result.getAttribute('href')).toContain(second);
  expect(result.getAttribute('href')).toContain('viewBoats');
});

it('saves measured search and embedding power through the settings command', async () => {
  const commands: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/knowledge/settings')
        return json(
          KnowledgeSettings.parse({
            embedding: {
              providerId: 'standin',
              model: 'small',
              address: window.location.origin,
              protocol: 'local',
            },
          }),
        );
      commands.push(JSON.parse(String(options?.body)));
      return json({ status: 'applied', actionId: crypto.randomUUID() });
    }),
  );
  const view = {
    providers: [{ providerId: 'standin', name: 'Stand-in' }],
    settings: { providers: [{ providerId: 'standin' }] },
  } as unknown as AiSettingsView;
  const rendered = renderSharing(<KnowledgeAdmin view={view} />);
  clients.push(() => rendered.client.clear());
  const user = userEvent.setup();
  await user.type(await screen.findByRole('textbox', { name: 'Search power per request (watts)' }), '40');
  await user.type(screen.getByRole('textbox', { name: 'Embedding power per request (watts)' }), '100');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(commands[0]).toMatchObject({
      kind: 'knowledge.settings',
      settings: { search: { powerWatts: 40 }, embedding: { powerWatts: 100 } },
    }),
  );
});

it('sends a paid search key with the settings change that moves its address', async () => {
  const commands: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/knowledge/settings')
        return json({
          ...KnowledgeSettings.parse({
            search: { engine: 'subscription', address: 'https://search.example.test/' },
          }),
          searchKeys: { subscription: true },
        });
      commands.push(JSON.parse(String(options?.body)));
      return json({ status: 'applied', actionId: crypto.randomUUID() });
    }),
  );
  const view = { providers: [], settings: { providers: [] } } as unknown as AiSettingsView;
  const rendered = renderSharing(<KnowledgeAdmin view={view} />);
  clients.push(() => rendered.client.clear());
  const user = userEvent.setup();
  // The stored key stays with the address it was entered for, so a new address needs it typed.
  await user.type(await screen.findByRole('textbox', { name: 'Search service address' }), 'v2');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(commands).toEqual([]);
  await user.type(screen.getByLabelText('Search API key'), 'entered-again');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(commands).toEqual([
      expect.objectContaining({
        kind: 'knowledge.settings',
        searchKey: 'entered-again',
        settings: expect.objectContaining({
          search: expect.objectContaining({ address: 'https://search.example.test/v2' }),
        }),
      }),
    ]),
  );
});

it('stages added notes without saving unrelated edits until the footer is used', async () => {
  const commands: Record<string, unknown>[] = [];
  let notes: MemoryNote[] = [
    {
      id: crypto.randomUUID(),
      databaseId: 'dbAAAAAAAAAAAAAA',
      visibility: 'personal',
      text: 'Original',
      updatedAt: new Date().toISOString(),
    },
  ];
  vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
    if (url.startsWith('/api/knowledge/memories')) return json(notes);
    if (url === '/api/databases') return json([{ id: 'dbAAAAAAAAAAAAAA', name: 'Garden' }]);
    const body = JSON.parse(String(options?.body));
    commands.push(body);
    notes = [
      ...notes.filter((note) => note.id !== body.memoryId),
      {
        id: body.memoryId,
        databaseId: body.databaseId,
        visibility: 'personal',
        text: body.text,
        updatedAt: new Date().toISOString(),
      },
    ];
    return json({ status: 'applied', actionId: body.id });
  });
  const rendered = renderSharing(<PersonalMemories />);
  clients.push(() => rendered.client.clear());
  const user = userEvent.setup();
  await user.type(await screen.findByRole('textbox', { name: /^Note$/ }), ' revised');
  await user.type(screen.getByRole('textbox', { name: 'New note' }), 'Added locally');
  await user.click(screen.getByRole('button', { name: 'Add note' }));
  expect(commands).toEqual([]);
  expect(screen.getByDisplayValue('Added locally')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(commands).toHaveLength(2));
  expect(commands.map((command) => command.text).sort()).toEqual(['Added locally', 'Original revised']);
});

it('marks invalid document import fields and focuses the first one', async () => {
  const commands: unknown[] = [];
  vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
    if (url === '/api/knowledge/settings') return json(KnowledgeSettings.parse({}));
    commands.push(options?.body);
    return json({ status: 'applied', actionId: crypto.randomUUID() });
  });
  const view = { providers: [], settings: { providers: [] } } as unknown as AiSettingsView;
  renderSharing(<KnowledgeAdmin view={view} />);
  const field = await screen.findByRole('textbox', { name: 'Maximum upload size (bytes)' });
  const user = userEvent.setup();
  await user.clear(field);
  await user.type(field, '0');
  await user.click(screen.getByRole('button', { name: /^Save$/ }));
  expect(commands).toEqual([]);
  expect(field.getAttribute('aria-invalid')).toBe('true');
  expect(field.getAttribute('aria-describedby')).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(field));
});
