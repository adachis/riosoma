import type { AppError } from '@riosoma/contracts';
import { Command, newId } from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import type { Actor } from '../../../http/policy.js';
import { parse } from '../../../http/validate.js';
import { templateCommand } from '../../../templates/instantiate.js';
import type { CommandContext } from '../../commands/context.js';
import { ensureGroup, lock, LONG_DEADLINES, retry, userError } from '../../commands/transaction.js';
import { dataStore } from '../../context.js';
import type { Note } from './report.js';

type Run = (input: Record<string, unknown>) => Promise<void>;

/** Commands as the person, as one action, in transactions the import chooses. */
export class Writer {
  constructor(
    private readonly app: FastifyInstance,
    private readonly actor: Actor,
    readonly databaseId: string,
    readonly groupId: string,
  ) {}

  transaction<T>(work: (run: Run, c: CommandContext) => Promise<T>): Promise<T> {
    const { pool, schemas } = dataStore(this.app.ctx);
    return retry(() =>
      withTransaction(
        pool,
        async (db) => {
          const c: CommandContext = {
            secretKey: this.app.ctx.config.secretKey,
            db,
            schemas,
            actor: this.actor,
            databaseId: this.databaseId,
          };
          await lock(c, [`database:${this.databaseId}`]);
          // Everything the import does is one action in the database's history.
          await ensureGroup(c, this.groupId);
          const run: Run = async (input) => {
            // A command the import got wrong is refused like anyone's, with the reason for each
            // value it got wrong, rather than failing oddly.
            parse(Command, { ...input, id: newId('command'), groupId: this.groupId });
            await templateCommand(c, this.groupId, input);
          };
          return work(run, c);
        },
        LONG_DEADLINES,
      ),
    );
  }

  apply(inputs: ReadonlyArray<Record<string, unknown>>): Promise<void> {
    if (!inputs.length) return Promise.resolve();
    return this.transaction(async (run) => {
      for (const input of inputs) await run(input);
    });
  }

  /** Like `apply`, but a refusal comes back instead of stopping the import. */
  async attempt(input: Record<string, unknown>): Promise<AppError | null> {
    try {
      await this.apply([input]);
      return null;
    } catch (error) {
      const refusal = userError(error);
      if (refusal) return refusal;
      throw error;
    }
  }
}

/**
 * Why a command was refused, for the report.  A refusal that only says some values were invalid
 * gives the first of its per-field reasons instead, since that's the one that says what was wrong.
 */
export function detail(error: AppError): NonNullable<Note['detail']> {
  const params: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(error.params ?? {}))
    if (typeof value === 'string' || typeof value === 'number') params[key] = value;
  const reason = Object.values(error.fields ?? {})[0];
  if (error.messageKey === 'errors.validationFailed' && reason) return { messageKey: reason, params };
  return { messageKey: error.messageKey, params };
}
