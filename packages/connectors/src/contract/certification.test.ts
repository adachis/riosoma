import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SOURCE_KINDS } from '@riosoma/contracts';
import {
  CERTIFICATION_MAX_AGE_MS,
  certificationPath,
  checkCertifications,
  writeCertification,
} from './certification.js';
import { SHIPPED_CONNECTORS, requiredCapabilities } from './capabilities.js';

const now = new Date('2026-10-02T12:00:00.000Z');
const version = '0.1.0';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'connector-certification-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const result = () => ({
  connector: 'postgres' as const,
  capabilitiesPassed: requiredCapabilities('postgres'),
});
const live = { ok: true, serverVersion: 'PostgreSQL 18.0' };

describe('connector certification', () => {
  it('covers every shipped kind and clearly lists missing certificates', async () => {
    expect(SHIPPED_CONNECTORS).toEqual(SOURCE_KINDS);
    expect(await checkCertifications(root, version, now)).toEqual(
      SOURCE_KINDS.map((connector) => ({ connector, reason: 'missing' })),
    );
  });

  it('writes an atomic live certificate and accepts it just before 30 days', async () => {
    const date = new Date(now.getTime() - CERTIFICATION_MAX_AGE_MS + 1);
    const record = await writeCertification(root, result(), version, live, date);
    expect(JSON.parse(await readFile(certificationPath(root, 'postgres'), 'utf8'))).toEqual(record);
    expect(record).toMatchObject({
      connector: 'postgres',
      version,
      date: date.toISOString(),
      serverVersionTested: live.serverVersion,
    });
    expect(await checkCertifications(root, version, now, ['postgres'])).toEqual([]);
  });

  it('expires at exactly 30 days', async () => {
    await writeCertification(
      root,
      result(),
      version,
      live,
      new Date(now.getTime() - CERTIFICATION_MAX_AGE_MS),
    );
    expect(await checkCertifications(root, version, now, ['postgres'])).toEqual([
      { connector: 'postgres', reason: 'expired' },
    ]);
  });

  it.each([
    [{ connector: 'mysql' }, 'invalid'],
    [{ date: '2026-02-30T12:00:00.000Z' }, 'invalid'],
    [{ date: new Date(now.getTime() + 1).toISOString() }, 'future'],
    [{ serverVersionTested: '' }, 'invalid'],
    [{ version: '0.0.0' }, 'version'],
    [{ capabilitiesPassed: ['list'] }, 'capabilities'],
    [{ capabilitiesPassed: [...requiredCapabilities('postgres'), 'list'] }, 'capabilities'],
  ])('refuses malformed, outdated, or incomplete metadata %j', async (patch, reason) => {
    const record = await writeCertification(root, result(), version, live, now);
    await writeFile(certificationPath(root, 'postgres'), JSON.stringify({ ...record, ...patch }));
    expect(await checkCertifications(root, version, now, ['postgres'])).toEqual([
      { connector: 'postgres', reason },
    ]);
  });

  it('refuses failed live tests, unreported server versions, and partial runs without replacing a certificate', async () => {
    const original = await writeCertification(root, result(), version, live, now);
    await expect(writeCertification(root, result(), version, { ok: false }, now)).rejects.toThrow();
    await expect(writeCertification(root, result(), version, { ok: true }, now)).rejects.toThrow();
    await expect(
      writeCertification(root, { connector: 'postgres', capabilitiesPassed: ['list'] }, version, live, now),
    ).rejects.toThrow();
    expect(JSON.parse(await readFile(certificationPath(root, 'postgres'), 'utf8'))).toEqual(original);
  });

  it('reports unreadable JSON without crashing or echoing its contents', async () => {
    await writeCertification(root, result(), version, live, now);
    await writeFile(certificationPath(root, 'postgres'), '{broken');
    expect(await checkCertifications(root, version, now, ['postgres'])).toEqual([
      { connector: 'postgres', reason: 'invalid' },
    ]);
  });
});
