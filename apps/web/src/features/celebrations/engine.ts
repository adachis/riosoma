import type { MessageDescriptor } from '@lingui/core';
import {
  CELEBRATIONS,
  QUIET_INTERVAL_MS,
  type CelebrationDefinition,
  type CelebrationName,
  type CelebrationSize,
} from './registry';

export type CelebrationLevel = 'on' | 'quieter' | 'off';

/** What a trigger knows when it asks for a celebration. */
export interface CelebrationRequest {
  userId: string;
  level: CelebrationLevel;
  /** What the milestone belongs to, such as a table's ID, so each one celebrates on its own */
  key: string;
  /** The element that caused it, which the sparkle or the confetti starts from */
  anchor?: Element | null;
  /** `you` when the person's own action set it off, `others` for someone else or a background job */
  cause?: 'you' | 'others';
}

export interface Celebration {
  name: CelebrationName;
  id: string;
  size: CelebrationSize;
  key: string;
  line: MessageDescriptor;
  anchor: Element | null;
  cause: 'you' | 'others';
}

/**
 * What became of a request.  Only `shown` reaches the screen.  Every other answer except `below`
 * still counts the milestone as used, so turning celebrations back on later never brings back a
 * moment that has passed.
 */
export type CelebrationOutcome =
  /** On its way to the screen */
  | 'shown'
  /** A once-only celebration that already happened */
  | 'done'
  /** A rate-limited celebration that happened too recently for this key */
  | 'resting'
  /** Another celebration happened less than ten minutes ago */
  | 'limited'
  /** Celebrations are set to small ones only */
  | 'quieter'
  /** Celebrations are off */
  | 'off'
  /** A crossing seen before its line, remembered so that crossing it later celebrates */
  | 'below'
  /** A crossing first seen already past its line, which never celebrates */
  | 'missed';

/** What one person's device remembers, in milliseconds since 1970. */
export interface CelebrationMemory {
  /** When the last celebration showed */
  last?: number;
  /** When each `id:key` last celebrated, or was used up without showing */
  fired: Record<string, number>;
  /** Crossings seen on the near side of their line, and when */
  below: Record<string, number>;
}

export interface CelebrationStore {
  read(userId: string): CelebrationMemory;
  write(userId: string, memory: CelebrationMemory): void;
}

/** Enough for years of milestones, few enough that storage never grows without end. */
const REMEMBERED = 400;

function prune(entries: Record<string, number>): Record<string, number> {
  const list = Object.entries(entries);
  if (list.length <= REMEMBERED) return entries;
  return Object.fromEntries(list.sort((a, b) => b[1] - a[1]).slice(0, REMEMBERED));
}

function parse(text: string | null): CelebrationMemory {
  const empty: CelebrationMemory = { fired: {}, below: {} };
  if (!text) return empty;
  try {
    const value = JSON.parse(text) as Partial<CelebrationMemory>;
    const numbers = (record: unknown) =>
      Object.fromEntries(
        Object.entries(record && typeof record === 'object' ? record : {}).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number',
        ),
      );
    return {
      ...(typeof value.last === 'number' ? { last: value.last } : {}),
      fired: numbers(value.fired),
      below: numbers(value.below),
    };
  } catch {
    return empty;
  }
}

/**
 * Keeps each person's memory in this browser's storage, which every tab shares, so two tabs never
 * celebrate the same thing.  Without storage, it lasts as long as the page.
 */
export function browserStore(): CelebrationStore {
  const fallback = new Map<string, string>();
  const keyFor = (userId: string) => `rio.celebrations.${userId}`;
  return {
    read(userId) {
      try {
        return parse(localStorage.getItem(keyFor(userId)));
      } catch {
        return parse(fallback.get(keyFor(userId)) ?? null);
      }
    },
    write(userId, memory) {
      const text = JSON.stringify(memory);
      try {
        localStorage.setItem(keyFor(userId), text);
      } catch {
        fallback.set(keyFor(userId), text);
      }
    },
  };
}

export function memoryStore(): CelebrationStore {
  const memories = new Map<string, CelebrationMemory>();
  return {
    read: (userId) => structuredClone(memories.get(userId) ?? { fired: {}, below: {} }),
    write: (userId, memory) => void memories.set(userId, structuredClone(memory)),
  };
}

