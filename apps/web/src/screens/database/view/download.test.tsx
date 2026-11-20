import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { encodeWhere, GridConfig, newId, type ViewMeta } from '@riosoma/contracts';
import { ToastRegion, toastQueue } from '@riosoma/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderShell, view } from '../shell/test-support';
import { ViewTabs } from '../shell/ViewTabs';
import { themeAccent, useViewDownload } from './download';
import { OfficeDownloadDialog } from './OfficeDownloadDialog';
import { ViewToolbar } from './ViewToolbar';

afterEach(() => {
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The zone the browser reports, which is the one a download has to ask the server for. */
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Copy with the app's two spaces after a period, which a text query normalizes to one. */
const FAILED = /The download didn’t work\.\s+Try again\./;
const OFFLINE = /Riosoma can’t reach the server\.\s+Check your connection and try again\./;

/** What the server sends back: bytes, and the name it chose for the file. */
function file(name: string, body = 'Field 0\r\nValue\r\n'): Response {
  const ascii = name.replace(/[^\x20-\x7E]|["\\]/g, '_');
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  });
}

function refused(messageKey: string): Response {
  return new Response(JSON.stringify({ error: { code: 'not_found', messageKey, userFault: true } }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

/** Records the name every download is saved under, without a browser saving anything. */
function saves(): string[] {
  const saved: string[] = [];
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push(this.download);
  });
  return saved;
}

function Tabs({
  views,
  canEdit = true,
  scope,
}: {
  views: ViewMeta[];
  canEdit?: boolean;
  scope?: { viewId: string; where: string };
}) {
  const downloads = useViewDownload(scope);
  return (
    <>
      <ViewTabs
        views={views}
        activeViewId={views[0]!.id}
        hrefFor={(id) => `/view/${id}`}
        canEdit={canEdit}
        onNavigate={() => {}}
        onCreate={() => {}}
        onRename={() => {}}
        onDuplicate={() => {}}
        onDelete={() => {}}
        downloads={downloads}
      />
      <ToastRegion />
    </>
  );
}

/** The view menu with the dialog a Word document or deck opens, as the database screen has it. */
function TabsWithDialog({ views, scope }: { views: ViewMeta[]; scope?: { viewId: string; where: string } }) {
  const downloads = useViewDownload(scope);
  const choosing = downloads.choosing;
  return (
    <>
      <ViewTabs
        views={views}
        activeViewId={views[0]!.id}
        hrefFor={(id) => `/view/${id}`}
        canEdit
        onNavigate={() => {}}
        onCreate={() => {}}
        onRename={() => {}}
        onDuplicate={() => {}}
        onDelete={() => {}}
        downloads={downloads}
      />
      {choosing && (
        <OfficeDownloadDialog
          format={choosing.format}
          viewName={views.find((item) => item.id === choosing.viewId)!.name}
          onDownload={(choices) => downloads.start(choosing.viewId, choosing.format, choices)}
          onCancel={downloads.cancel}
        />
      )}
      <ToastRegion />
    </>
  );
}

function Toolbar({ viewId }: { viewId: string }) {
  const downloads = useViewDownload();
  return (
    <>
      <ViewToolbar
        config={GridConfig.parse({})}
        fields={[]}
        primaryFieldId={newId('field')}
        downloads={{
          ...downloads.labels,
          busy: downloads.pending !== null,
          pending: downloads.pending?.viewId === viewId,
          onDownload: (format) => downloads.download(viewId, format),
        }}
        onConfigChange={() => {}}
      />
      <ToastRegion />
    </>
  );
}

/**
 * Opens a view's menu with the keyboard alone.  React Aria leaves focus on the panel in this DOM
 * while a browser moves it into the menu, so the test makes that move for the arrow keys.
 */
async function openMenu(label: string): Promise<void> {
  await userEvent.tab();
  await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: label }));
  await userEvent.keyboard('{Enter}');
  await screen.findByRole('menuitem', { name: 'Download CSV' });
  screen.getByRole('menu', { name: label }).focus();
}

function notices(): HTMLElement {
  return screen.getByRole('region', { name: 'Notifications' });
}

const itemNames = () => screen.getAllByRole('menuitem').map((item) => item.textContent);

