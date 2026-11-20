import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(root, 'packages/connectors');
// The connectors that need driver packages of their own, which the connector service runs
const driversRoot = join(root, 'packages/connector-drivers');
const certificates = process.env.RIOSOMA_CERTIFICATION_DIR
  ? resolve(process.env.RIOSOMA_CERTIFICATION_DIR)
  : join(packageRoot, 'certifications');
const mode = process.argv[2] ?? 'contract';

function run(args, cwd = root, env = process.env) {
  return new Promise((fulfill, reject) => {
    const child = spawn('pnpm', args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? fulfill() : reject(new Error('sources.contract.commandFailed')),
    );
  });
}

export function fixtureGaps(kit, observed, results) {
  return kit.SHIPPED_CONNECTORS.flatMap((connector) => {
    const required = kit.requiredCapabilities(connector)
    const complete = results.some((result) => result.connector === connector &&
      required.every((check) => result.capabilitiesPassed?.includes(check)))
    return [
      ...required.filter((check) => !observed.get(connector)?.has(check))
        .map((check) => ({ connector, check })),
      ...(complete ? [] : [{ connector, check: 'contract.result' }]),
    ]
  })
}

async function fixtures(kit) {
  await run(['exec', 'node', '--test', 'tools/connector_contract.test.mjs']);
  const reports = await mkdtemp(join(root, 'tools/.contract-reports-'));
  const env = { ...process.env, RIOSOMA_CONTRACT_REPORT_DIR: reports };
  try {
    for (const cwd of [packageRoot, driversRoot])
      await run(['exec', 'vitest', 'run', '--config', 'contract.config.ts', '--maxWorkers=3'], cwd, env);
    await run(
      ['exec', 'vitest', 'run', '--config', 'connector-contract.config.ts', '--maxWorkers=3'],
      join(root, 'apps/server'),
      env,
    );
    const observed = new Map();
    const results = [];
    for (const file of await readdir(reports)) {
      const result = JSON.parse(await readFile(join(reports, file), 'utf8'));
      results.push(...(result.results ?? []));
      for (const [connector, checks] of Object.entries(result.observed ?? result)) {
        const passed = observed.get(connector) ?? new Set();
        for (const check of checks) passed.add(check);
        observed.set(connector, passed);
      }
    }
    const missing = fixtureGaps(kit, observed, results);
    process.stdout.write(
      `${JSON.stringify(
        {
          mode,
          observed: Object.fromEntries([...observed].map(([kind, checks]) => [kind, [...checks].sort()])),
          missing,
        },
        null,
        2,
      )}\n`,
    );
    if (missing.length) process.exitCode = 1;
  } finally {
    await rm(reports, { recursive: true, force: true });
  }
}

export async function runLiveAdapters(kit, contracts, version, directory, suiteFailures = new Set()) {
  const outcomes = []
  const seen = new Set()
  for (let adapter of contracts) {
    const { connector } = adapter
    kit.invariant(!seen.has(connector.kind), 'live.duplicate')
    seen.add(connector.kind)
    let step = 'prepare'
    try {
      if (adapter.prepare) adapter = await adapter.prepare()
      kit.invariant(adapter.connector.kind === connector.kind, 'live.connectorKind')
      step = 'contract'
      const result = await kit.runConnectorContract(adapter)
      step = 'test'
      const test = await adapter.connector.test(adapter.context)
      kit.assertSecretFree(test, adapter.context)
      step = 'version'
      if (adapter.serverVersion) {
        const observed = await adapter.serverVersion()
        if (observed) test.serverVersion = observed
      }
      kit.assertSecretFree(test, adapter.context)
      step = 'certificate'
      kit.invariant(!suiteFailures.has(connector.kind), 'live.protocolSuite')
      await kit.writeCertification(directory, result, version, test)
      outcomes.push({ connector: connector.kind, status: 'passed' })
    } catch (error) {
      const diagnostic =
        error instanceof kit.ContractViolation
          ? { check: error.check }
          : {
              check: `live.${step}`,
              reason:
                typeof error?.messageKey === 'string' && error.messageKey
                  ? error.messageKey
                  : (error instanceof Error && Object.getPrototypeOf(error)?.constructor?.name) || 'Error',
            }
      outcomes.push({ connector: connector.kind, status: 'failed', ...diagnostic })
    } finally {
      try {
        await adapter.cleanup?.()
      } catch {
        outcomes.push({ connector: connector.kind, status: 'failed', check: 'live.cleanup' })
      }
    }
  }
  for (const connector of kit.SHIPPED_CONNECTORS)
    if (!seen.has(connector)) outcomes.push({ connector, status: 'unconfigured' })
  return outcomes
}

