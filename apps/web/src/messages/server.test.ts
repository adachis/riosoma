import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { i18n } from '@lingui/core';
import { describe, expect, it } from 'vitest';
import { TEST_STEPS } from '@riosoma/contracts';
import { FORMULA_MESSAGES } from './formula';
import { SERVER_MESSAGES } from './server';
import { serverMessage } from './useServerMessage';

const ROOT = join(import.meta.dirname, '../../../..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

/** Keys the server, the database layer, and the connectors can put in an error or a report. */
function emittedKeys(): string[] {
  const keys = new Set<string>();
  for (const file of [
    ...sources(join(ROOT, 'apps/server/src')),
    ...sources(join(ROOT, 'packages/db/src')),
    ...sources(join(ROOT, 'packages/contracts/src')),
    // Connectors name their own failures, so a Data Source message can start its life here.
    ...sources(join(ROOT, 'packages/connectors/src')),
    // So do the connectors the connector service runs, and the service itself.
    ...sources(join(ROOT, 'packages/connector-drivers/src')),
    ...sources(join(ROOT, 'apps/connector-service/src')),
  ]) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/new AppError\(\s*'[a-z_]+',\s*'([^']+)'/g)) keys.add(m[1]!);
    for (const m of text.matchAll(/'(setup\.(?:diagnose|fix)\.[A-Za-z.]+)'/g)) keys.add(m[1]!);
    for (const m of text.matchAll(/'(sources\.[A-Za-z.]+)'/g)) keys.add(m[1]!);
    // Single sign-on sends its keys in redirects, field errors, and test results.
    for (const m of text.matchAll(/'(sso\.[A-Za-z.]+)'/g)) keys.add(m[1]!);
    // So do cloud drives, when connecting an account and testing an app.
    for (const m of text.matchAll(/'(drives\.[A-Za-z.]+)'/g)) keys.add(m[1]!);
    for (const m of text.matchAll(
      /'(data\.(?:access|value|field|table|view|record|database|command|undo|paste|filter|link|formula|share|user|file|form)\.[A-Za-z.]+)'/g,
    )) {
      keys.add(m[1]!);
    }
  }
  return [...keys].sort();
}

