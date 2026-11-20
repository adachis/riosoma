import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The updater sidecar, run as it runs in Compose, against a stand-in Docker Engine API on
 * 127.0.0.1.  Nothing here touches a real Docker socket.  Riosoma's /healthz answers through the
 * stand-in's exec, as the sidecar asks each container for it.
 */

const SCRIPT = fileURLToPath(new URL('../../../../deploy/updater/updater.mjs', import.meta.url));
const REPOSITORY = 'registry.example.test/riosoma';
const digestOf = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;
const NEW_DIGEST = digestOf('b');
const OLD_IMAGE_ID = digestOf('1');
const NEW_IMAGE_ID = digestOf('2');
const OLD_ID = 'a1'.repeat(32);
const SELF_ID = 'c3'.repeat(32);
const LEFTOVER_ID = 'd4'.repeat(32);
const CONNECTORS_REPOSITORY = 'registry.example.test/riosoma-connectors';
const CONNECTORS_NEW_DIGEST = digestOf('e');
const CONNECTORS_OLD_IMAGE_ID = digestOf('3');
const CONNECTORS_ID = 'f5'.repeat(32);
const DAY = 24 * 60 * 60_000;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

function json(response: ServerResponse, status: number, value?: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(value === undefined ? '' : JSON.stringify(value));
}

