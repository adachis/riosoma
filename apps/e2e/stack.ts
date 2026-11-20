import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { selfSignedCertificate } from '../server/src/test/saml-idp';
import { startMailCatcher } from './mail';
import { stopProcess } from './process-shutdown';
import { testWebDirectory } from './web-build';

/**
 * A complete Riosoma for browser tests: a throwaway PostgreSQL, the built server, the built web
 * app, and the themes, on a free port.  Build first: `pnpm turbo run build`.  Suite setup builds
 * the web test artifact separately so release language settings cannot disable browser coverage.
 *
 * The server sends its email to a mail catcher on this machine, and its calls to outside
 * services that tests stand in for go to a port on this machine (see `outside-hosts.ts`).
 */
export const SETUP_TOKEN = 'e2e-setup-token-0123456789abcdef';
const ROOT = resolve(import.meta.dirname, '../..');

/** Outside services a test may stand in for, whose names resolve to this machine */
export const STAND_IN_HOSTS = ['hooks.slack.com'];

/** Where a stand-in for an outside service listens, and the certificate the server trusts for it */
export interface StandIn {
  port: number;
  certificate: string;
  privateKey: string;
}

export interface Stack {
  baseURL: string;
  /** The superuser address of the server's own database, or empty when it runs without one */
  databaseURL: string;
  /** The folder the mail catcher keeps each message the server sends in */
  mailDir: string;
  standIn: StandIn;
  stop(): Promise<void>;
}

export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => done(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

/** How long a server has to become healthy, which a busy machine running a fresh install needs */
export const HEALTH_WAIT_MS = 90_000;
/** How many of its last lines a server that failed to start reports */
const LAST_LINES = 40;

/** What a process has printed, as far as it's kept */
export interface Printed {
  /** Its last lines, oldest first */
  lines(): string[];
  /** Settles once the process has ended and everything it printed has arrived */
  ended: Promise<void>;
}

/**
 * Passes everything a process prints through to this one's output, and keeps its last lines so a
 * failed start can say why.
 */
export function lastLines(child: ChildProcess, keep = LAST_LINES): Printed {
  const lines: string[] = [];
  const add = (...more: string[]) => {
    lines.push(...more.filter((line) => line.trim()));
    lines.splice(0, Math.max(0, lines.length - keep));
  };
  for (const [from, to] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ] as const) {
    let partial = '';
    from?.setEncoding('utf8');
    from?.on('data', (text: string) => {
      to.write(text);
      const parts = (partial + text).split('\n');
      partial = parts.pop() ?? '';
      add(...parts);
    });
    from?.on('end', () => add(partial));
  }
  // A process's output streams close after it exits, so its last words arrive before this settles.
  const ended = new Promise<void>((settle) => child.once('close', () => settle()));
  return { lines: () => [...lines], ended };
}

function withLastLines(message: string, printed: string[]): Error {
  return new Error(
    printed.length
      ? `${message}.  The last lines it printed:\n${printed.join('\n')}`
      : `${message}.  It printed nothing.`,
  );
}

export async function waitForHealth(
  url: string,
  server: ChildProcess,
  printed: Printed,
  waitMs = HEALTH_WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      // Its last words are usually why, so they get a moment to arrive.
      await Promise.race([printed.ended, new Promise((r) => setTimeout(r, 5_000))]);
      const how = server.exitCode !== null ? `code ${server.exitCode}` : `signal ${server.signalCode}`;
      throw withLastLines(`The server exited early with ${how}`, printed.lines());
    }
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw withLastLines(`The server did not become healthy within ${waitMs / 1000} seconds`, printed.lines());
}