describe('server messages', () => {
  it('has explicit catalog IDs for reader failures', () => {
    const keys = new Set(
      sources(join(ROOT, 'apps/server/src/ingest/readers')).flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(/'(ingest\.reader\.[A-Za-z]+)'/g)].map((match) => match[1]!),
      ),
    );
    expect(keys.size).toBe(6);
    for (const key of keys) expect(SERVER_MESSAGES[key]).toMatchObject({ id: key });
  });
  it('has explicit catalog IDs for extraction outcomes and warnings', () => {
    const keys = new Set(
      sources(join(ROOT, 'apps/server/src/ingest/extract')).flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(/'(ingest\.extract\.[A-Za-z]+)'/g)].map((match) => match[1]!),
      ),
    );
    expect(keys.size).toBeGreaterThan(12);
    for (const key of keys) expect(SERVER_MESSAGES[key]).toMatchObject({ id: key });
  });
  it('has English text for every formula engine diagnostic', () => {
    const keys = new Set(
      sources(join(ROOT, 'packages/formula/src')).flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(/'(formula\.[A-Za-z.]+)'/g)].map((match) => match[1]!),
      ),
    );
    expect(keys.size).toBeGreaterThan(20);
    expect([...keys].filter((key) => !FORMULA_MESSAGES[key]?.message)).toEqual([]);
  });

  it('has text for every key the server can send', () => {
    const missing = emittedKeys().filter((key) => !SERVER_MESSAGES[key]);
    expect(missing).toEqual([]);
  });

  it('reaches the Data Source keys the connectors and the server emit', () => {
    const keys = emittedKeys().filter((key) => key.startsWith('sources.'));
    // Without the connector's own key the scan above would pass while reading nothing at all.
    expect(keys).toContain('sources.kindUnavailable');
    expect(keys.filter((key) => !SERVER_MESSAGES[key]?.message)).toEqual([]);
  });

  it('reaches the single sign-on keys the server sends', () => {
    const keys = emittedKeys().filter((key) => key.startsWith('sso.'));
    // A redirect carries its key as a plain string, so this proves the scan finds them at all.
    expect(keys).toContain('sso.state');
    expect(keys).toContain('sso.test.unreachable');
    expect(keys.filter((key) => !SERVER_MESSAGES[key]?.message)).toEqual([]);
  });

  it('reaches the cloud drive keys the server sends', () => {
    const keys = emittedKeys().filter((key) => key.startsWith('drives.'));
    expect(keys).toContain('drives.connect.state');
    expect(keys).toContain('drives.test.client');
    expect(keys.filter((key) => !SERVER_MESSAGES[key]?.message)).toEqual([]);
  });

  it('has text for every step of a source connection test', () => {
    expect(TEST_STEPS.filter((step) => !SERVER_MESSAGES[`sources.test.${step}`]?.message)).toEqual([]);
  });

  it('explains encrypted file transfers and the operator setting for plain FTP', () => {
    i18n.load('en-US', {});
    i18n.activate('en-US');
    const message = serverMessage(i18n, 'sources.file.ftp');
    expect(message).toContain('FTPS or SFTP');
    expect(message).toContain('limited to localhost');
    expect(message).toContain('RIOSOMA_AUTOMATIONS_ALLOW_PRIVATE_HOSTS=true');
    expect(message).not.toMatch(/https?/i);
  });

  it.each(['tokenHelp', 'deniedToken'])(
    'explains the Calendly organization role requirement in %s',
    (guidance) => {
      i18n.load('en-US', {});
      i18n.activate('en-US');
      const message = serverMessage(i18n, `sources.app.calendly.${guidance}`);
      expect(message).toContain('organization admin or owner');
      expect(message).toContain('organization-wide');
      expect(message).toContain('personal access token');
      expect(message).toContain('Integrations & apps, API and webhooks');
      expect(message).toContain('read access to users, scheduled events, event types, and organizations');
    },
  );

  it('fills parameters and friendly units', () => {
    i18n.load('en-US', {});
    i18n.activate('en-US');
    expect(serverMessage(i18n, 'auth.signIn.locked', { retryAfterSeconds: 610 })).toContain('11 minutes');
    expect(serverMessage(i18n, 'mfa.locked', { retryAfterSeconds: 61 })).toBe(
      'Too many tries.  Try again in 2 minutes.',
    );
    expect(serverMessage(i18n, 'setup.diagnose.auth.tokenFailed', { provider: 'aws-rds-iam' })).toContain(
      'AWS',
    );
    expect(
      serverMessage(i18n, 'setup.diagnose.extensions.available', {
        installed: 'pg_trgm',
        available: '',
        missing: 'vector',
      }),
    ).toBe('Optional extensions.  Installed: pg_trgm.  Ready to install: none.  Not available: vector.');
    // Unknown keys fall back to a general message rather than showing the key.
    expect(serverMessage(i18n, 'errors.somethingNew')).toBe('Something went wrong on the server.');
  });

  it('explains broken function calls in cells that retain only an error key', () => {
    i18n.load('en-US', {});
    i18n.activate('en-US');
    expect(serverMessage(i18n, 'formula.function.unknown')).toBe(
      'This formula calls a function that is unavailable. Update the call or restore the named function.',
    );
    expect(serverMessage(i18n, 'formula.function.arity')).toBe(
      'This formula passes the wrong number of arguments. Check the function parameters and update the call.',
    );
    expect(serverMessage(i18n, 'formula.function.arity', { name: 'NET' })).toBe(
      'Check how many arguments NET needs.',
    );
  });
});
