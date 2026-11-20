import { ident, query, sql, withTransaction } from '@riosoma/db';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { auditEvent, authDatabase } from '../../auth/database.js';
import { notify } from '../../notifications/produce.js';
import { dataStore } from '../context.js';
import { loadTable } from '../metadata.js';
import { CLAMAV_MAX_FILE_BYTES, ScanTooLarge, scanStream } from './clamd.js';
import { recordScannerStatus, requireApprovedScanner, scannerSettings } from './settings.js';
import { SNIFF_BYTES } from './detect.js';
import type { FileRow } from './metadata.js';
import { imagePreviews } from './previews.js';
import { fileStorage } from './storage.js';

function completeContents(source: Readable, expected: number): Readable {
  return Readable.from(
    (async function* () {
      let size = 0;
      try {
        if (!Number.isSafeInteger(expected) || expected < 0) throw new Error('Invalid stored file size');
        for await (const value of source) {
          const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
          size += bytes.length;
          if (size > expected) throw new Error('Stored file size does not match metadata');
          yield bytes;
        }
        // An empty or truncated storage read must never release a metadata-only attachment.
        if (size !== expected) throw new Error('Stored file size does not match metadata');
      } finally {
        source.destroy();
      }
    })(),
    { objectMode: false },
  );
}

