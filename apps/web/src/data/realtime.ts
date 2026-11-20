import { isDemoSession } from '../demo';
import type { ClientMessage, ServerMessage } from '@riosoma/contracts';
import type { Clock, RealtimeSocket, WebSocketFactory } from './deps';
import { retryDelay } from './deps';

export interface RealtimeSubscriber {
  databaseId: string;
  seq(): number;
  message(message: ServerMessage): void;
  connection(ready: boolean): void;
}

const connections = new Set<RealtimeConnection>();
export function sharedRealtime(
  factory: WebSocketFactory,
  clock: Clock,
  clientId: string,
  userId: string,
  csrf: () => string | null,
): RealtimeConnection {
  let connection = [...connections].find((entry) => entry.matches(factory, clock, clientId, userId));
  if (!connection) {
    connection = new RealtimeConnection(factory, clock, clientId, userId, csrf);
    connections.add(connection);
  }
  return connection;
}

export class RealtimeConnection {
  private socket: RealtimeSocket | undefined;
  private subscribers = new Set<RealtimeSubscriber>();
  private ready = false;
  private retry: unknown;
  private heartbeat: unknown;
  private attempt = 0;
  private awaitingPong = false;
  constructor(
    private readonly factory: WebSocketFactory,
    private readonly clock: Clock,
    private readonly clientId: string,
    private readonly userId: string,
    private readonly csrf: () => string | null,
  ) {}
  matches(factory: WebSocketFactory, clock: Clock, clientId: string, userId: string): boolean {
    return (
      this.factory === factory && this.clock === clock && this.clientId === clientId && this.userId === userId
    );
  }
  add(subscriber: RealtimeSubscriber): () => void {
    this.subscribers.add(subscriber);
    if (this.ready) {
      this.subscribe(subscriber);
      subscriber.connection(true);
    } else if (!this.socket && this.retry === undefined) this.connect();
    return () => {
      this.subscribers.delete(subscriber);
      if (![...this.subscribers].some((entry) => entry.databaseId === subscriber.databaseId)) {
        if (subscriber.databaseId) this.send({ type: 'unsubscribe', databaseId: subscriber.databaseId });
      }
      if (this.subscribers.size === 0) {
        this.clock.clearTimeout(this.retry);
        this.clock.clearTimeout(this.heartbeat);
        const socket = this.socket;
        this.socket = undefined;
        this.ready = false;
        socket?.close();
        connections.delete(this);
      }
    };
  }
  /** Asks for a database's changes, and says whether the request went out. */
  subscribe(subscriber: RealtimeSubscriber): boolean {
    return (
      !subscriber.databaseId ||
      this.send({ type: 'subscribe', databaseId: subscriber.databaseId, sinceSeq: subscriber.seq() })
    );
  }
  send(message: ClientMessage): boolean {
    if (!this.ready || !this.socket) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      this.disconnected(this.socket);
      return false;
    }
  }
  reconnect(refreshAuthentication = false): void {
    if (refreshAuthentication) {
      // A retained connection still belongs to its expired cookie and CSRF token.
      const socket = this.socket;
      this.socket = undefined;
      this.ready = false;
      this.clock.clearTimeout(this.heartbeat);
      socket?.close();
      for (const subscriber of this.subscribers) subscriber.connection(false);
    }
    if (this.ready) return;
    this.clock.clearTimeout(this.retry);
    this.retry = undefined;
    if (!this.socket) this.connect();
  }
  private connect(): void {
    if (!this.subscribers.size || isDemoSession()) return;
    try {
      const origin = typeof location === 'undefined' ? 'http://localhost' : location.origin;
      const url = new URL('/api/realtime', origin === 'null' ? 'http://localhost' : origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = this.factory(url.toString());
      this.socket = socket;
      socket.addEventListener('open', () => {
        if (this.socket !== socket) return;
        const csrf = this.csrf();
        if (!csrf) {
          this.disconnected(socket);
          return;
        }
        try {
          socket.send(
            JSON.stringify({ type: 'hello', clientId: this.clientId, csrf } satisfies ClientMessage),
          );
        } catch {
          this.disconnected(socket);
        }
      });
      socket.addEventListener('message', (event) => {
        if (this.socket !== socket || typeof event.data !== 'string') return;
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        if (message.type === 'ready') {
          this.ready = true;
          this.attempt = 0;
          for (const subscriber of this.subscribers) this.subscribe(subscriber);
          for (const subscriber of this.subscribers) subscriber.connection(true);
          this.ping();
        } else if (message.type === 'remoteToolsChanged') {
          window.dispatchEvent(new Event('remoteToolsChanged'));
        } else if (message.type === 'accountDeactivated') {
          window.dispatchEvent(new Event('accountDeactivated'));
          for (const subscriber of this.subscribers) subscriber.message(message);
          this.clock.clearTimeout(this.retry);
          this.clock.clearTimeout(this.heartbeat);
          this.socket = undefined;
          this.ready = false;
          socket.close();
        } else if (message.type === 'personChanged') {
          window.dispatchEvent(new CustomEvent('personChanged', { detail: message.person }));
          for (const subscriber of this.subscribers) subscriber.message(message);
        } else if (message.type === 'organizationChanged') {
          window.dispatchEvent(new Event('organizationChanged'));
        } else if (message.type === 'pong') this.awaitingPong = false;
        else if (this.ready) {
          const databaseId =
            message.type === 'change'
              ? message.change.databaseId
              : 'databaseId' in message
                ? message.databaseId
                : undefined;
          for (const subscriber of this.subscribers)
            if (!databaseId || databaseId === subscriber.databaseId) subscriber.message(message);
        }
      });
      socket.addEventListener('close', () => this.disconnected(socket));
      socket.addEventListener('error', () => this.disconnected(socket));
    } catch {
      this.scheduleReconnect();
    }
  }
  private ping(): void {
    this.clock.clearTimeout(this.heartbeat);
    this.awaitingPong = false;
    const tick = () => {
      if (!this.ready || !this.socket) return;
      if (this.awaitingPong) {
        this.disconnected(this.socket);
        return;
      }
      this.awaitingPong = true;
      this.send({ type: 'ping' });
      this.heartbeat = this.clock.setTimeout(tick, 25_000);
    };
    this.heartbeat = this.clock.setTimeout(tick, 25_000);
  }
  private disconnected(socket: RealtimeSocket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.ready = false;
    this.clock.clearTimeout(this.heartbeat);
    socket.close();
    this.scheduleReconnect();
  }
  private scheduleReconnect(): void {
    for (const subscriber of this.subscribers) subscriber.connection(false);
    if (!this.subscribers.size || this.retry !== undefined) return;
    this.retry = this.clock.setTimeout(
      () => {
        this.retry = undefined;
        this.connect();
      },
      retryDelay(this.attempt++, this.clock),
    );
  }
}
