import { recoverImport } from '../../asset-recovery';
import type { ConnectionsView, ConnectedProvider, ProviderConnection, SessionInfo } from '@riosoma/contracts';
import { hashKey, type QueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { isDemoSession } from '../../demo';
import { sessionQuery } from '../../session';

/**
 * The person's cloud drive accounts, shared by every open attachment panel and the settings page,
 * so connecting in one place shows everywhere at once.  They belong to one signed-in person, so
 * the store starts over whenever someone else is signed in to the tab.
 */
class ConnectionStore {
  private view: ConnectionsView | null = null;
  private loading: Promise<void> | null = null;
  /** Who the store is for, as organization and user, or undefined until a session says */
  private person: string | null | undefined = undefined;
  /** Counts each start over, so an answer read for someone earlier is dropped */
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  snapshot = (): ConnectionsView | null => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  /** Reads them once, unless asked to read again. */
  load(again = false): Promise<void> {
    if (isDemoSession()) {
      // Demo panels keep their local sources without reading private connected accounts.
      this.generation++;
      this.view = { providers: [] };
      this.loading = Promise.resolve();
      this.notify();
      return this.loading;
    }
    if (this.loading && !again) return this.loading;
    const generation = this.generation;
    const current = () => generation === this.generation;
    const loading: Promise<void> = api<unknown>('/api/connections')
      .then(async (body) => {
        if (!current()) return;
        const { ConnectionsView } = await recoverImport(() => import('./connection-validation'));
        if (!current()) return;
        const parsed = ConnectionsView.safeParse(body);
        this.view = parsed.success ? parsed.data : { providers: [] };
      })
      .catch(() => {
        if (!current()) return;
        // Without an answer, no drive is offered, and the next panel asks again.
        this.view = { providers: [] };
        if (this.loading === loading) this.loading = null;
      })
      .finally(() => {
        if (current()) this.notify();
      });
    this.loading = loading;
    return loading;
  }

  provider(provider: ConnectedProvider): ProviderConnection | undefined {
    return this.view?.providers.find((entry) => entry.provider === provider);
  }

  /** Starts over for someone else, or for nobody, forgetting what it read and what it's reading. */
  forPerson(person: string | null): void {
    if (person === this.person) return;
    this.person = person;
    this.reset();
  }

  /** Forgets what it read, and drops any answer still on its way. */
  reset(): void {
    this.generation++;
    this.view = null;
    this.loading = null;
    this.notify();
  }
}

export const connectionStore = new ConnectionStore();

/**
 * Keeps the store to whoever the session names.  Signing out, signing in as someone else, and a
 * session that ended all pass through the session query, and its cache tells listeners before
 * anything renders for the new person.
 */
export function keepConnectionsToPerson(client: QueryClient): () => void {
  const key = hashKey(sessionQuery.queryKey);
  return client.getQueryCache().subscribe((event) => {
    if (event.type === 'removed' || event.query.queryHash !== key) return;
    const session = event.query.state.data as SessionInfo | null | undefined;
    // Undefined means the session hasn't been read yet, which says nothing about who it is.
    if (session === undefined) return;
    connectionStore.forPerson(
      session ? `${session.org.id}:${session.user.id}:${Boolean(session.demo)}` : null,
    );
  });
}
