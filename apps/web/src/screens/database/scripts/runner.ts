import type { ScriptButtonContext } from '@riosoma/contracts';
import type {
  ScriptClientMessage,
  ScriptOutput,
  ScriptPrompt,
  ScriptRunError,
  ScriptServerMessage,
} from '@riosoma/contracts';
import { currentCsrfToken } from '../../../api';
import type { RealtimeSocket } from '../../../data/deps';

/**
 * One run of a saved script, over its own WebSocket.  The server runs the script and streams what
 * it logs and shows, stops when it asks the person something, and carries on with the answer.
 * Closing the socket stops the run.
 */

export type ScriptSocketFactory = (url: string) => RealtimeSocket;
export const browserScriptSocket: ScriptSocketFactory = (url) => new WebSocket(url);

/** Where a script's run socket is, on this page's own origin */
export function scriptRunUrl(scriptId: string): string {
  const origin =
    typeof location === 'undefined' || location.origin === 'null' ? 'http://localhost' : location.origin;
  const url = new URL(`/api/scripts/${encodeURIComponent(scriptId)}/run`, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export type RunEntry =
  | { id: number; kind: 'log'; level: 'log' | 'info' | 'warn' | 'error'; text: string }
  | ({ id: number } & ScriptOutput);

export type RunStatus = 'idle' | 'starting' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'canceled';

export interface RunState {
  status: RunStatus;
  entries: RunEntry[];
  prompt: { promptId: number; prompt: ScriptPrompt } | null;
  error: ScriptRunError | null;
  /** Records created, changed, or deleted so far */
  writes: number;
  /** The action the run's writes belong to, once the run has started */
  groupId: string | null;
  /** The script's own time, once it's done */
  ms: number | null;
}

export const IDLE: RunState = {
  status: 'idle',
  entries: [],
  prompt: null,
  error: null,
  writes: 0,
  groupId: null,
  ms: null,
};

/** What changes a run as the panel shows it: the server's messages, and the panel's own steps */
export type RunEvent =
  | ScriptServerMessage
  /** The socket closed before the run said how it ended */
  | { type: 'lost' }
  /** A new run begins */
  | { type: 'reset' }
  /** The person answered the prompt, so the script carries on */
  | { type: 'answered' };

export function reduceRun(state: RunState, message: RunEvent): RunState {
  const nextId = state.entries.length ? state.entries.at(-1)!.id + 1 : 1;
  switch (message.type) {
    case 'reset':
      return { ...IDLE, status: 'starting' };
    case 'answered':
      return state.status === 'waiting' ? { ...state, status: 'running', prompt: null } : state;
    case 'started':
      return { ...state, status: 'running', groupId: message.groupId };
    case 'log':
      return {
        ...state,
        entries: [...state.entries, { id: nextId, kind: 'log', level: message.level, text: message.text }],
      };
    case 'output':
      return { ...state, entries: [...state.entries, { id: nextId, ...message.output }] };
    case 'prompt':
      return { ...state, status: 'waiting', prompt: { promptId: message.promptId, prompt: message.prompt } };
    case 'wrote':
      return { ...state, writes: message.writes };
    case 'finished':
      return {
        ...state,
        status: message.state,
        prompt: null,
        error: message.error,
        writes: message.writes,
        ms: message.ms,
      };
    case 'refused':
      return { ...state, status: 'failed', prompt: null, error: { messageKey: message.messageKey } };
    case 'lost':
      // The socket closed before the run said how it ended.
      return state.status === 'starting' || state.status === 'running' || state.status === 'waiting'
        ? { ...state, status: 'failed', prompt: null, error: { messageKey: 'scripts.run.lost' } }
        : state;
  }
}

export interface ScriptRunHandle {
  answer(promptId: number, value: unknown): void;
  cancel(): void;
  /** Closes the socket without waiting, which stops the run */
  close(): void;
}

/**
 * Opens a run's socket and starts the script.  `onMessage` hears everything the server sends,
 * and a `lost` message when the socket closes before `finished`.
 */
export function startScriptRun(
  scriptId: string,
  onMessage: (message: ScriptServerMessage | { type: 'lost' }) => void,
  deps: { socket?: ScriptSocketFactory; csrf?: () => string | null; button?: ScriptButtonContext } = {},
): ScriptRunHandle {
  let socket: RealtimeSocket;
  let done = false;
  let closed = false;
  const lost = () => {
    if (done) return;
    done = true;
    onMessage({ type: 'lost' });
  };
  try {
    socket = (deps.socket ?? browserScriptSocket)(scriptRunUrl(scriptId));
  } catch {
    queueMicrotask(lost);
    return { answer: () => {}, cancel: () => {}, close: () => {} };
  }
  const send = (message: ScriptClientMessage) => {
    if (closed) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // A socket that's gone reports itself through its close.
    }
  };
  socket.addEventListener('open', () => {
    const csrf = (deps.csrf ?? currentCsrfToken)();
    if (!csrf) {
      socket.close();
      return;
    }
    send({ type: 'start', csrf, ...(deps.button ? { button: deps.button } : {}) });
  });
  socket.addEventListener('message', (event) => {
    if (done) return;
    let message: ScriptServerMessage;
    try {
      message = JSON.parse(String(event.data)) as ScriptServerMessage;
    } catch {
      return;
    }
    if (message.type === 'finished' || message.type === 'refused') done = true;
    onMessage(message);
  });
  socket.addEventListener('close', () => {
    closed = true;
    lost();
  });
  return {
    answer: (promptId, value) => send({ type: 'answer', promptId, value }),
    cancel: () => send({ type: 'cancel' }),
    close: () => {
      if (closed) return;
      closed = true;
      socket.close();
    },
  };
}
