import { cleanup, createEvent, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { KnowledgeLibrary } from '@riosoma/contracts';
import { json, renderSharing } from '../../screens/database/share/testing';
import { KnowledgeLibraryPanel } from './Libraries';

vi.mock('@tanstack/react-router', () => ({ useParams: () => ({}), useSearch: () => ({}) }));
const clients: Array<() => void> = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
});
it('shows search and document status without mutation controls to a reader', async () => {
  const id = crypto.randomUUID();
  const library: KnowledgeLibrary = {
    id,
    scope: { kind: 'database', databaseId: 'dbAAAAAAAAAAAAAA' },
    name: 'Policies',
    description: 'Member policies',
    label: 'internal',
    guidance: '',
    canManage: false,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/libraries')
        ? json([library])
        : json([
            {
              id: crypto.randomUUID(),
              libraryId: id,
              name: 'Policy',
              status: 'ready',
              errorKey: null,
              size: 10,
              updatedAt: new Date().toISOString(),
            },
          ]),
    ),
  );
  const view = renderSharing(<KnowledgeLibraryPanel scope={library.scope} />);
  clients.push(() => view.client.clear());
  expect(await screen.findByText('Ready to search')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Delete document' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add document' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Save library' }) as HTMLButtonElement).disabled).toBe(true);
});
it('does not search while typing and shows supplied citations after submitting', async () => {
  const library: KnowledgeLibrary = {
    id: crypto.randomUUID(),
    scope: { kind: 'personal' },
    name: 'Policies',
    description: '',
    label: 'internal',
    guidance: '',
    canManage: true,
  };
  const searches: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/libraries')) return json([library]);
      if (url.endsWith('/documents')) return json([]);
      searches.push(JSON.parse(String(options?.body)));
      return json({
        passages: [
          {
            documentId: crypto.randomUUID(),
            libraryId: library.id,
            document: 'Policy',
            section: 'Members',
            text: 'Use member names',
            score: 1,
            url: '/settings/knowledge?document=policy',
          },
        ],
      });
    }),
  );
  const view = renderSharing(<KnowledgeLibraryPanel scope={library.scope} />);
  clients.push(() => view.client.clear());
  const user = userEvent.setup();
  await user.type(await screen.findByRole('textbox', { name: 'Search documents for' }), 'members');
  expect(searches).toEqual([]);
  await user.keyboard('{Enter}');
  expect(await screen.findByText('Use member names')).toBeTruthy();
  expect(searches).toEqual([{ query: 'members', libraryId: library.id }]);
  expect(screen.getByRole('link', { name: /Policy.*Members/ }).getAttribute('href')).toContain(
    'document=policy',
  );
});

async function uploadForm() {
  const library: KnowledgeLibrary = {
    id: crypto.randomUUID(),
    scope: { kind: 'personal' },
    name: 'Policies',
    description: '',
    label: 'internal',
    guidance: '',
    canManage: true,
  };
  const commands: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/libraries')) return json([library]);
      if (url.endsWith('/documents')) return json([]);
      commands.push(JSON.parse(String(options?.body)));
      return json({ id: crypto.randomUUID() });
    }),
  );
  const view = renderSharing(<KnowledgeLibraryPanel scope={library.scope} />);
  clients.push(() => view.client.clear());
  const input = await screen.findByLabelText('Upload a document');
  return { input, commands, library };
}

it('keeps a picked file visible until its upload completes', async () => {
  const { input } = await uploadForm();
  const file = new File(['# Policy'], 'policy.md', { type: 'text/markdown' });
  await userEvent.upload(input, file);
  expect((input as HTMLInputElement).files?.[0]?.name).toBe(file.name);
});

