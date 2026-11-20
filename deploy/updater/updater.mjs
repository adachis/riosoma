// The updater sidecar for Docker Compose installs: one-click updates for Riosoma.
//
// It listens on a Compose network it shares with the Riosoma server alone.  The server names a
// version, its run, and its schema, and hands over the signed update feed.  The sidecar trusts
// nothing else it's told.  It checks the feed's Ed25519 signature with its own copy of the keys
// (feed-keys.json, beside this file), refuses a feed older than the newest it has seen, and works
// out for itself which release this install may update to, the way the server does.  The version
// asked for has to be that release.  It takes the image digest for this machine's platform from the
// release, and checks that the backup service's database is Riosoma's.  Then it pulls that digest
// from the registry the running container came from, checks the image is that version, stops
// Riosoma, backs up the database with the backup service, and starts the new image with the old
// container's settings.  A release that runs a connector service names that image's digest in a
// label of its own image, which the feed's digest vouches for, and the sidecar updates the
// connector service the same way, just before Riosoma.  When the new version
// answers /healthz, the old containers go, .env names the new images, and the sidecar replaces
// itself with the same image, so a new signing key reaches it.  When the new version doesn't answer
// in time, the sidecar removes it, restores the backup, and starts the old containers again.
//
// It talks to the Docker Engine API over its socket, and needs nothing but Node.  Settings:
//   UPDATER_TOKEN            the secret shared with Riosoma's RIOSOMA_UPDATER_TOKEN (required)
//   UPDATER_PORT             where it listens, 8090 by default
//   DOCKER_HOST              unix:///var/run/docker.sock by default, or tcp://host:port
//   UPDATER_PROJECT          the Compose project, found from this container's own labels when unset
//   UPDATER_SERVICE          Riosoma's service, riosoma by default
//   UPDATER_BACKUP_SERVICE   the backup service, backup by default
//   UPDATER_CONNECTORS_SERVICE  the connector service, connectors by default
//   UPDATER_COMPOSE_DIR      the Compose folder, mounted so .env can name the new image, /compose
//   UPDATER_STATE_DIR        where the current job and the newest feed's time are kept, /state
//   UPDATER_HEALTH_SECONDS   how long a new version has to answer /healthz, 600
//   UPDATER_FEED_KEYS_FILE   for testing only: a keys file used in place of feed-keys.json
import { demultiplex } from './stream.mjs';
import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  chownSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, request } from 'node:http';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION =
  /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
/** The server's run IDs, which the sidecar uses as its own job IDs */
const RUN_ID = /^[A-Za-z0-9_-]{1,100}$/;
/** A PostgreSQL schema name, as a Riosoma database profile allows one */
const SCHEMA = /^[a-z_][a-z0-9_]{1,62}$/;
const FEED_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
const FUTURE_SKEW_MS = 24 * 60 * 60_000;
const BODY_LIMIT = 3_000_000;
const FINISHED = new Set(['succeeded', 'rolled_back', 'failed']);
/** Asks the server inside a container for /healthz, the way the image's own health check does */
const HEALTH_COMMAND = [
  '/nodejs/bin/node',
  '-e',
  "fetch('http://127.0.0.1:8080/healthz',{signal:AbortSignal.timeout(5000)}).then((r)=>r.text()).then((t)=>process.stdout.write(t),()=>process.exit(1))",
];
/** The same question, put to the connector service inside its container */
const CONNECTORS_HEALTH_COMMAND = [
  '/nodejs/bin/node',
  '-e',
  "fetch('http://127.0.0.1:8091/healthz',{signal:AbortSignal.timeout(5000)}).then((r)=>r.text()).then((t)=>process.stdout.write(t),()=>process.exit(1))",
];
/** How long a new connector service has to answer, which needs no migrations */
const CONNECTORS_HEALTH_MS = 120_000;
/** The label on Riosoma's image that names its connector service's image, by digest */
const CONNECTORS_LABEL = 'io.riosoma.connectors.digest';

