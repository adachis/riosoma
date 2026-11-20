import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SourceKind } from '@riosoma/contracts';
import { SHIPPED_CONNECTORS, requiredCapabilities, type ContractCapability } from './capabilities.js';
import { invariant } from './assertions.js';
import type { ContractResult } from './kit.js';

export const CERTIFICATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export interface Certification {
  connector: SourceKind;
  version: string;
  date: string;
  serverVersionTested: string;
  capabilitiesPassed: ContractCapability[];
}
export interface CertificationIssue {
  connector: SourceKind;
  reason: 'missing' | 'invalid' | 'expired' | 'future' | 'version' | 'capabilities';
}

export function certificationPath(root: string, connector: SourceKind): string {
  invariant(SHIPPED_CONNECTORS.includes(connector), 'certification.connector');
  return join(root, connector, 'certification.json');
}

/** A fixture result is insufficient: the caller must supply a successful live connection test. */
export async function writeCertification(
  root: string,
  result: ContractResult,
  version: string,
  liveTest: { ok: boolean; serverVersion?: string },
  now = new Date(),
): Promise<Certification> {
  invariant(liveTest.ok && liveTest.serverVersion?.trim(), 'certification.liveVersion');
  invariant(version.length > 0 && Number.isFinite(now.getTime()), 'certification.metadata');
  const expected = requiredCapabilities(result.connector).sort();
  invariant(
    JSON.stringify([...new Set(result.capabilitiesPassed)].sort()) === JSON.stringify(expected),
    'certification.capabilities',
  );
  const record: Certification = {
    connector: result.connector,
    version,
    date: now.toISOString(),
    serverVersionTested: liveTest.serverVersion!,
    capabilitiesPassed: expected,
  };
  const file = certificationPath(root, result.connector);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, file);
  return record;
}

/** Checks every shipped kind, independent of which live accounts happen to be configured. */
export async function checkCertifications(
  root: string,
  version: string,
  now = new Date(),
  kinds: readonly SourceKind[] = SHIPPED_CONNECTORS,
): Promise<CertificationIssue[]> {
  invariant(Number.isFinite(now.getTime()), 'certification.clock');
  const issues: CertificationIssue[] = [];
  for (const connector of kinds) {
    let record: unknown;
    try {
      record = JSON.parse(await readFile(certificationPath(root, connector), 'utf8'));
    } catch (error) {
      issues.push({
        connector,
        reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid',
      });
      continue;
    }
    if (!record || typeof record !== 'object') {
      issues.push({ connector, reason: 'invalid' });
      continue;
    }
    const value = record as Partial<Certification>;
    const date = typeof value.date === 'string' ? new Date(value.date) : new Date(NaN);
    let reason: CertificationIssue['reason'] | undefined;
    if (
      value.connector !== connector ||
      !Number.isFinite(date.getTime()) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.date ?? '') ||
      date.toISOString() !== value.date ||
      typeof value.serverVersionTested !== 'string' ||
      !value.serverVersionTested.trim()
    )
      reason = 'invalid';
    else if (date.getTime() > now.getTime()) reason = 'future';
    else if (now.getTime() - date.getTime() >= CERTIFICATION_MAX_AGE_MS) reason = 'expired';
    else if (value.version !== version) reason = 'version';
    else if (
      !Array.isArray(value.capabilitiesPassed) ||
      JSON.stringify([...value.capabilitiesPassed].sort()) !==
        JSON.stringify(requiredCapabilities(connector).sort())
    )
      reason = 'capabilities';
    if (reason) issues.push({ connector, reason });
  }
  return issues;
}