it('accepts a desktop document drop through the upload form and command bus', async () => {
  const { input, commands, library } = await uploadForm();
  const file = new File(['# Policy'], 'policy.md', { type: 'text/markdown' });
  const transfer = { types: ['Files'], files: [file], dropEffect: 'none' };
  const over = createEvent.dragOver(input, { dataTransfer: transfer });
  fireEvent(input, over);
  expect((over as DragEvent).dataTransfer?.dropEffect).toBe('copy');
  expect(screen.getByText(/Drop a document here/)).toBeTruthy();
  fireEvent.drop(input, { dataTransfer: transfer });
  expect(screen.getByText('policy.md')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Add document' }));
  await waitFor(() => expect(commands).toHaveLength(1));
  expect(commands[0]).toMatchObject({
    kind: 'library.document',
    libraryId: library.id,
    name: 'policy.md',
    source: { kind: 'file', base64: btoa('# Policy') },
  });
});

it.each(['size', 'type', 'multiple'])(
  'refuses a desktop upload with invalid %s before submitting',
  async (invalid) => {
    const { input, commands } = await uploadForm();
    const file = new File(['text'], invalid === 'type' ? 'policy.exe' : 'policy.txt');
    if (invalid === 'size') Object.defineProperty(file, 'size', { value: 10 * 1024 * 1024 + 1 });
    fireEvent.drop(input, {
      dataTransfer: { types: ['Files'], files: invalid === 'multiple' ? [file, file] : [file] },
    });
    expect(screen.getByRole('alert').textContent).toMatch(/one.*10 MB/i);
    expect((screen.getByRole('button', { name: 'Add document' }) as HTMLButtonElement).disabled).toBe(true);
    expect(commands).toEqual([]);
  },
);

it('describes the upload limits with two spaces between sentences', async () => {
  const { input } = await uploadForm();
  const help = document.getElementById(input.getAttribute('aria-describedby') ?? '');
  expect(help?.textContent).toBe(
    'One PDF, Word (.docx), Markdown, plain text, or HTML file, up to 10 MB.  Your library may have a lower limit.',
  );
});

it('shows indexing, stops it through the command bus, and checks again until indexing ends', async () => {
  const library: KnowledgeLibrary = {
    id: crypto.randomUUID(),
    scope: { kind: 'personal' },
    name: 'Policies',
    description: '',
    label: 'internal',
    guidance: '',
    canManage: true,
  };
  const waiting = crypto.randomUUID();
  const reading = crypto.randomUUID();
  const statuses: Record<string, string> = { [waiting]: 'indexing', [reading]: 'indexing' };
  const commands: Array<{ kind: string; documentId?: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/libraries')) return json([library]);
      if (url.endsWith('/documents'))
        return json(
          [waiting, reading].map((id, index) => ({
            id,
            libraryId: library.id,
            name: index ? 'Planting' : 'Harvest',
            status: statuses[id],
            errorKey: statuses[id] === 'failed' ? 'libraries.indexCanceled' : null,
            size: 10,
            updatedAt: new Date(0).toISOString(),
          })),
        );
      const command = JSON.parse(String(options?.body)) as { kind: string; documentId?: string };
      commands.push(command);
      statuses[command.documentId!] = 'failed';
      return json({ status: 'applied', actionId: crypto.randomUUID() });
    }),
  );
  const view = renderSharing(<KnowledgeLibraryPanel scope={library.scope} />);
  clients.push(() => view.client.clear());
  expect(await screen.findAllByText('Indexing…')).toHaveLength(2);
  expect(screen.queryByRole('button', { name: 'Re-index' })).toBeNull();
  await userEvent.click(screen.getAllByRole('button', { name: 'Stop indexing' })[0]!);
  await waitFor(() =>
    expect(commands).toEqual([
      expect.objectContaining({ kind: 'library.cancelIndex', libraryId: library.id, documentId: waiting }),
    ]),
  );
  expect(await screen.findByText(/Indexing was stopped\./)).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Re-index' })).toHaveLength(1);
  // The server finishes the other document on its own, and the list finds out without a reload.
  statuses[reading] = 'ready';
  expect(await screen.findByText('Ready to search', undefined, { timeout: 5000 })).toBeTruthy();
  expect(screen.queryByText('Indexing…')).toBeNull();
});

it('keeps search results in place while the list checks on a document still indexing', async () => {
  const library: KnowledgeLibrary = {
    id: crypto.randomUUID(),
    scope: { kind: 'personal' },
    name: 'Policies',
    description: '',
    label: 'internal',
    guidance: '',
    canManage: true,
  };
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/libraries')) return json([library]);
      if (url.endsWith('/documents')) {
        reads += 1;
        return json([
          {
            id: 'waiting',
            libraryId: library.id,
            name: 'Harvest',
            status: 'indexing',
            errorKey: null,
            size: 10,
            updatedAt: new Date(0).toISOString(),
          },
        ]);
      }
      return json({
        passages: [
          {
            documentId: crypto.randomUUID(),
            libraryId: library.id,
            document: 'Policy',
            section: 'Members',
            text: 'Use member names',
            score: 1,
            url: '/settings/knowledge?document=policy',
          },
        ],
      });
    }),
  );
  const view = renderSharing(<KnowledgeLibraryPanel scope={library.scope} />);
  clients.push(() => view.client.clear());
  const user = userEvent.setup();
  await user.type(await screen.findByRole('textbox', { name: 'Search documents for' }), 'members');
  await user.keyboard('{Enter}');
  expect(await screen.findByText('Use member names')).toBeTruthy();
  const before = reads;
  await waitFor(() => expect(reads).toBeGreaterThan(before), { timeout: 5000 });
  expect(screen.getByText('Use member names')).toBeTruthy();
});
