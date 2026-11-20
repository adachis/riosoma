// Seeds the search, graph, and metrics fleet and runs the connectors' live suite against it.
//
// Start the fleet under a project name of your own, so its containers and volumes are easy to
// find and remove afterwards, then seed it, then take it down:
//
//   docker compose -p rio-sources-search-graph -f ops/test-fleet/compose.yaml \
//     --profile sources-search-graph up -d --wait
//   node ops/test-fleet/search-graph-smoke.mjs
//   docker compose -p rio-sources-search-graph -f ops/test-fleet/compose.yaml \
//     --profile sources-search-graph down -v
//
// Every credential is read from the container that holds it, so nothing secret is written here.
// Set RIOSOMA_TEST_SEARCH_GRAPH_PROJECT when the fleet runs under another project prefix.  A
// service that isn't running is skipped, and the live suite skips the engines it has no settings
// for, so one engine at a time works too.

import { execFileSync, spawnSync } from 'node:child_process';

const env = { ...process.env };
const project = env.RIOSOMA_TEST_SEARCH_GRAPH_PROJECT ?? 'rio-sources-search-graph';
/** The ports compose.yaml publishes on this machine, by service name. */
const PORTS = {
  elasticsearch: 19200,
  opensearch: 19201,
  meilisearch: 17700,
  typesense: 18108,
  neo4j: 17474,
  influxdb2: 18086,
  influxdb3: 18181,
  prometheus: 19090,
};
const address = (service) => `http://127.0.0.1:${PORTS[service]}`;

async function request(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  await response.body?.cancel();
  return response;
}

/** A running container's own settings: its environment, and the command line that started it. */
function inspected(service) {
  let entry;
  try {
    [entry] = JSON.parse(
      execFileSync('docker', ['inspect', `${project}-${service}-1`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return null;
  }
  const environment = Object.fromEntries(
    (entry.Config?.Env ?? []).map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }),
  );
  const command = [...(entry.Config?.Entrypoint ?? []), ...(entry.Config?.Cmd ?? [])];
  return { environment, command };
}

function settings(name, connection, secrets = {}) {
  env[`RIOSOMA_TEST_${name}_SETTINGS`] = JSON.stringify({ connection, secrets });
}

/** Waits for an engine to answer, since a healthcheck passing can still precede a ready API. */
async function ready(service, path) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await request(`${address(service)}${path}`);
      if (response.ok || response.status === 401) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 1_000));
  }
  throw new Error(`${service} did not answer on ${address(service)}${path}`);
}

const started = [];

const elasticsearch = inspected('elasticsearch');
if (elasticsearch) {
  await ready('elasticsearch', '/');
  settings(
    'ELASTICSEARCH',
    { kind: 'elasticsearch', endpoint: address('elasticsearch'), auth: 'basic', user: 'elastic' },
    { password: elasticsearch.environment.ELASTIC_PASSWORD ?? '' },
  );
  started.push('elasticsearch');
}

if (inspected('opensearch')) {
  await ready('opensearch', '/');
  settings('OPENSEARCH', { kind: 'opensearch', endpoint: address('opensearch'), auth: 'none' });
  started.push('opensearch');
}

const meilisearch = inspected('meilisearch');
if (meilisearch) {
  await ready('meilisearch', '/health');
  settings(
    'MEILISEARCH',
    { kind: 'meilisearch', endpoint: address('meilisearch'), auth: 'api-key' },
    { apiKey: meilisearch.environment.MEILI_MASTER_KEY ?? '' },
  );
  started.push('meilisearch');
}

const typesense = inspected('typesense');
if (typesense) {
  await ready('typesense', '/health');
  const at = typesense.command.indexOf('--api-key');
  settings(
    'TYPESENSE',
    { kind: 'typesense', endpoint: address('typesense'), auth: 'api-key' },
    { apiKey: at === -1 ? '' : (typesense.command[at + 1] ?? '') },
  );
  started.push('typesense');
}

const neo4j = inspected('neo4j');
if (neo4j) {
  await ready('neo4j', '/');
  const [user, password] = (neo4j.environment.NEO4J_AUTH ?? 'neo4j/').split('/');
  settings(
    'NEO4J',
    { kind: 'neo4j', endpoint: address('neo4j'), auth: 'basic', user, database: 'neo4j' },
    { password: password ?? '' },
  );
  started.push('neo4j');
}

const influxdb2 = inspected('influxdb2');
if (influxdb2) {
  await ready('influxdb2', '/ping');
  settings(
    'INFLUXDB',
    {
      kind: 'influxdb',
      endpoint: address('influxdb2'),
      auth: 'token',
      version: '2',
      database: influxdb2.environment.DOCKER_INFLUXDB_INIT_BUCKET ?? 'riosoma_test',
      organization: influxdb2.environment.DOCKER_INFLUXDB_INIT_ORG ?? 'riosoma',
    },
    { token: influxdb2.environment.DOCKER_INFLUXDB_INIT_ADMIN_TOKEN ?? '' },
  );
  started.push('influxdb2');
}

if (inspected('influxdb3')) {
  await ready('influxdb3', '/health');
  // Version 3 starts with no database, and a query names one, so the run makes its own.
  const database = 'riosoma_test';
  const made = await request(`${address('influxdb3')}/api/v3/configure/database`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ db: database }),
  });
  if (![200, 201, 204, 409].includes(made.status))
    throw new Error(`InfluxDB 3 refused a test database with HTTP ${made.status}`);
  settings('INFLUXDB3', {
    kind: 'influxdb',
    endpoint: address('influxdb3'),
    auth: 'none',
    version: '3',
    database,
  });
  started.push('influxdb3');
}

if (inspected('prometheus')) {
  await ready('prometheus', '/-/healthy');
  // Prometheus scrapes itself, so `up` has samples from the first scrape onwards.
  settings('PROMETHEUS', {
    kind: 'prometheus',
    endpoint: address('prometheus'),
    auth: 'none',
    query: 'up',
    stepSeconds: 15,
    windowMinutes: 15,
  });
  started.push('prometheus');
}

if (!started.length) throw new Error(`No fleet member is running under the project ${project}`);
process.stdout.write(`Seeded ${started.join(', ')}\n`);

const run = spawnSync(
  'pnpm',
  [
    '--filter',
    '@riosoma/connectors',
    'exec',
    'vitest',
    'run',
    'src/http-engines/engines.live.test.ts',
    '--maxWorkers=3',
  ],
  { env, stdio: 'inherit' },
);
process.exitCode = run.status ?? 1;
