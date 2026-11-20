import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  idsOf,
  type ConnectionsView,
  type DriveListing,
  type ProviderConnection,
  type SessionInfo,
} from '@riosoma/contracts';
import { ApiError } from '../../api';
import { openDatabase } from '../../data';
import { settle } from '../../data/testing/relational';
import { renderField } from '../../screens/database/fields/fieldTestUtils';
import { failure, json, renderSharing, session } from '../../screens/database/share/testing';
import { ConnectedAccounts } from '../../screens/settings/connections/ConnectedAccounts';
import { sessionQuery } from '../../session';
import { AttachmentEditor } from '../../grid/editors/AttachmentEditor';
import { AttachmentPanel } from '../AttachmentPanel';
import { attachment, attachmentFixture } from '../testing';
import { attachmentUploads } from '../upload';
import { AddFromMenu } from './AddFromMenu';
import { CONNECTIONS_CHANNEL, connectionStore, importPick, keepConnectionsToPerson } from './api';
import { CONNECT_WAIT_MS } from './ConnectPrompt';
import { DrivePicker } from './DrivePicker';
import { GooglePicker, picksFrom } from './GooglePicker';
import { fitArea, ScreenCrop } from './ScreenCapture';

const CONNECTED = {
  name: 'Dee',
  email: 'dee@example.test',
  connectedAt: '2026-09-01T10:00:00Z',
  needsReconnect: false,
};

function view(
  providers: Partial<Record<'dropbox' | 'box' | 'google', Partial<ProviderConnection>>>,
): ConnectionsView {
  return {
    providers: (['dropbox', 'box', 'google'] as const).map((provider) => ({
      provider,
      available: false,
      account: null,
      ...providers[provider],
    })),
  };
}

const ROOT: DriveListing = {
  entries: [
    { id: 'id:folder', name: 'Projects', kind: 'folder', size: null, modifiedAt: null, thumbnail: false },
    { id: 'id:a', name: 'Garden.png', kind: 'file', size: 2048, modifiedAt: null, thumbnail: true },
    { id: 'id:b', name: 'Notes.txt', kind: 'file', size: 10, modifiedAt: null, thumbnail: false },
  ],
  cursor: null,
};
const INSIDE: DriveListing = {
  entries: [{ id: 'id:c', name: 'Plan.pdf', kind: 'file', size: 4096, modifiedAt: null, thumbnail: false }],
  cursor: null,
};

let requests: Array<{ url: string; method: string }> = [];

