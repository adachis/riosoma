import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConnectorError } from '../types.js';
import { driverDefinition, type DriverId } from './catalog.js';

export interface InstalledDriver {
  revision: string;
  version: string;
  catalogHash: string;
  licenseHash: string;
  installedAt: string;
}

export function driversDirectory(directory?: string): string {
  return resolve(
    directory ??
      process.env.RIOSOMA_DRIVERS_DIR ??
      join(process.env.RIOSOMA_CONFIG_DIR ?? '/config', 'drivers'),
  );
}

export async function installedDriver(directory: string, id: DriverId): Promise<InstalledDriver | null> {
  try {
    const folder = join(directory, id);
    if ((await lstat(folder)).isSymbolicLink()) throw new Error();
    const path = join(folder, 'active.json');
    if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink()) throw new Error();
    const value = JSON.parse(await readFile(path, 'utf8')) as InstalledDriver;
    if (
      !/^[a-f0-9-]{36}$/.test(value.revision) ||
      !/^[a-f0-9]{64}$/.test(value.catalogHash) ||
      !/^[a-f0-9]{64}$/.test(value.licenseHash) ||
      typeof value.version !== 'string'
    )
      throw new Error();
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ConnectorError('sources.drivers.invalidInstall');
  }
}

/** How many connections in this process are open on each driver revision, by revision */
const opened = new Map<string, number>();
/** What runs once the last connection open on a revision closes */
const waiting = new Map<string, Array<() => void>>();

/**
 * Counts one more connection open on `revision` until the function it returns is called.  An
 * update leaves a revision in use in place, so a driver that loads its files as it needs them keeps
 * finding them for as long as the connection lasts.
 */
export function useRevision(revision: string): () => void {
  opened.set(revision, (opened.get(revision) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (opened.get(revision) ?? 1) - 1;
    if (left > 0) {
      opened.set(revision, left);
      return;
    }
    opened.delete(revision);
    const callbacks = waiting.get(revision) ?? [];
    waiting.delete(revision);
    for (const callback of callbacks) callback();
  };
}

/**
 * Whether a connection in this process is open on `revision`.  When one is, `then` runs once the
 * last of them closes.  The answer and the wait begin together, so no connection closes between.
 */
export function revisionInUse(revision: string, then?: () => void): boolean {
  if (!opened.has(revision)) return false;
  if (then) waiting.set(revision, [...(waiting.get(revision) ?? []), then]);
  return true;
}

/** Recheck the active manifest on every call, including after a module was cached by a worker. */
export async function installedDriverUrl(id: DriverId, directory?: string): Promise<string> {
  const root = driversDirectory(directory);
  const installed = await installedDriver(root, id);
  if (!installed) throw new ConnectorError('sources.test.driverMissing');
  return (await driverEntry(root, id, installed.revision)).url;
}

/**
 * The active revision's entry for a connection to load, the revision's folder, and the function
 * that ends its use.  The revision is counted in use before it's checked, and checked to be still
 * active, so an update that lands in between is followed to the revision it activated rather than
 * pruned from under it.
 */
export async function useInstalledDriver(
  id: DriverId,
  directory?: string,
): Promise<{ url: string; folder: string; release: () => void }> {
  const root = driversDirectory(directory);
  for (let attempt = 0; attempt < 3; attempt++) {
    const installed = await installedDriver(root, id);
    if (!installed) throw new ConnectorError('sources.test.driverMissing');
    const release = useRevision(installed.revision);
    try {
      if ((await installedDriver(root, id))?.revision !== installed.revision) {
        release();
        continue;
      }
      return { ...(await driverEntry(root, id, installed.revision)), release };
    } catch (error) {
      release();
      throw error;
    }
  }
  throw new ConnectorError('sources.drivers.busy');
}

async function driverEntry(
  root: string,
  id: DriverId,
  name: string,
): Promise<{ url: string; folder: string }> {
  const definition = driverDefinition(id)!;
  const revision = join(await realpath(root), id, name);
  const entry = join(revision, definition.entry);
  const actualRoot = await realpath(revision);
  const actual = await realpath(entry);
  const inside = relative(actualRoot, actual);
  if (
    inside.startsWith(`..${sep}`) ||
    inside === '..' ||
    isAbsolute(inside) ||
    actualRoot !== revision ||
    actual !== entry
  )
    throw new ConnectorError('sources.drivers.invalidInstall');
  return { url: pathToFileURL(entry).href, folder: revision };
}
