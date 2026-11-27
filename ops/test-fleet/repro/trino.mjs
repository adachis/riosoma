/**
 * Minimal reproduction for Trino sort pushdown mismatch (`sort.rows`).
 * Run while `--profile trino` and `--profile postgres17` are up and seeded.
 */
import { contracts } from '../../../tools/connector_live_sql.mjs';
import { fleetSettingsEnv } from '../contract-settings.mjs';

Object.assign(process.env, fleetSettingsEnv(['trino']));

const list = await contracts();
const adapter = await list.find((entry) => entry.connector.kind === 'trino').prepare();
try {
  const probe = await adapter.sort.run(adapter.context);
  console.log(
    JSON.stringify(
      {
        expectedIds: adapter.sort.expectedRows.map((row) => row.id),
        actualIds: probe.rows.map((row) => row.id),
      },
      null,
      2,
    ),
  );
} finally {
  await adapter.cleanup?.();
}