function serve(connections: ConnectionsView) {
  requests = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET' });
    if (url === '/api/connections') return json(connections);
    if (url.startsWith('/api/connections/dropbox/files')) {
      const folder = new URL(url, 'http://localhost').searchParams.get('folder');
      return json(folder === 'id:folder' ? INSIDE : ROOT);
    }
    if (url === '/api/connections/dropbox' && init?.method === 'DELETE')
      return new Response(null, { status: 204 });
    return json({ error: { code: 'not_found', messageKey: 'errors.notFound', userFault: true } }, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

beforeEach(() => {
  connectionStore.reset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('loads available cloud drives when an attachment menu mounts with an empty store', async () => {
  serve(view({ dropbox: { available: true } }));
  expect(connectionStore.snapshot()).toBeNull();
  const props = { locale: 'en-US', onFiles: vi.fn(), onPicks: vi.fn() };
  renderSharing(
    <>
      <AddFromMenu {...props} />
      <AddFromMenu {...props} />
    </>,
  );

  await waitFor(() => expect(requests).toContainEqual({ url: '/api/connections', method: 'GET' }));
  await userEvent.click((await screen.findAllByRole('button', { name: 'More ways to add' }))[0]!);
  expect(await screen.findByRole('menuitem', { name: 'From Dropbox' })).toBeTruthy();
  expect(requests.filter((request) => request.url === '/api/connections')).toHaveLength(1);
});

describe('the Dropbox and Box picker', () => {
  it('moves with the arrow keys, picks with Space, opens folders with Enter, and keeps picks across folders', async () => {
    serve(view({ dropbox: { available: true, account: CONNECTED } }));
    const onPick = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderSharing(<DrivePicker provider="dropbox" locale="en-US" onPick={onPick} onClose={onClose} />);
    const grid = await screen.findByRole('grid', { name: 'Dropbox' });
    await waitFor(() =>
      expect(
        within(grid)
          .getAllByRole('row')
          .map((row) => row.textContent),
      ).toEqual(['ProjectsFolder', 'Garden.png2 kB', 'Notes.txt10 byte']),
    );
    const rows = within(grid).getAllByRole('row');
    expect(rows[1]!.querySelector('img')?.getAttribute('src')).toBe(
      '/api/connections/dropbox/thumbnails/id%3Aa',
    );
    expect(rows[2]!.querySelector('img')).toBeNull();
    act(() => rows[0]!.focus());
    await user.keyboard('{ArrowDown} ');
    await user.keyboard('{ArrowDown} ');
    await waitFor(() => expect(screen.getByText('2 selected')).toBeTruthy());
    // A folder can't be picked, only opened.
    await user.keyboard('{ArrowUp}{ArrowUp} ');
    expect(screen.getByText('2 selected')).toBeTruthy();
    await user.keyboard('{Enter}');
    const inside = await screen.findByRole('grid', { name: 'Projects' });
    const plan = await within(inside).findByRole('row', { name: /Plan\.pdf/ });
    act(() => plan.focus());
    await user.keyboard(' ');
    await waitFor(() => expect(screen.getByText('3 selected')).toBeTruthy());
    // The trail leads back up, where the earlier picks are still picked.
    await user.click(screen.getByRole('button', { name: 'Dropbox' }));
    const top = await screen.findByRole('grid', { name: 'Dropbox' });
    await waitFor(() =>
      expect(
        within(top)
          .getAllByRole('row')
          .map((row) => row.getAttribute('aria-selected')),
      ).toEqual([null, 'true', 'true']),
    );
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(onPick).toHaveBeenCalledWith([
      { provider: 'dropbox', fileId: 'id:a', name: 'Garden.png', size: 2048 },
      { provider: 'dropbox', fileId: 'id:b', name: 'Notes.txt', size: 10 },
      { provider: 'dropbox', fileId: 'id:c', name: 'Plan.pdf', size: 4096 },
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it('picks a file with a click or a tap, unpicks it the same way, and opens a folder with one', async () => {
    serve(view({ dropbox: { available: true, account: CONNECTED } }));
    const onPick = vi.fn();
    const user = userEvent.setup();
    renderSharing(<DrivePicker provider="dropbox" locale="en-US" onPick={onPick} onClose={() => {}} />);
    const grid = await screen.findByRole('grid', { name: 'Dropbox' });
    const garden = await within(grid).findByRole('row', { name: /Garden\.png/ });
    await user.click(garden);
    await waitFor(() => expect(screen.getByText('1 selected')).toBeTruthy());
    expect(garden.getAttribute('aria-selected')).toBe('true');
    await user.click(within(grid).getByRole('row', { name: /Notes\.txt/ }));
    await waitFor(() => expect(screen.getByText('2 selected')).toBeTruthy());
    await user.click(garden);
    await waitFor(() => expect(screen.getByText('1 selected')).toBeTruthy());
    await user.click(within(grid).getByRole('row', { name: /Projects/ }));
    const inside = await screen.findByRole('grid', { name: 'Projects' });
    await user.click(await within(inside).findByRole('row', { name: /Plan\.pdf/ }));
    await waitFor(() => expect(screen.getByText('2 selected')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(onPick).toHaveBeenCalledWith([
      { provider: 'dropbox', fileId: 'id:b', name: 'Notes.txt', size: 10 },
      { provider: 'dropbox', fileId: 'id:c', name: 'Plan.pdf', size: 4096 },
    ]);
  });

  it('searches the whole drive', async () => {
    serve(view({ dropbox: { available: true, account: CONNECTED } }));
    const user = userEvent.setup();
    renderSharing(<DrivePicker provider="dropbox" locale="en-US" onPick={() => {}} onClose={() => {}} />);
    await screen.findByRole('grid', { name: 'Dropbox' });
    await user.type(screen.getByRole('searchbox', { name: 'Search Dropbox' }), 'plan{Enter}');
    await screen.findByRole('grid', { name: 'Search results' });
    expect(requests.some((request) => request.url.includes('query=plan'))).toBe(true);
  });

  it('asks to connect first, in a window of its own', async () => {
    serve(view({ dropbox: { available: true } }));
    const open = vi.fn(() => ({ closed: false }) as Window);
    vi.stubGlobal('open', open);
    const user = userEvent.setup();
    renderSharing(<DrivePicker provider="dropbox" locale="en-US" onPick={() => {}} onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Connect Dropbox' }));
    expect(open).toHaveBeenCalledWith(
      '/api/oauth/start/dropbox?next=%2Fconnected%2Fdropbox',
      'rio-connect-dropbox',
      'popup,width=560,height=720',
    );
    expect(requests.some((request) => request.url.includes('/files'))).toBe(false);
  });
});

describe('connecting in a window of its own', () => {
  /** What the window that connects says when it lands, the way another window hears it. */
  function landed(message: Record<string, unknown>) {
    const newValue = JSON.stringify({ id: crypto.randomUUID(), ...message });
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: CONNECTIONS_CHANNEL, newValue }));
    });
  }

  it('keeps waiting while the provider has the window, and hears how it went without a channel', async () => {
    const fetch = serve(view({ dropbox: { available: true } }));
    vi.stubGlobal('BroadcastChannel', undefined);
    // The opener policy cuts the window off, so it reads as closed while it's still open.
    vi.stubGlobal(
      'open',
      vi.fn(() => ({ closed: true }) as Window),
    );
    const user = userEvent.setup();
    renderSharing(<DrivePicker provider="dropbox" locale="en-US" onPick={() => {}} onClose={() => {}} />);
    const button = await screen.findByRole('button', { name: 'Connect Dropbox' });
    await user.click(button);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(button.hasAttribute('data-pending')).toBe(true);
    const before = fetch.mock.calls.length;
    landed({ provider: 'dropbox', ok: false, error: 'drives.connect.denied' });
    await waitFor(() => expect(button.hasAttribute('data-pending')).toBe(false));
    expect(screen.getByText(/access wasn’t allowed/)).toBeTruthy();
    expect(fetch.mock.calls.length).toBeGreaterThan(before);
  });

  it('stops waiting after ten minutes, when the server has forgotten the attempt', async () => {
    serve(view({ dropbox: { available: true } }));
    vi.stubGlobal(
      'open',
      vi.fn(() => ({ closed: false }) as Window),
    );
    renderSharing(<DrivePicker provider="dropbox" locale="en-US" onPick={() => {}} onClose={() => {}} />);
    const button = await screen.findByRole('button', { name: 'Connect Dropbox' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(button);
      expect(button.hasAttribute('data-pending')).toBe(true);
      act(() => vi.advanceTimersByTime(CONNECT_WAIT_MS - 1000));
      expect(button.hasAttribute('data-pending')).toBe(true);
      act(() => vi.advanceTimersByTime(1000));
      expect(button.hasAttribute('data-pending')).toBe(false);
      expect(screen.getByText(/Connecting took too long/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the connection store', () => {
  it('forgets one person’s accounts when someone else signs in to the tab', async () => {
    const client = new QueryClient();
    const stop = keepConnectionsToPerson(client);
    try {
      client.setQueryData(sessionQuery.queryKey, session);
      serve(view({ dropbox: { available: true, account: CONNECTED } }));
      await connectionStore.load();
      expect(connectionStore.provider('dropbox')?.account).toMatchObject({ email: 'dee@example.test' });
      // Saving a preference keeps the same person, and what the store read.
      const saved: SessionInfo = { ...session, preferences: { ...session.preferences, locale: 'fr' } };
      client.setQueryData(sessionQuery.queryKey, saved);
      expect(connectionStore.snapshot()).not.toBeNull();
      // A read that's still going when the person signs out never lands.
      const late = connectionStore.load(true);
      client.setQueryData(sessionQuery.queryKey, null);
      expect(connectionStore.snapshot()).toBeNull();
      await late;
      expect(connectionStore.snapshot()).toBeNull();
      const someoneElse: SessionInfo = { ...session, user: { ...session.user, id: 'user_bea' } };
      client.setQueryData(sessionQuery.queryKey, someoneElse);
      serve(view({ dropbox: { available: true } }));
      await connectionStore.load();
      expect(connectionStore.provider('dropbox')?.account).toBeNull();
    } finally {
      stop();
    }
  });
});

describe('the Google Drive picker', () => {
  it('offers to connect again when Google stopped accepting the account', async () => {
    let asked = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/connections') {
        asked++;
        // The server marks the account when it's refused, so the second read says so.
        return json(
          view({
            google: { available: true, account: { ...CONNECTED, needsReconnect: asked > 1 } },
          }),
        );
      }
      if (url === '/api/connections/google/picker') return failure('drives.reconnect', 403);
      return json({ error: { code: 'not_found', messageKey: 'errors.notFound', userFault: true } }, 404);
    });
    vi.stubGlobal('fetch', fetch);
    renderSharing(<GooglePicker locale="en-US" onPick={() => {}} onClose={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Connect Google Drive' })).toBeTruthy();
    expect(screen.getByText(/Google Drive stopped accepting Riosoma’s access/)).toBeTruthy();
    await waitFor(() => expect(asked).toBe(2));
    expect(connectionStore.provider('google')?.account?.needsReconnect).toBe(true);
  });
});

describe('the ways to add', () => {
  it('offers only the drives an admin set up and left on, and the camera and screen where the browser has them', async () => {
    serve(view({ dropbox: { available: true }, box: { available: false }, google: { available: true } }));
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn(), getDisplayMedia: vi.fn() },
    });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const user = userEvent.setup();
    await connectionStore.load();
    renderSharing(<AddFromMenu locale="en-US" onFiles={() => {}} onPicks={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'More ways to add' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'From Dropbox',
      'From Google Drive',
      'Take photo',
      'Capture screen',
    ]);
  });

  it('leaves the menu out when nothing else can work', async () => {
    serve(view({ dropbox: { available: false, account: CONNECTED } }));
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: undefined });
    await connectionStore.load();
    renderSharing(<AddFromMenu locale="en-US" onFiles={() => {}} onPicks={() => {}} />);
    expect(screen.queryByRole('button', { name: 'More ways to add' })).toBeNull();
  });
});

describe('copying a picked file', () => {
  function lines(...events: unknown[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  }
  const target = { tableId: 'tbl1', fieldId: 'fld1', recordId: 'rec1' };

  it('reads its progress and the stored file', async () => {
    const file = attachment('Garden.png');
    const fetch = vi.fn(async () =>
      lines(
        { kind: 'progress', bytes: 0, total: 200 },
        { kind: 'progress', bytes: 100, total: 200 },
        { kind: 'done', file },
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const progress = vi.fn();
    const pick = {
      provider: 'google' as const,
      fileId: 'doc1',
      name: 'Plan',
      size: null,
      exportAs: 'docx' as const,
    };
    await expect(importPick(target, pick, progress, new AbortController().signal)).resolves.toEqual(file);
    expect(progress.mock.calls).toEqual([[0], [0.5]]);
    expect(fetch).toHaveBeenCalledWith(
      '/api/tables/tbl1/fields/fld1/records/rec1/imports',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ provider: 'google', fileId: 'doc1', exportAs: 'docx' }),
      }),
    );
  });

  it('turns a failure line into the server’s message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        lines({
          kind: 'failed',
          error: { code: 'payload_too_large', messageKey: 'data.file.tooLarge', userFault: true },
        }),
      ),
    );
    const failed = importPick(
      target,
      { provider: 'box', fileId: '1', name: 'a', size: 1 },
      () => {},
      new AbortController().signal,
    );
    await expect(failed).rejects.toBeInstanceOf(ApiError);
    await expect(failed).rejects.toMatchObject({ status: 413, info: { messageKey: 'data.file.tooLarge' } });
  });
});