export async function startStack(
  options: { database?: boolean; clamavApprovedUrls?: string[]; offline?: boolean } = {},
): Promise<Stack> {
  const webDirectory = testWebDirectory();
  const withDatabase = options.database ?? true;
  let pg: TestPostgres | null = null;
  let dbUrl = '';
  let dropDb: (() => Promise<void>) | null = null;
  if (withDatabase) {
    pg = await startTestPostgres();
    const db = await pg.createDatabase('e2e');
    dbUrl = db.url;
    dropDb = db.drop;
  }
  const configDir = mkdtempSync(join(tmpdir(), 'rio-e2e-config-'));
  const removeConfig = () => {
    try {
      rmSync(configDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      // Shutdown errors are reported separately, so leftover files cannot replace a process failure.
      console.warn(`Could not remove browser test configuration after shutdown: ${configDir}`, error);
    }
  };
  const mail = await startMailCatcher(join(configDir, 'mail'));
  // An optional local Mailpit binary relays to the same mailbox reader, preserving recipients.
  let mailpit: ChildProcess | undefined;
  let mailpitPrinted: Printed | undefined;
  let smtpUrl = mail.url;
  if (process.env.RIOSOMA_E2E_MAILPIT) {
    const smtpPort = await freePort();
    const httpPort = await freePort();
    const relay = join(configDir, 'mailpit-relay.yml');
    writeFileSync(relay, `host: 127.0.0.1\nport: ${new URL(mail.url).port}\nauth: none\n`);
    mailpit = spawn(
      process.env.RIOSOMA_E2E_MAILPIT,
      [
        '--smtp',
        `127.0.0.1:${smtpPort}`,
        '--listen',
        `127.0.0.1:${httpPort}`,
        '--database',
        join(configDir, 'mailpit.db'),
        '--smtp-relay-config',
        relay,
        '--smtp-relay-all',
        '--disable-version-check',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const printed = lastLines(mailpit);
    mailpitPrinted = printed;
    try {
      const deadline = Date.now() + HEALTH_WAIT_MS;
      for (;;) {
        if (mailpit.exitCode !== null || mailpit.signalCode !== null || Date.now() > deadline)
          throw withLastLines('Mailpit did not become healthy', printed.lines());
        if (
          await fetch(`http://127.0.0.1:${httpPort}/readyz`, { signal: AbortSignal.timeout(1_000) })
            .then((response) => response.ok)
            .catch(() => false)
        )
          break;
        await new Promise((done) => setTimeout(done, 100));
      }
      smtpUrl = `smtp://127.0.0.1:${smtpPort}`;
    } catch (error) {
      try {
        await stopProcess(mailpit, printed.ended, 'Browser test Mailpit');
      } finally {
        await mail.stop();
        await dropDb?.();
        await pg?.stop();
        removeConfig();
      }
      throw error;
    }
  }
  const standIn: StandIn = {
    port: await freePort(),
    ...selfSignedCertificate(STAND_IN_HOSTS[0]!),
  };
  const trusted = join(configDir, 'stand-in.pem');
  writeFileSync(trusted, standIn.certificate);
  const port = await freePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const preload = join(import.meta.dirname, 'outside-hosts.ts');
  const server = spawn(process.execPath, ['--import', preload, join(ROOT, 'apps/server/dist/main.js')], {
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'production',
      // Apply the launcher's resource limits without inheriting unrelated Node startup flags.
      NODE_OPTIONS: process.env.RIOSOMA_E2E_NODE_OPTIONS ?? '',
      RIOSOMA_PORT: String(port),
      RIOSOMA_HOST: '127.0.0.1',
      RIOSOMA_BASE_URL: baseURL,
      RIOSOMA_CONFIG_DIR: configDir,
      RIOSOMA_SETUP_TOKEN: SETUP_TOKEN,
      RIOSOMA_WEB_DIR: webDirectory,
      RIOSOMA_THEMES_DIR: process.env.RIOSOMA_THEMES_DIR ?? join(ROOT, 'themes'),
      RIOSOMA_LOG_LEVEL: 'warn',
      // File sources read from a web server the tests start on this machine, which the server may
      // reach only while it allows private hosts.  Webhooks and automations follow the same rule.
      RIOSOMA_AUTOMATIONS_ALLOW_PRIVATE_HOSTS: options.offline ? 'false' : 'true',
      ...(options.offline
        ? { RIOSOMA_UPDATE_CHECKS: 'off', RIOSOMA_TELEMETRY: 'off', RIOSOMA_HUB_URL: 'off' }
        : {}),
      // Invitations, reports, and replies go to the catcher, which speaks plain SMTP.
      RIOSOMA_SMTP_URL: smtpUrl,
      ...(process.env.RIOSOMA_E2E_PDF_RENDERER_URL
        ? { RIOSOMA_PDF_RENDERER_URL: process.env.RIOSOMA_E2E_PDF_RENDERER_URL }
        : {}),
      RIOSOMA_SMTP_ALLOW_PLAINTEXT: 'true',
      RIOSOMA_MAIL_FROM: 'Riosoma <riosoma@example.test>',
      RIOSOMA_E2E_STAND_IN_HOSTS: STAND_IN_HOSTS.join(','),
      RIOSOMA_E2E_STAND_IN_PORT: String(standIn.port),
      NODE_EXTRA_CA_CERTS: trusted,
      ...(options.clamavApprovedUrls?.length
        ? { RIOSOMA_CLAMAV_APPROVED_URLS: options.clamavApprovedUrls.join(',') }
        : {}),
      ...(dbUrl ? { RIOSOMA_DATABASE_URL: `${dbUrl}?sslmode=disable` } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const printed = lastLines(server);
  async function stop() {
    const stopped = await Promise.allSettled([
      stopProcess(server, printed.ended, `Browser test server at ${baseURL}`),
      ...(mailpit && mailpitPrinted
        ? [stopProcess(mailpit, mailpitPrinted.ended, 'Browser test Mailpit')]
        : []),
    ]);
    const failures = stopped.filter((result) => result.status === 'rejected').map((result) => result.reason);
    // A later cleanup error must not replace the name of a process that missed its deadline.
    for (const cleanup of [() => mail.stop(), () => dropDb?.(), () => pg?.stop(), removeConfig]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        `Could not stop browser test stack at ${baseURL}\n${failures.map(String).join('\n')}`,
      );
  }
  try {
    await waitForHealth(baseURL, server, printed);
  } catch (error) {
    // A server that never came up is stopped with everything started for it, so a slow start
    // leaves nothing running behind the failed run.
    await stop();
    throw error;
  }
  return { baseURL, databaseURL: dbUrl, mailDir: mail.dir, standIn, stop };
}