async function live(kit, version) {
  // Existing account suites provide additional service-specific coverage when configured.
  let suitesPassed = true;
  const suiteFailures = new Set();
  const reports = await mkdtemp(join(root, 'tools/.contract-live-reports-'));
  const { startTestPostgres } = await import(
    pathToFileURL(join(root, 'packages/testkit/dist/index.js')).href
  );
  // A distinct credential avoids collisions with diagnostic keys and authenticates the local fleet.
  const postgres = process.env.RIOSOMA_TEST_DATABASE_URL
    ? undefined
    : await startTestPostgres({ password: randomBytes(24).toString('hex') });
  const env = { ...process.env, RIOSOMA_CONTRACT_REPORT_DIR: reports,
    ...(postgres ? { RIOSOMA_TEST_DATABASE_URL: postgres.url } : {}) };
  try {
    for (const [index, [cwd, config]] of [
      [packageRoot, 'contract-live.config.ts'],
      [driversRoot, 'contract-live.config.ts'],
      [join(root, 'apps/server'), 'connector-contract-live.config.ts'],
    ].entries()) {
      const output = join(reports, `${index}.json`);
      try {
        await run(['exec', 'vitest', 'run', '--config', config, '--maxWorkers=3',
          '--reporter=default', '--reporter=json', `--outputFile.json=${output}`], cwd, env);
      } catch {
        suitesPassed = false;
        process.exitCode = 1;
      }
    }
    for (const file of await readdir(reports)) {
      const report = JSON.parse(await readFile(join(reports, file), 'utf8'));
      for (const kind of report.failedConnectors ?? []) suiteFailures.add(kind);
    }
  } finally {
    await postgres?.stop();
    await rm(reports, { recursive: true, force: true });
  }
  const module = process.env.RIOSOMA_CONTRACT_LIVE_MODULE;
  // Account adapters own their seeded data and service-specific cancellation/query-history probes.
  const configured = await import(
    pathToFileURL(module ? resolve(module) : join(root, 'tools/connector_live_sql.mjs')).href
  );
  const contracts =
    typeof configured.contracts === 'function' ? await configured.contracts() : configured.contracts;
  kit.invariant(Array.isArray(contracts), 'live.adapters');
  const outcomes = await runLiveAdapters(kit, contracts, version, certificates, suiteFailures);
  if (outcomes.some((outcome) => outcome.status === 'failed')) process.exitCode = 1;
  process.stdout.write(`${JSON.stringify({ mode, suitesPassed, outcomes }, null, 2)}\n`);
}

export async function main() {
try {
  if (!['contract', 'contract:live', 'certification:check'].includes(mode))
    throw new Error('sources.contract.invalidCommand');
  await run([
    'turbo',
    'run',
    'build',
    '--filter=@riosoma/connectors...',
    '--filter=@riosoma/connector-drivers...',
    '--filter=@riosoma/testkit...',
    ...(mode !== 'certification:check' ? ['--filter=@riosoma/server'] : []),
  ]);
  const kit = await import(pathToFileURL(join(packageRoot, 'dist/contract/index.js')).href);
  const { version } = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (mode === 'contract') await fixtures(kit);
  else if (mode === 'contract:live') await live(kit, version);
  else {
    const issues = await kit.checkCertifications(certificates, version);
    process.stdout.write(`${JSON.stringify({ mode, issues }, null, 2)}\n`);
    if (issues.length) process.exitCode = 1;
  }
} catch {
  // Driver errors may contain credentials.  Shared assertions emit only stable check identifiers.
  process.stderr.write(`${JSON.stringify({ mode, messageKey: 'sources.contract.commandFailed' })}\n`);
  process.exitCode = 1;
}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
