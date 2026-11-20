import { describe, expect, it } from 'vitest';
import { HubBugReport, redactHubText } from './hub.js';

describe('upstream credential redaction', () => {
  it.each([
    'access_token',
    'refresh_token',
    'client_secret',
    'ACCESS_TOKEN',
    'refresh-token',
    'clientSecret',
  ])('redacts the complete %s credential and rejects it in every published field', (key) => {
    const credential = crypto.randomUUID().replace(/[0-9-]/g, 'x');
    const text = `Grid freezes with ${key}=${credential}`;
    expect(redactHubText(text)).toBe('Grid freezes with [secret]');
    const report = {
      installId: crypto.randomUUID(),
      fingerprint: 'a'.repeat(64),
      version: '1.2.3',
      platform: 'Linux',
      title: 'Grid freezes',
      description: 'Grid freezes',
    };
    for (const field of ['platform', 'title', 'description']) {
      expect(HubBugReport.safeParse({ ...report, [field]: text }).success).toBe(false);
      expect(HubBugReport.safeParse({ ...report, [field]: redactHubText(text) }).success).toBe(true);
    }
    expect(HubBugReport.safeParse({ ...report, version: text }).success).toBe(false);
    expect(HubBugReport.safeParse({ ...report, version: redactHubText(text) }).success).toBe(false);
  });
});

describe('upstream bug report version', () => {
  const report = {
    installId: crypto.randomUUID(),
    fingerprint: 'a'.repeat(64),
    platform: 'Linux',
    title: 'Grid freezes',
    description: 'Grid freezes',
  };
  it.each(['custom', '0.95.0', '1.2.3-rc.1', '1.2.3-beta', '0.1.0-dev'])('accepts %s', (version) => {
    expect(HubBugReport.safeParse({ ...report, version }).success).toBe(true);
  });
  it.each([
    '@someone',
    'see www.example.test',
    'other/repo#1',
    '1.2',
    '1.2.3-nightly',
    '1.2.3\n@someone',
    '',
  ])('rejects free text such as %j', (version) => {
    expect(HubBugReport.safeParse({ ...report, version }).success).toBe(false);
  });
});
