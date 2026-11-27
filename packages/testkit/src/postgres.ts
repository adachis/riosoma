import { execFile } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { DatabaseProfile } from '@riosoma/contracts';
import { noteRunningTestServer, noteStoppedTestServer } from './isolation.js';

const run = promisify(execFile);

/**
 * A throwaway PostgreSQL server for tests.  CI points `RIOSOMA_TEST_DATABASE_URL` at a service
 * container; on a developer machine the kit starts a private cluster from the local PostgreSQL
 * binaries in a temporary directory and removes it afterward.
 */
export interface TestPostgres {
  /** Superuser URL for the server's default database */
  url: string;
  /** A fresh, empty database with its own name; each test file should use its own */
  createDatabase(prefix?: string): Promise<{ url: string; profile: DatabaseProfile; drop(): Promise<void> }>;
  stop(): Promise<void>;
}

const BIN_CANDIDATES = [
  process.env.RIOSOMA_PG_BIN,
  '/opt/homebrew/opt/postgresql@18/bin',
  '/opt/homebrew/opt/postgresql@17/bin',
  '/opt/homebrew/opt/postgresql@16/bin',
  '/usr/local/opt/postgresql@16/bin',
  '/usr/lib/postgresql/18/bin',
  '/usr/lib/postgresql/17/bin',
  '/usr/lib/postgresql/16/bin',
];