/** One frame of Docker's multiplexed stream */
function frame(text: string): Buffer {
  const data = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

interface Container {
  Id: string;
  Name: string;
  Image: string;
  Config: Record<string, unknown> & { Env: string[]; Labels: Record<string, string>; Image: string };
  HostConfig: Record<string, unknown>;
  NetworkSettings: { Networks: Record<string, Record<string, unknown>> };
  State: { Status: string; Running: boolean; Health?: { Status: string } };
  startedAt?: number;
}

interface EngineOptions {
  /** How long after it starts the new version answers /healthz */
  healthyAfterMs?: number;
  /** Whether the new version never answers /healthz */
  neverHealthy?: boolean;
  /** Renames the stand-in refuses, besides those Docker itself refuses */
  refuseRename?: (to: string) => boolean;
  /** A sidecar left over from an earlier update, which the new one removes as it starts */
  leftover?: boolean;
  /** Whether the Compose project runs a connector service */
  connectors?: boolean;
  /** Whether the new release's image names a connector service image */
  connectorsRelease?: boolean;
}

const IMAGE_ENV = ['PATH=/usr/bin', 'RIOSOMA_VERSION=1.0.0', 'NODE_ENV=production'];

/**
 * A Docker Engine API with a Compose project of Riosoma 1.0.0, its backup service, and the
 * updater itself.  The backup service's database holds the runs in `runsInBackupDatabase`.
 */
class Engine {
  calls: Array<{ method: string; path: string; body?: unknown }> = [];
  containers = new Map<string, Container>();
  images = new Map<string, Record<string, unknown>>();
  execs = new Map<string, { cmd: string[]; exitCode: number; output: string }>();
  runsInBackupDatabase = new Set<string>();
  private count = 0;
  server = createServer((request, response) => void this.handle(request, response));

  constructor(readonly options: EngineOptions = {}) {
    const labels = (service: string) => ({
      'com.docker.compose.project': 'rio',
      'com.docker.compose.service': service,
    });
    this.images.set(OLD_IMAGE_ID, {
      Id: OLD_IMAGE_ID,
      RepoDigests: [`${REPOSITORY}@${digestOf('a')}`],
      Os: 'linux',
      Architecture: 'amd64',
      Config: {
        Env: IMAGE_ENV,
        Cmd: ['dist/main.js'],
        User: 'nonroot',
        Labels: { 'org.opencontainers.image.title': 'riosoma' },
      },
    });
    this.add({
      Id: OLD_ID,
      Name: '/rio-riosoma-1',
      Image: OLD_IMAGE_ID,
      Config: {
        Image: `${REPOSITORY}:1.0.0`,
        Hostname: OLD_ID.slice(0, 12),
        Env: [...IMAGE_ENV, 'RIOSOMA_BASE_URL=https://rio.example.test'],
        Cmd: ['dist/main.js'],
        User: 'nonroot',
        Labels: { ...labels('riosoma'), 'org.opencontainers.image.title': 'riosoma' },
      },
      HostConfig: { Binds: ['rio_config:/config'], RestartPolicy: { Name: 'unless-stopped' } },
      NetworkSettings: {
        Networks: {
          rio_default: { Aliases: ['riosoma', OLD_ID.slice(0, 12)] },
          rio_domains: { IPAMConfig: { IPv4Address: '172.30.52.3' }, Aliases: ['riosoma'] },
          rio_updater: { Aliases: ['riosoma'] },
        },
      },
      State: { Status: 'running', Running: true },
    });
    this.add({
      Id: 'backup1',
      Name: '/rio-backup-1',
      Image: 'postgres',
      Config: { Image: 'postgres', Env: [], Labels: labels('backup') },
      HostConfig: {},
      NetworkSettings: { Networks: {} },
      State: { Status: 'running', Running: true },
    });
    this.add({
      Id: SELF_ID,
      Name: '/rio-updater-1',
      Image: OLD_IMAGE_ID,
      Config: {
        Image: `${REPOSITORY}:1.0.0`,
        Hostname: SELF_ID.slice(0, 12),
        Env: [...IMAGE_ENV, 'UPDATER_TOKEN=from-compose'],
        Cmd: ['/app/updater/updater.mjs'],
        User: '0:0',
        Labels: { ...labels('updater'), 'org.opencontainers.image.title': 'riosoma' },
      },
      HostConfig: { Binds: ['/var/run/docker.sock:/var/run/docker.sock', 'rio_updater-state:/state'] },
      NetworkSettings: { Networks: { rio_updater: { Aliases: ['updater', SELF_ID.slice(0, 12)] } } },
      State: { Status: 'running', Running: true },
    });
    if (options.connectors) {
      this.images.set(CONNECTORS_OLD_IMAGE_ID, {
        Id: CONNECTORS_OLD_IMAGE_ID,
        RepoDigests: [`${CONNECTORS_REPOSITORY}@${digestOf('9')}`],
        Os: 'linux',
        Architecture: 'amd64',
        Config: { Env: IMAGE_ENV, Cmd: ['dist/main.js'], User: 'nonroot', Labels: {} },
      });
      this.add({
        Id: CONNECTORS_ID,
        Name: '/rio-connectors-1',
        Image: CONNECTORS_OLD_IMAGE_ID,
        Config: {
          Image: `${CONNECTORS_REPOSITORY}:1.0.0`,
          Env: [...IMAGE_ENV, 'RIOSOMA_LOG_LEVEL=info'],
          Cmd: ['dist/main.js'],
          User: 'nonroot',
          Labels: labels('connectors'),
        },
        HostConfig: { Binds: ['rio_connector-token:/connector-token:ro'] },
        NetworkSettings: {
          Networks: {
            rio_default: { Aliases: ['connectors'] },
            rio_connectors: { Aliases: ['connectors', 'connector-service'] },
          },
        },
        State: { Status: 'running', Running: true },
      });
    }
    if (options.leftover)
      this.add({
        Id: LEFTOVER_ID,
        Name: '/rio-updater-1-replaced',
        Image: OLD_IMAGE_ID,
        Config: { Image: `${REPOSITORY}:0.9.0`, Env: [], Labels: labels('updater') },
        HostConfig: {},
        NetworkSettings: { Networks: {} },
        State: { Status: 'running', Running: true },
      });
  }

  private add(container: Container) {
    this.containers.set(container.Id, container);
  }

  called(method: string, prefix: string) {
    return this.calls.filter((call) => call.method === method && call.path.startsWith(prefix));
  }

  execCommands(containerId: string) {
    return this.called('POST', `/containers/${containerId}/exec`).map(
      (call) => (call.body as { Cmd: string[] }).Cmd,
    );
  }

  byName(name: string) {
    return [...this.containers.values()].find((item) => item.Name === `/${name}`);
  }

  private container(id: string): Container | undefined {
    const name = decodeURIComponent(id);
    return this.containers.get(name) ?? this.byName(name);
  }

  /** What /healthz answers inside a container, or null when nothing is listening */
  private health(container: Container): string | null {
    if (!container.State.Running) return null;
    if (container.Image === OLD_IMAGE_ID || container.Image === CONNECTORS_OLD_IMAGE_ID)
      return JSON.stringify({ status: 'ok', version: '1.0.0' });
    // A new connector service answers at once: it has no migrations to run.
    if (container.Name.includes('connectors')) return JSON.stringify({ status: 'ok', version: '1.1.0' });
    if (this.options.neverHealthy) return null;
    if (Date.now() - (container.startedAt ?? 0) < (this.options.healthyAfterMs ?? 0)) return null;
    return JSON.stringify({ status: 'ok', version: '1.1.0' });
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://docker');
    const method = request.method ?? 'GET';
    const payload = method === 'POST' ? await body(request) : undefined;
    this.calls.push({
      method,
      path: url.pathname + url.search,
      ...(payload === undefined ? {} : { body: payload }),
    });
    const path = url.pathname;
    let match: RegExpExecArray | null;
    if (path === '/_ping') return response.end('OK');
    if (path === '/info') return json(response, 200, { Architecture: 'x86_64', OSType: 'linux' });
    if (path === '/containers/json') {
      const filters = JSON.parse(url.searchParams.get('filters') ?? '{}') as { label?: string[] };
      const list = [...this.containers.values()].filter((item) =>
        (filters.label ?? []).every((label) => {
          const [key, value] = label.split('=');
          return item.Config.Labels[key!] === value;
        }),
      );
      return json(
        response,
        200,
        list.map((item) => ({
          Id: item.Id,
          Names: [item.Name],
          Labels: item.Config.Labels,
          State: item.State.Status,
        })),
      );
    }
    if (path === '/images/create' && url.searchParams.get('fromImage') === CONNECTORS_REPOSITORY) {
      if (url.searchParams.get('tag') !== CONNECTORS_NEW_DIGEST)
        return json(response, 200, { error: 'not found' });
      this.images.set(`${CONNECTORS_REPOSITORY}@${CONNECTORS_NEW_DIGEST}`, {
        Id: digestOf('4'),
        RepoDigests: [`${CONNECTORS_REPOSITORY}@${CONNECTORS_NEW_DIGEST}`],
        Os: 'linux',
        Architecture: 'amd64',
        Config: {
          Env: ['PATH=/usr/bin', 'RIOSOMA_VERSION=1.1.0', 'NODE_ENV=production'],
          Cmd: ['dist/main.js'],
          User: 'nonroot',
          Labels: {},
        },
      });
      response.writeHead(200);
      return response.end('{"status":"Pulling"}\n{"status":"Digest: done"}\n');
    }
    if (path === '/images/create') {
      const tag = url.searchParams.get('tag');
      if (url.searchParams.get('fromImage') !== REPOSITORY || tag !== NEW_DIGEST)
        return json(response, 200, { error: 'not found' });
      this.images.set(`${REPOSITORY}@${NEW_DIGEST}`, {
        Id: NEW_IMAGE_ID,
        RepoDigests: [`${REPOSITORY}@${NEW_DIGEST}`],
        Os: 'linux',
        Architecture: 'amd64',
        Config: {
          Env: ['PATH=/usr/bin', 'RIOSOMA_VERSION=1.1.0', 'NODE_ENV=production'],
          Cmd: ['dist/main.js'],
          User: 'nonroot',
          Labels: {
            'org.opencontainers.image.title': 'riosoma',
            ...(this.options.connectorsRelease
              ? { 'io.riosoma.connectors.digest': CONNECTORS_NEW_DIGEST }
              : {}),
          },
        },
      });
      response.writeHead(200);
      return response.end('{"status":"Pulling"}\n{"status":"Digest: done"}\n');
    }
    if ((match = /^\/images\/(.+)\/json$/.exec(path))) {
      const image = this.images.get(decodeURIComponent(match[1]!));
      return image ? json(response, 200, image) : json(response, 404, { message: 'no such image' });
    }
    if (path === '/containers/create') {
      const name = url.searchParams.get('name')!;
      if (this.byName(name)) return json(response, 409, { message: 'name in use' });
      const spec = payload as Container['Config'] & {
        HostConfig: Record<string, unknown>;
        NetworkingConfig: unknown;
      };
      const id = `new${++this.count}`.padEnd(64, '0');
      const { HostConfig, NetworkingConfig: _networking, ...config } = spec;
      this.add({
        Id: id,
        Name: `/${name}`,
        Image: NEW_IMAGE_ID,
        Config: { ...config, Labels: config.Labels ?? {}, Env: config.Env ?? [] },
        HostConfig,
        NetworkSettings: { Networks: {} },
        State: { Status: 'created', Running: false },
      });
      return json(response, 201, { Id: id });
    }
    if (/^\/networks\/([^/]+)\/connect$/.test(path)) return json(response, 200);
    if ((match = /^\/containers\/([^/]+)\/(start|stop|rename|exec)$/.exec(path))) {
      const container = this.container(match[1]!);
      if (!container) return json(response, 404, { message: 'no such container' });
      if (match[2] === 'start') {
        // Docker's own check calls the new version unhealthy at once, which must not end the wait.
        container.State = {
          Status: 'running',
          Running: true,
          ...(container.Image === NEW_IMAGE_ID ? { Health: { Status: 'unhealthy' } } : {}),
        };
        container.startedAt = Date.now();
        return json(response, 204);
      }
      if (match[2] === 'stop') {
        container.State = { Status: 'exited', Running: false };
        return json(response, 204);
      }
      if (match[2] === 'rename') {
        const to = url.searchParams.get('name')!;
        // Docker refuses a name in use, including the container's own.
        if (this.byName(to) || this.options.refuseRename?.(to))
          return json(response, 409, { message: 'name refused' });
        container.Name = `/${to}`;
        return json(response, 204);
      }
      const cmd = (payload as { Cmd: string[] }).Cmd;
      if (!container.State.Running) return json(response, 409, { message: 'not running' });
      const id = `exec${++this.count}`;
      if (cmd[0] === '/nodejs/bin/node') {
        const answer = this.health(container);
        this.execs.set(id, { cmd, exitCode: answer ? 0 : 1, output: answer ?? '' });
      } else if (cmd.includes('once')) {
        this.execs.set(id, {
          cmd,
          exitCode: 0,
          output: 'riosoma-backup: wrote riosoma-20261001T000000Z.dump (12K)\n',
        });
      } else if (cmd.includes('restore')) {
        this.execs.set(id, {
          cmd,
          exitCode: 0,
          output: 'riosoma-backup: restored riosoma-20261001T000000Z.dump\n',
        });
      } else {
        const query = cmd.at(-1) ?? '';
        const held = [...this.runsInBackupDatabase].some((run) => query.includes(`'${run}'`));
        this.execs.set(id, { cmd, exitCode: 0, output: held ? '1\n' : '0\n' });
      }
      return json(response, 201, { Id: id });
    }
    if ((match = /^\/exec\/([^/]+)\/start$/.exec(path))) {
      const exec = this.execs.get(match[1]!)!;
      response.writeHead(200, { 'content-type': 'application/vnd.docker.multiplexed-stream' });
      return response.end(frame(exec.output));
    }
    if ((match = /^\/exec\/([^/]+)\/json$/.exec(path)))
      return json(response, 200, { ExitCode: this.execs.get(match[1]!)?.exitCode ?? 1 });
    if ((match = /^\/containers\/([^/]+)\/json$/.exec(path))) {
      const container = this.container(match[1]!);
      return container
        ? json(response, 200, container)
        : json(response, 404, { message: 'no such container' });
    }
    if (method === 'DELETE' && (match = /^\/containers\/([^/]+)$/.exec(path))) {
      this.containers.delete(this.container(match[1]!)?.Id ?? '');
      return json(response, 204);
    }
    return json(response, 404, { message: 'unknown' });
  }
}

interface Keys {
  id: string;
  privateKey: KeyObject;
  publicKey: string;
}

function keypair(id: string): Keys {
  const pair = generateKeyPairSync('ed25519');
  return { id, privateKey: pair.privateKey, publicKey: pair.publicKey.export({ format: 'jwk' }).x! };
}

function signedFeed(keys: Keys, releases: unknown[], issuedAt = new Date()): string {
  const payload = JSON.stringify({ schema: 1, issuedAt: issuedAt.toISOString(), releases });
  return JSON.stringify({
    keyId: keys.id,
    signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64'),
    payload,
  });
}

const release = (version: string, extra: Record<string, unknown> = {}) => ({
  version,
  date: '2026-09-28',
  notes: 'Faster grids.',
  security: false,
  minimumVersion: '0.9.0',
  images: { 'linux/amd64': NEW_DIGEST, 'linux/arm64': digestOf('c') },
  ...extra,
});
const RELEASE = release('1.1.0');

const signing = keypair('test-key');
const token = ['updater', 'token', 'x'.repeat(32)].join('-');

/** A sidecar on a stand-in engine, with its own Compose folder and state */
async function startSidecar(options: EngineOptions & { healthSeconds?: number } = {}) {
  const engine = new Engine(options);
  const dockerPort = await listen(engine.server);
  const folder = mkdtempSync(join(tmpdir(), 'rio-updater-'));
  writeFileSync(
    join(folder, 'keys.json'),
    JSON.stringify([{ id: signing.id, publicKey: signing.publicKey }]),
  );
  writeFileSync(
    join(folder, '.env'),
    `COMPOSE_PROFILES=postgres,backup,updater\nRIOSOMA_IMAGE=${REPOSITORY}:1.0.0\n`,
    { mode: 0o640 },
  );
  const child: ChildProcess = spawn(process.execPath, [SCRIPT], {
    env: {
      PATH: process.env.PATH,
      UPDATER_TOKEN: token,
      UPDATER_PORT: '0',
      UPDATER_LISTEN: '127.0.0.1',
      DOCKER_HOST: `tcp://127.0.0.1:${dockerPort}`,
      UPDATER_PROJECT: 'rio',
      UPDATER_SELF: SELF_ID,
      UPDATER_COMPOSE_DIR: folder,
      UPDATER_STATE_DIR: join(folder, 'state'),
      UPDATER_FEED_KEYS_FILE: join(folder, 'keys.json'),
      UPDATER_HEALTH_SECONDS: String(options.healthSeconds ?? 2),
      UPDATER_POLL_MS: '50',
      RIOSOMA_VERSION: '1.0.0',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let output = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      output += chunk;
      const line = /"msg":"updater listening","port":(\d+)/.exec(output);
      if (line) resolve(Number(line[1]));
    });
    child.once('exit', (code) => reject(new Error(`updater exited with ${code}: ${output}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  async function call(method: string, path: string, payload?: unknown, bearer = token) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  let runs = 0;
  /** Asks for an update as the server does, for a run the backup's database holds unless told not to */
  function update(version: string, feed: string, { recorded = true } = {}) {
    const runId = `job${String(++runs).padStart(14, '0')}`;
    if (recorded) engine.runsInBackupDatabase.add(runId);
    return call('POST', '/v1/updates', { version, feed, runId, schema: 'rio_app' });
  }
  async function finished(id: string): Promise<Record<string, unknown>> {
    for (let tries = 0; tries < 400; tries++) {
      const { body: answer } = await call('GET', `/v1/updates/${id}`);
      const job = answer.job as Record<string, unknown>;
      if (['succeeded', 'rolled_back', 'failed'].includes(job.state as string)) return job;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('the update never finished');
  }
  async function stop() {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => engine.server.close(() => resolve()));
    rmSync(folder, { recursive: true, force: true });
  }
  return { engine, folder, call, update, finished, stop };
}

type Sidecar = Awaited<ReturnType<typeof startSidecar>>;

describe('the updater sidecar', () => {
  let sidecar: Sidecar;
  beforeAll(async () => {
    sidecar = await startSidecar();
  });
  afterAll(() => sidecar.stop());

  it('answers only with the shared token, and says what it would update and its own version', async () => {
    expect((await sidecar.call('GET', '/v1/status', undefined, 'wrong'.repeat(8))).status).toBe(401);
    const status = await sidecar.call('GET', '/v1/status');
    expect(status.body).toMatchObject({
      ready: true,
      problem: null,
      version: '1.0.0',
      updater: '1.0.0',
      job: null,
    });
  });

  it('refuses a tampered, stale, or unsigned feed, and a release it can’t find', async () => {
    const feed = signedFeed(signing, [RELEASE]);
    const tampered = feed.replace('Faster grids.', 'Faster grids!');
    expect((await sidecar.update('1.1.0', tampered)).body).toEqual({ problem: 'signature' });
    const stranger = keypair('test-key');
    expect((await sidecar.update('1.1.0', signedFeed(stranger, [RELEASE]))).body).toEqual({
      problem: 'signature',
    });
    const old = signedFeed(signing, [RELEASE], new Date(Date.now() - 15 * DAY));
    expect((await sidecar.update('1.1.0', old)).body).toEqual({ problem: 'stale' });
    const unsigned = JSON.stringify({ payload: (JSON.parse(feed) as { payload: string }).payload });
    expect((await sidecar.update('1.1.0', unsigned)).body).toEqual({ problem: 'signature' });
    expect((await sidecar.update('1.2.0', signedFeed(signing, [RELEASE]))).body).toEqual({
      problem: 'release',
    });
  });

  it('updates only to the release the server would choose', async () => {
    // A prerelease isn't offered to a server on a full release.
    const candidate = signedFeed(signing, [release('1.1.0-rc.1')]);
    expect((await sidecar.update('1.1.0-rc.1', candidate)).body).toEqual({ problem: 'release' });
    // Only the newest release it can reach, not an older one in between.
    const two = signedFeed(signing, [RELEASE, release('1.2.0')]);
    expect((await sidecar.update('1.1.0', two)).body).toEqual({ problem: 'release' });
    // A release it can't reach directly.
    const far = signedFeed(signing, [release('1.1.0', { minimumVersion: '1.0.5' })]);
    expect((await sidecar.update('1.1.0', far)).body).toEqual({ problem: 'minimum' });
    expect(sidecar.engine.called('POST', '/images/create')).toEqual([]);
  });

  it('refuses a feed older than one it already trusted', async () => {
    // A newer feed it verifies is kept as the newest, even when the update is then refused.
    const newer = await sidecar.update('1.1.0', signedFeed(signing, [RELEASE]), { recorded: false });
    expect(newer.body).toEqual({ problem: 'backupDatabase' });
    const replayed = signedFeed(signing, [RELEASE], new Date(Date.now() - DAY));
    expect((await sidecar.update('1.1.0', replayed)).body).toEqual({ problem: 'older' });
    expect(JSON.parse(readFileSync(join(sidecar.folder, 'state', 'feed.json'), 'utf8'))).toEqual({
      issuedAt: expect.any(Number),
    });
  });

  it('refuses when the backup service’s database isn’t Riosoma’s', async () => {
    const answer = await sidecar.update('1.1.0', signedFeed(signing, [RELEASE]), { recorded: false });
    expect(answer).toEqual({ status: 409, body: { problem: 'backupDatabase' } });
    const check = sidecar.engine.execCommands('backup1').at(-1)!;
    expect(check.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(check.at(-1)).toMatch(/^SELECT count\(\*\) FROM "rio_app"\.update_runs WHERE id = 'job\d{14}'$/);
    expect(sidecar.engine.called('POST', `/containers/${OLD_ID}/stop`)).toEqual([]);
    // Names that could break out of the query are refused before any query runs.
    const execs = sidecar.engine.execCommands('backup1').length;
    const bad = await sidecar.call('POST', '/v1/updates', {
      version: '1.1.0',
      feed: signedFeed(signing, [RELEASE]),
      runId: 'job00000000000099',
      schema: 'rio_app".x; --',
    });
    expect(bad.body).toEqual({ problem: 'backupDatabase' });
    expect(sidecar.engine.execCommands('backup1')).toHaveLength(execs);
  });

  it('starts exactly one of many simultaneous updates, and runs it through to the end', async () => {
    const feed = signedFeed(signing, [RELEASE]);
    const answers = await Promise.all(Array.from({ length: 10 }, () => sidecar.update('1.1.0', feed)));
    const statuses = answers.map((answer) => answer.status).sort();
    expect(statuses).toEqual([202, ...Array.from({ length: 9 }, () => 409)]);
    for (const answer of answers.filter((item) => item.status === 409))
      expect(answer.body).toEqual({ problem: 'busy' });
    const started = answers.find((answer) => answer.status === 202)!;
    const id = (started.body.job as { id: string }).id;
    const job = await sidecar.finished(id);
    // The app update finishes before the sidecar starts its own replacement.
    await expect
      .poll(() => sidecar.engine.byName('rio-updater-1'))
      .toMatchObject({
        Image: NEW_IMAGE_ID,
        State: { Running: true },
      });
    expect(job).toMatchObject({
      id,
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      state: 'succeeded',
      backup: 'riosoma-20261001T000000Z.dump',
      problem: null,
    });
    const { engine } = sidecar;
    // Job success precedes the sidecar replacement, so its requests may still be in flight.
    await vi.waitFor(() => {
      expect(engine.containers.get(SELF_ID)!.Name).toBe('/rio-updater-1-replaced');
      expect(engine.byName('rio-updater-1')!.State.Running).toBe(true);
    });
    expect(engine.called('POST', '/images/create')).toHaveLength(1);
    expect(engine.called('POST', `/containers/${OLD_ID}/stop`)).toHaveLength(1);
    const steps = engine.calls
      .filter((item) => item.method !== 'GET' && !item.path.startsWith('/exec/'))
      .map((item) => `${item.method} ${item.path.split('?')[0]}`);
    // Riosoma stops before the backup starts, and the new container starts only after it.
    const backedUp = engine.calls.findIndex((item) =>
      (item.body as { Cmd?: string[] })?.Cmd?.includes('once'),
    );
    const stopped = engine.calls.findIndex((item) => item.path.startsWith(`/containers/${OLD_ID}/stop`));
    const created = engine.calls.findIndex((item) => item.path.startsWith('/containers/create'));
    expect(stopped).toBeLessThan(backedUp);
    expect(backedUp).toBeLessThan(created);
    expect(steps).not.toContain('POST /containers/backup1/restore');
    expect(engine.called('POST', '/images/create')[0]!.path).toContain(
      `tag=${encodeURIComponent(NEW_DIGEST)}`,
    );
    const [app, updater] = engine.called('POST', '/containers/create');
    expect(app!.path).toContain('name=rio-riosoma-1');
    const spec = app!.body as {
      Image: string;
      Env: string[];
      Hostname?: string;
      Cmd?: unknown;
      NetworkingConfig: unknown;
    };
    expect(spec.Image).toBe(`${REPOSITORY}:1.1.0@${NEW_DIGEST}`);
    // What the old image set stays behind, so the new image's own version and command apply.
    expect(spec.Env).toEqual(['RIOSOMA_BASE_URL=https://rio.example.test']);
    expect(spec.Hostname).toBeUndefined();
    expect(spec.Cmd).toBeUndefined();
    expect(spec.NetworkingConfig).toEqual({ EndpointsConfig: { rio_default: { Aliases: ['riosoma'] } } });
    expect(engine.called('POST', '/networks/rio_domains/connect')[0]!.body).toMatchObject({
      EndpointConfig: { IPAMConfig: { IPv4Address: '172.30.52.3' }, Aliases: ['riosoma'] },
    });
    // The old container goes once the new one answers /healthz, whatever Docker's own check said.
    expect(engine.called('DELETE', `/containers/${OLD_ID}`)).toHaveLength(1);
    const env = readFileSync(join(sidecar.folder, '.env'), 'utf8');
    expect(env).toBe(
      `COMPOSE_PROFILES=postgres,backup,updater\nRIOSOMA_IMAGE=${REPOSITORY}:1.1.0@${NEW_DIGEST}\n`,
    );
    expect(statSync(join(sidecar.folder, '.env')).mode & 0o777).toBe(0o640);

    // Then the updater replaces itself with the same image, keeping its own settings.
    expect(updater!.path).toContain('name=rio-updater-1');
    const own = updater!.body as {
      Image: string;
      Env: string[];
      Cmd: string[];
      User: string;
      NetworkingConfig: unknown;
    };
    expect(own.Image).toBe(`${REPOSITORY}:1.1.0@${NEW_DIGEST}`);
    expect(own.Env).toEqual(['UPDATER_TOKEN=from-compose']);
    expect(own.Cmd).toEqual(['/app/updater/updater.mjs']);
    expect(own.User).toBe('0:0');
    expect(own.NetworkingConfig).toEqual({ EndpointsConfig: { rio_updater: { Aliases: ['updater'] } } });
    // Until its replacement removes it, this sidecar turns every update away.
    expect((await sidecar.call('GET', '/v1/status')).body).toMatchObject({ ready: false, problem: 'busy' });
    expect((await sidecar.update('1.1.0', feed)).body).toEqual({ problem: 'busy' });
  });
});

describe('the updater sidecar when the new version never answers /healthz', () => {
  let sidecar: Sidecar;
  beforeAll(async () => {
    sidecar = await startSidecar({ neverHealthy: true, healthSeconds: 2, leftover: true });
  });
  afterAll(() => sidecar.stop());

  it('removes an updater it replaced earlier as it starts', async () => {
    for (let tries = 0; tries < 100 && sidecar.engine.containers.has(LEFTOVER_ID); tries++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sidecar.engine.containers.has(LEFTOVER_ID)).toBe(false);
    expect(sidecar.engine.containers.has(SELF_ID)).toBe(true);
    // With the anonymous volume Docker made for its image's /config, or each update leaves one.
    expect(sidecar.engine.called('DELETE', `/containers/${LEFTOVER_ID}`).map((call) => call.path)).toEqual([
      `/containers/${LEFTOVER_ID}?force=1&v=1`,
    ]);
  });

  it('waits the full time, then removes it, restores the backup, and starts the old container', async () => {
    const began = Date.now();
    const started = await sidecar.update('1.1.0', signedFeed(signing, [RELEASE]));
    expect(started.status).toBe(202);
    const job = await sidecar.finished((started.body.job as { id: string }).id);
    expect(job).toMatchObject({
      state: 'rolled_back',
      problem: 'health',
      backup: 'riosoma-20261001T000000Z.dump',
    });
    expect(Date.now() - began).toBeGreaterThanOrEqual(2_000);
    const { engine } = sidecar;
    const checks = engine.calls.filter(
      (call) =>
        (call.body as { Cmd?: string[] })?.Cmd?.[0] === '/nodejs/bin/node' && call.path.includes('/new'),
    );
    // Docker called it unhealthy at once, but the sidecar kept asking /healthz for the whole wait.
    expect(checks.length).toBeGreaterThan(10);
    const cmds = engine.execCommands('backup1').filter((cmd) => cmd[1] === '/usr/local/bin/riosoma-backup');
    expect(cmds).toEqual([
      ['/bin/sh', '/usr/local/bin/riosoma-backup', 'once'],
      ['/bin/sh', '/usr/local/bin/riosoma-backup', 'restore', 'riosoma-20261001T000000Z.dump'],
    ]);
    expect([...engine.containers.keys()].some((id) => id.startsWith('new'))).toBe(false);
    const removed = engine.called('DELETE', '/containers/new');
    expect(removed).not.toEqual([]);
    expect(removed.every((call) => call.path.endsWith('?force=1&v=1'))).toBe(true);
    const old = engine.containers.get(OLD_ID)!;
    expect(old.Name).toBe('/rio-riosoma-1');
    expect(old.State.Running).toBe(true);
    expect(readFileSync(join(sidecar.folder, '.env'), 'utf8')).toContain(
      `RIOSOMA_IMAGE=${REPOSITORY}:1.0.0\n`,
    );
    // Nothing replaced the updater, and the next update may start.
    expect(engine.containers.get(SELF_ID)!.Name).toBe('/rio-updater-1');
    expect((await sidecar.call('GET', '/v1/status')).body).toMatchObject({ ready: true });
  });
});

describe('the updater sidecar when migrations take longer than Docker’s own health check', () => {
  let sidecar: Sidecar;
  beforeAll(async () => {
    sidecar = await startSidecar({ healthyAfterMs: 1_000, healthSeconds: 4 });
  });
  afterAll(() => sidecar.stop());

  it('keeps waiting through Docker’s unhealthy status until /healthz answers', async () => {
    const started = await sidecar.update('1.1.0', signedFeed(signing, [RELEASE]));
    const job = await sidecar.finished((started.body.job as { id: string }).id);
    expect(job).toMatchObject({ state: 'succeeded', problem: null });
    const created = sidecar.engine.byName('rio-riosoma-1')!;
    expect(created.Image).toBe(NEW_IMAGE_ID);
    expect(created.State.Health).toEqual({ Status: 'unhealthy' });
  });
});

describe('the updater sidecar when the old container can’t give up its name', () => {
  let sidecar: Sidecar;
  beforeAll(async () => {
    sidecar = await startSidecar({ refuseRename: (to) => to.includes('-before-') });
  });
  afterAll(() => sidecar.stop());

  it('starts the old container again as it was, restores nothing, and says why', async () => {
    const started = await sidecar.update('1.1.0', signedFeed(signing, [RELEASE]));
    const job = await sidecar.finished((started.body.job as { id: string }).id);
    expect(job).toMatchObject({
      state: 'failed',
      problem: 'rename',
      backup: 'riosoma-20261001T000000Z.dump',
    });
    const { engine } = sidecar;
    expect(engine.execCommands('backup1').some((cmd) => cmd.includes('restore'))).toBe(false);
    expect(engine.called('POST', '/containers/create')).toEqual([]);
    const old = engine.containers.get(OLD_ID)!;
    expect(old.Name).toBe('/rio-riosoma-1');
    expect(old.State.Running).toBe(true);
    expect((await sidecar.call('GET', '/v1/status')).body).toMatchObject({ ready: true, version: '1.0.0' });
  });
});

describe('the updater sidecar with a connector service', () => {
  let sidecar: Sidecar;
  beforeAll(async () => {
    sidecar = await startSidecar({ connectors: true, connectorsRelease: true });
  });
  afterAll(() => sidecar.stop());

  it('updates the connector service just before Riosoma, and names both images in .env', async () => {
    const started = await sidecar.update('1.1.0', signedFeed(signing, [RELEASE]));
    expect(started.status).toBe(202);
    const job = await sidecar.finished((started.body.job as { id: string }).id);
    expect(job).toMatchObject({ state: 'succeeded', problem: null });
    const { engine } = sidecar;
    const pulls = engine.called('POST', '/images/create').map((call) => call.path);
    expect(pulls.some((path) => path.includes(encodeURIComponent(CONNECTORS_REPOSITORY)))).toBe(true);
    const created = engine.called('POST', '/containers/create').map((call) => call.path.split('name=')[1]);
    // The connector service changes over first, after the backup, and Riosoma after it.
    expect(created.slice(0, 2)).toEqual(['rio-connectors-1', 'rio-riosoma-1']);
    const service = engine.called('POST', '/containers/create')[0]!.body as {
      Image: string;
      Env: string[];
      NetworkingConfig: unknown;
    };
    expect(service.Image).toBe(`${CONNECTORS_REPOSITORY}:1.1.0@${CONNECTORS_NEW_DIGEST}`);
    expect(service.Env).toEqual(['RIOSOMA_LOG_LEVEL=info']);
    expect(engine.called('POST', '/networks/rio_connectors/connect')[0]!.body).toMatchObject({
      EndpointConfig: { Aliases: ['connectors', 'connector-service'] },
    });
    // The connector service answered as the new version before Riosoma was made.
    const asked = engine.calls.findIndex((call) =>
      ((call.body as { Cmd?: string[] })?.Cmd ?? []).some((part) => part.includes('8091')),
    );
    const madeApp = engine.calls.findIndex((call) =>
      call.path.startsWith('/containers/create?name=rio-riosoma-1'),
    );
    expect(asked).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(madeApp);
    expect(engine.containers.has(CONNECTORS_ID)).toBe(false);
    expect(engine.byName('rio-connectors-1')!.State.Running).toBe(true);
    expect(readFileSync(join(sidecar.folder, '.env'), 'utf8')).toBe(
      `COMPOSE_PROFILES=postgres,backup,updater\nRIOSOMA_IMAGE=${REPOSITORY}:1.1.0@${NEW_DIGEST}\n` +
        `RIOSOMA_CONNECTORS_IMAGE=${CONNECTORS_REPOSITORY}:1.1.0@${CONNECTORS_NEW_DIGEST}\n`,
    );
  });
});

describe('the updater sidecar without a connector service', () => {
  let sidecar: Sidecar;
  beforeAll(async () => {
    sidecar = await startSidecar({ connectorsRelease: true });
  });
  afterAll(() => sidecar.stop());

  it('won’t run a release that needs one, and changes nothing', async () => {
    const started = await sidecar.update('1.1.0', signedFeed(signing, [RELEASE]));
    expect(started.status).toBe(202);
    const job = await sidecar.finished((started.body.job as { id: string }).id);
    expect(job).toMatchObject({ state: 'failed', problem: 'connectors', backup: null });
    const { engine } = sidecar;
    expect(engine.called('POST', `/containers/${OLD_ID}/stop`)).toEqual([]);
    expect(engine.called('POST', '/containers/create')).toEqual([]);
    expect(engine.containers.get(OLD_ID)!.State.Running).toBe(true);
  });
});

describe('the updater sidecar with a connector service when the new Riosoma never answers', () => {
  let sidecar: Sidecar;
  beforeAll(async () => {
    sidecar = await startSidecar({
      connectors: true,
      connectorsRelease: true,
      neverHealthy: true,
      healthSeconds: 1,
    });
  });
  afterAll(() => sidecar.stop());

  it('puts the old connector service back beside the old Riosoma', async () => {
    const started = await sidecar.update('1.1.0', signedFeed(signing, [RELEASE]));
    const job = await sidecar.finished((started.body.job as { id: string }).id);
    expect(job).toMatchObject({ state: 'rolled_back', problem: 'health' });
    const { engine } = sidecar;
    const old = engine.containers.get(CONNECTORS_ID)!;
    expect(old.Name).toBe('/rio-connectors-1');
    expect(old.State.Running).toBe(true);
    expect([...engine.containers.keys()].some((id) => id.startsWith('new'))).toBe(false);
    expect(engine.containers.get(OLD_ID)!.State.Running).toBe(true);
    expect(readFileSync(join(sidecar.folder, '.env'), 'utf8')).not.toContain('RIOSOMA_CONNECTORS_IMAGE');
  });
});
