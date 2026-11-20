import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DatabaseSchema,
  RowData,
  RioBlock,
  RioContext,
  RioEvent,
  RioMessage,
  RioStatus,
  UndoPreview,
} from '@riosoma/contracts';
import { I18nProvider } from '@lingui/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { i18n } from '@lingui/core';
import { RioAssistantView } from './RioAssistant';
import { PLAN_APPLIED } from './PlanPreview';
import { RIO_DANCE_MS, rioReact } from './reactions';
import { setCsrfToken } from '../../api';
import { openDatabase } from '../../data/session';
import type { DatabaseSession } from '../../data/types';
import { FakeServer } from '../../data/testing';
import { createGridController } from '../../grid/view/controller';
import { json, failure, renderSharing } from '../../screens/database/share/testing';

i18n.load('en-US', {});
i18n.activate('en-US');

const ready: RioStatus = {
  enabled: true,
  paused: false,
  tiers: ['everyday', 'power'],
  autonomy: 'previewBig',
  diagnose: true,
  routines: false,
  routineRunLimitUsd: 1,
};
const conversation = {
  id: 'conversation-one',
  title: 'Earlier work',
  createdAt: '2026-09-27T10:00:00Z',
  updatedAt: '2026-09-27T10:00:00Z',
};
const reply: RioMessage = { id: 'reply-one', role: 'rio', blocks: [], createdAt: conversation.createdAt };
const plan: RioBlock = {
  kind: 'plan',
  planId: 'plan-one',
  databaseId: 'database-one',
  summary: 'Update the records',
  steps: ['Set the value', 'Check the result'],
  needsApproval: true,
  status: 'pending',
};
const receipt: RioBlock = {
  kind: 'receipt',
  planId: 'plan-one',
  databaseId: 'database-one',
  groupId: 'group-one',
  summary: 'Updated the records',
};
const cleanupTasks: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const task of cleanupTasks.splice(0)) task();
  setCsrfToken(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

function start(
  options: {
    status?: RioStatus;
    phone?: boolean;
    canManage?: boolean;
    context?: RioContext;
    session?: DatabaseSession;
    historyBlocks?: RioBlock[];
    historyMessages?: RioMessage[];
    discovery?: { schema: DatabaseSchema; rows: RowData[] };
    waitForRecords?: () => Promise<void>;
    undoPreview?: UndoPreview;
    open?: boolean;
    footprint?: Record<string, unknown>;
  } = {},
) {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let streamSignal: AbortSignal | undefined;
  let blockResult: Response | undefined;
  let compactResult: Response | undefined;
  const encoder = new TextEncoder();
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (options.discovery) {
      if (url === '/api/databases') return json([options.discovery.schema.database]);
      if (url.endsWith('/schema')) return json(options.discovery.schema);
      if (url.includes('/records/')) {
        await options.waitForRecords?.();
        return json(options.discovery.rows.find((row) => url.endsWith(row.id)));
      }
    }
    if (url === '/api/rio/active-conversation')
      return json(
        init?.method === 'PUT'
          ? {
              conversation,
              messages: options.historyMessages ?? [{ ...reply, blocks: options.historyBlocks ?? [plan] }],
            }
          : { conversation: { ...conversation, id: 'active-one' }, messages: [] },
      );
    if (url === '/api/rio/status') return json(options.status ?? ready);
    if (url === '/api/ai/footprint/mine') return json(options.footprint ?? { used: false });
    if (url.endsWith('/messages')) {
      streamSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    if (url.endsWith('/compact'))
      return (
        compactResult ??
        json({
          conversation: { ...conversation, id: 'active-one', contextUsage: { tokens: 200, limit: 32000 } },
          messages: [
            { ...reply, summarized: true, blocks: [{ kind: 'text', text: 'Earlier reply' }] },
            {
              ...reply,
              id: 'compact-one',
              compaction: true,
              usage: {
                providerId: 'fixture',
                model: 'configured',
                inputTokens: 200,
                outputTokens: 40,
                costUsd: null,
                ms: 10,
                footprint: null,
              },
              blocks: [{ kind: 'notice', messageKey: 'rio.compacted' }],
            },
          ],
        })
      );
    if (url.endsWith('/apply')) return blockResult ?? json(receipt);
    if (url.endsWith('/dismiss')) return new Response(null, { status: 204 });
    if (url.includes('/undo-preview/')) return json(options.undoPreview ?? { creations: [] });
    if (url.endsWith('/undo') || url.startsWith('/api/home/undo/'))
      return blockResult ?? json({ status: 'applied', skipped: 0 });
    if (url === '/api/rio/conversations')
      return json(init?.method === 'POST' ? conversation : [conversation]);
    if (url === `/api/rio/conversations/${conversation.id}`)
      return json({ conversation, messages: [{ ...reply, blocks: options.historyBlocks ?? [plan] }] });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  setCsrfToken('csrf-test');
  const rendered = renderSharing(
    <RioAssistantView
      phone={options.phone ?? false}
      canManage={options.canManage ?? true}
      context={options.context ?? {}}
      session={options.session ?? null}
      initialOpen={options.open ?? false}
    />,
  );
  cleanupTasks.push(() => rendered.client.clear());
  const user = userEvent.setup();
  return {
    ...rendered,
    remount: async () => {
      const wrap = (children: React.ReactNode) => (
        <I18nProvider i18n={i18n}>
          <QueryClientProvider client={rendered.client}>{children}</QueryClientProvider>
        </I18nProvider>
      );
      rendered.rerender(wrap(null));
      rendered.rerender(
        wrap(
          <RioAssistantView
            phone={options.phone ?? false}
            canManage
            context={options.context ?? {}}
            session={options.session ?? null}
          />,
        ),
      );
      await screen.findByRole('textbox');
    },
    user,
    fetcher,
    signal: () => streamSignal,
    blockResult: (result: Response) => {
      blockResult = result;
    },
    compactResult: (result: Response) => {
      compactResult = result;
    },
    async open() {
      await user.click(screen.getByRole('button', { name: 'AI: Ask Rio' }));
      await screen.findByRole('textbox');
      await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
    },
    async send(text = 'Help with this table') {
      await user.type(screen.getByRole('textbox'), text);
      await user.keyboard('{Enter}');
      await waitFor(() => expect(stream).toBeDefined());
    },
    async event(event: RioEvent) {
      await act(async () => {
        stream!.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\r\n\r\n`));
      });
    },
    async disconnect() {
      await act(async () => stream!.close());
    },
    async history() {
      await user.click(screen.getByRole('button', { name: 'Past conversations' }));
      await user.click(await screen.findByRole('menuitem', { name: /Earlier work/ }));
    },
  };
}

const mood = () => document.querySelector('.rio-avatar')?.getAttribute('data-mood');

describe('Rio panel', () => {
  it.each([false, true])(
    'closes with Escape from the composer and restores launcher focus (phone: %s)',
    async (phone) => {
      const app = start({ phone });
      await app.open();
      await app.user.click(screen.getByRole('textbox'));
      await app.user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'AI: Ask Rio' })),
      );
    },
  );

  it.each(['event', 'block', 'connection'])(
    'restores a failed question for editing and resending after a %s failure',
    async (failure) => {
      const app = start();
      await app.open();
      await app.send('次の質問 🌱 مرحبا');
      await app.event({ type: 'start', message: reply });
      if (failure === 'connection') {
        // An incomplete stream must leave the question available for another attempt.
        await app.event({ type: 'text', blockIndex: 0, delta: 'Partial reply' });
        await app.disconnect();
      } else if (failure === 'event') {
        await app.event({ type: 'error', messageKey: 'errors.internal' });
      } else {
        await app.event({
          type: 'block',
          blockIndex: 0,
          block: { kind: 'error', messageKey: 'errors.internal' },
        });
        await app.event({ type: 'done' });
      }
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('次の質問 🌱 مرحبا');
      await app.user.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() =>
        expect(app.fetcher.mock.calls.filter(([url]) => url.endsWith('/messages'))).toHaveLength(2),
      );
    },
  );

  it('preserves a newer draft when a reply fails', async () => {
    const app = start();
    await app.open();
    await app.send('First question');
    await app.user.type(screen.getByRole('textbox'), 'Next question');
    await app.event({ type: 'error', messageKey: 'errors.internal' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Next question');
  });

  it('keeps overlong input editable and explains why it cannot be sent', async () => {
    const app = start();
    await app.open();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'a'.repeat(8001) } });
    expect((input as HTMLTextAreaElement).maxLength).toBe(-1);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Keep your message to 8,000 characters or fewer.')).toBeDefined();
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    await app.user.click(input);
    await app.user.keyboard('{Enter}');
    expect(app.signal()).toBeUndefined();
    fireEvent.change(input, { target: { value: 'a'.repeat(8000) } });
    expect(input.getAttribute('aria-invalid')).not.toBe('true');
    await app.user.keyboard('{Enter}');
    await waitFor(() => expect(app.signal()).toBeDefined());
  });

  it.each([false, true])(
    'keeps an approval receipt when the plan completes while the panel is closed (phone: %s)',
    async (phone) => {
      const app = start({ phone });
      await app.open();
      await app.send();
      await app.event({ type: 'start', message: reply });
      await app.event({ type: 'block', blockIndex: 0, block: plan });
      await app.event({ type: 'done' });
      await screen.findByRole('button', { name: 'Apply' });
      await app.user.click(screen.getByRole('button', { name: 'Close Rio' }));
      await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
      await act(async () => {
        window.dispatchEvent(new CustomEvent(PLAN_APPLIED, { detail: receipt }));
      });
      await app.open();
      await screen.findByRole('button', { name: 'Undo' });
      expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
      expect(screen.getByText(receipt.summary)).toBeDefined();
    },
  );

  it.each([false, true])(
    'opens, moves focus inside, closes, and restores focus (phone: %s)',
    async (phone) => {
      const app = start({ phone });
      const pet = screen.getByRole('button', { name: 'AI: Ask Rio' });
      await app.open();
      const panel = phone
        ? screen.getByRole('dialog', { name: 'Rio' })
        : screen.getByRole('complementary', { name: 'Rio' });
      expect(panel.contains(document.activeElement)).toBe(true);
      if (phone) expect(document.querySelector('.rio-assistant__sheet')).not.toBeNull();
      expect(screen.getByText(/Hi!.*I’m Rio/).textContent).toBe(
        'Hi!  I’m Rio.  Ask me to find records, explain a table, or build something for you.',
      );
      await app.user.click(screen.getByRole('button', { name: 'Close Rio' }));
      await waitFor(() => expect(document.activeElement).toBe(pet));
      expect(screen.queryByRole('textbox')).toBeNull();
      await app.open();
      await app.user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    },
  );

  it('sends Enter, preserves Shift+Enter, streams safe Markdown and usage, and follows working moods', async () => {
    const app = start();
    await app.open();
    await app.user.click(screen.getByRole('button', { name: 'Thorough' }));
    await app.user.type(screen.getByRole('textbox'), 'First line');
    await app.user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(app.signal()).toBeUndefined();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('First line\n');
    await app.send('Second line');
    expect(mood()).toBe('thinking');
    const request = app.fetcher.mock.calls.find(([url]) => url.endsWith('/messages'))!;
    expect(JSON.parse(request[1]!.body as string)).toMatchObject({
      text: 'First line\nSecond line',
      context: {},
      tier: 'power',
      autonomy: 'previewBig',
      locale: 'en-US',
    });
    expect(request[1]?.headers).toMatchObject({ 'x-csrf-token': 'csrf-test' });
    await app.event({ type: 'start', message: reply });
    await app.event({
      type: 'text',
      blockIndex: 0,
      delta: '**Strong** and *gentle* `code` [site](https://example.com)\n\n- one\n- two\n\n',
    });
    expect(mood()).toBe('happy');
    expect(screen.getByText('Strong').tagName).toBe('STRONG');
    expect(screen.getByText('gentle').tagName).toBe('EM');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'site' }).getAttribute('href')).toBe('https://example.com');
    await app.event({ type: 'working', messageKey: 'rio.working.schema' });
    expect(screen.getByRole('status').textContent).toBe('Reading the table’s setup…');
    expect(mood()).toBe('thinking');
    await app.event({
      type: 'text',
      blockIndex: 0,
      delta: '<img src=x onerror=alert(1)>\n\n[bad](javascript:alert)',
    });
    expect(screen.getByText(/<img src=x/)).toBeDefined();
    expect(document.querySelector('.rio-assistant__conversation img')).toBeNull();
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
    await app.event({
      type: 'usage',
      usage: {
        providerId: 'registry',
        model: 'configured',
        inputTokens: 8,
        outputTokens: 12,
        costUsd: 0.01,
        ms: 20,
      },
    });
    expect(screen.getByText('configured · 20 tokens · $0.01')).toBeDefined();
    await app.event({ type: 'done' });
    expect(mood()).toBe('idle');
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it.each([
    [
      {
        energyWh: { min: 0.41, max: 0.93 },
        gwpG: { min: 0.12, max: 0.34 },
        method: 'EcoLogits 0.11.1',
        zone: 'WOR',
      },
      'Estimate: about 0.41 to 0.93 Wh and 0.12 to 0.34 g CO2e',
    ],
    [null, 'No energy or carbon estimate for this model'],
  ])('shows a reply’s estimated energy and carbon beside its cost: %#', async (footprint, words) => {
    const app = start();
    await app.open();
    await app.send();
    await app.event({ type: 'start', message: reply });
    await app.event({ type: 'text', blockIndex: 0, delta: 'Done' });
    await app.event({
      type: 'usage',
      usage: {
        providerId: 'registry',
        model: 'configured',
        inputTokens: 8,
        outputTokens: 12,
        costUsd: 0.01,
        ms: 20,
        footprint,
      },
    });
    expect(screen.getByText('configured · 20 tokens · $0.01')).toBeDefined();
    expect(screen.getByText(words)).toBeDefined();
    expect(screen.getByRole('button', { name: 'How it’s estimated' })).toBeDefined();
    await app.event({ type: 'done' });
  });

  it('adds no footprint line to a reply from before estimates were kept', async () => {
    const app = start();
    await app.open();
    await app.send();
    await app.event({ type: 'start', message: reply });
    await app.event({
      type: 'usage',
      usage: {
        providerId: 'registry',
        model: 'configured',
        inputTokens: 8,
        outputTokens: 12,
        costUsd: null,
        ms: 20,
      },
    });
    expect(screen.getByText('configured · 20 tokens')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'How it’s estimated' })).toBeNull();
    await app.event({ type: 'done' });
  });

  it.each(['Stop', 'Close Rio', 'unmount', 'pagehide'])('aborts the active stream on %s', async (action) => {
    const app = start();
    await app.open();
    await app.send();
    await app.event({ type: 'start', message: reply });
    if (action === 'unmount') app.unmount();
    else if (action === 'pagehide') fireEvent(window, new Event('pagehide'));
    else await app.user.click(screen.getByRole('button', { name: action }));
    expect(app.signal()?.aborted).toBe(true);
    if (action === 'Stop') {
      expect(mood()).toBe('idle');
      expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    }
  });

  it('shows the long-conversation notice, compacts the transcript, and displays its footprint', async () => {
    const app = start();
    await app.open();
    await app.send();
    await app.event({ type: 'start', message: reply });
    await app.event({ type: 'contextUsage', usage: { tokens: 25000, limit: 32000 } });
    await app.event({ type: 'done' });
    expect(
      screen.getByText('This conversation is getting long. Rio will start forgetting the earliest messages.'),
    ).toBeDefined();
    await app.user.click(screen.getByRole('button', { name: 'Compact' }));
    expect(await screen.findByText('Conversation compacted. Earlier messages are still here.')).toBeDefined();
    expect(screen.getByText('Summarized')).toBeDefined();
    expect(screen.getByText('Earlier reply')).toBeDefined();
    expect(screen.getByText('No energy or carbon estimate for this model')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Compact' })).toBeNull();
    expect(app.fetcher.mock.calls.find(([url]) => url.endsWith('/compact'))?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ context: {}, tier: 'everyday', locale: 'en-US' }),
    });
  });

  it.each([true, false])(
    'renders a compaction gateway failure with model and settings only for admins (%s)',
    async (canManage) => {
      const app = start({ canManage, phone: true });
      await app.open();
      await app.send();
      await app.event({ type: 'start', message: reply });
      await app.event({ type: 'contextUsage', usage: { tokens: 25000, limit: 32000 } });
      await app.event({ type: 'done' });
      app.compactResult(
        json(
          {
            error: {
              code: 'unavailable',
              messageKey: 'ai.gateway.modelRestricted',
              params: { model: 'allowed-route', providerId: 'gateway-office' },
              userFault: false,
            },
          },
          503,
        ),
      );
      await app.user.click(screen.getByRole('button', { name: 'Compact' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(
        canManage
          ? 'The gateway route only allows model allowed-route.  Set that model in the gateway’s model list.'
          : 'Rio can’t reach its AI service right now; an admin has been told.',
      );
      const link = within(alert).queryByRole('link', { name: 'Open gateway settings' });
      expect(Boolean(link)).toBe(canManage);
      if (canManage) expect(link?.getAttribute('href')).toBe('/settings/ai#gateway-office');
      else expect(alert.textContent).not.toContain('allowed-route');
    },
  );

  it('keeps the active transcript and draft when the panel unmounts and remounts', async () => {
    const app = start();
    await app.open();
    await app.send('Remember this request');
    await app.event({ type: 'start', message: reply });
    await app.event({ type: 'text', blockIndex: 0, delta: 'Remembered reply' });
    await app.event({ type: 'done' });
    await app.user.type(screen.getByRole('textbox'), 'Unsent draft');
    await app.remount();
    expect(screen.getByText('Remember this request')).toBeDefined();
    expect(screen.getByText('Remembered reply')).toBeDefined();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Unsent draft');
    expect(app.fetcher.mock.calls.filter(([url]) => url === '/api/rio/active-conversation')).toHaveLength(1);
  });

  it('reconstructs context dividers from the server transcript when opening history', async () => {
    const app = start({
      historyMessages: [
        {
          ...reply,
          id: 'first-person',
          role: 'person',
          context: { label: 'Home' },
          blocks: [{ kind: 'text', text: 'Start at Home' }],
        },
        { ...reply, id: 'first-reply', blocks: [{ kind: 'text', text: 'Home reply' }] },
        {
          ...reply,
          id: 'next-person',
          role: 'person',
          context: { databaseId: 'database-one', label: 'Projects › Tasks' },
          blocks: [{ kind: 'text', text: 'Continue in Tasks' }],
        },
      ],
    });
    await app.open();
    await app.history();
    const divider = await screen.findByRole('separator');
    expect(divider.textContent).toBe('Now in Projects › Tasks');
    expect(divider.previousElementSibling?.textContent).toBe('Home reply');
    await app.remount();
    expect(screen.getAllByRole('separator')).toHaveLength(1);
    expect(screen.getByRole('separator').textContent).toBe('Now in Projects › Tasks');
  });

  it('restores the saved scroll after delayed record blocks size and preserves it during hydration', async () => {
    const positions = new WeakMap<HTMLElement, number>();
    const height = (element: HTMLElement) => element.querySelectorAll('tbody tr').length * 100;
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) {
      return positions.get(this) ?? 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, top) {
      positions.set(this, Math.min(top, Math.max(0, height(this) - 200)));
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return height(this);
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200);
    const resizeCallbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback);
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    const server = new FakeServer();
    const f = server.createDatabase(40);
    const database = server.database(f.databaseId);
    const rows = Array.from({ length: 40 }, (_, index) => database.rows(f.tableId).get(f.recordId(index))!);
    const delayed: { pending?: Promise<void> } = {};
    let release!: () => void;
    const app = start({
      historyBlocks: [
        {
          kind: 'records',
          tableId: f.tableId,
          recordIds: rows.map((row) => row.id),
          fieldIds: [f.textFieldId],
        },
      ],
      discovery: { schema: database.schema, rows },
      waitForRecords: async () => {
        await delayed.pending;
      },
    });
    await app.open();
    await app.history();
    await waitFor(() => expect(screen.getByRole('log').querySelectorAll('tbody tr')).toHaveLength(40));
    await act(async () => {
      for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    const log = screen.getByRole('log');
    log.scrollTop = 500;
    fireEvent.scroll(log);
    const saved = () => JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!);
    expect(saved().scrollTop).toBe(500);
    delayed.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.client.removeQueries({ queryKey: ['rio', 'records'] });
    await app.remount();
    expect(screen.getByRole('log').scrollTop).toBe(0);
    fireEvent.scroll(screen.getByRole('log'));
    expect(saved().scrollTop).toBe(500);
    await act(async () => {
      release();
    });
    await waitFor(() => expect(screen.getByRole('log').querySelectorAll('tbody tr')).toHaveLength(40));
    act(() => {
      for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
    });
    await waitFor(() => expect(screen.getByRole('log').scrollTop).toBe(500));
    expect(saved().scrollTop).toBe(500);
  });

  it('shows this month’s AI spending in the panel header, beside the close button', async () => {
    start({
      open: true,
      footprint: {
        used: true,
        month: '2026-10-01',
        calls: 12,
        pricedCalls: 12,
        estimatedCalls: 0,
        costUsd: 0.42,
        energyWh: { min: 0, max: 0 },
        gwpG: { min: 0, max: 0 },
        byFeature: [],
      },
    });
    const usage = await screen.findByRole('button', { name: 'Your AI use this month: $0.42' });
    const header = document.querySelector('.rio-assistant__header')!;
    expect(header.contains(usage)).toBe(true);
    const end = header.querySelector('.rio-assistant__header-end')!;
    expect(end.contains(usage)).toBe(true);
    expect(end.contains(screen.getByRole('button', { name: 'Close Rio' }))).toBe(true);
  });

  it('leaves the panel header without a spending control before any AI use', async () => {
    start({ open: true });
    await screen.findByRole('button', { name: 'Close Rio' });
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Your AI use this month/ })).toBeNull());
  });

  it('keeps the transcript when closed and reopened, and lets the launcher close it', async () => {
    const app = start();
    await app.open();
    await app.history();
    await app.user.click(screen.getByRole('button', { name: 'AI: Ask Rio' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    await app.open();
    expect(screen.getByText('Update the records')).toBeDefined();
  });

  it('applies a home plan and undoes its receipt through the home command route', async () => {
    const app = start({ historyBlocks: [{ ...plan, databaseId: null }] });
    await app.open();
    await app.history();
    app.blockResult(json({ ...receipt, databaseId: null }));
    await app.user.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByRole('button', { name: 'Undo' });
    app.blockResult(json({ id: 'undo-home', status: 'applied' }));
    await app.user.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('Undone');
    expect(app.fetcher.mock.calls).toContainEqual([
      '/api/home/undo/group-one',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('"id":') }),
    ]);
    expect(app.fetcher.mock.calls.some(([url]) => url.startsWith('/api/databases/'))).toBe(false);
  });

  it('pins attention, answers questions, starts new conversations, and loads history', async () => {
    const app = start();
    await app.open();
    await app.send();
    await app.event({ type: 'start', message: reply });
    await app.event({
      type: 'block',
      blockIndex: 0,
      block: { kind: 'attention', text: 'Check these values' },
    });
    expect(document.querySelector('.rio-assistant__composer')?.textContent).toContain('Check these values');
    expect(screen.getByRole('log').textContent).not.toContain('Check these values');
    await app.event({
      type: 'block',
      blockIndex: 1,
      block: { kind: 'questions', prompt: 'Which records?', options: ['All of them', 'Selected ones'] },
    });
    await app.event({ type: 'done' });
    await app.user.click(screen.getByRole('button', { name: 'Selected ones' }));
    await waitFor(() =>
      expect(app.fetcher.mock.calls.filter(([url]) => url.endsWith('/messages'))).toHaveLength(2),
    );
    expect(
      JSON.parse(app.fetcher.mock.calls.filter(([url]) => url.endsWith('/messages'))[1]![1]!.body as string)
        .text,
    ).toBe('Selected ones');
    await app.user.click(screen.getByRole('button', { name: 'Past conversations' }));
    await app.user.click(await screen.findByRole('menuitem', { name: 'New conversation' }));
    expect(app.signal()?.aborted).toBe(true);
    expect(await screen.findByText(/Hi!.*I’m Rio/)).toBeDefined();
    await app.history();
    expect(await screen.findByText('Update the records')).toBeDefined();
  });

  it('applies a plan, replaces it with its receipt, celebrates, and undoes its database group', async () => {
    const app = start();
    await app.open();
    await app.history();
    expect(screen.getByText('Set the value')).toBeDefined();
    await app.user.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByText('Updated the records');
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
    expect(mood()).toBe('celebrating');
    await app.user.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('Undone');
    const request = app.fetcher.mock.calls.find(([url]) => url.endsWith('/undo'))!;
    expect(request[0]).toBe('/api/databases/database-one/undo');
    expect(JSON.parse(request[1]!.body as string)).toMatchObject({
      groupId: 'group-one',
      clientId: expect.any(String),
      commandId: expect.any(String),
    });
    await waitFor(() => expect(mood()).toBe('idle'), { timeout: 4000 });
  });

  it('asks before a receipt removes a created table and sends confirmation only after yes', async () => {
    const app = start({
      historyBlocks: [receipt],
      undoPreview: {
        creations: [
          {
            kind: 'table',
            id: 'table-one',
            name: 'Projects',
            tables: 0,
            records: 12,
            changedSince: [],
          },
        ],
      },
    });
    await app.open();
    await app.history();
    await app.user.click(screen.getByRole('button', { name: 'Undo' }));
    await app.user.click(await screen.findByRole('button', { name: 'Keep it' }));
    expect(app.fetcher.mock.calls.some(([url]) => url.endsWith('/undo'))).toBe(false);
    await app.user.click(screen.getByRole('button', { name: 'Undo' }));
    await app.user.click(await screen.findByRole('button', { name: 'Move to trash' }));
    await screen.findByText('Undone');
    const request = app.fetcher.mock.calls.find(([url]) => url.endsWith('/undo'))!;
    expect(JSON.parse(request[1]!.body as string)).toMatchObject({ confirmedMajorCreation: true });
  });

  it('dismisses plans and reports failed applies without losing the plan', async () => {
    const app = start();
    await app.open();
    await app.history();
    app.blockResult(failure('errors.internal', 500));
    await app.user.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByRole('alert');
    expect(mood()).toBe('oops');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDefined();
    await app.user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByText('Dismissed')).toBeDefined();
  });

  it.each([null, 'database-one'])(
    'retains completed undo when reopening a receipt for %s',
    async (databaseId) => {
      const restored = { ...receipt, databaseId, undone: true };
      const app = start({ historyBlocks: [restored] });
      await app.open();
      await app.history();
      expect(await screen.findByText('Undone')).toBeDefined();
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
      expect(app.fetcher.mock.calls.some(([url]) => url.includes('/undo'))).toBe(false);
    },
  );

  it('keeps completed undo when the receipt is closed and reopened', async () => {
    const app = start({ historyBlocks: [receipt] });
    await app.open();
    await app.history();
    await app.user.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('Undone');
    await app.user.click(screen.getByRole('button', { name: 'Close Rio' }));
    await app.open();
    expect(await screen.findByText('Undone')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('does not confirm a rejected undo', async () => {
    const app = start({ historyBlocks: [receipt] });
    await app.open();
    await app.history();
    app.blockResult(json({ status: 'rejected', skipped: 0, error: { messageKey: 'errors.internal' } }));
    await app.user.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('Undone')).toBeNull();
    expect(mood()).toBe('oops');
  });

  it('shows stream errors and error blocks and settles into the error mood', async () => {
    const app = start();
    await app.open();
    await app.send();
    await app.event({ type: 'start', message: reply });
    await app.event({
      type: 'block',
      blockIndex: 0,
      block: { kind: 'error', messageKey: 'errors.internal' },
    });
    expect(screen.getByRole('alert')).toBeDefined();
    await app.event({ type: 'error', messageKey: 'errors.internal' });
    expect(mood()).toBe('oops');
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it.each([true, false])(
    'shows actionable gateway errors and settings only to admins (%s)',
    async (canManage) => {
      const app = start({ canManage });
      await app.open();
      await app.send();
      await app.event({ type: 'start', message: reply });
      const details = {
        messageKey: 'ai.gateway.modelRestricted',
        params: { model: 'allowed-route' },
        providerId: 'gateway-office',
      };
      await app.event({ type: 'block', blockIndex: 0, block: { kind: 'error', ...details } });
      await app.event({ type: 'error', ...details });
      const alerts = screen.getAllByRole('alert');
      expect(alerts).toHaveLength(2);
      for (const alert of alerts) {
        expect(alert.textContent).toContain(
          canManage
            ? 'The gateway route only allows model allowed-route.  Set that model in the gateway’s model list.'
            : 'Rio can’t reach its AI service right now; an admin has been told.',
        );
        const link = within(alert).queryByRole('link', { name: 'Open gateway settings' });
        expect(Boolean(link)).toBe(canManage);
        if (canManage) expect(link?.getAttribute('href')).toBe('/settings/ai#gateway-office');
        else expect(alert.textContent).not.toContain('allowed-route');
      }
    },
  );

  it('renders the buffer fix and gateway link from saved conversation history', async () => {
    const app = start({
      canManage: true,
      historyBlocks: [
        { kind: 'error', messageKey: 'ai.gateway.requestBufferTooSmall', providerId: 'gateway-office' },
      ],
    });
    await app.open();
    await app.history();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Raise nginx_http_client_body_buffer_size, for example to 1m.',
    );
    expect(screen.getByRole('link', { name: 'Open gateway settings' }).getAttribute('href')).toBe(
      '/settings/ai#gateway-office',
    );
  });

  it.each([true, false])(
    'shows off state and the settings link only for administrators (%s)',
    async (canManage) => {
      const app = start({ status: { ...ready, enabled: false }, canManage });
      await app.open();
      expect(screen.getByText('Rio isn’t turned on here yet.')).toBeDefined();
      expect(Boolean(screen.queryByRole('link', { name: 'Turn on AI in Settings' }))).toBe(canManage);
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
    },
  );

  it.each([true, false])(
    'explains missing provider consent and deep links to settings (admin: %s)',
    async (canManage) => {
      const app = start({
        status: { ...ready, enabled: false, tiers: [], disabledReason: 'noProvider' },
        canManage,
      });
      await app.open();
      expect(screen.getByText('Rio is off because no provider is turned on.')).toBeDefined();
      expect(screen.getByRole('link', { name: 'Review providers in AI settings' }).getAttribute('href')).toBe(
        '/settings/ai#providers',
      );
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
    },
  );

  it('shows the budget pause and hides a tier switch when only one tier exists', async () => {
    const app = start({ status: { ...ready, paused: true, tiers: ['power'] } });
    await app.open();
    expect(screen.getByText(/Rio is resting/).textContent).toBe(
      'Rio is resting until next month.  This month’s AI budget is used up.',
    );
    expect(screen.queryByRole('button', { name: 'Quick' })).toBeNull();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('opens historical records from outside their database', async () => {
    const server = new FakeServer();
    const f = server.createDatabase(1);
    const database = server.database(f.databaseId);
    const row = database.rows(f.tableId).get(f.recordId(0))!;
    const app = start({
      historyBlocks: [
        { kind: 'records', tableId: f.tableId, recordIds: [row.id], fieldIds: [f.textFieldId] },
      ],
      discovery: { schema: database.schema, rows: [row] },
    });
    await app.open();
    await app.history();
    const name = String(row.values[f.textFieldId]);
    const cards = await screen.findByRole('list');
    const link = within(cards).getByRole('link', { name: `Open record: ${name}` });
    expect(link.getAttribute('href')).toBe(`/${f.databaseId}/${f.tableId}/${f.viewId}/${row.id}`);
    expect(within(cards).getByRole('heading', { name })).toBeDefined();
  });

  it('sends the database route and grid selection, and renders record values and links from its session', async () => {
    const server = new FakeServer();
    const f = server.createDatabase(3);
    const session = await openDatabase(f.databaseId, server.deps());
    cleanupTasks.push(() => session.close());
    const schema = session.getSchema();
    const rows = session.openView(f.viewId);
    await waitFor(() => expect(rows.loading()).toBe(false));
    const controller = createGridController(
      {
        session,
        rows,
        table: schema.tableById.get(f.tableId)!,
        view: schema.viewById.get(f.viewId)!,
        fields: schema.fields.get(f.tableId)!,
        peers: [],
        format: { locale: 'en-US', timeZone: 'UTC', collaborators: schema.collaborators },
        onConfig: vi.fn(),
        onExpand: vi.fn(),
        onField: vi.fn(),
        onMenu: vi.fn(),
        onPreview: vi.fn(),
      },
      new AbortController().signal,
    );
    cleanupTasks.push(() => {
      controller.destroy();
      rows.close();
    });
    controller.host.onSelectionChange?.({
      active: { row: 0, col: 0 },
      range: { start: { row: 0, col: 0 }, end: { row: 1, col: 1 } },
      rows: { kind: 'none' },
    });
    const context = {
      databaseId: f.databaseId,
      tableId: f.tableId,
      viewId: f.viewId,
      recordId: f.recordId(0),
    };
    const app = start({ session, context });
    await app.open();
    await app.send();
    const request = app.fetcher.mock.calls.find(([url]) => url.endsWith('/messages'))!;
    expect(JSON.parse(request[1]!.body as string).context).toEqual({
      ...context,
      recordIds: [f.recordId(0), f.recordId(1)],
      fieldIds: [f.textFieldId, f.numberFieldId],
    });
    await app.event({ type: 'start', message: reply });
    await app.event({
      type: 'block',
      blockIndex: 0,
      block: {
        kind: 'records',
        tableId: f.tableId,
        recordIds: [f.recordId(0)],
        fieldIds: [f.textFieldId, f.numberFieldId],
      },
    });
    const cards = await screen.findByRole('list');
    const row = await session.getRecord(f.tableId, f.recordId(0));
    const name = String(row?.values[f.textFieldId]);
    expect(await within(cards).findByRole('link', { name: `Open record: ${name}` })).toBeDefined();
    expect(
      within(cards)
        .getByRole('link', { name: `Open record: ${name}` })
        .getAttribute('href'),
    ).toBe(`/${f.databaseId}/${f.tableId}/${f.viewId}/${f.recordId(0)}`);
    expect(within(cards).getByRole('heading', { name })).toBeDefined();
  });
});

describe('Rio’s reactions to the rest of the app', () => {
  it('shows a mood it was asked for, then goes back to what it was doing', () => {
    vi.useFakeTimers();
    try {
      start({ open: true });
      act(() => rioReact({ kind: 'mood', mood: 'celebrating', seconds: 3 }));
      expect(screen.getByRole('img', { name: 'Rio, celebrating' })).toBeDefined();
      act(() => void vi.advanceTimersByTime(3000));
      expect(screen.getByRole('img', { name: 'Rio, idle' })).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dances a short, happy dance and then stops', () => {
    vi.useFakeTimers();
    try {
      start({ open: true });
      // Rio dances where he can be seen: at the corner of the open panel.
      const mascot = document.querySelector('.rio-assistant__mascot')!;
      expect(mascot.hasAttribute('data-dancing')).toBe(false);
      act(() => rioReact({ kind: 'dance' }));
      expect(mascot.hasAttribute('data-dancing')).toBe(true);
      expect(screen.getByRole('img', { name: 'Rio, happy' })).toBeDefined();
      act(() => void vi.advanceTimersByTime(RIO_DANCE_MS));
      expect(mascot.hasAttribute('data-dancing')).toBe(false);
      expect(screen.getByRole('img', { name: 'Rio, idle' })).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('naps sooner on a Sunday afternoon', () => {
    vi.useFakeTimers();
    try {
      // A Sunday at 14:00 wherever the tests run, reached from the real date rather than pinned.
      const now = new Date();
      now.setDate(now.getDate() + ((7 - now.getDay()) % 7));
      now.setHours(14, 0, 0, 0);
      vi.setSystemTime(now);
      start({ open: true });
      act(() => void vi.advanceTimersByTime(59_000));
      expect(screen.getByRole('img', { name: 'Rio, idle' })).toBeDefined();
      act(() => void vi.advanceTimersByTime(1000));
      expect(screen.getByRole('img', { name: 'Rio, napping' })).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps its usual nap on other days', () => {
    vi.useFakeTimers();
    try {
      const now = new Date();
      // The next Monday, at the same hour.
      now.setDate(now.getDate() + ((8 - now.getDay()) % 7));
      now.setHours(14, 0, 0, 0);
      vi.setSystemTime(now);
      start({ open: true });
      act(() => void vi.advanceTimersByTime(60_000));
      expect(screen.getByRole('img', { name: 'Rio, idle' })).toBeDefined();
      act(() => void vi.advanceTimersByTime(60_000));
      expect(screen.getByRole('img', { name: 'Rio, napping' })).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