function findBin(): string {
  const dir = BIN_CANDIDATES.find((d) => d && existsSync(join(d, 'pg_ctl')));
  if (!dir) {
    throw new Error('No PostgreSQL binaries found.  Set RIOSOMA_TEST_DATABASE_URL or RIOSOMA_PG_BIN.');
  }
  return dir;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export function profileFor(url: string): DatabaseProfile {
  const u = new URL(url);
  return DatabaseProfile.parse({
    host: u.hostname,
    port: Number(u.port || 5432),
    database: decodeURIComponent(u.pathname.slice(1)),
    user: decodeURIComponent(u.username),
    auth: { method: 'password', password: decodeURIComponent(u.password) || 'test' },
    tls: { mode: 'disable' },
    pool: { max: 5, idleTimeoutMs: 1_000 },
  });
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

function makeKit(url: string, stop: () => Promise<void>): TestPostgres {
  return {
    url,
    async createDatabase(prefix = 't') {
      const name = `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const admin = new pg.Client({ connectionString: url });
      await admin.connect();
      try {
        await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      } finally {
        await admin.end();
      }
      const dbUrl = withDatabase(url, name);
      return {
        url: dbUrl,
        profile: profileFor(dbUrl),
        async drop() {
          const c = new pg.Client({ connectionString: url });
          await c.connect();
          try {
            await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
          } finally {
            await c.end();
          }
        },
      };
    },
    stop,
  };
}

export interface TestPostgresOptions {
  /** Forces a private cluster with SCRAM authentication. */
  password?: string;
  /** PEM material copied into the private cluster with restricted key permissions. */
  tls?: { certPem: string; keyPem: string };
  /** Where a private cluster's port comes from, which only the kit's own tests choose. */
  choosePort?: () => Promise<number>;
}

/** How many ports a private cluster tries when something else takes each one before it can. */
const PORT_ATTEMPTS = 5;

/**
 * Whether a postmaster's log says it couldn't listen because something else had the address.
 * The cluster runs with the C locale, so the message is PostgreSQL's English one.
 */
function addressTaken(log: string): boolean {
  return /could not bind IPv4 address "127\.0\.0\.1": Address already in use/.test(log);
}

/** True while a process with this ID exists, including ones owned by other users. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Stops clusters whose test run died without stopping them.  macOS allows only a few dozen shared
 * memory segments, and a handful of abandoned clusters is enough to stop new ones from starting.
 */
async function sweepAbandoned(bin: string): Promise<void> {
  for (const parent of new Set([tmpdir(), '/tmp'])) {
    let names: string[];
    try {
      names = readdirSync(parent).filter((name) => name.startsWith('rio-pg-'));
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = join(parent, name);
      let owner: number;
      try {
        owner = Number(readFileSync(join(dir, 'owner.pid'), 'utf8'));
      } catch {
        continue;
      }
      if (!Number.isInteger(owner) || owner <= 0 || alive(owner)) continue;
      await run(join(bin, 'pg_ctl'), ['-D', join(dir, 'data'), '-m', 'immediate', '-w', 'stop'], {
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      }).catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  await sweepOrphanSegments();
}

/**
 * A PostgreSQL server killed without shutting down leaves its small System V interlock segment
 * behind.  macOS allows only 32 of them system-wide, so orphans from crashed or killed test runs
 * eventually stop every new test cluster from starting.  Remove this user's orphans: 56-byte
 * segments nothing is attached to whose creator has exited.
 */
async function sweepOrphanSegments(): Promise<void> {
  if (process.platform !== 'darwin') return;
  let listing: string;
  try {
    listing = (await run('ipcs', ['-m', '-a'])).stdout;
  } catch {
    return;
  }
  const user = process.env.USER;
  for (const line of listing.split('\n')) {
    // T ID KEY MODE OWNER GROUP CREATOR CGROUP NATTCH SEGSZ CPID LPID ...
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'm' || cols.length < 11) continue;
    const [, id, , , owner, , , , attached, size, creator] = cols;
    const pid = Number(creator);
    if (
      owner !== user ||
      attached !== '0' ||
      size !== '56' ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      alive(pid)
    )
      continue;
    await run('ipcrm', ['-m', id!]).catch(() => undefined);
  }
}

export async function startTestPostgres(options: TestPostgresOptions = {}): Promise<TestPostgres> {
  const external = process.env.RIOSOMA_TEST_DATABASE_URL;
  if (external && !options.password && !options.tls && !options.choosePort)
    return makeKit(external, async () => undefined);

  const bin = findBin();
  await sweepAbandoned(bin);
  const dir = mkdtempSync(join(tmpdir(), 'rio-pg-'));
  // Recorded so a later run can stop this cluster if this process dies without cleaning up.
  writeFileSync(join(dir, 'owner.pid'), String(process.pid));
  const data = join(dir, 'data');
  const log = join(dir, 'server.log');
  let port = 0;
  // macOS refuses to start the postmaster without an explicit locale in the environment.
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C' };
  try {
    const passwordFile = join(dir, 'password');
    if (options.password) writeFileSync(passwordFile, options.password, { mode: 0o600 });
    await run(
      join(bin, 'initdb'),
      [
        '-D',
        data,
        '-U',
        'postgres',
        ...(options.password ? ['--auth=scram-sha-256', `--pwfile=${passwordFile}`] : ['--auth=trust']),
        '--no-sync',
        '-E',
        'UTF8',
        '--locale=C',
      ],
      { env },
    );
    if (options.tls) {
      writeFileSync(join(data, 'server.crt'), options.tls.certPem);
      writeFileSync(join(data, 'server.key'), options.tls.keyPem, { mode: 0o600 });
      appendFileSync(join(data, 'postgresql.conf'), '\nssl = on\n');
    }
    // The port comes from a listener that closes before the postmaster binds it, since a server in
    // another process can't take over a socket bound here, and anything on the machine can take
    // the port in between.  When the postmaster's log says that happened, it starts on another
    // port.  Every other failure ends the start.
    for (let attempt = 1; ; attempt++) {
      port = await (options.choosePort ?? freePort)();
      const before = existsSync(log) ? readFileSync(log, 'utf8').length : 0;
      try {
        await run(
          join(bin, 'pg_ctl'),
          [
            '-D',
            data,
            '-l',
            log,
            '-w',
            '-o',
            `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
            'start',
          ],
          { env },
        );
        break;
      } catch (error) {
        const said = existsSync(log) ? readFileSync(log, 'utf8').slice(before) : '';
        if (attempt < PORT_ATTEMPTS && addressTaken(said)) continue;
        throw error;
      }
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  // The port came from a listener that closed before PostgreSQL took it, and an earlier cluster may
  // have stopped on it, so clear any record of the port as one no server answers on.
  noteRunningTestServer(port);
  const url = `postgres://postgres:${encodeURIComponent(options.password ?? 'test')}@127.0.0.1:${port}/postgres`;
  return makeKit(url, async () => {
    // Recorded before the stop, so a client that was never ended fails here rather than reaching
    // whatever test server the operating system gives this port to next.
    noteStoppedTestServer(port, 'a PostgreSQL server this test run started and stopped');
    await run(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { env }).catch(
      () => undefined,
    );
    rmSync(dir, { recursive: true, force: true });
  });
}
