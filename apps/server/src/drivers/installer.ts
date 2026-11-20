import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { AppError } from '@riosoma/contracts';
import {
  DRIVER_CATALOG,
  catalogHash,
  driverAddons,
  driverArtifacts,
  driversDirectory,
  installedDriver,
  licenseHash,
  revisionInUse,
  unpackedBytes,
  type DriverArtifact,
  type DriverDefinition,
  type DriverId,
  type InstalledDriver,
} from '@riosoma/connectors';
import { clock, processStarts, running, STARTED, START_TOLERANCE_MS } from '../shared/processes.js';
import { extractAddon, MAX_DRIVER_BYTES, receiveArchive, tooLarge, unpackDriverFile } from './archive.js';

export interface InstallRequest {
  licenseHash: string;
  catalogHash: string;
  /** Install from the archives uploaded for this driver rather than downloading them */
  offline?: boolean;
}
export type DriverAudit = (action: string, metadata: Record<string, unknown>) => Promise<void>;

/** The longest one download may take, its whole archive included */
export const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Where pinned archives download from: npm's registry, and IBM's own folder of its client */
const DOWNLOAD_SOURCES = [
  'https://registry.npmjs.org/',
  'https://public.dhe.ibm.com/ibmdl/export/pub/software/data/db2/drivers/odbc_cli/',
] as const;
/** The longest one upload may take, from its first byte to its last */
export const UPLOAD_TIMEOUT_MS = 15 * 60_000;
/**
 * How old a lock gets before the next change takes it over even when its process can't be shown to
 * be gone, as when another host took it.  Every download and upload has its own deadline, so no
 * install, upload, or removal holds a lock anywhere near this long.
 */
export const LOCK_STALE_MS = 60 * 60_000;

/** Who holds a driver's lock, written inside it when it's taken */
interface LockOwner {
  host: string;
  pid: number;
  /** When that process started, so a later process given the same ID isn't taken for it */
  started: number;
  /** When the lock was taken, in milliseconds since 1970 */
  at: number;
  token: string;
}
interface LockState {
  owner: LockOwner | null;
  /** The lock folder's own identity, which moving it keeps */
  ino: number;
  /** When the lock folder last changed, for a lock whose owner can't be read */
  changed: number;
}

export interface InstallerOptions {
  catalog?: readonly DriverDefinition[];
  platform?: string;
  /** The bytes free for drivers in `directory` */
  freeSpace?: (directory: string) => Promise<number>;
}

const busy = () => new AppError('conflict', 'sources.drivers.busy');
const invalidInstall = () => new AppError('validation_failed', 'sources.drivers.invalidInstall');
const megabytes = (bytes: number) => Math.ceil(bytes / 1024 / 1024);
const ACTIVE = 'active.json';
const UPLOADS = 'uploads';

async function freeSpace(directory: string): Promise<number> {
  const info = await statfs(directory);
  return info.bavail * info.bsize;
}

async function lockState(path: string): Promise<LockState | null> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let owner: LockOwner | null = null;
  try {
    const value = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as LockOwner;
    if (
      typeof value.host === 'string' &&
      Number.isSafeInteger(value.pid) &&
      Number.isFinite(value.started) &&
      Number.isFinite(value.at) &&
      typeof value.token === 'string'
    )
      owner = value;
  } catch {
    // A lock whose owner can't be read goes by its own age alone.
  }
  return { owner, ino: info.ino, changed: info.mtimeMs };
}

/**
 * Whether a lock's holder is gone.  On this host its process has stopped, or its process ID now
 * belongs to a process that started at another time, like this one restarted after a crash.  A lock
 * from another host, or whose owner can't be read, is gone once it's older than `LOCK_STALE_MS`.
 */
async function stale({ owner, changed }: LockState): Promise<boolean> {
  // A time that far ahead is as wrong as one that far behind.
  if (Math.abs(clock() - (owner?.at ?? changed)) > LOCK_STALE_MS) return true;
  if (!owner || owner.host !== hostname()) return false;
  if (owner.pid === process.pid) return Math.abs(owner.started - STARTED) > START_TOLERANCE_MS;
  if (!running(owner.pid)) return true;
  const start = (await processStarts([owner.pid])).get(owner.pid);
  return start !== undefined && Math.abs(start - owner.started) > START_TOLERANCE_MS;
}

/** The server supplies the catalog and audit writer.  Neither is taken from an install request. */
export class DriverInstaller {
  readonly directory: string;
  private readonly catalog: readonly DriverDefinition[];
  private readonly platform: string;
  private readonly freeSpace: (directory: string) => Promise<number>;

