import { accountMessages } from '../auth/messages.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { AppError } from '@riosoma/contracts';
import { connectDatabase } from '@riosoma/db';
import { loadConfig } from '../config.js';
import { startupFailure } from '../configuration-error.js';
import { runAuthenticationCommand } from '../data/commands/authentication.js';
import { NO_SESSIONS } from '../http/policy.js';
import { SetupState } from '../setup/state.js';
import type { AppContext } from '../app.js';

/** This entry point has no HTTP route, and uses only the server's local configuration. */
export async function ownerResetLink(ctx: AppContext, email: string, localShell: boolean): Promise<string> {
  if (!localShell) throw new AppError('forbidden', 'auth.reset.serverShell');
  const result = await runAuthenticationCommand(
    ctx,
    { kind: 'auth.reset.owner', email },
    { serverShell: true },
  );
  if (!result.link) throw new AppError('unavailable', 'auth.reset.invalid');
  return result.link;
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new AppError('forbidden', 'auth.reset.serverShell');
  const email = process.argv.length === 3 ? process.argv[2] : undefined;
  if (!email) throw new AppError('validation_failed', 'auth.reset.commandUsage');
  const config = loadConfig();
  if (!config.database) throw new AppError('setup_required', 'setup.database.required');
  const database = await connectDatabase(config.database);
  try {
    const ctx: AppContext = {
      config,
      pool: database.pool,
      sessions: NO_SESSIONS,
      setup: new SetupState(config.configDir, undefined),
    };
    console.log(await ownerResetLink(ctx, email, true));
  } finally {
    await database.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(
      error instanceof AppError
        ? (accountMessages[error.messageKey] ?? error.messageKey)
        : JSON.stringify(startupFailure(error)),
    );
    process.exitCode = 1;
  });
}