export interface CelebrationEngineOptions {
  store?: CelebrationStore;
  now?: () => number;
  /** A number in [0, 1), for picking Rio's line */
  random?: () => number;
}

/**
 * Decides whether a milestone celebrates, applying each celebration's own rule, the person's
 * setting, and the ten-minute quiet between celebrations, and hands the ones that do to whatever
 * draws them.
 */
export class CelebrationEngine {
  private readonly store: CelebrationStore;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly listeners = new Set<(celebration: Celebration) => void>();

  constructor(options: CelebrationEngineOptions = {}) {
    this.store = options.store ?? browserStore();
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  subscribe(listener: (celebration: Celebration) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Something the app watched happen, such as an import finishing without a problem. */
  celebrate(name: CelebrationName, request: CelebrationRequest): CelebrationOutcome {
    const memory = this.store.read(request.userId);
    const outcome = this.decide(name, request, memory);
    this.store.write(request.userId, memory);
    if (outcome === 'shown') this.emit(name, request);
    return outcome;
  }

  /**
   * A state the app read, and whether it is past the celebration's line.  It celebrates only when
   * this device saw the same key short of the line before, so data that was already there when
   * someone first looked stays quiet.
   */
  observe(name: CelebrationName, request: CelebrationRequest & { reached: boolean }): CelebrationOutcome {
    const definition: CelebrationDefinition = CELEBRATIONS[name];
    const slot = `${definition.id}:${request.key}`;
    const memory = this.store.read(request.userId);
    if (memory.fired[slot] !== undefined && 'once' in definition.rule) return 'done';
    if (!request.reached) {
      if (memory.below[slot] !== undefined) return 'below';
      memory.below = prune({ ...memory.below, [slot]: this.now() });
      this.store.write(request.userId, memory);
      return 'below';
    }
    if (memory.below[slot] === undefined) {
      memory.fired = prune({ ...memory.fired, [slot]: this.now() });
      this.store.write(request.userId, memory);
      return 'missed';
    }
    return this.celebrate(name, request);
  }

  /**
   * Uses up a once-only crossing without showing it, for a line crossed in a way that isn't the
   * milestone, such as having a first database because someone shared one.
   */
  retire(name: CelebrationName, request: Pick<CelebrationRequest, 'userId' | 'key'>): CelebrationOutcome {
    const definition: CelebrationDefinition = CELEBRATIONS[name];
    const slot = `${definition.id}:${request.key}`;
    const memory = this.store.read(request.userId);
    if (memory.fired[slot] !== undefined) return 'done';
    memory.fired = prune({ ...memory.fired, [slot]: this.now() });
    const { [slot]: _crossed, ...below } = memory.below;
    memory.below = below;
    this.store.write(request.userId, memory);
    return 'missed';
  }

  private decide(name: CelebrationName, request: CelebrationRequest, memory: CelebrationMemory) {
    const definition: CelebrationDefinition = CELEBRATIONS[name];
    const slot = `${definition.id}:${request.key}`;
    const now = this.now();
    const previous = memory.fired[slot];
    if (previous !== undefined) {
      if ('once' in definition.rule) return 'done';
      if (now - previous < definition.rule.everyMs) return 'resting';
    }
    memory.fired = prune({ ...memory.fired, [slot]: now });
    const { [slot]: _crossed, ...below } = memory.below;
    memory.below = below;
    if (request.level === 'off') return 'off';
    if (request.level === 'quieter' && definition.size !== 'small') return 'quieter';
    if (definition.size !== 'large' && memory.last !== undefined && now - memory.last < QUIET_INTERVAL_MS)
      return 'limited';
    memory.last = now;
    return 'shown';
  }

  private emit(name: CelebrationName, request: CelebrationRequest): void {
    const definition: CelebrationDefinition = CELEBRATIONS[name];
    const lines = definition.lines;
    const line = lines[Math.min(lines.length - 1, Math.floor(this.random() * lines.length))]!;
    const celebration: Celebration = {
      name,
      id: definition.id,
      size: definition.size,
      key: request.key,
      line,
      anchor: request.anchor ?? null,
      cause: request.cause ?? 'you',
    };
    for (const listener of this.listeners) listener(celebration);
  }
}

/** The app's one engine, which triggers everywhere report to and the overlay draws from. */
export const celebrations = new CelebrationEngine();