function log(level, msg, fields = {}) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields })}\n`);
}

function fail(message) {
  log('error', message);
  process.exit(1);
}

function dockerAddress(value) {
  if (value.startsWith('unix://')) return { socketPath: value.slice('unix://'.length) };
  const url = new URL(value.replace(/^tcp:/, 'http:'));
  return { host: url.hostname, port: Number(url.port || 2375) };
}

function readSettings(env) {
  const token = (env.UPDATER_TOKEN ?? '').trim();
  if (!/^[A-Za-z0-9_-]{32,512}$/.test(token))
    fail(
      'UPDATER_TOKEN must be 32 to 512 letters, digits, underscores, or hyphens, the same as RIOSOMA_UPDATER_TOKEN',
    );
  const number = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const port = env.UPDATER_PORT ? Number(env.UPDATER_PORT) : 8090;
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('UPDATER_PORT must be a port number');
  return {
    token,
    port,
    listen: env.UPDATER_LISTEN || '0.0.0.0',
    docker: dockerAddress(env.DOCKER_HOST || 'unix:///var/run/docker.sock'),
    project: env.UPDATER_PROJECT || null,
    service: env.UPDATER_SERVICE || 'riosoma',
    backupService: env.UPDATER_BACKUP_SERVICE || 'backup',
    connectorsService: env.UPDATER_CONNECTORS_SERVICE || 'connectors',
    composeDir: env.UPDATER_COMPOSE_DIR || '/compose',
    stateDir: env.UPDATER_STATE_DIR || '/state',
    keysFile: env.UPDATER_FEED_KEYS_FILE || fileURLToPath(new URL('./feed-keys.json', import.meta.url)),
    // This container, which Docker names by its hostname unless Compose was told otherwise
    self: env.UPDATER_SELF || hostname(),
    // The release this sidecar came from, which the image sets
    version: VERSION.test(env.RIOSOMA_VERSION ?? '') ? env.RIOSOMA_VERSION : null,
    healthMs: number(env.UPDATER_HEALTH_SECONDS, 600) * 1000,
    pollMs: number(env.UPDATER_POLL_MS, 2000),
    stopSeconds: number(env.UPDATER_STOP_SECONDS, 30),
  };
}

const settings = readSettings(process.env);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Orders versions as semantic versioning does, the same way the server does */
function compareVersions(left, right) {
  const a = VERSION.exec(left);
  const b = VERSION.exec(right);
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference) return Math.sign(difference);
  }
  const pa = a[4]?.split('.');
  const pb = b[4]?.split('.');
  if (!pa || !pb) return pa ? -1 : pb ? 1 : 0;
  for (let index = 0; index < Math.max(pa.length, pb.length); index++) {
    const x = pa[index];
    const y = pb[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny && Number(x) !== Number(y)) return Math.sign(Number(x) - Number(y));
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// State kept across restarts, in the state volume

function readState(name) {
  try {
    return JSON.parse(readFileSync(join(settings.stateDir, name), 'utf8'));
  } catch {
    return null;
  }
}

function writeState(name, value) {
  try {
    mkdirSync(settings.stateDir, { recursive: true, mode: 0o700 });
    const file = join(settings.stateDir, name);
    writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch (error) {
    log('warn', 'could not save the updater’s state', { file: name, error: String(error?.message ?? error) });
  }
}

// The feed

function feedKeys() {
  try {
    const keys = JSON.parse(readFileSync(settings.keysFile, 'utf8'));
    return Array.isArray(keys)
      ? keys.filter((key) => typeof key?.id === 'string' && typeof key?.publicKey === 'string')
      : [];
  } catch {
    return [];
  }
}

/** When the newest feed this sidecar has trusted was signed, in milliseconds */
function newestFeed() {
  const kept = readState('feed.json');
  return Number.isFinite(kept?.issuedAt) ? kept.issuedAt : 0;
}

/**
 * The feed, when one of the keys signed it, it's fresh, and it's no older than the newest feed
 * this sidecar has trusted, or why not.  An old feed replayed can't bring back a release a later
 * feed withdrew.
 */
function verifyFeed(text, now = new Date()) {
  const keys = feedKeys();
  if (!keys.length) return { problem: 'signature' };
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { problem: 'signature' };
  }
  const { keyId, signature, payload } = envelope ?? {};
  if (typeof keyId !== 'string' || typeof signature !== 'string' || typeof payload !== 'string')
    return { problem: 'signature' };
  const key = keys.find((candidate) => candidate.id === keyId);
  if (!key) return { problem: 'signature' };
  let valid;
  try {
    const material = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: key.publicKey },
      format: 'jwk',
    });
    const bytes = Buffer.from(signature, 'base64');
    valid = bytes.length === 64 && verify(null, Buffer.from(payload, 'utf8'), material, bytes);
  } catch {
    valid = false;
  }
  if (!valid) return { problem: 'signature' };
  let feed;
  try {
    feed = JSON.parse(payload);
  } catch {
    return { problem: 'signature' };
  }
  const issued = Date.parse(feed?.issuedAt);
  if (feed?.schema !== 1 || !Number.isFinite(issued) || !Array.isArray(feed.releases))
    return { problem: 'signature' };
  if (issued - now.getTime() > FUTURE_SKEW_MS) return { problem: 'signature' };
  if (now.getTime() - issued > FEED_MAX_AGE_MS) return { problem: 'stale' };
  if (issued < newestFeed()) return { problem: 'older' };
  writeState('feed.json', { issuedAt: issued });
  return { feed };
}

const prerelease = (version) => version.includes('-');

/**
 * The release a server at `current` updates to, exactly as the server's own `offer()` picks it:
 * the newest newer release it can reach directly, and a prerelease only for a server on one.
 */
function targetRelease(feed, current) {
  const available = feed.releases
    .filter((release) => typeof release?.version === 'string' && VERSION.test(release.version))
    .filter((release) => compareVersions(release.version, current) > 0)
    .filter((release) => !prerelease(release.version) || prerelease(current))
    .sort((a, b) => compareVersions(b.version, a.version));
  return (
    available.find(
      (release) =>
        typeof release.minimumVersion === 'string' && compareVersions(current, release.minimumVersion) >= 0,
    ) ?? null
  );
}

// The Docker Engine API

function docker(method, path, body, { raw = false, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const call = request(
      {
        ...settings.docker,
        method,
        path,
        headers: {
          host: 'docker',
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const buffer = Buffer.concat(chunks);
          if (raw) return resolve({ status: response.statusCode, buffer });
          const text = buffer.toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: response.statusCode, json, text });
        });
      },
    );
    call.setTimeout(timeoutMs, () => call.destroy(new Error('the Docker Engine API took too long')));
    call.on('error', reject);
    call.end(payload);
  });
}

async function exec(containerId, command, timeoutMs = 4 * 60 * 60_000) {
  const created = await docker('POST', `/containers/${containerId}/exec`, {
    AttachStdout: true,
    AttachStderr: true,
    Cmd: command,
  });
  if (created.status !== 201 || !created.json?.Id) throw new Error(`exec: ${created.status}`);
  const started = await docker(
    'POST',
    `/exec/${created.json.Id}/start`,
    { Detach: false, Tty: false },
    { raw: true, timeoutMs },
  );
  if (started.status !== 200) throw new Error(`exec start: ${started.status}`);
  const inspected = await docker('GET', `/exec/${created.json.Id}/json`);
  return { exitCode: inspected.json?.ExitCode ?? -1, output: demultiplex(started.buffer) };
}

async function containersOf(project, service) {
  const labels = [`com.docker.compose.service=${service}`];
  if (project) labels.push(`com.docker.compose.project=${project}`);
  const filters = encodeURIComponent(JSON.stringify({ label: labels }));
  const listed = await docker('GET', `/containers/json?all=1&filters=${filters}`);
  if (listed.status !== 200 || !Array.isArray(listed.json)) throw new Error('docker');
  return listed.json;
}

async function inspectContainer(id) {
  const inspected = await docker('GET', `/containers/${encodeURIComponent(id)}/json`);
  return inspected.status === 200 ? inspected.json : null;
}

async function inspectImage(reference) {
  const inspected = await docker('GET', `/images/${encodeURIComponent(reference)}/json`);
  return inspected.status === 200 ? inspected.json : null;
}

/** The Compose project: the setting, or this container's own */
async function composeProject() {
  if (settings.project) return settings.project;
  const self = await inspectContainer(settings.self);
  return self?.Config?.Labels?.['com.docker.compose.project'] ?? null;
}

function platformOf(architecture) {
  if (architecture === 'x86_64' || architecture === 'amd64') return 'linux/amd64';
  if (architecture === 'aarch64' || architecture === 'arm64') return 'linux/arm64';
  return null;
}

/** The repository an image reference names, without its tag or digest */
function repositoryOf(reference) {
  const name = reference.split('@')[0];
  const slash = name.lastIndexOf('/');
  const colon = name.lastIndexOf(':');
  return colon > slash ? name.slice(0, colon) : name;
}

function envValue(list, name) {
  const entry = (list ?? []).find((item) => item.startsWith(`${name}=`));
  return entry === undefined ? null : entry.slice(name.length + 1);
}

/**
 * Everything an update needs, or the first thing missing: Docker, one running Riosoma container,
 * a running backup service, and a Compose folder whose .env can be written.
 */
async function preflight() {
  try {
    const ping = await docker('GET', '/_ping', undefined, { timeoutMs: 5_000 });
    if (ping.status !== 200) return { problem: 'docker' };
  } catch {
    return { problem: 'docker' };
  }
  const project = await composeProject();
  const apps = (await containersOf(project, settings.service)).filter((item) => item.State === 'running');
  const projects = new Set(apps.map((item) => item.Labels?.['com.docker.compose.project']));
  if (projects.size > 1 || apps.length > 1) return { problem: 'ambiguous' };
  if (!apps.length) return { problem: 'container' };
  const app = await inspectContainer(apps[0].Id);
  if (!app) return { problem: 'container' };
  const backups = (await containersOf([...projects][0], settings.backupService)).filter(
    (item) => item.State === 'running',
  );
  if (backups.length !== 1) return { problem: 'backup' };
  try {
    accessSync(settings.composeDir, constants.W_OK);
  } catch {
    return { problem: 'compose' };
  }
  const info = await docker('GET', '/info');
  const platform = platformOf(info.json?.Architecture);
  if (!platform) return { problem: 'platform' };
  // The connector service, which a Compose file from before it existed doesn't have.
  const services = (await containersOf([...projects][0], settings.connectorsService)).filter(
    (item) => item.State === 'running',
  );
  if (services.length > 1) return { problem: 'ambiguous' };
  const connectors = services.length ? await inspectContainer(services[0].Id) : null;
  return {
    problem: null,
    app,
    backupId: backups[0].Id,
    platform,
    version: envValue(app.Config?.Env, 'RIOSOMA_VERSION'),
    repository: repositoryOf(app.Config?.Image ?? ''),
    connectors,
    connectorsRepository: connectors ? repositoryOf(connectors.Config?.Image ?? '') : null,
  };
}

/**
 * Whether the backup service's database is Riosoma's: it holds the run the server recorded before
 * asking for this update.  The backups dump BACKUP_DATABASE_URL, which can name another database,
 * and a rollback restores into it, so an update never starts until this holds.  The names are
 * checked against strict patterns before they go into the query.
 */
async function backupHoldsRun(backupId, schema, runId) {
  if (!SCHEMA.test(schema) || !RUN_ID.test(runId)) return false;
  const query = `SELECT count(*) FROM "${schema}".update_runs WHERE id = '${runId}'`;
  const answer = await exec(
    backupId,
    [
      '/bin/sh',
      '-c',
      'psql --dbname="$BACKUP_DATABASE_URL" --no-psqlrc --quiet --tuples-only --no-align --command "$1"',
      'riosoma-updater',
      query,
    ],
    60_000,
  ).catch(() => null);
  return answer?.exitCode === 0 && answer.output.trim() === '1';
}

// Jobs.  The job in flight, or the last one, is `current`.  Each run works on its own job object,
// and a new one takes `current` before anything waits, so only one can ever start.

let current = null;
/** Set once this sidecar has started its replacement, which takes over from here */
let replaced = false;
const busy = () => replaced || (current !== null && !FINISHED.has(current.state));

function publicJob(value) {
  if (!value) return null;
  const { id, fromVersion, toVersion, state, backup, problem, startedAt, finishedAt } = value;
  return { id, fromVersion, toVersion, state, backup, problem, startedAt, finishedAt };
}

function step(job, state) {
  job.state = state;
  writeState('job.json', job);
  log('info', 'update step', { job: job.id, state });
}

function finish(job, state, problem = null) {
  job.state = state;
  job.problem = problem;
  job.finishedAt = new Date().toISOString();
  writeState('job.json', job);
  log(state === 'succeeded' ? 'info' : 'warn', 'update finished', { job: job.id, state, problem });
}

async function pull(repository, digest) {
  const query = `fromImage=${encodeURIComponent(repository)}&tag=${encodeURIComponent(digest)}`;
  const pulled = await docker('POST', `/images/create?${query}`, undefined, { timeoutMs: 60 * 60_000 });
  if (pulled.status !== 200) return false;
  // The pull answers with a line of JSON per step, and a failure is one of them.
  for (const line of pulled.text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.error || entry.errorDetail) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** The pulled image is the one the feed named: that digest, this platform, and that version */
async function verifyImage(repository, digest, platform, version) {
  const image = await inspectImage(`${repository}@${digest}`);
  if (!image) return null;
  const digests = image.RepoDigests ?? [];
  if (!digests.includes(`${repository}@${digest}`)) return null;
  if (`${image.Os}/${image.Architecture}` !== platform) return null;
  if (envValue(image.Config?.Env, 'RIOSOMA_VERSION') !== version) return null;
  return image;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * A new container's settings: the old container's, less everything it only had because its image
 * did, so the new image's own environment, command, health check, and labels take their place.
 */
function containerSpec(old, oldImage, newImage, reference) {
  const config = { ...old.Config };
  const imageConfig = oldImage?.Config ?? {};
  config.Image = reference;
  config.Env = (old.Config.Env ?? []).filter((entry) => !(imageConfig.Env ?? []).includes(entry));
  for (const key of [
    'Cmd',
    'Entrypoint',
    'WorkingDir',
    'User',
    'Healthcheck',
    'StopSignal',
    'ExposedPorts',
    'Volumes',
    'Shell',
    'OnBuild',
  ])
    if (same(config[key], imageConfig[key])) delete config[key];
  const labels = {};
  for (const [name, value] of Object.entries(old.Config.Labels ?? {}))
    if (imageConfig.Labels?.[name] !== value) labels[name] = value;
  if (labels['com.docker.compose.image']) labels['com.docker.compose.image'] = newImage.Id;
  config.Labels = labels;
  if (old.Id.startsWith(config.Hostname ?? '-')) delete config.Hostname;
  delete config.Domainname;
  const networks = Object.entries(old.NetworkSettings?.Networks ?? {});
  const endpoint = ([, settingsOf]) => ({
    ...(settingsOf.IPAMConfig ? { IPAMConfig: settingsOf.IPAMConfig } : {}),
    Aliases: (settingsOf.Aliases ?? []).filter((alias) => !old.Id.startsWith(alias)),
    ...(settingsOf.Links ? { Links: settingsOf.Links } : {}),
    ...(settingsOf.DriverOpts ? { DriverOpts: settingsOf.DriverOpts } : {}),
  });
  const first = networks[0];
  return {
    body: {
      ...config,
      HostConfig: old.HostConfig,
      NetworkingConfig: { EndpointsConfig: first ? { [first[0]]: endpoint(first) } : {} },
    },
    // Older Engine APIs create a container on one network, so it joins the rest before it starts.
    others: networks.slice(1).map((entry) => ({ name: entry[0], endpoint: endpoint(entry) })),
  };
}

/** Creates a container from a spec under a name and joins it to its other networks */
async function createContainer(name, spec) {
  const created = await docker('POST', `/containers/create?name=${encodeURIComponent(name)}`, spec.body);
  if (created.status !== 201 || !created.json?.Id) throw new Error(`create: ${created.status}`);
  const id = created.json.Id;
  for (const network of spec.others) {
    const connected = await docker('POST', `/networks/${encodeURIComponent(network.name)}/connect`, {
      Container: id,
      EndpointConfig: network.endpoint,
    });
    if (connected.status !== 200) throw Object.assign(new Error(`connect: ${connected.status}`), { id });
  }
  return id;
}

/**
 * Whether the server in a container answers /healthz as `version` before the wait is over.  Only
 * Riosoma's own answer counts.  Docker's health status is left out, since the image's check calls
 * a container unhealthy long before a large database's migrations can finish, and nothing but
 * the full wait ends it early.
 */
async function healthy(containerId, version, command = HEALTH_COMMAND, waitMs = settings.healthMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      const answer = await exec(containerId, command, 30_000);
      const body = answer.exitCode === 0 ? JSON.parse(answer.output) : null;
      if (body?.status === 'ok' && body.version === version) return true;
    } catch {
      // Not answering yet: the container may be starting, restarting, or running migrations.
    }
    await sleep(Math.min(settings.pollMs, Math.max(0, deadline - Date.now())));
  }
  return false;
}

/** Names the new image in .env, keeping the file's owner and permissions */
function recordImage(reference, name = 'RIOSOMA_IMAGE') {
  const file = join(settings.composeDir, '.env');
  const line = `${name}=${reference}`;
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const pattern = new RegExp(`^(?:export\\s+)?${name}=.*$`, 'm');
  const next = pattern.test(text)
    ? text.replace(pattern, line)
    : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
  const temporary = join(settings.composeDir, `.env.updater-${process.pid}.tmp`);
  writeFileSync(temporary, next, { mode: 0o600 });
  if (existsSync(file)) {
    const stat = statSync(file);
    try {
      chownSync(temporary, stat.uid, stat.gid);
    } catch {
      // Not running as root: the file stays this process's, as it was.
    }
    chmodSync(temporary, stat.mode & 0o777);
  }
  renameSync(temporary, file);
}

async function startContainer(id) {
  const started = await docker('POST', `/containers/${id}/start`);
  return started.status === 204 || started.status === 304;
}

async function stopContainer(id, seconds) {
  const stopped = await docker('POST', `/containers/${id}/stop?t=${seconds}`, undefined, {
    timeoutMs: (seconds + 30) * 1000,
  });
  return stopped.status === 204 || stopped.status === 304;
}

async function renameContainer(id, name) {
  const renamed = await docker('POST', `/containers/${id}/rename?name=${encodeURIComponent(name)}`);
  return renamed.status === 204;
}

/**
 * Removes a container the updater made, or replaced, with the anonymous volumes Docker made for it
 * alone, such as the one for the image's /config when nothing is mounted there.  Named volumes stay.
 */
async function discardContainer(id) {
  await docker('DELETE', `/containers/${id}?force=1&v=1`).catch(() => undefined);
}

async function removeContainer(id) {
  await stopContainer(id, 10).catch(() => false);
  await discardContainer(id);
}

/**
 * Brings the old version back after the new one failed.  Each part runs only when the step it
 * undoes happened: the new container goes if it was made, the backup is restored only if the new
 * version was started, since only then could its migrations have run, and the old container gets
 * its name back if it gave it up.  A new version that never started ends the run `failed`, with the
 * database untouched, and one that started and failed ends it `rolled_back`.
 */
async function bringBack(job, plan, done, problem) {
  step(job, 'rolling_back');
  try {
    if (done.newId) await removeContainer(done.newId);
    // The connector service goes back first, so the old Riosoma starts beside the one it knew.
    const service = done.connectors;
    if (service?.newId) await removeContainer(service.newId);
    if (service?.renamed && !(await renameContainer(plan.connectors.app.Id, plan.connectors.name)))
      return finish(job, 'failed', 'rollback');
    if (service?.stopped && !(await startContainer(plan.connectors.app.Id)))
      return finish(job, 'failed', 'rollback');
    if (done.started) {
      const restored = await exec(plan.backupId, [
        '/bin/sh',
        '/usr/local/bin/riosoma-backup',
        'restore',
        job.backup,
      ]);
      if (restored.exitCode !== 0) return finish(job, 'failed', 'rollback');
    }
    if (done.renamed && !(await renameContainer(plan.app.Id, plan.name)))
      return finish(job, 'failed', 'rollback');
    if (!(await startContainer(plan.app.Id))) return finish(job, 'failed', 'rollback');
    if (!done.started) return finish(job, 'failed', problem);
    if (!(await healthy(plan.app.Id, job.fromVersion))) return finish(job, 'failed', 'rollback');
    finish(job, 'rolled_back', problem);
  } catch (error) {
    log('error', 'rollback failed', { job: job.id, error: String(error?.message ?? error) });
    finish(job, 'failed', 'rollback');
  }
}

/**
 * Replaces this sidecar with one from the new image, so a key the new release carries reaches it.
 * This container steps aside under another name and turns every update away, and the new one
 * removes it as it starts.  If anything goes wrong this one takes its name back and keeps going,
 * and the server, seeing an updater older than itself, shows the steps to update it by hand.
 */
async function replaceSelf(reference, image) {
  const self = await inspectContainer(settings.self).catch(() => null);
  if (!self) return log('warn', 'could not find this container to update it', { container: settings.self });
  // Without its own image, it can't tell which settings came from it, such as the old version.
  const selfImage = await inspectImage(self.Image).catch(() => null);
  if (!selfImage)
    return log('warn', 'could not read this container’s image to update it', { image: self.Image });
  const name = self.Name.replace(/^\//, '');
  const spec = containerSpec(self, selfImage, image, reference);
  let newId = null;
  try {
    if (!(await renameContainer(self.Id, `${name}-replaced`))) throw new Error('rename');
    replaced = true;
    newId = await createContainer(name, spec);
    if (!(await startContainer(newId))) throw new Error('start');
    log('info', 'the updater started its replacement', { image: reference });
  } catch (error) {
    log('warn', 'the updater could not replace itself, so run docker compose up -d to update it', {
      error: String(error?.message ?? error),
    });
    newId ??= error?.id ?? null;
    if (newId) await discardContainer(newId);
    if (replaced) await renameContainer(self.Id, name).catch(() => false);
    replaced = false;
  }
}

/** Removes the sidecar this one replaced, which stepped aside when it started this one */
async function removeReplaced() {
  const self = await inspectContainer(settings.self).catch(() => null);
  const labels = self?.Config?.Labels ?? {};
  const service = labels['com.docker.compose.service'];
  if (!self || !service) return;
  for (const item of await containersOf(labels['com.docker.compose.project'] ?? null, service)) {
    if (item.Id === self.Id || !(item.Names ?? []).some((name) => name.endsWith('-replaced'))) continue;
    await discardContainer(item.Id);
    log('info', 'removed the updater this one replaced', { container: item.Id });
  }
}

async function runUpdate(job, plan) {
  const { repository, digest, platform } = plan;
  const reference = `${repository}:${job.toVersion}@${digest}`;
  step(job, 'pulling');
  if (!(await pull(repository, digest).catch(() => false))) return finish(job, 'failed', 'pull');
  step(job, 'verifying');
  const image = await verifyImage(repository, digest, platform, job.toVersion).catch(() => null);
  if (!image) return finish(job, 'failed', 'verify');
  // The old image says which of the container's settings came from it rather than from Compose.
  const oldImage = await inspectImage(plan.app.Image).catch(() => null);
  if (!oldImage) return finish(job, 'failed', 'verify');
  // A release with a connector service names its image, and it comes down and checks out before
  // anything stops.  A Compose file from before the connector service can't run that release.
  const serviceDigest = image.Config?.Labels?.[CONNECTORS_LABEL] ?? '';
  let service = null;
  let serviceImages = null;
  if (DIGEST.test(serviceDigest)) {
    if (!plan.connectors) return finish(job, 'failed', 'connectors');
    service = { ...plan.connectors, digest: serviceDigest };
    if (!(await pull(service.repository, service.digest).catch(() => false)))
      return finish(job, 'failed', 'pull');
    const image = await verifyImage(service.repository, service.digest, platform, job.toVersion).catch(
      () => null,
    );
    const old = await inspectImage(service.app.Image).catch(() => null);
    if (!image || !old) return finish(job, 'failed', 'verify');
    serviceImages = { image, old, reference: `${service.repository}:${job.toVersion}@${service.digest}` };
  }
  step(job, 'stopping');
  if (!(await stopContainer(plan.app.Id, settings.stopSeconds).catch(() => false)))
    return finish(job, 'failed', 'stop');
  // The backup starts once Riosoma has stopped, so it holds every change made before the update.
  step(job, 'backing_up');
  const backup = await exec(plan.backupId, ['/bin/sh', '/usr/local/bin/riosoma-backup', 'once']).catch(
    () => null,
  );
  const written = backup?.exitCode === 0 ? /wrote (riosoma-[0-9TZ]+\.dump)/.exec(backup.output)?.[1] : null;
  if (!written) {
    await startContainer(plan.app.Id).catch(() => false);
    return finish(job, 'failed', 'backupFailed');
  }
  job.backup = written;
  step(job, 'starting');
  // Nothing has changed yet, so if the old container can't give up its name, it just starts again.
  if (
    !(await renameContainer(plan.app.Id, `${plan.name}-before-${job.id.slice(0, 12)}`).catch(() => false))
  ) {
    await startContainer(plan.app.Id).catch(() => false);
    return finish(job, 'failed', 'rename');
  }
  const done = { renamed: true, newId: null, started: false, connectors: null };
  if (service) {
    // The connector service keeps no data, so it changes over without a backup of its own.
    done.connectors = { stopped: false, renamed: false, newId: null };
    try {
      if (!(await stopContainer(service.app.Id, 10))) throw new Error('stop');
      done.connectors.stopped = true;
      if (!(await renameContainer(service.app.Id, `${service.name}-before-${job.id.slice(0, 12)}`)))
        throw new Error('rename');
      done.connectors.renamed = true;
      done.connectors.newId = await createContainer(
        service.name,
        containerSpec(service.app, serviceImages.old, serviceImages.image, serviceImages.reference),
      );
      if (!(await startContainer(done.connectors.newId))) throw new Error('start');
    } catch (error) {
      done.connectors.newId ??= error?.id ?? null;
      log('warn', 'the new connector service could not start', {
        job: job.id,
        error: String(error?.message ?? error),
      });
      return bringBack(job, plan, done, 'start');
    }
    if (
      !(await healthy(done.connectors.newId, job.toVersion, CONNECTORS_HEALTH_COMMAND, CONNECTORS_HEALTH_MS))
    )
      return bringBack(job, plan, done, 'health');
  }
  try {
    done.newId = await createContainer(plan.name, containerSpec(plan.app, oldImage, image, reference));
  } catch (error) {
    done.newId = error?.id ?? null;
    log('warn', 'the new version could not be created', {
      job: job.id,
      error: String(error?.message ?? error),
    });
    return bringBack(job, plan, done, 'start');
  }
  // From here the new version may have run its migrations, so going back restores the backup.
  done.started = true;
  if (!(await startContainer(done.newId).catch(() => false))) return bringBack(job, plan, done, 'start');
  step(job, 'checking');
  if (!(await healthy(done.newId, job.toVersion))) return bringBack(job, plan, done, 'health');
  await docker('DELETE', `/containers/${plan.app.Id}`).catch(() => undefined);
  if (service) await docker('DELETE', `/containers/${service.app.Id}`).catch(() => undefined);
  try {
    recordImage(reference);
  } catch (error) {
    log('warn', 'could not name the new image in .env, so set RIOSOMA_IMAGE yourself', {
      image: reference,
      error: String(error?.message ?? error),
    });
  }
  if (service)
    try {
      recordImage(serviceImages.reference, 'RIOSOMA_CONNECTORS_IMAGE');
    } catch (error) {
      log('warn', 'could not name the new image in .env, so set RIOSOMA_CONNECTORS_IMAGE yourself', {
        image: serviceImages.reference,
        error: String(error?.message ?? error),
      });
    }
  finish(job, 'succeeded');
  await replaceSelf(reference, image);
}

/**
 * Starts an update to `version` for the server's run `runId`, or says why it can't.  The lock is
 * taken before anything waits: a request that finds a job in flight is turned away at once, and
 * this one's job holds `current` from its first line, through every check, until it's refused or
 * it ends.
 */
async function startUpdate(body) {
  if (busy()) return { status: 409, body: { problem: 'busy' } };
  const { version, feed: feedText, runId, schema } = body ?? {};
  if (
    typeof version !== 'string' ||
    !VERSION.test(version) ||
    typeof feedText !== 'string' ||
    typeof runId !== 'string' ||
    !RUN_ID.test(runId) ||
    typeof schema !== 'string'
  )
    return { status: 400, body: { problem: 'release' } };
  const previous = current;
  const job = {
    id: runId,
    fromVersion: null,
    toVersion: version,
    state: 'requested',
    backup: null,
    problem: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  current = job;
  const refuse = (status, problem) => {
    current = previous;
    return { status, body: { problem } };
  };
  try {
    const checked = verifyFeed(feedText);
    if (checked.problem) return refuse(422, checked.problem);
    const release = checked.feed.releases.find((item) => item?.version === version);
    if (!release) return refuse(422, 'release');
    const ready = await preflight().catch(() => ({ problem: 'docker' }));
    if (ready.problem) return refuse(409, ready.problem);
    const running = ready.version;
    if (!running || !VERSION.test(running)) return refuse(409, 'container');
    const target = targetRelease(checked.feed, running);
    if (target?.version !== version) {
      const tooOld =
        typeof release.minimumVersion === 'string' && compareVersions(running, release.minimumVersion) < 0;
      return refuse(422, tooOld && compareVersions(version, running) > 0 ? 'minimum' : 'release');
    }
    const digest = release.images?.[ready.platform];
    if (typeof digest !== 'string' || !DIGEST.test(digest)) return refuse(422, 'platform');
    if (!(await backupHoldsRun(ready.backupId, schema, runId))) return refuse(409, 'backupDatabase');
    job.fromVersion = running;
    writeState('job.json', job);
    log('info', 'update requested', { job: job.id, from: running, to: version });
    const plan = {
      app: ready.app,
      name: ready.app.Name.replace(/^\//, ''),
      backupId: ready.backupId,
      platform: ready.platform,
      repository: ready.repository,
      digest,
      connectors: ready.connectors
        ? {
            app: ready.connectors,
            name: ready.connectors.Name.replace(/^\//, ''),
            repository: ready.connectorsRepository,
          }
        : null,
    };
    void runUpdate(job, plan).catch((error) => {
      log('error', 'update failed', { job: job.id, error: String(error?.message ?? error) });
      if (!FINISHED.has(job.state)) finish(job, 'failed', 'start');
    });
    return { status: 202, body: { job: publicJob(job) } };
  } catch (error) {
    log('error', 'update refused', { error: String(error?.message ?? error) });
    return refuse(500, 'docker');
  }
}

// The API

const tokenHash = createHash('sha256').update(settings.token).digest();

function authorized(header) {
  const match = /^Bearer (.+)$/.exec(header ?? '');
  if (!match) return false;
  return timingSafeEqual(createHash('sha256').update(match[1]).digest(), tokenHash);
}

function send(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  response.end(text);
}

async function readBody(incoming) {
  const chunks = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += chunk.length;
    if (size > BODY_LIMIT) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

async function handle(incoming, response) {
  if (!authorized(incoming.headers.authorization)) return send(response, 401, { problem: 'token' });
  const path = new URL(incoming.url ?? '/', 'http://updater').pathname;
  if (incoming.method === 'GET' && path === '/v1/status') {
    const ready = busy() ? { problem: 'busy' } : await preflight().catch(() => ({ problem: 'docker' }));
    return send(response, 200, {
      ready: !ready.problem,
      problem: ready.problem ?? null,
      version: ready.version ?? null,
      updater: settings.version,
      job: publicJob(current),
    });
  }
  if (incoming.method === 'POST' && path === '/v1/updates') {
    const body = await readBody(incoming);
    if (!body) return send(response, 400, { problem: 'release' });
    const answer = await startUpdate(body);
    return send(response, answer.status, answer.body);
  }
  const match = /^\/v1\/updates\/([A-Za-z0-9_-]{1,100})$/.exec(path);
  if (incoming.method === 'GET' && match) {
    if (!current || current.id !== match[1]) return send(response, 404, { problem: 'unknown' });
    return send(response, 200, { job: publicJob(current) });
  }
  return send(response, 404, { problem: 'unknown' });
}

current = readState('job.json');
if (current && !current.id) current = null;
// A job the sidecar was in the middle of when it stopped can't be picked up again.
if (current && !FINISHED.has(current.state)) {
  Object.assign(current, { state: 'failed', problem: 'interrupted', finishedAt: new Date().toISOString() });
  writeState('job.json', current);
}
const server = createServer((incoming, response) => {
  handle(incoming, response).catch((error) => {
    log('error', 'request failed', { error: String(error?.message ?? error) });
    if (!response.headersSent) send(response, 500, { problem: 'docker' });
    else response.destroy();
  });
});
server.listen(settings.port, settings.listen, () => {
  const address = server.address();
  log('info', 'updater listening', {
    port: typeof address === 'object' && address ? address.port : settings.port,
  });
  void removeReplaced().catch((error) =>
    log('warn', 'could not remove the updater this one replaced', { error: String(error?.message ?? error) }),
  );
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
