import { randomInt } from 'node:crypto';
import type { RowData, SimulatedSend, SimulatedWrite } from '@riosoma/contracts';
import type pg from 'pg';
import { LiveReads } from '../sources/live-commands.js';

/**
 * What a simulation records as it walks an automation, beside what a run would save.  Nothing in
 * here is ever written anywhere: record changes are applied, in order, in one transaction that's
 * always rolled back, and sends are only described.
 */

/** A simulation stops after this many record changes, since it holds each record it changes until it ends. */
export const MAX_SIMULATED_WRITES = 100;
/** How long a simulated change waits for a lock someone else holds, in milliseconds */
const LOCK_TIMEOUT_MS = 2_000;

export class Simulation {
  /** How many record changes the simulation has worked out */
  changes = 0;
  /** Records the simulation changed, as they read right after the change, by `tableId:recordId` */
  readonly rows = new Map<string, RowData | null>();
  readonly writes = new Map<string, SimulatedWrite[]>();
  readonly sends = new Map<string, SimulatedSend[]>();
  readonly inputs = new Map<string, Record<string, unknown> | null>();
  /** What live tables' sources answered, so no record is read from its source twice */
  readonly live = new LiveReads();
  /** The trigger record's values as the person simulating reads them, by field ID */
  trigger: Record<string, string | null> = {};
  conditions: { matched: boolean; parts: Array<boolean | null> } | null = null;
  skippedBecause: 'conditions' | 'record' | undefined;
  private client: Promise<pg.PoolClient> | null = null;
  /** The changes under way, one after another, which the transaction waits for before it ends */
  private queue: Promise<unknown> = Promise.resolve();
  private ended = false;
  /**
   * The row number the next record the simulation adds takes.  Tables number their records from 1
   * up, so these count down from a point of the simulation's own, far below zero, and never meet a
   * number a table gives out or one another simulation takes at the same time.
   */
  private nextRid = -(2 ** 40 + randomInt(2 ** 40));

  constructor(private readonly pool: pg.Pool) {}

  write(stepId: string, write: SimulatedWrite): void {
    this.writes.set(stepId, [...(this.writes.get(stepId) ?? []), write]);
  }

  send(stepId: string, send: SimulatedSend): void {
    this.sends.set(stepId, [...(this.sends.get(stepId) ?? []), send]);
  }

  /** A row number for a record the simulation adds, taken from no sequence */
  rid(): number {
    return this.nextRid--;
  }

  /**
   * Applies one change in the simulation's transaction, which the first change begins.  Changes go
   * one at a time, each kept to a savepoint, so a refused change leaves the ones before it standing,
   * and every change after them sees them all.  Once the simulation has ended, none begins, so a
   * change a timed-out script asked for can't outlive the transaction.
   */
  change<T>(work: (db: pg.PoolClient) => Promise<T>): Promise<T> {
    const next = this.queue.then(() => this.apply(work));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async apply<T>(work: (db: pg.PoolClient) => Promise<T>): Promise<T> {
    if (this.ended) throw new Error('The simulation has ended');
    this.client ??= (async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
      } catch (error) {
        client.release(true);
        throw error;
      }
      return client;
    })();
    const db = await this.client;
    await db.query('SAVEPOINT simulated_change');
    try {
      const result = await work(db);
      await db.query('RELEASE SAVEPOINT simulated_change');
      return result;
    } catch (error) {
      // A connection that can't go back to the savepoint fails every change after this one too.
      await db.query('ROLLBACK TO SAVEPOINT simulated_change').catch(() => undefined);
      throw error;
    }
  }

  /**
   * Throws away every change the simulation made, once any change under way is done, and gives
   * its connection back.
   */
  async discard(): Promise<void> {
    this.ended = true;
    await this.queue;
    const opened = this.client;
    this.client = null;
    const client = opened ? await opened.catch(() => null) : null;
    if (!client) return;
    let healthy = true;
    await client.query('ROLLBACK').catch(() => {
      healthy = false;
    });
    client.release(!healthy);
  }
}

/**
 * Runs `work` in a transaction that's rolled back whatever happens, so what it wrote is read and
 * then gone.  It's short and waits little for locks, so it never holds up edits.
 */
export async function rolledBack<T>(pool: pg.Pool, work: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let healthy = true;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
    return await work(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {
      healthy = false;
    });
    client.release(!healthy);
  }
}

/** The stand-in answer a step that would send gets, so the steps after it can still be walked. */
export const STAND_IN = { status: 200, body: '' } as const;
