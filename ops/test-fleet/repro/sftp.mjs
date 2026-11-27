/**
 * Minimal reproduction for the SFTP connector unhandled stream error event.
 * Run while `--profile sftp` is up and `RIOSOMA_SFTP_HOST_KEY` is exported.
 */
import { contracts } from '../../../tools/connector_live_sql.mjs';
import { fleetSettingsEnv } from '../contract-settings.mjs';

Object.assign(
  process.env,
  fleetSettingsEnv(['sftp'], {
    sftpHostKey: process.env.RIOSOMA_SFTP_HOST_KEY,
  }),
);

const list = await contracts();
const adapter = await list.find((entry) => entry.connector.kind === 'sftp').prepare();
try {
  await adapter.connector.test(adapter.context);
} finally {
  await adapter.cleanup?.();
}
