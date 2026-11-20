import { afterEach, expect, it, vi } from 'vitest';
import { ConversationStore } from './conversation-store';
import { panelStorageKey, savedPanelOpen } from './conversation-session';
import { json, session } from '../../screens/database/share/testing';
import type { RioConversationDetail } from '@riosoma/contracts';

const detail: RioConversationDetail = {
  conversation: {
    id: 'saved-conversation',
    title: 'Saved work',
    createdAt: '2026-10-02T10:00:00Z',
    updatedAt: '2026-10-02T10:00:00Z',
  },
  messages: [
    {
      id: 'saved-message',
      role: 'rio',
      blocks: [{ kind: 'text', text: 'Saved answer' }],
      createdAt: '2026-10-02T10:00:00Z',
    },
  ],
};
afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it('restores panel intent before loading the conversation only for the same sign-in', () => {
  const store = new ConversationStore(panelStorageKey(session));
  store.patch({ open: true });
  expect(savedPanelOpen(session)).toBe(true);
  expect(savedPanelOpen({ ...session, csrfToken: 'fresh-sign-in' })).toBe(false);
  expect(savedPanelOpen(null)).toBe(false);
  sessionStorage.setItem(panelStorageKey(session), '{');
  expect(savedPanelOpen(session)).toBe(false);
});

it('rehydrates the server conversation and restores the open panel and scroll position after a reload', async () => {
  const fetcher = vi.fn(async (_url: string) => json(detail));
  vi.stubGlobal('fetch', fetcher);
  const before = new ConversationStore('rio.test');
  await before.hydrate();
  before.patch({ open: true, scrollTop: 217, scrollAnchor: { messageId: 'saved-message', offset: 17 } });
  const reloaded = new ConversationStore('rio.test');
  expect(reloaded.get().conversation).toBeNull();
  await reloaded.hydrate();
  expect(reloaded.get()).toMatchObject({
    conversation: detail.conversation.id,
    messages: detail.messages,
    open: true,
    scrollTop: 217,
    scrollAnchor: { messageId: 'saved-message', offset: 17 },
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.every((call) => call[0] === '/api/rio/active-conversation')).toBe(true);
});

it('restores the draft and tier on reload only for the same conversation and sign-in', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json(detail)),
  );
  const key = panelStorageKey(session);
  const before = new ConversationStore(key);
  await before.hydrate();
  before.patch({ input: '次の質問 🌱 مرحبا', tier: 'power' });
  const reloaded = new ConversationStore(key);
  await reloaded.hydrate();
  expect(reloaded.get()).toMatchObject({ input: '次の質問 🌱 مرحبا', tier: 'power' });
  expect(
    new ConversationStore(panelStorageKey({ ...session, csrfToken: 'new-sign-in' })).get(),
  ).toMatchObject({
    input: '',
    tier: 'everyday',
  });
  reloaded.accept({ conversation: { ...detail.conversation, id: 'another-conversation' }, messages: [] });
  expect(reloaded.get().input).toBe('');
});

it('changes the active conversation only when the server pointer changes, and preserves page dividers', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string) => json(detail)),
  );
  const store = new ConversationStore('rio.test');
  await store.hydrate();
  store.context('Projects › Tasks');
  store.context('Projects › Notes');
  store.patch({ open: false });
  await store.hydrate();
  expect(store.get().conversation).toBe(detail.conversation.id);
  expect(store.get().dividers).toEqual([{ after: 'saved-message', location: 'Projects › Notes' }]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      json({ conversation: { ...detail.conversation, id: 'new-session-conversation' }, messages: [] }),
    ),
  );
  await store.hydrate(true);
  expect(store.get()).toMatchObject({
    conversation: 'new-session-conversation',
    messages: [],
    dividers: [],
    scrollTop: null,
  });
});

it('keeps an explicitly selected conversation when an earlier hydration arrives late', async () => {
  let respond!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    ),
  );
  const store = new ConversationStore('rio.test');
  const hydration = store.hydrate();
  store.accept({ conversation: { ...detail.conversation, id: 'selected-conversation' }, messages: [] });
  respond(json(detail));
  await hydration;
  expect(store.get()).toMatchObject({ conversation: 'selected-conversation', messages: [], ready: true });
});
