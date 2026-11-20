import { AppError } from '@riosoma/contracts';
import type { AppContext } from '../../app.js';
import type { Actor } from '../../http/policy.js';

/**
 * How long each stage of a document import may take.  Each clock starts with its own stage, so time
 * spent waiting for a slot never shortens the reading.  Tests shorten them.
 */
export const DOCUMENT_TIMING = {
  /** The longest a request waits in line before it is told the import is busy */
  queueMs: 60_000,
  /** The longest an upload may take to arrive once its slot is granted */
  uploadMs: 30_000,
  /** The longest the reading itself may take once its slot is granted */
  extractionMs: 120_000,
};

/** Readings one server runs at once */
const SLOTS = 2;
/** Requests waiting in line, in all, for one person, and for one organization */
const WAITING = 8;
const PERSON_WAITING = 3;
const ORG_WAITING = 4;
/** A full line still takes an organization's first waiting request, up to this many in all. */
const WAITING_CAP = 16;

type Waiting = { person: string; org: string; start: () => void };
type Queue = {
  people: Set<string>;
  orgs: Map<string, number>;
  /** When each organization with work running or waiting last got a slot, as a running count */
  served: Map<string, number>;
  turns: number;
  waiting: Waiting[];
};
const queues = new WeakMap<AppContext, Queue>();

export const documentCanceled = () => new AppError('bad_request', 'import.document.canceled');
const busy = () => new AppError('rate_limited', 'import.document.busy');

/**
 * Fills free slots fairly: the next slot goes to the waiting organization with the fewest readings
 * running, then to the one served least recently, then to the earliest request.  An organization
 * alone uses every slot, and one that is waiting gets the next free slot ahead of an organization
 * already reading or just served.
 */
function advance(queue: Queue) {
  while (queue.people.size < SLOTS) {
    let index = -1;
    let best: [number, number] = [Infinity, Infinity];
    queue.waiting.forEach((item, at) => {
      if (queue.people.has(item.person)) return;
      const rank: [number, number] = [queue.orgs.get(item.org) ?? 0, queue.served.get(item.org) ?? -1];
      if (rank[0] < best[0] || (rank[0] === best[0] && rank[1] < best[1])) {
        best = rank;
        index = at;
      }
    });
    if (index < 0) return;
    queue.waiting.splice(index, 1)[0]!.start();
  }
}

/** An organization with nothing running or waiting drops out of the record of turns. */
function forget(queue: Queue, org: string) {
  if (!queue.orgs.has(org) && !queue.waiting.some((item) => item.org === org)) queue.served.delete(org);
}

/**
 * Waiting uploads keep their streams paused, with one active reading per person and the server's
 * slots shared fairly between organizations.  A wait that runs out answers busy, and a canceled
 * one fails quietly.
 */
export async function withDocumentSlot<T>(
  ctx: AppContext,
  actor: Actor,
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw documentCanceled();
  let queue = queues.get(ctx);
  if (!queue) {
    queue = { people: new Set(), orgs: new Map(), served: new Map(), turns: 0, waiting: [] };
    queues.set(ctx, queue);
  }
  const current = queue;
  const person = actor.userId;
  const org = actor.orgId;
  const orgWaiting = current.waiting.filter((item) => item.org === org).length;
  if (
    current.waiting.length >= (orgWaiting ? WAITING : WAITING_CAP) ||
    current.waiting.filter((item) => item.person === person).length >= PERSON_WAITING ||
    orgWaiting >= ORG_WAITING
  )
    throw busy();
  await new Promise<void>((resolve, reject) => {
    const leave = (error: AppError) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const index = current.waiting.indexOf(item);
      if (index >= 0) current.waiting.splice(index, 1);
      forget(current, org);
      reject(error);
    };
    const abort = () => leave(documentCanceled());
    const timer = setTimeout(() => leave(busy()), DOCUMENT_TIMING.queueMs);
    const item: Waiting = {
      person,
      org,
      start: () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        current.people.add(person);
        current.orgs.set(org, (current.orgs.get(org) ?? 0) + 1);
        current.served.set(org, ++current.turns);
        resolve();
      },
    };
    current.waiting.push(item);
    signal?.addEventListener('abort', abort, { once: true });
    advance(current);
  });
  try {
    if (signal?.aborted) throw documentCanceled();
    return await work();
  } finally {
    current.people.delete(person);
    const held = (current.orgs.get(org) ?? 1) - 1;
    if (held > 0) current.orgs.set(org, held);
    else current.orgs.delete(org);
    advance(current);
    forget(current, org);
  }
}