  constructor(
    directory: string,
    readonly enabled: boolean,
    private readonly audit: DriverAudit,
    options: InstallerOptions = {},
  ) {
    this.directory = driversDirectory(directory);
    this.catalog = options.catalog ?? DRIVER_CATALOG;
    this.platform = options.platform ?? `${process.platform}-${process.arch}`;
    this.freeSpace = options.freeSpace ?? freeSpace;
  }

  private definition(id: string): DriverDefinition {
    const driver = this.catalog.find((item) => item.id === id);
    if (!driver) throw new AppError('validation_failed', 'sources.drivers.unknown');
    return driver;
  }

  /** A driver that may be installed here, or the reason it can't be */
  private installable(id: string): DriverDefinition {
    if (!this.enabled) throw new AppError('forbidden', 'sources.drivers.disabled');
    const driver = this.definition(id);
    if (!driver.ready || !driver.licenseText || !driver.artifacts.length)
      throw new AppError('validation_failed', 'sources.drivers.unavailable');
    if (!driver.platforms.includes(this.platform) || !driverArtifacts(driver, this.platform).length)
      throw new AppError('validation_failed', 'sources.drivers.platform');
    return driver;
  }

  async list() {
    return {
      enabled: this.enabled,
      platform: this.platform,
      drivers: await Promise.all(
        this.catalog.map(async (driver) => ({
          ...driver,
          // An offline install uploads the archives for this server's platform, and only those.
          artifacts: driverArtifacts(driver, this.platform),
          licenseHash: licenseHash(driver),
          catalogHash: catalogHash(driver),
          supported: driver.platforms.includes(this.platform),
          installed: await installedDriver(this.directory, driver.id),
        })),
      ),
    };
  }