describe('Google files', () => {
  it('become PDF by default, or their own Office format', () => {
    const documents = [
      { id: 'd', name: 'Plan', mimeType: 'application/vnd.google-apps.document' },
      { id: 's', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet' },
      { id: 'p', name: 'Pitch', mimeType: 'application/vnd.google-apps.presentation' },
      { id: 'g', name: 'Sketch', mimeType: 'application/vnd.google-apps.drawing' },
      { id: 'b', name: 'photo.png', mimeType: 'image/png', sizeBytes: '512' },
    ];
    expect(picksFrom(documents, 'pdf').map((pick) => pick.exportAs)).toEqual([
      'pdf',
      'pdf',
      'pdf',
      'pdf',
      undefined,
    ]);
    expect(picksFrom(documents, 'office').map((pick) => pick.exportAs)).toEqual([
      'docx',
      'xlsx',
      'pptx',
      'pdf',
      undefined,
    ]);
    expect(picksFrom(documents, 'office').at(-1)).toMatchObject({ size: 512 });
  });
});

describe('the screen capture crop', () => {
  it('keeps the area inside the picture', () => {
    expect(fitArea({ x: -5, y: 700, width: 900, height: 40 }, 800, 600)).toEqual({
      x: 0,
      y: 560,
      width: 800,
      height: 40,
    });
  });

  it('moves the area with the arrow keys and resizes it with Shift', async () => {
    vi.stubGlobal(
      'URL',
      Object.assign(Object.create(URL), URL, {
        createObjectURL: () => 'blob:capture',
        revokeObjectURL: () => {},
      }),
    );
    const capture = {
      width: 800,
      height: 600,
      toBlob: (done: (blob: Blob) => void) => done(new Blob(['x'])),
    };
    renderSharing(
      <ScreenCrop
        capture={capture as unknown as HTMLCanvasElement}
        onCapture={() => {}}
        onClose={() => {}}
      />,
    );
    const area = await screen.findByRole('group', { name: 'Area to keep, 800 by 600 pixels' });
    fireEvent.keyDown(area, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(area, { key: 'ArrowUp', shiftKey: true, altKey: true });
    expect(area.getAttribute('aria-label')).toBe('Area to keep, 790 by 599 pixels');
    fireEvent.keyDown(area, { key: 'ArrowRight' });
    expect(area.style.insetInlineStart).toBe(`${(10 / 800) * 100}%`);
  });
});

describe('connected accounts', () => {
  it('lists the accounts and disconnects one after asking', async () => {
    serve(view({ dropbox: { available: true, account: CONNECTED }, google: { available: true } }));
    const user = userEvent.setup();
    renderSharing(<ConnectedAccounts />);
    expect(await screen.findByText(/Dee \(dee@example\.test\), connected/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect Google Drive' })).toBeTruthy();
    expect(screen.queryByText('Box')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Disconnect Dropbox' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect Dropbox?' });
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() =>
      expect(requests).toContainEqual({ url: '/api/connections/dropbox', method: 'DELETE' }),
    );
  });
});

describe('copies in the attachment panel', () => {
  it('shows each copy’s progress, cancels one, and appends the rest to the record', async () => {
    const f = attachmentFixture([]);
    const session = await openDatabase(f.source.databaseId, f.deps);
    const view = session.openView(f.source.viewId);
    await settle();
    const row = view.getRow(0)!;
    const copies: Array<{ body: string; signal: AbortSignal; send(event: unknown): void; end(): void }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
        const signal = init.signal!;
        signal.addEventListener('abort', () => controller.error(signal.reason));
        copies.push({
          body: String(init.body),
          signal,
          send: (event) => controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`)),
          end: () => controller.close(),
        });
        return new Response(body, { status: 200 });
      }),
    );
    renderField(
      <AttachmentPanel
        field={f.field}
        recordId={row.id}
        ids={[]}
        session={session}
        locale="en-US"
        onChange={() => {}}
      />,
    );
    const uploads = attachmentUploads(session, f.source.tableId, f.field.id, row.id);
    act(() =>
      uploads.addRemote([
        { provider: 'dropbox', fileId: 'id:a', name: 'Keep.png', size: 100 },
        { provider: 'dropbox', fileId: 'id:b', name: 'Stop.png', size: 100 },
      ]),
    );
    await waitFor(() => expect(copies).toHaveLength(2));
    await act(async () => {
      copies[0]!.send({ kind: 'progress', bytes: 50, total: 100 });
      await settle();
    });
    await waitFor(() =>
      expect(
        screen.getByRole('progressbar', { name: 'Copying Keep.png' }).getAttribute('aria-valuenow'),
      ).toBe('50'),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel copying Stop.png' }));
    expect(copies[1]!.signal.aborted).toBe(true);
    expect(screen.queryByRole('progressbar', { name: 'Copying Stop.png' })).toBeNull();
    const kept = attachment('Keep.png');
    await act(async () => {
      copies[0]!.send({ kind: 'done', file: kept });
      copies[0]!.end();
      await settle();
    });
    await waitFor(() =>
      expect(idsOf(session.cachedRecord(f.source.tableId, row.id)!.values[f.field.id] ?? null)).toEqual([
        kept.id,
      ]),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    session.close();
  });
});

describe('a picker opened from a grid cell', () => {
  it('stays open with its cell editor when a button inside it is pressed', async () => {
    serve(view({ dropbox: { available: true } }));
    const open = vi.fn(() => ({ closed: false }) as Window);
    vi.stubGlobal('open', open);
    const f = attachmentFixture([]);
    const session = await openDatabase(f.source.databaseId, f.deps);
    const rows = session.openView(f.source.viewId);
    await settle();
    const anchor = document.createElement('div');
    document.body.append(anchor);
    const done = vi.fn();
    const user = userEvent.setup();
    renderField(
      <AttachmentEditor
        request={{
          cell: { row: 0, col: 0 },
          column: { id: f.field.id, edit: 'custom', width: 180 },
          row: rows.getRow(0)!,
          initialText: null,
          anchor,
          done,
          cancel: vi.fn(),
        }}
        context={{
          field: f.field,
          session,
          format: { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() },
          canEditOptions: false,
          apply: vi.fn(),
          addOption: vi.fn(() => ''),
        }}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'More ways to add' }));
    await user.click(await screen.findByRole('menuitem', { name: 'From Dropbox' }));
    await user.click(await screen.findByRole('button', { name: 'Connect Dropbox' }));
    expect(done).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      '/api/oauth/start/dropbox?next=%2Fconnected%2Fdropbox',
      'rio-connect-dropbox',
      'popup,width=560,height=720',
    );
    expect(screen.getByRole('dialog', { name: 'Add from Dropbox' })).toBeTruthy();
    // Google draws its picker on the page itself, outside any dialog of the app's.
    const drawn = document.createElement('div');
    drawn.className = 'picker-dialog-bg';
    document.body.append(drawn);
    fireEvent.pointerDown(drawn);
    drawn.remove();
    expect(done).not.toHaveBeenCalled();
    // A press on the page itself still ends the edit.
    fireEvent.pointerDown(anchor);
    expect(done).toHaveBeenCalledExactlyOnceWith('none');
    anchor.remove();
    session.close();
  });
});
