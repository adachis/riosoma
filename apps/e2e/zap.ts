import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SETUP_TOKEN, startStack } from './stack';
import { buildTestWeb } from './web-build';
import { highRiskAlerts } from './zap-report';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, '.unit-logs/zap');
// Pin the scanner and its bundled rules together so nightly results remain reproducible.
const image =
  'ghcr.io/zaproxy/zaproxy@sha256:9624669db72f54d86c4b46a7064518bd9bf79d8c61a4c31befa9923489f328af';
const accepted = JSON.parse(readFileSync(resolve(root, '.github/zap/rules.json'), 'utf8')) as Record<
  string,
  string
>;
for (const [id, reason] of Object.entries(accepted))
  if (!/^\d+$/.test(id) || typeof reason !== 'string' || !reason.trim() || /[\r\n]/.test(reason))
    throw new Error('Each accepted ZAP rule needs a numeric ID and a one-line reason');

mkdirSync(output, { recursive: true });
writeFileSync(
  resolve(output, 'rules.conf'),
  Object.entries(accepted)
    .map(([id, reason]) => `${id}\tINFO\t${reason}\n`)
    .join(''),
);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

async function docker(args: string[]): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn('docker', args, { stdio: 'inherit' });
    child.once('error', fail);
    child.once('close', (code) => done(code ?? 3));
  });
}

const web = await buildTestWeb();
process.env.RIOSOMA_E2E_WEB_DIR = web.directory;
try {
  const stack = await startStack({ offline: true });
  try {
    const owner = await fetch(`${stack.baseURL}/api/setup/owner`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-setup-token': SETUP_TOKEN },
      body: JSON.stringify({
        orgName: 'Scan fixture',
        name: 'Scan owner',
        email: 'scan@example.test',
        password: randomUUID() + randomUUID(),
        locale: 'en-US',
      }),
    });
    if (!owner.ok) throw new Error(`Scan fixture setup failed: ${owner.status}`);
    // No credentials are handed to the scanner.  Scan the public surface after setup closes.
    const definition = await fetch(`${stack.baseURL}/api/v1/openapi.json`);
    const document = (await definition.json()) as { openapi?: string; paths?: object };
    if (!definition.ok || !document.openapi || !Object.keys(document.paths ?? {}).length)
      throw new Error('Server did not publish an OpenAPI document');
    let failed = false;
    for (const kind of ['baseline', 'api'] as const) {
      if (controller.signal.aborted) throw new Error('Scan interrupted');
      const name = `riosoma-zap-${randomUUID()}`;
      const abort = () => {
        void docker(['kill', name]);
      };
      controller.signal.addEventListener('abort', abort, { once: true });
      // A failed scan must never reuse a report from an earlier run.
      const reportPath = resolve(output, `${kind}.json`);
      writeFileSync(reportPath, 'null');
      rmSync(resolve(output, `${kind}.html`), { force: true });
      try {
        const code = await docker([
          'run',
          '--name',
          name,
          '--network',
          'host',
          '--user',
          `${process.getuid!()}:${process.getgid!()}`,
          '-v',
          `${output}:/zap/wrk:rw`,
          image,
          kind === 'baseline' ? 'zap-baseline.py' : 'zap-api-scan.py',
          '-t',
          kind === 'baseline' ? stack.baseURL : `${stack.baseURL}/api/v1/openapi.json`,
          ...(kind === 'api' ? ['-f', 'openapi'] : ['--autooff', '-m', '1']),
          '-c',
          'rules.conf',
          '-I',
          '-r',
          `${kind}.html`,
          '-J',
          `${kind}.json`,
          // Use bundled add-ons only, with no update or telemetry traffic from the scanner.
          '-z',
          '-silent -config autoupdate.checkOnStart=false -config autoupdate.downloadNewRelease=false -config autoupdate.installAddonUpdates=false',
        ]);
        if (controller.signal.aborted) throw new Error('Scan interrupted');
        if (code !== 0 && code !== 2) {
          console.error(`${kind}: scanner failed with exit ${code}`);
          failed = true;
        }
        const alerts = highRiskAlerts(JSON.parse(readFileSync(reportPath, 'utf8')), accepted);
        for (const alert of alerts) console.error(`${kind}: ${alert.pluginid} ${alert.name}`);
        failed ||= alerts.length > 0;
      } catch (error) {
        console.error(error);
        failed = true;
      } finally {
        controller.signal.removeEventListener('abort', abort);
        // Also clean up after a Docker client error or job cancellation.
        if (await docker(['rm', '-f', name])) failed = true;
      }
    }
    if (failed) throw new Error('ZAP scan failed.  Review both HTML and JSON reports.');
  } finally {
    await stack.stop();
  }
} finally {
  delete process.env.RIOSOMA_E2E_WEB_DIR;
  web.remove();
}
