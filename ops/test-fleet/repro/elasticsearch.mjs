/**
 * Minimal reproduction for Elasticsearch `_id` sort pushdown rejection.
 * Run while `--profile elasticsearch` is up and seeded.
 */
import { contracts } from '../../../tools/connector_live_sql.mjs';
import { fleetSettingsEnv } from '../contract-settings.mjs';

Object.assign(process.env, fleetSettingsEnv(['elasticsearch']));

const list = await contracts();
const adapter = await list.find((entry) => entry.connector.kind === 'elasticsearch').prepare();
try {
  await adapter.sort.run(adapter.context);
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
