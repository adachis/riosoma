import {
  newId,
  type DatabaseRole,
  type ScriptClientMessage,
  type ScriptMeta,
  type ScriptServerMessage,
} from '@riosoma/contracts';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import type { RealtimeSocket } from '../../../data/deps';
import { useSchema } from '../../../data/hooks';
import { openDatabase } from '../../../data/session';
import { FakeServer } from '../../../data/testing';
import type { DatabaseSession } from '../../../data/types';
import { renderWithProviders } from '../automations/test-support';
import { ScriptPanel } from './ScriptPanel';
import { ScriptSidebar } from './ScriptSidebar';
import type { ScriptSocketFactory } from './runner';

export interface ScriptFixture {
  server: FakeServer;
  session: DatabaseSession;
  databaseId: string;
  tableId: string;
  recordId(index: number): string;
  scripts: ScriptMeta[];
}

export function scriptMeta(databaseId: string, name: string, source: string, position = 0): ScriptMeta {
  return {
    id: newId('script'),
    databaseId,
    name,
    description: '',
    source,
    position,
    createdAt: '',
    updatedAt: '',
  };
}

/** A database with a Tasks table of three records, and the scripts given, opened as `role`. */
export async function scriptFixture(
  options: { role?: DatabaseRole; scripts?: (databaseId: string) => ScriptMeta[] } = {},
): Promise<ScriptFixture> {
  const server = new FakeServer();
  const base = server.createDatabase(3);
  const { schema } = server.database(base.databaseId);
  schema.database.role = options.role ?? 'owner';
  schema.tables[0]!.name = 'Tasks';
  const scripts = options.scripts?.(base.databaseId) ?? [];
  schema.scripts = scripts;
  const session = await openDatabase(base.databaseId, server.deps());
  return {
    server,
    session,
    databaseId: base.databaseId,
    tableId: base.tableId,
    recordId: base.recordId,
    scripts,
  };
}

/**
 * A run's socket as the panel sees it.  The test plays the server: it reads what the panel sent
 * and sends back whatever the server would.
 */
export class FakeRunSocket implements RealtimeSocket {
  readonly url: string;
  readonly sent: ScriptClientMessage[] = [];
  closed = false;
  private listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => this.emit('open', {}));
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data: string): void {
    if (this.closed) throw new TypeError('closed');
    this.sent.push(JSON.parse(data) as ScriptClientMessage);
  }

  /** What the server sends */
  push(...messages: ScriptServerMessage[]): void {
    for (const message of messages) this.emit('message', { data: JSON.stringify(message) });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit('close', {}));
  }
}

/** Opens fake run sockets and remembers each one, newest last */
export function fakeSockets(): { sockets: FakeRunSocket[]; connect: ScriptSocketFactory } {
  const sockets: FakeRunSocket[] = [];
  return {
    sockets,
    connect: (url) => {
      const socket = new FakeRunSocket(url);
      sockets.push(socket);
      return socket;
    },
  };
}

/** The sidebar and the panel, wired as the database screen wires them */
function ScriptsHost({
  session,
  initial,
  connect,
}: {
  session: DatabaseSession;
  initial: string | null;
  connect: ScriptSocketFactory;
}) {
  const schema = useSchema(session);
  const [open, setOpen] = useState<string | null>(initial);
  if (!schema) return null;
  const script = open ? schema.scriptById.get(open) : undefined;
  return (
    <>
      <nav aria-label="Sidebar">
        <ScriptSidebar session={session} schema={schema} openScriptId={open} onOpen={setOpen} />
      </nav>
      {script ? (
        <ScriptPanel
          key={script.id}
          session={session}
          schema={schema}
          script={script}
          connect={connect}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}

function renderInRouter(element: ReactElement) {
  const root = createRootRoute({ component: () => element });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  return { ...renderWithProviders(<RouterProvider router={router} />), router };
}

export function renderScripts(
  fixture: ScriptFixture,
  connect: ScriptSocketFactory,
  initial: string | null = null,
) {
  return renderInRouter(<ScriptsHost session={fixture.session} initial={initial} connect={connect} />);
}