  /** The drivers folder, made when missing.  A link in its place is refused. */
  private async root(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(this.directory)).isSymbolicLink()) throw invalidInstall();
  }

  /** One driver's folder, made when missing.  A link in its place is refused. */
  private async folder(id: DriverId): Promise<string> {
    const folder = join(this.directory, id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if ((await lstat(folder)).isSymbolicLink()) throw invalidInstall();
    return folder;
  }

  /**
   * Runs `action` holding the driver's lock, a folder that records the host, process, and time that
   * took it.  A lock whose holder is gone, as `stale` decides, is moved aside and taken over, and
   * one whose holder is alive answers that the driver is busy.
   */
  private async locked<T>(id: DriverId, action: () => Promise<T>): Promise<T> {
    await this.root();
    const lock = join(this.directory, `.${id}.lock`);
    const token = await this.acquire(lock);
    try {
      return await action();
    } finally {
      if ((await lockState(lock))?.owner?.token === token) await rm(lock, { recursive: true, force: true });
    }
  }

  private async acquire(lock: string): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await mkdir(lock, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!(await this.takeOver(lock))) throw busy();
        continue;
      }
      const owner: LockOwner = {
        host: hostname(),
        pid: process.pid,
        started: STARTED,
        at: clock(),
        token: randomUUID(),
      };
      try {
        await writeFile(join(lock, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        await rm(lock, { recursive: true, force: true });
        throw error;
      }
      return owner.token;
    }
    throw busy();
  }

  /** Moves a stale lock aside, and says whether the lock is free to take now. */
  private async takeOver(lock: string): Promise<boolean> {
    const held = await lockState(lock);
    if (!held) return true;
    if (!(await stale(held))) return false;
    const aside = `${lock}.stale-${randomUUID()}`;
    try {
      await rename(lock, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
    const moved = await lockState(aside);
    if (moved && moved.ino === held.ino && moved.owner?.token === held.owner?.token) {
      await rm(aside, { recursive: true, force: true });
      return true;
    }
    // Someone took the lock between the look and the move, so it goes back to them.
    await rename(aside, lock).catch(() => undefined);
    return false;
  }

  /** Refuses clearly, before anything is written, when the drivers folder lacks `needed` bytes. */
  private async room(needed: number): Promise<void> {
    const available = await this.freeSpace(this.directory);
    if (available < needed)
      throw new AppError('validation_failed', 'sources.drivers.space', {
        params: { needed: megabytes(needed), available: megabytes(available) },
      });
  }

  /**
   * Removes everything in a driver's folder but its active manifest and the revision it names:
   * revisions it replaced, and whatever an install that stopped part way left, like a revision
   * never activated, a manifest never moved into place, or an archive never unpacked.  Nothing is
   * removed while the active manifest can't be read, so a damaged one never costs the revision.
   *
   * A replaced revision that a connection in this process still has open stays until the last such
   * connection closes, so a sync reading with it can still load its files.  A server that starts
   * has no connections yet, so its cleanup removes every replaced revision.
   */
  private async prune(id: DriverId): Promise<void> {
    const folder = join(this.directory, id);
    let names: string[];
    try {
      if ((await lstat(folder)).isSymbolicLink()) return;
      names = await readdir(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let active: InstalledDriver | null;
    try {
      active = await installedDriver(this.directory, id);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === ACTIVE || name === active?.revision) continue;
      if (revisionInUse(name, () => void this.retire(id, name))) continue;
      await rm(join(folder, name), { recursive: true, force: true });
    }
  }

  /**
   * Removes one replaced revision once no connection has it open.  Only a revision that was active
   * once comes here, and none becomes active again, so no install can be writing it and the lock
   * isn't needed.  Should this fail, the next install or start of the server clears it.
   */
  private async retire(id: DriverId, revision: string): Promise<void> {
    try {
      const folder = join(this.directory, id);
      if ((await lstat(folder)).isSymbolicLink()) return;
      if ((await installedDriver(this.directory, id))?.revision === revision) return;
      if (revisionInUse(revision, () => void this.retire(id, revision))) return;
      await rm(join(folder, revision), { recursive: true, force: true });
    } catch {
      // Left for the next install or start.
    }
  }

  /**
   * Clears what a crash left, for a server that's starting: each driver's folder is pruned to its
   * active revision, under its lock, so a lock the crash left is taken over first.  A driver whose
   * lock a live process holds is left for that process.
   */
  async cleanup(): Promise<void> {
    try {
      if ((await lstat(this.directory)).isSymbolicLink()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const driver of this.catalog) {
      try {
        await this.locked(driver.id, () => this.prune(driver.id));
      } catch (error) {
        if (!(error instanceof AppError && error.messageKey === 'sources.drivers.busy')) throw error;
      }
    }
    // Locks moved aside by a takeover that stopped before removing them
    for (const name of await readdir(this.directory))
      if (/^\.[a-z_]+\.lock\.stale-/.test(name))
        await rm(join(this.directory, name), { recursive: true, force: true });
  }

  /**
   * Keeps one archive uploaded from an offline computer, for a later install.  Its bytes go to a
   * file as they arrive, hashed and counted on the way: more than `MAX_DRIVER_BYTES` stops it there,
   * and a hash other than the catalog's leaves nothing behind.  It takes the driver's lock, so an
   * install never reads an archive while it's written.
   */
  async upload(id: string, artifactId: string, source: Readable, declared?: number): Promise<void> {
    const driver = this.installable(id);
    const artifact = driverArtifacts(driver, this.platform).find((item) => item.id === artifactId);
    if (!artifact) throw new AppError('validation_failed', 'sources.drivers.unknown');
    if (declared !== undefined && declared > MAX_DRIVER_BYTES) throw tooLarge();
    await this.locked(driver.id, async () => {
      await this.room((declared ?? MAX_DRIVER_BYTES) + unpackedBytes(driver, this.platform));
      const uploads = join(await this.folder(driver.id), UPLOADS);
      await mkdir(uploads, { recursive: true, mode: 0o700 });
      if ((await lstat(uploads)).isSymbolicLink()) throw invalidInstall();
      const partial = join(uploads, `.${randomUUID()}.partial`);
      const timer = setTimeout(
        () => source.destroy(new AppError('validation_failed', 'sources.drivers.uploadIncomplete')),
        UPLOAD_TIMEOUT_MS,
      );
      try {
        // The request stays open when the archive is refused part way, so the refusal can be sent.
        await receiveArchive(source.iterator({ destroyOnReturn: false }), artifact.integrity, partial);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError('validation_failed', 'sources.drivers.uploadIncomplete');
      } finally {
        clearTimeout(timer);
      }
      await rename(partial, join(uploads, `${artifact.id}.tgz`));
    });
  }

  async install(id: string, input: InstallRequest): Promise<InstalledDriver> {
    const driver = this.installable(id);
    if (input.licenseHash !== licenseHash(driver) || input.catalogHash !== catalogHash(driver))
      throw new AppError('validation_failed', 'sources.drivers.licenseChanged');
    return this.locked(driver.id, async () => {
      const folder = await this.folder(driver.id);
      const uploads = join(folder, UPLOADS);
      try {
        return await this.installLocked(driver, input, folder, uploads);
      } finally {
        // Uploaded archives serve one install, whatever became of it.
        if (input.offline) await rm(uploads, { recursive: true, force: true });
      }
    });
  }

  private async installLocked(
    driver: DriverDefinition,
    input: InstallRequest,
    folder: string,
    uploads: string,
  ): Promise<InstalledDriver> {
    const archives = new Map<string, string>();
    const artifacts = driverArtifacts(driver, this.platform);
    if (input.offline)
      for (const artifact of artifacts) {
        const path = join(uploads, `${artifact.id}.tgz`);
        const info = await lstat(path).catch(() => null);
        if (!info?.isFile()) throw new AppError('validation_failed', 'sources.drivers.uploadsRequired');
        archives.set(artifact.id, path);
      }
    // Uploaded archives are already here.  A download needs room for one archive at a time too.
    await this.room(unpackedBytes(driver, this.platform) + (input.offline ? 0 : MAX_DRIVER_BYTES));
    await this.audit('sources.drivers.licenseAccepted', {
      driverId: driver.id,
      version: driver.version,
      licenseHash: input.licenseHash,
    });
    const revision = randomUUID();
    const stage = join(folder, revision);
    const temporaryManifest = join(folder, `${revision}.json`);
    const before = await installedDriver(this.directory, driver.id);
    try {
      await mkdir(stage, { mode: 0o700 });
      for (const artifact of artifacts) {
        const uploaded = archives.get(artifact.id);
        const archive = uploaded ?? join(folder, `${revision}.${artifact.id}.tgz`);
        if (!uploaded) await download(artifact, archive);
        try {
          await unpackDriverFile(archive, artifact.integrity, join(stage, artifact.target), artifact.root, {
            links: artifact.links,
          });
        } finally {
          if (!uploaded) await rm(archive, { force: true });
        }
      }
      // A native add-on comes out of the unpacked package the way its own installer takes it, from
      // the zip the package ships, for this platform only, and never from a build on this server.
      for (const addon of driverAddons(driver, this.platform))
        await extractAddon(
          join(stage, addon.archive),
          addon.entry,
          addon.sha256,
          addon.size,
          join(stage, addon.target),
        );
      const manifest = JSON.parse(await readFile(join(stage, 'package/package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (
        manifest.name !== driver.id ||
        manifest.version !== driver.version ||
        !(await lstat(join(stage, driver.entry))).isFile()
      )
        throw invalidInstall();
      const installed: InstalledDriver = {
        revision,
        version: driver.version,
        catalogHash: input.catalogHash,
        licenseHash: input.licenseHash,
        installedAt: new Date().toISOString(),
      };
      await writeFile(temporaryManifest, JSON.stringify(installed), { flag: 'wx', mode: 0o600 });
      await this.audit('sources.drivers.installing', {
        driverId: driver.id,
        version: driver.version,
        revision,
      });
      await rename(temporaryManifest, join(folder, ACTIVE));
      try {
        await this.audit('sources.drivers.installed', {
          driverId: driver.id,
          version: driver.version,
          revision,
        });
      } catch (error) {
        if (before) {
          await writeFile(temporaryManifest, JSON.stringify(before), { flag: 'wx', mode: 0o600 });
          await rename(temporaryManifest, join(folder, ACTIVE));
        } else await rm(join(folder, ACTIVE), { force: true });
        throw error;
      }
      // Only the active revision stays, apart from one a connection still has open, which goes
      // when that connection closes.  A source's next connection loads the new revision.  Should
      // this fail, the next install or start of the server clears what's left.
      await this.prune(driver.id).catch(() => undefined);
      return installed;
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      await rm(temporaryManifest, { force: true });
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    const driver = this.definition(id);
    await this.locked(driver.id, async () => {
      await this.audit('sources.drivers.removing', { driverId: id });
      await rm(join(this.directory, driver.id), { recursive: true, force: true });
      await this.audit('sources.drivers.removed', { driverId: id });
    });
  }
}

/** Streams one pinned archive from where it's published to `path`, hashed and capped as it arrives. */
async function download(artifact: DriverArtifact, path: string): Promise<void> {
  if (!DOWNLOAD_SOURCES.some((source) => artifact.url.startsWith(source)))
    throw new AppError('validation_failed', 'sources.drivers.unknown');
  try {
    const response = await fetch(artifact.url, {
      redirect: 'error',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) throw new AppError('validation_failed', 'sources.drivers.download');
    if (Number(response.headers.get('content-length') ?? 0) > MAX_DRIVER_BYTES) {
      await response.body.cancel().catch(() => undefined);
      throw new AppError('validation_failed', 'sources.drivers.archiveInvalid');
    }
    await receiveArchive(response.body, artifact.integrity, path);
  } catch (error) {
    if (error instanceof AppError)
      throw error.code === 'payload_too_large'
        ? new AppError('validation_failed', 'sources.drivers.archiveInvalid')
        : error;
    throw new AppError('validation_failed', 'sources.drivers.download');
  }
}