/** Row locks distribute the queue across replicas and serialize scans with deletion and moves. */
export async function scanPendingFiles(
  app: FastifyInstance,
  defaultEnabled = Boolean(app.ctx.config.clamavUrl),
): Promise<void> {
  if (!app.ctx.pool || !app.ctx.config.database) return;
  const { pool, schemas } = dataStore(app.ctx);
  const { audit } = authDatabase(app.ctx);
  for (let count = 0; count < 10; count++) {
    const found = await withTransaction(pool, async (db) => {
      const result = await query<FileRow>(
        db,
        sql`SELECT f.* FROM ${ident(schemas.app, 'files')} f
        JOIN ${ident(schemas.app, 'orgs')} o ON o.id = f.org_id
        WHERE scan_state IN ('quarantined', 'unavailable') AND scan_next_at <= now()
          AND COALESCE((o.settings->'fileScanner'->>'enabled')::boolean, ${defaultEnabled})
        ORDER BY scan_next_at LIMIT 1 FOR NO KEY UPDATE OF f, o SKIP LOCKED`,
      );
      const file = result.rows[0];
      if (!file) return false;
      const settings = await scannerSettings(db, schemas.app, file.org_id, app.ctx.config);
      const address = settings.address;
      const storage = fileStorage(file.storage, db, schemas.app, app.ctx.config);
      let signature: string | null;
      try {
        if (!address) throw new Error('Scanner address missing');
        requireApprovedScanner(address, app.ctx.config);
        if (!file.scan_signature && Number(file.size) > CLAMAV_MAX_FILE_BYTES) throw new ScanTooLarge();
        signature =
          file.scan_signature ??
          (await scanStream(address, completeContents(storage.read(file.storage_key), Number(file.size))));
      } catch (error) {
        const oversized = error instanceof ScanTooLarge;
        await recordScannerStatus(db, schemas.app, file.org_id, {
          address,
          reachable: oversized,
          tested: false,
          signatureDate: null,
          lastError: oversized ? 'files.scanner.tooLarge' : 'files.scanner.scanFailed',
        });
        if (oversized) {
          const state = settings.oversizedPolicy === 'allow' ? 'too_large_allowed' : 'too_large';
          await query(
            db,
            sql`UPDATE ${ident(schemas.app, 'files')}
            SET scan_state = ${state}, scan_attempts = scan_attempts + 1 WHERE id = ${file.id}`,
          );
          await auditEvent(
            db,
            audit,
            'data.file.tooLargeToScan',
            { orgId: file.org_id },
            {
              orgId: file.org_id,
              fileId: file.id,
              policy: settings.oversizedPolicy,
            },
          );
          return true;
        }
        const overdue = Date.now() - file.created_at.getTime() >= 60 * 60 * 1000;
        const delay = Math.min(900, 15 * 2 ** Math.min(file.scan_attempts, 6));
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'files')}
          SET scan_attempts = scan_attempts + 1, scan_next_at = now() + ${delay} * interval '1 second',
            scan_state = ${overdue ? 'unavailable' : 'quarantined'} WHERE id = ${file.id}`,
        );
        if (overdue && file.scan_state !== 'unavailable') {
          await auditEvent(
            db,
            audit,
            'data.file.scanUnavailable',
            { orgId: file.org_id },
            {
              orgId: file.org_id,
              fileId: file.id,
            },
          );
          const admins = await query<{ user_id: string }>(
            db,
            sql`SELECT user_id FROM ${ident(schemas.app, 'memberships')}
            WHERE org_id = ${file.org_id} AND (kind = 'owner' OR cardinality(admin_roles) > 0)`,
          );
          for (const admin of admins.rows)
            await notify(db, schemas, {
              orgId: file.org_id,
              recipientId: admin.user_id,
              kind: 'fileScan',
              actorId: null,
              subjectId: file.id,
              target: { reason: { messageKey: 'files.scanUnavailable' } },
            });
        }
        return true;
      }
      if (signature && !file.scan_signature) {
        // Commit the detection before deleting external bytes, so a crash cannot lose the verdict.
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'files')} SET scan_signature = ${signature}
          WHERE id = ${file.id}`,
        );
        return true;
      }
      if (signature) {
        // Byte deletion precedes the tombstone, so a failed deletion stays quarantined for retry.
        for (const key of [file.storage_key, `${file.storage_key}_small`, `${file.storage_key}_large`])
          await storage.delete(key);
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'files')}
          SET scan_state = 'infected', scan_signature = ${signature},
          thumbnails = ${file.thumbnails?.source ? JSON.stringify({ source: file.thumbnails.source }) : null}::jsonb WHERE id = ${file.id}`,
        );
        await auditEvent(
          db,
          audit,
          'data.file.infected',
          { orgId: file.org_id },
          {
            orgId: file.org_id,
            fileId: file.id,
            signature,
          },
        );
        if (file.created_by) {
          const table = await loadTable(db, schemas, file.table_id);
          await notify(db, schemas, {
            orgId: file.org_id,
            recipientId: file.created_by,
            kind: 'fileScan',
            actorId: null,
            subjectId: file.id,
            target: {
              databaseId: table?.databaseId,
              tableId: file.table_id,
              reason: { messageKey: 'files.infected', params: { signature } },
            },
          });
        }
      } else {
        await query(db, sql`SAVEPOINT scan_previews`);
        try {
          const parts: Buffer[] = [];
          for await (const part of storage.read(file.storage_key, { start: 0, end: SNIFF_BYTES - 1 }))
            parts.push(part as Buffer);
          const image = await imagePreviews(storage, file.storage_key, file.type, Buffer.concat(parts));
          await query(
            db,
            sql`UPDATE ${ident(schemas.app, 'files')} SET width = ${image.width}, height = ${image.height},
            thumbnails = ${
              image.thumbnails || file.thumbnails?.source
                ? JSON.stringify({
                    ...image.thumbnails,
                    ...(file.thumbnails?.source ? { source: file.thumbnails.source } : {}),
                  })
                : null
            }::jsonb WHERE id = ${file.id}`,
          );
        } catch {
          await query(db, sql`ROLLBACK TO SAVEPOINT scan_previews`);
          for (const suffix of ['small', 'large']) await storage.delete(`${file.storage_key}_${suffix}`);
        }
        await query(db, sql`RELEASE SAVEPOINT scan_previews`);
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'files')} SET scan_state = 'clean' WHERE id = ${file.id}`,
        );
      }
      return true;
    });
    if (!found) break;
  }
}

export function installFileScanner(app: FastifyInstance): void {
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  app.addHook('onReady', async () => {
    // Environment defaults belong to startup.  Saved organization settings can change at runtime.
    const defaultEnabled = Boolean(app.ctx.config.clamavUrl);
    const run = () => {
      if (running) return;
      running = scanPendingFiles(app, defaultEnabled)
        .catch((err: unknown) => app.log.warn({ err }, 'file scan failed'))
        .finally(() => {
          running = undefined;
        });
    };
    timer = setInterval(run, 5000);
    timer.unref();
    run();
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await running;
  });
}