describe('downloading a view', () => {
  it('carries the active view’s where token and leaves other views unfiltered', async () => {
    const saved = saves();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        calls.push(path);
        return file('Records.csv');
      }),
    );
    const grid = view('Grid');
    const other = view('Other');
    const where = encodeWhere({ conjunction: 'and', conditions: [] });
    renderShell(<Tabs views={[grid, other]} scope={{ viewId: grid.id, where }} />);
    await userEvent.click(screen.getByRole('button', { name: 'More for Grid' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Download CSV' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(new URL(calls[0]!, 'http://localhost').searchParams.get('where')).toBe(where);
    await userEvent.click(screen.getByRole('button', { name: 'More for Other' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Download CSV' }));
    await waitFor(() => expect(saved).toHaveLength(2));
    expect(new URL(calls[1]!, 'http://localhost').searchParams.has('where')).toBe(false);
  });

  it('keeps the where token when a document waits for its download dialog', async () => {
    const saved = saves();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        calls.push(path);
        return file('Records.docx');
      }),
    );
    const grid = view('Grid');
    const where = encodeWhere({ conjunction: 'and', conditions: [] });
    renderShell(<TabsWithDialog views={[grid]} scope={{ viewId: grid.id, where }} />);
    await userEvent.click(screen.getByRole('button', { name: 'More for Grid' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Word document' }));
    const dialog = await screen.findByRole('dialog', { name: 'Download a Word document' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(new URL(calls[0]!, 'http://localhost').searchParams.get('where')).toBe(where);
  });

  it('sends the reader’s zone and language, and saves the file the server names', async () => {
    const saved = saves();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        calls.push(path);
        return file('Tasks - Grid.csv');
      }),
    );
    const grid = view('Grid');
    renderShell(<Tabs views={[grid]} />);
    await openMenu('More for Grid');
    // Focus lands on the first item, so Enter alone downloads a CSV.
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(saved).toEqual(['Tasks - Grid.csv']));
    expect(calls[0]!.startsWith(`/api/views/${grid.id}/export?`)).toBe(true);
    const query = new URL(calls[0]!, 'http://localhost').searchParams;
    expect(query.get('format')).toBe('csv');
    expect(query.get('timeZone')).toBe(ZONE);
    expect(query.get('locale')).toBe('en-US');
    // A name in another script survives the trip, in the form the header carries it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => file('Задачи - Сетка.xlsx')),
    );
    await userEvent.click(screen.getByRole('button', { name: 'More for Grid' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Download Excel' }));
    await waitFor(() => expect(saved).toEqual(['Tasks - Grid.csv', 'Задачи - Сетка.xlsx']));
    expect(calls).toHaveLength(1);
  });

  it('offers both formats in the toolbar overflow, and to a reader', async () => {
    const saved = saves();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        calls.push(path);
        return file('Tasks - Grid.xlsx');
      }),
    );
    const grid = view('Grid');
    const phone = vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
    renderShell(<Toolbar viewId={grid.id} />);
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(itemNames()).toEqual(['Download CSV', 'Download Excel', 'Word document', 'PowerPoint deck']);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Download Excel' }));
    await waitFor(() => expect(saved).toEqual(['Tasks - Grid.xlsx']));
    expect(new URL(calls[0]!, 'http://localhost').searchParams.get('format')).toBe('xlsx');
    cleanup();
    for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
    phone.mockRestore();
    // A reader cannot rename or delete a view, but a download needs only read access.
    renderShell(<Tabs views={[grid]} canEdit={false} />);
    await openMenu('More for Grid');
    expect(itemNames()).toEqual(['Download CSV', 'Download Excel', 'Word document', 'PowerPoint deck']);
  });

  it('holds a second download, says what it is doing, and reports why one failed', async () => {
    const saved = saves();
    let release: ((value: Response) => void) | null = null;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const trigger = (name: string) => screen.getByRole('button', { name });
    renderShell(<Tabs views={[view('Grid'), view('Other')]} />);
    await openMenu('More for Grid');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText('Preparing the file…')).toBeDefined();
    // The menu closed with the press, so the view's own button carries the pending state.
    await waitFor(() => expect(trigger('More for Grid').hasAttribute('data-pending')).toBe(true));
    // Another view's menu still opens, but a second download waits for the first to finish.
    await userEvent.click(trigger('More for Other'));
    await screen.findByRole('menuitem', { name: 'Download CSV' });
    expect(
      screen
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
        ?.slice(0, 2),
    ).toEqual(['Download CSV', 'Download Excel']);
    for (const name of ['Download CSV', 'Download Excel', 'Word document', 'PowerPoint deck'])
      expect(screen.getByRole('menuitem', { name }).getAttribute('aria-disabled')).toBe('true');
    await userEvent.keyboard('{Escape}');
    expect(fetch).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('format=csv'), expect.anything());
    release!(refused('errors.notFound'));
    await waitFor(() => expect(trigger('More for Grid').hasAttribute('data-pending')).toBe(false));
    expect(saved).toEqual([]);
    expect(within(notices()).getByText(FAILED)).toBeDefined();
    // The server's own reason rides along, so a lost grant reads as one rather than a mystery.
    expect(within(notices()).getByText('That page or item doesn’t exist.')).toBeDefined();
    expect(screen.queryByText('Preparing the file…')).toBeNull();
  });

  it('names a file the server forgot to, and says so when the server cannot be reached', async () => {
    const saved = saves();
    const grid = view('Grid');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Field 0\r\n', { headers: { 'content-type': 'text/csv' } })),
    );
    renderShell(<Tabs views={[grid]} />);
    await openMenu('More for Grid');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(saved).toEqual([`${grid.id}.csv`]));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network');
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'More for Grid' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Download Excel' }));
    expect(await within(notices()).findByText(FAILED)).toBeDefined();
    expect(within(notices()).getByText(OFFLINE)).toBeDefined();
    expect(saved).toEqual([`${grid.id}.csv`]);
  });

  it('asks for a title before a Word document, and for a layout before a deck', async () => {
    const saved = saves();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        calls.push(path);
        const format = new URL(path, 'http://localhost').searchParams.get('format');
        return file(`Tasks - Grid.${format}`);
      }),
    );
    const grid = view('Grid');
    renderShell(<TabsWithDialog views={[grid]} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'More for Grid' }));
    await user.click(screen.getByRole('menuitem', { name: 'Word document' }));
    const word = await screen.findByRole('dialog', { name: 'Download a Word document' });
    // Nothing downloads until the dialog says what to call it.
    expect(calls).toEqual([]);
    const title = within(word).getByRole('textbox', { name: 'Title' });
    expect(title).toHaveProperty('value', 'Grid');
    expect(within(word).queryByRole('radiogroup')).toBeNull();
    await user.clear(title);
    await user.type(title, 'Board review');
    await user.click(within(word).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(saved).toEqual(['Tasks - Grid.docx']));
    expect(screen.queryByRole('dialog')).toBeNull();
    const asked = new URL(calls[0]!, 'http://localhost');
    expect(asked.pathname).toBe(`/api/views/${grid.id}/export`);
    expect(Object.fromEntries(asked.searchParams)).toEqual({
      format: 'docx',
      timeZone: ZONE,
      locale: 'en-US',
      title: 'Board review',
    });

    // A deck also asks how to lay the records out, and carries the theme's accent.
    document.documentElement.style.setProperty('--rio-accent', '#336699');
    try {
      await user.click(screen.getByRole('button', { name: 'More for Grid' }));
      await user.click(screen.getByRole('menuitem', { name: 'PowerPoint deck' }));
      const deck = await screen.findByRole('dialog', { name: 'Download a PowerPoint deck' });
      expect(within(deck).getByRole('radio', { name: 'A slide for each record' })).toHaveProperty(
        'checked',
        true,
      );
      await user.click(within(deck).getByRole('radio', { name: 'A table' }));
      await user.click(within(deck).getByRole('button', { name: 'Download' }));
      await waitFor(() => expect(saved).toEqual(['Tasks - Grid.docx', 'Tasks - Grid.pptx']));
    } finally {
      document.documentElement.style.removeProperty('--rio-accent');
    }
    expect(Object.fromEntries(new URL(calls[1]!, 'http://localhost').searchParams)).toEqual({
      format: 'pptx',
      timeZone: ZONE,
      locale: 'en-US',
      title: 'Grid',
      layout: 'table',
      accent: '336699',
    });

    // Cancel closes the dialog and downloads nothing.
    await user.click(screen.getByRole('button', { name: 'More for Grid' }));
    await user.click(screen.getByRole('menuitem', { name: 'Word document' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('reads the theme’s accent in any form a theme writes it', () => {
    expect(themeAccent()).toBeUndefined();
    const root = document.documentElement.style;
    try {
      root.setProperty('--rio-accent', '#AbC');
      expect(themeAccent()).toBe('aabbcc');
      root.setProperty('--rio-accent', '#12AB9f');
      expect(themeAccent()).toBe('12ab9f');
    } finally {
      root.removeProperty('--rio-accent');
    }
  });
});
