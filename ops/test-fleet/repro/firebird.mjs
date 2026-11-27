/**
 * Minimal reproduction for Firebird sign-in timeout classification.
 * Run while `--profile firebird5` is up.
 */
import { contracts } from '../../../tools/connector_live_sql.mjs';
import { fleetSettingsEnv } from '../contract-settings.mjs';

Object.assign(process.env, fleetSettingsEnv(['firebird']));

const list = await contracts();
const adapter = await list.find((entry) => entry.connector.kind === 'firebird').prepare();
try {
  await adapter.timeout({ ...adapter.context, timeoutMs: 10, statementTimeoutMs: 10 });
  process.exitCode = 1;
} catch (error) {
  console.log(
    JSON.stringify(
      {
        name: error?.constructor?.name,
        messageKey: error?.messageKey ?? null,
        params: error?.params ?? null,
        detail: error?.detail ?? error?.message ?? null,
      },
      null,
      2,
    ),
  );
} finally {
  await adapter.cleanup?.();
}
