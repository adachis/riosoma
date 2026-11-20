import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
const temporary = mkdtempSync(join(tmpdir(), 'riosoma-hub-build-'));
const result = spawnSync(process.execPath, [cli, 'deploy', '--dry-run', '--outdir', 'dist'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    XDG_CONFIG_HOME: temporary,
    WRANGLER_LOG_PATH: join(temporary, 'build.log'),
    WRANGLER_SEND_METRICS: 'false',
  },
});
rmSync(temporary, { recursive: true, force: true });
process.exitCode = result.status ?? 1;
