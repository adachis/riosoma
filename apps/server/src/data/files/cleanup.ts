import { ident, query, sql, withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app.js';
import { dataStore } from '../context.js';
import type { FileRow } from './metadata.js';
import { cleanupUploads } from './resumable.js';
import { fileStorage } from './storage.js';

export async function cleanupUnattached(ctx: AppContext): Promise<void> {
  if (!ctx.pool || !ctx.config.database) return;
  await cleanupUploads({ ctx });
  const { pool, schemas } = dataStore(ctx);
  for (;;) {
    const count = await withTransaction(pool, async (db) => {
      // The same row lock guards initial attachment, so cleanup cannot delete a claimed file.
      const files = await query<FileRow>(
        db,
        sql`SELECT * FROM ${ident(schemas.app, 'files')}
        WHERE field_id IS NOT NULL AND attached_at IS NULL AND created_at < now() - interval '1 day'
        AND table_id NOT IN (SELECT t.id FROM ${ident(schemas.app, 'tables')} t
          JOIN ${ident(schemas.app, 'databases')} d ON d.id = t.database_id WHERE d.legal_hold)
        ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED`,
      );
      for (const file of files.rows) {
        await query(
          db,
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:file:${file.storage_key}`}, 0))`,
        );
        await query(db, sql`DELETE FROM ${ident(schemas.app, 'files')} WHERE id = ${file.id}`);
        const shared = await query(
          db,
          sql`SELECT 1 FROM ${ident(schemas.app, 'files')} WHERE storage_key = ${file.storage_key} LIMIT 1`,
        );
        if (!shared.rowCount) {
          const storage = fileStorage(file.storage, db, schemas.app, ctx.config);
          for (const key of [file.storage_key, `${file.storage_key}_small`, `${file.storage_key}_large`])
            await storage.delete(key);
        }
      }
      return files.rows.length;
    });
    if (count < 100) return;
  }
}

export function installFileCleanup(app: FastifyInstance): void {
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  app.addHook('onReady', async () => {
    timer = setInterval(
      () => {
        if (running) return;
        running = cleanupUnattached(app.ctx)
          .catch((error: unknown) => {
            app.log.warn({ err: error }, 'unattached file cleanup failed');
          })
          .finally(() => {
            running = undefined;
          });
      },
      60 * 60 * 1000,
    );
    timer.unref();
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await running;
  });
}
