import { connectDatabase, ident, query, sql } from '@riosoma/db';
import { loadConfig } from '../config.js';
import { startupFailure } from '../configuration-error.js';
import { checkFileStorage } from '../data/files/check.js';
import { moveFiles, MoveRunning, removeOldCopies } from '../data/files/move.js';
import { missingSetting, STORAGE_KINDS, type StorageKind } from '../data/files/storage.js';

/**
 * Moves attachments from wherever they are to another store, or removes the old copies a move
 * left behind.
 *
 *   node apps/server/dist/tools/storage-move.js --to <postgres|local|s3|azure-blob>
 *   node apps/server/dist/tools/storage-move.js --remove-old
 *
 * From a checkout, `pnpm --filter @riosoma/server storage:move --to s3` runs the same thing.  It
 * reads the settings the way the server does, so both stores' settings must be there: the one files
 * are in now, to read them, and the one they're going to.  Each file is copied, checked by size and
 * checksum in its new store, and then switched over, while the server keeps running.  It can be
 * stopped and run again at any time.  It exits with 1 when any file couldn't be moved, and those
 * stay where they were.
 */

const USAGE = 'Usage: storage-move --to <postgres|local|s3|azure-blob>, or storage-move --remove-old';

/** A problem worth saying in words.  Anything else is printed the way a failed start is, with no values. */
class ToolError extends Error {}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const to = args.indexOf('--to') >= 0 ? args[args.indexOf('--to') + 1] : undefined;
  const removeOld = args.includes('--remove-old');
  if (removeOld === Boolean(to)) throw new ToolError(USAGE);
  if (to && !(STORAGE_KINDS as readonly string[]).includes(to)) throw new ToolError(USAGE);
  const log = (line: string) => console.log(line);

  const config = loadConfig();
  if (!config.database) throw new ToolError('The server has no database configured yet');
  // One connection holds the lock that keeps moves apart, and the move itself needs another.
  const database = await connectDatabase(config.database, { max: Math.max(2, config.database.pool.max) });
  try {
    const appSchema = config.database.schemas.app;
    if (removeOld) {
      const report = await removeOldCopies(database.pool, appSchema, config, log);
      return report.failed.length ? 1 : 0;
    }
    const target = to as StorageKind;
    const needed = (kind: StorageKind) => {
      const setting = missingSetting(kind, config);
      return (
        setting &&
        `Set ${setting}${setting === 'RIOSOMA_FILES_DIR' ? '' : ' and the settings that go with it'}`
      );
    };
    if (needed(target)) throw new ToolError(`${needed(target)} to move files to ${target}`);
    const sources = await query<{ storage: StorageKind }>(
      database.pool,
      sql`SELECT DISTINCT storage FROM ${ident(appSchema, 'files')} WHERE storage <> ${target}`,
    );
    for (const { storage } of sources.rows)
      if (needed(storage))
        throw new ToolError(
          `${needed(storage)}, since some files are in ${storage} and have to be read from there`,
        );
    // The same check the server makes at start, against the store the files are going to.
    await checkFileStorage({ ...config, filesStorage: target });
    if ((config.filesStorage ?? 'postgres') !== target)
      log(
        `New uploads still go to ${config.filesStorage ?? 'postgres'}.  Set RIOSOMA_FILES_STORAGE to ${target}, ` +
          'restart the server, and run this again to move what was uploaded meanwhile.',
      );
    const report = await moveFiles(database.pool, appSchema, config, target, log);
    if (!report.failed.length)
      log('The old copies are still there.  Once you are satisfied, remove them with --remove-old.');
    return report.failed.length ? 1 : 0;
  } catch (error) {
    if (error instanceof MoveRunning)
      throw new ToolError(`${error.message}.  Wait for it to finish, then try again`);
    if ((error as { code?: unknown }).code === '42P01')
      throw new ToolError('Start the server once with this version, so its migrations run, then try again');
    throw error;
  } finally {
    await database.close();
  }
}

if (/storage-move\.[jt]s$/.test(process.argv[1] ?? '')) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof ToolError ? error.message : JSON.stringify(startupFailure(error)));
      process.exit(1);
    },
  );
}
