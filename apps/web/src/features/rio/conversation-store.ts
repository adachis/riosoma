import { useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import type {
  RioContextUsage,
  RioConversationDetail,
  RioMessage,
  RioTier,
  SessionInfo,
} from '@riosoma/contracts';
import { api } from '../../api';
import { useSession } from '../../session';
import { conversationPerson, observeConversationSessions, panelStorageKey } from './conversation-session';

interface Divider {
  after: string | null;
  location: string;
}
interface ConversationState {
  conversation: string | null;
  messages: RioMessage[];
  input: string;
  tier: RioTier;
  open: boolean;
  scrollTop: number | null;
  scrollAnchor: { messageId: string; offset: number } | null;
  contextUsage?: RioContextUsage | undefined;
  dividers: Divider[];
  location: string | null;
  ready: boolean;
}

/** Owned by the application query client, so routed screens and panel lifetimes cannot reset it. */
export class ConversationStore {
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private generation = 0;
  private savedConversation: string | null = null;
  private state: ConversationState = {
    conversation: null,
    messages: [],
    input: '',
    tier: 'everyday',
    open: false,
    scrollTop: null,
    scrollAnchor: null,
    dividers: [],
    location: null,
    ready: false,
  };
  constructor(private readonly storageKey: string) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as Pick<
        ConversationState,
        'open' | 'scrollTop' | 'scrollAnchor' | 'dividers' | 'location' | 'conversation' | 'input' | 'tier'
      > | null;
      if (saved) {
        this.savedConversation = saved.conversation ?? null;
        this.state = { ...this.state, ...saved, conversation: null };
      }
    } catch {
      /* An unavailable browser store still leaves the server copy authoritative. */
    }
  }
  get = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  patch = (patch: Partial<ConversationState>) => {
    this.state = { ...this.state, ...patch };
    try {
      const { open, scrollTop, scrollAnchor, dividers, location, conversation, input, tier } = this.state;
      sessionStorage.setItem(
        this.storageKey,
        JSON.stringify({
          open,
          scrollTop,
          scrollAnchor,
          dividers,
          location,
          conversation: conversation ?? this.savedConversation,
          input,
          tier,
        }),
      );
    } catch {
      /* State in memory survives navigation even when browser storage is unavailable. */
    }
    for (const listener of this.listeners) listener();
  };
  messages = (update: RioMessage[] | ((previous: RioMessage[]) => RioMessage[])) => {
    this.patch({ messages: typeof update === 'function' ? update(this.state.messages) : update });
  };
  accept = (detail: RioConversationDetail) => {
    this.generation++;
    const previous = this.state.conversation ?? this.savedConversation;
    const changed = previous !== null && previous !== detail.conversation.id;
    this.savedConversation = detail.conversation.id;
    this.patch({
      conversation: detail.conversation.id,
      messages: detail.messages,
      ready: true,
      contextUsage: detail.conversation.contextUsage,
      ...(changed ? { input: '', scrollTop: null, scrollAnchor: null, location: null, dividers: [] } : {}),
    });
  };
  hydrate = (refresh = false): Promise<void> => {
    if (this.loading) return this.loading;
    if (this.state.ready && !refresh) return Promise.resolve();
    const generation = this.generation;
    this.loading = api<RioConversationDetail>('/api/rio/active-conversation')
      .then((detail) => {
        // Choosing a conversation takes precedence over an earlier hydration response.
        if (generation === this.generation) this.accept(detail);
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  };
  context = (location: string) => {
    if (location === this.state.location) return;
    const dividers =
      this.state.location && this.state.messages.length
        ? [...this.state.dividers, { after: this.state.messages.at(-1)!.id, location }]
        : this.state.dividers;
    this.patch({ location, dividers });
  };
}

const stores = new WeakMap<QueryClient, { person: string; store: ConversationStore }>();
function forSession(client: QueryClient, session: SessionInfo | null) {
  const person = conversationPerson(session);
  let entry = stores.get(client);
  if (entry?.person !== person) {
    entry = { person, store: new ConversationStore(panelStorageKey(session)) };
    stores.set(client, entry);
  }
  return entry.store;
}

observeConversationSessions(forSession);

export function useConversationStore() {
  const client = useQueryClient();
  const session = useSession();
  const store = forSession(client, session);
  return { store, state: useSyncExternalStore(store.subscribe, store.get) };
}
