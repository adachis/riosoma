import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { probeDatabase } from './probe.js';

const hasOpenSsl = spawnSync('openssl', ['version']).status === 0;
let kit: TestPostgres;
let db: Awaited<ReturnType<TestPostgres['createDatabase']>>;
let certPem: string;

describe.skipIf(!hasOpenSsl)(
  'TLS diagnostics (requires the openssl command; skipped when unavailable)',
  () => {
    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'rio-cert-'));
      try {
        execFileSync(
          'openssl',
          [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-days',
            '1',
            '-subj',
            '/CN=localhost',
            '-addext',
            'subjectAltName=DNS:localhost,IP:127.0.0.1',
            '-keyout',
            join(dir, 'server.key'),
            '-out',
            join(dir, 'server.crt'),
          ],
          { stdio: 'pipe' },
        );
        certPem = readFileSync(join(dir, 'server.crt'), 'utf8');
        kit = await startTestPostgres({
          tls: { certPem, keyPem: readFileSync(join(dir, 'server.key'), 'utf8') },
        });
        db = await kit.createDatabase('tls');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);

    afterAll(async () => {
      await db?.drop();
      await kit?.stop();
    });

    it.each(['require', 'prefer'] as const)('%s encrypts without requiring trust', async (mode) => {
      const report = await probeDatabase({ ...db.profile, tls: { mode } });
      expect(report.ok).toBe(true);
      expect(report.steps.find((step) => step.step === 'tls')).toMatchObject({
        status: 'ok',
        messageKey: 'setup.diagnose.tls.ok',
      });
    });

    it('reports an untrusted self-signed certificate', async () => {
      const report = await probeDatabase({ ...db.profile, tls: { mode: 'verify-full' } });
      expect(report.ok).toBe(false);
      expect(report.steps.at(-1)).toMatchObject({
        step: 'tls',
        messageKey: 'setup.diagnose.tls.untrusted',
        fixKey: 'setup.fix.addCa',
      });
    });

    it('trusts the supplied CA and verifies the requested name', async () => {
      const report = await probeDatabase({
        ...db.profile,
        tls: { mode: 'verify-full', caPem: certPem, serverName: 'localhost' },
      });
      expect(report.ok).toBe(true);
    });

    it('verifies IP subject alternative names without sending an IP as SNI', async () => {
      const report = await probeDatabase({ ...db.profile, tls: { mode: 'verify-full', caPem: certPem } });
      expect(report.ok).toBe(true);
    });

    it('reports a name mismatch separately from trust', async () => {
      const report = await probeDatabase({
        ...db.profile,
        tls: { mode: 'verify-full', caPem: certPem, serverName: 'wrong.invalid' },
      });
      expect(report.ok).toBe(false);
      expect(report.steps.at(-1)).toMatchObject({
        step: 'tls',
        messageKey: 'setup.diagnose.tls.nameMismatch',
        fixKey: 'setup.fix.useCertName',
      });
    });

    it('verify-ca does not check the name', async () => {
      const report = await probeDatabase({
        ...db.profile,
        tls: { mode: 'verify-ca', caPem: certPem, serverName: 'wrong.invalid' },
      });
      expect(report.ok).toBe(true);
    });
  },
);
