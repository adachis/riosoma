import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TELEMETRY_FEATURES,
  TELEMETRY_SIZES,
  TELEMETRY_USES,
  type TelemetryPayload,
} from '../../../packages/contracts/src/updates.js';
import type { HubBugReport } from '../../../packages/contracts/src/hub.js';

// Wrangler supplies Miniflare, so tests and local development run the same runtime.
const require = createRequire(import.meta.resolve('wrangler/package.json'));
interface Limiter {
  limit: number;
  period: number;
}
// Wrangler also reads the committed configuration here the way it does for a deployment.
const { unstable_readConfig: readConfig } = createRequire(import.meta.url)('wrangler') as {
  unstable_readConfig(options: { config: string }): {
    vars: Record<string, string>;
    ratelimits: Array<{ name: string; namespace_id: string; simple: Limiter }>;
  };
};
interface Runtime {
  dispatchFetch(url: string, init?: RequestInit): Promise<Response>;
  getD1Database(name: string): Promise<D1Database>;
  getR2Bucket(name: string): Promise<R2Bucket>;
  dispose(): Promise<void>;
}
const { Miniflare, Response: RuntimeResponse } = require('miniflare') as {
  Miniflare: new (options: unknown) => Runtime;
  Response: typeof Response;
};

let runtime: Runtime;
let db: D1Database;
const hits: Array<{ url: string; body: Record<string, unknown> }> = [];
let githubStatus = 201;
let githubResponseGate: Promise<void> | undefined;
let githubRequestStarted: (() => void) | undefined;
let githubToken: string;
let statsToken: string;
const issueUrl = 'https://github.com/adachis/riosoma/issues/42';

function previousWeek(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7) - 7);
  return date.toISOString().slice(0, 10);
}
const telemetry = (): TelemetryPayload => ({
  schema: 1,
  installId: crypto.randomUUID(),
  week: previousWeek(),
  version: '1.2.3',
  install: 'compose',
  databases: Object.fromEntries(TELEMETRY_SIZES.map((key) => [key, 1])) as TelemetryPayload['databases'],
  tables: Object.fromEntries(TELEMETRY_SIZES.map((key) => [key, 2])) as TelemetryPayload['tables'],
  features: Object.fromEntries(TELEMETRY_FEATURES.map((key) => [key, true])) as TelemetryPayload['features'],
  uses: Object.fromEntries(TELEMETRY_USES.map((key) => [key, '1-9'])) as TelemetryPayload['uses'],
});
const report = (fields: Partial<HubBugReport> = {}): HubBugReport => ({
  installId: crypto.randomUUID(),
  fingerprint: 'a'.repeat(64),
  version: '1.2.3',
  platform: 'Linux',
  title: 'Grid freezes',
  description: 'Pasting several rows freezes the grid.',
  ...fields,
});
const post = (path: string, payload: unknown, address?: string) =>
  runtime.dispatchFetch(`https://hub.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(address ? { 'cf-connecting-ip': address } : {}) },
    body: JSON.stringify(payload),
  });

/** A null limiter leaves the binding out, as a deployment whose configuration lacks it would. */
async function initialize(
  overrides: Record<string, string | undefined> = {},
  limiter: Limiter | null = { limit: 10_000, period: 60 },
) {
  hits.length = 0;
  githubStatus = 201;
  githubResponseGate = undefined;
  githubRequestStarted = undefined;
  githubToken = crypto.randomUUID();
  statsToken = crypto.randomUUID();
  runtime = new Miniflare({
    modules: true,
    scriptPath: fileURLToPath(new URL('../dist/index.js', import.meta.url)),
    compatibilityDate: '2026-07-30',
    d1Databases: ['STATS'],
    r2Buckets: ['FEED'],
    ...(limiter ? { ratelimits: { WRITE_LIMITER: { namespace_id: '1001', simple: limiter } } } : {}),
    bindings: Object.fromEntries(
      Object.entries({
        GITHUB_TOKEN: githubToken,
        STATS_TOKEN: statsToken,
        BUG_REPORTS_PER_INSTALL_DAY: '10',
        BUG_NEW_ISSUES_PER_DAY: '100',
        ...overrides,
      }).filter(([, value]) => value !== undefined),
    ),
    outboundService: async (request: Request) => {
      // Every outbound request ends here, including unexpected URLs.  No real network API is contacted.
      const value = (await request.json()) as Record<string, unknown>;
      hits.push({ url: request.url, body: value });
      expect(new URL(request.url).hostname).toBe('api.github.com');
      expect(request.headers.get('authorization')).toBe(`Bearer ${githubToken}`);
      githubRequestStarted?.();
      await githubResponseGate;
      return new RuntimeResponse(JSON.stringify({ number: 42, html_url: issueUrl }), {
        status: githubStatus,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  db = await runtime.getD1Database('STATS');
  const folder = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(folder)).sort()) {
    const migration = await readFile(new URL(name, folder), 'utf8');
    await db.batch(
      migration
        .split(';')
        .filter((sql) => sql.trim())
        .map((sql) => db.prepare(sql)),
    );
  }
}
beforeEach(async () => {
  await clearOfUtcMidnight();
  await initialize();
});
afterEach(async () => {
  await runtime?.dispose();
});

/** The local limiter counts in clock-aligned minutes, so begin early enough in one to finish inside it. */
async function startOfMinute() {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 10_000) await new Promise((resolve) => setTimeout(resolve, left + 50));
}

/** The test and worker read separate clocks, so keep every request and computed day or week on one UTC day. */
async function clearOfUtcMidnight() {
  const left = 86_400_000 - (Date.now() % 86_400_000);
  if (left <= 15_000) await new Promise((resolve) => setTimeout(resolve, left + 50));
}
const numbered = (index: number) => report({ fingerprint: index.toString(16).padStart(64, '0') });

describe('service and feed', () => {
  it('names the service, answers health, and rejects unrecognized paths and methods', async () => {
    expect(await (await runtime.dispatchFetch('https://hub.test/')).text()).toBe('Riosoma hub\n');
    expect(await (await runtime.dispatchFetch('https://hub.test/health')).text()).toBe('ok\n');
    expect((await runtime.dispatchFetch('https://hub.test/missing')).status).toBe(404);
    expect((await post('/updates.json', {})).status).toBe(404);
  });
  it('returns 404 before a release and streams the latest envelope unchanged with cache headers and ETag', async () => {
    expect((await runtime.dispatchFetch('https://hub.test/updates.json')).status).toBe(404);
    const bucket = await runtime.getR2Bucket('FEED');
    const envelope = JSON.stringify({ payload: '{"schema":1}', keyId: 'release', signature: 'signed' });
    await bucket.put('updates.json', envelope);
    const response = await runtime.dispatchFetch('https://hub.test/updates.json');
    expect(await response.text()).toBe(envelope);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('content-type')).toBe('application/json');
    const etag = response.headers.get('etag')!;
    expect(etag).toMatch(/^".+"$/);
    expect(
      (await runtime.dispatchFetch('https://hub.test/updates.json', { headers: { 'if-none-match': etag } }))
        .status,
    ).toBe(304);
    await bucket.put('updates.json', 'new-envelope');
    expect(await (await runtime.dispatchFetch('https://hub.test/updates.json')).text()).toBe('new-envelope');
  });
});

describe('weekly telemetry', () => {
  it('replaces one install/week and keeps other installs and weeks, without request metadata', async () => {
    const payload = telemetry();
    expect((await post('/telemetry', payload)).status).toBe(204);
    expect((await post('/telemetry', { ...payload, version: '2.0.0' })).status).toBe(204);
    expect((await post('/telemetry', telemetry())).status).toBe(204);
    expect((await post('/telemetry', { ...payload, week: '2026-01-05' })).status).toBe(204);
    const rows = await db.prepare('SELECT * FROM telemetry').all<{ payload: string }>();
    expect(rows.results).toHaveLength(3);
    expect(rows.results.some((row) => JSON.parse(row.payload).version === '2.0.0')).toBe(true);
    expect(Object.keys(rows.results[0]!)).toEqual(['install_id', 'week', 'payload']);
  });
  it('rejects extra fields, missing maps, malformed dates, invalid identifiers, ranges, and counts', async () => {
    const valid = telemetry();
    for (const invalid of [
      null,
      [],
      { ...valid, ip: '127.0.0.1' },
      { ...valid, features: {} },
      { ...valid, databases: { ...valid.databases, private: 2 } },
      { ...valid, installId: 'not-a-uuid' },
      { ...valid, week: '2026-10-02' },
      { ...valid, week: '2026-02-30' },
      { ...valid, tables: { ...valid.tables, '0': -1 } },
      { ...valid, uses: { ...valid.uses, bookings: 'lots' } },
      { ...valid, version: 'private-build-name' },
    ]) {
      expect((await post('/telemetry', invalid)).status).toBe(400);
    }
    expect((await db.prepare('SELECT count(*) AS n FROM telemetry').first<{ n: number }>())?.n).toBe(0);
  });
  it('enforces the 32 KB cap on bytes, including streamed bodies without Content-Length', async () => {
    const text = JSON.stringify(telemetry());
    const padded = text + ' '.repeat(32 * 1024 - Buffer.byteLength(text));
    expect(
      (await runtime.dispatchFetch('https://hub.test/telemetry', { method: 'POST', body: padded })).status,
    ).toBe(204);
    expect(
      (await runtime.dispatchFetch('https://hub.test/telemetry', { method: 'POST', body: padded + ' ' }))
        .status,
    ).toBe(413);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('é'.repeat(17_000)));
        controller.close();
      },
    });
    expect(
      (
        await runtime.dispatchFetch('https://hub.test/telemetry', {
          method: 'POST',
          body: stream,
          duplex: 'half',
        } as RequestInit)
      ).status,
    ).toBe(413);
  });
});

describe('upstream bugs', () => {
  it('rejects named credentials before storing or publishing a report', async () => {
    for (const key of ['access_token', 'refresh_token', 'client_secret']) {
      const credential = crypto.randomUUID().replace(/[0-9-]/g, 'x');
      expect((await post('/bugs', report({ description: `${key}=${credential}` }))).status).toBe(400);
    }
    expect(hits).toHaveLength(0);
    expect(await db.prepare('SELECT count(*) AS n FROM bug_reports').first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT count(*) AS n FROM bug_install_days').first()).toEqual({ n: 0 });
  });
  it('refreshes a concurrent pending issue without adding reports, quota usage, versions, or comments', async () => {
    let release!: () => void;
    githubResponseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      githubRequestStarted = resolve;
    });
    const payload = report();
    const first = post('/bugs', payload);
    try {
      await started;
      expect((await post('/bugs', report({ version: '2.0.0' }))).status).toBe(202);
      const lookup = () => runtime.dispatchFetch(`https://hub.test/bugs/${payload.fingerprint}`);
      const pending = await lookup();
      expect(pending.status).toBe(202);
      expect(await pending.json()).toEqual({ issueUrl: null });
      release();
      expect(await (await first).json()).toEqual({ issueUrl });
      await db.prepare("UPDATE bug_reports SET last_comment_day = '2026-01-01'").run();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const filed = await lookup();
        expect(filed.status).toBe(200);
        expect(await filed.json()).toEqual({ issueUrl });
        expect(filed.headers.get('cache-control')).toBe('no-store');
      }
      expect(hits).toHaveLength(1);
      expect(await db.prepare('SELECT count FROM bug_reports').first()).toEqual({ count: 2 });
      expect(
        await db
          .prepare('SELECT count FROM bug_install_days WHERE install_id = ?')
          .bind(payload.installId)
          .first(),
      ).toEqual({ count: 1 });
      expect(await db.prepare('SELECT count FROM bug_issue_days').first()).toEqual({ count: 1 });
      expect((await db.prepare('SELECT version FROM bug_versions').all()).results).toHaveLength(2);
      expect((await runtime.dispatchFetch(`https://hub.test/bugs/${'b'.repeat(64)}`)).status).toBe(404);
      expect((await runtime.dispatchFetch('https://hub.test/bugs/invalid')).status).toBe(404);
    } finally {
      release();
      await first;
    }
  });
  it('honors configurable limits, including zero, and stores reports without a GitHub secret', async () => {
    await runtime.dispose();
    await initialize({ BUG_REPORTS_PER_INSTALL_DAY: '2', BUG_NEW_ISSUES_PER_DAY: '0' });
    const payload = report();
    expect((await post('/bugs', payload)).status).toBe(202);
    expect((await post('/bugs', payload)).status).toBe(202);
    expect((await post('/bugs', payload)).status).toBe(429);
    expect(hits).toHaveLength(0);
    await runtime.dispose();
    await initialize({ GITHUB_TOKEN: undefined });
    expect((await post('/bugs', report())).status).toBe(202);
    expect((await db.prepare('SELECT state FROM bug_reports').first())?.state).toBe('queued');
    expect(hits).toHaveLength(0);
    await runtime.dispose();
    await initialize({ BUG_REPORTS_PER_INSTALL_DAY: '0' });
    expect((await post('/bugs', report())).status).toBe(429);
  });
  it('files once with the labels, dedupes concurrent fingerprints and accumulates versions', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) => post('/bugs', report({ version: `1.2.${index}` }))),
    );
    expect(responses.every((response) => [200, 202].includes(response.status))).toBe(true);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.body).toMatchObject({ title: 'Grid freezes', labels: ['bug', 'from-installs'] });
    expect((await post('/bugs', report())).status).toBe(200);
    expect(await (await post('/bugs', report())).json()).toEqual({ issueUrl });
    expect(hits).toHaveLength(1);
    expect(await db.prepare('SELECT count FROM bug_reports').first()).toEqual({ count: 7 });
    expect((await db.prepare('SELECT version FROM bug_versions').all()).results).toHaveLength(5);
  });
  it('claims at most one daily comment per fingerprint, including concurrent reports', async () => {
    await post('/bugs', report());
    await db.prepare("UPDATE bug_reports SET last_comment_day = '2026-01-01'").run();
    await Promise.all([
      post('/bugs', report({ version: '2.0.0' })),
      post('/bugs', report({ version: '3.0.0' })),
    ]);
    expect(hits).toHaveLength(2);
    expect(hits[1]?.url).toMatch(/\/42\/comments$/);
    expect(hits[1]?.body.body).toContain('Reports:');
    expect(hits[1]?.body.body).toContain('2.0.0');
    await post('/bugs', report());
    expect(hits).toHaveLength(2);
  });
  it('allows ten reports per install per UTC day and cannot race past the limit', async () => {
    const payload = report();
    const responses = await Promise.all(Array.from({ length: 12 }, () => post('/bugs', payload)));
    expect(responses.filter((response) => response.status === 429)).toHaveLength(2);
    expect((await db.prepare('SELECT count FROM bug_reports').first())?.count).toBe(10);
    await db.prepare('DELETE FROM bug_install_days').run();
    expect((await post('/bugs', payload)).status).toBe(200);
  });
  it('stores fingerprints beyond the global daily cap and can file them on a later day', async () => {
    const day = new Date().toISOString().slice(0, 10);
    await db.prepare('INSERT INTO bug_issue_days VALUES (?, 99)').bind(day).run();
    const payloads = [report({ fingerprint: 'b'.repeat(64) }), report({ fingerprint: 'c'.repeat(64) })];
    const responses = await Promise.all(payloads.map((payload) => post('/bugs', payload)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 202]);
    expect(hits).toHaveLength(1);
    expect((await db.prepare('SELECT count FROM bug_issue_days').first())?.count).toBe(100);
    const queued = await db
      .prepare("SELECT fingerprint FROM bug_reports WHERE state = 'queued'")
      .first<{ fingerprint: string }>();
    await db.prepare('DELETE FROM bug_issue_days').run();
    // A lookup never files a queued report, even with a slot free.  Only another report does.
    const lookup = await runtime.dispatchFetch(`https://hub.test/bugs/${queued!.fingerprint}`);
    expect(lookup.status).toBe(202);
    expect(await lookup.json()).toEqual({ issueUrl: null });
    expect(hits).toHaveLength(1);
    expect((await post('/bugs', report({ fingerprint: queued!.fingerprint }))).status).toBe(200);
    expect(hits).toHaveLength(2);
  });
  it('holds ambiguous GitHub failures for review and never refiles them automatically', async () => {
    githubStatus = 500;
    expect((await post('/bugs', report())).status).toBe(502);
    githubStatus = 201;
    expect((await post('/bugs', report())).status).toBe(202);
    expect(hits).toHaveLength(1);
    expect((await db.prepare('SELECT state FROM bug_reports').first())?.state).toBe('review');
  });
  it('rejects screenshots, identifiers, unredacted values, and invalid fields', async () => {
    const valid = report();
    for (const invalid of [
      { ...valid, screenshot: 'data:image/png;base64,AA==' },
      { ...valid, fingerprint: 'free-text' },
      { ...valid, description: 'Email person@example.com' },
      { ...valid, description: 'https://private.test?q=secret' },
      { ...valid, title: 'password=private' },
      { ...valid, platform: '127.0.0.1' },
      { ...valid, description: '"record value"' },
      { ...valid, description: '' },
      { ...valid, installId: 'organization-name' },
    ])
      expect((await post('/bugs', invalid)).status).toBe(400);
    expect(hits).toHaveLength(0);
  });
  it('publishes the description and context only inside code blocks, so mentions and links stay plain text', async () => {
    const description = '@someone see other/repo#1 and www.example.test\n# Urgent\n[open](//example.test/p)';
    const platform = '@team Linux';
    expect((await post('/bugs', report({ description, platform }))).status).toBe(200);
    expect(hits[0]?.body.body).toBe(
      [
        '```text',
        description,
        '```',
        '',
        '```text',
        'Version: 1.2.3',
        `Platform: ${platform}`,
        `Fingerprint: ${'a'.repeat(64)}`,
        '```',
      ].join('\n'),
    );
  });
  it('fences reports and versions stored earlier, whatever backticks or text they hold', async () => {
    const fingerprint = 'd'.repeat(64);
    const stored = '```\n@someone\n```';
    await db
      .prepare('INSERT INTO bug_reports (fingerprint, title, description, platform) VALUES (?, ?, ?, ?)')
      .bind(fingerprint, 'Grid freezes', stored, 'Linux')
      .run();
    await db
      .prepare('INSERT INTO bug_versions (fingerprint, version) VALUES (?, ?)')
      .bind(fingerprint, '@someone www.example.test')
      .run();
    expect((await post('/bugs', report({ fingerprint }))).status).toBe(200);
    expect(String(hits[0]?.body.body).split('\n').slice(0, 6)).toEqual([
      '````text',
      '```',
      '@someone',
      '```',
      '````',
      '',
    ]);
    await db.prepare("UPDATE bug_reports SET last_comment_day = '2026-01-01'").run();
    expect((await post('/bugs', report({ fingerprint }))).status).toBe(200);
    expect(hits[1]?.body.body).toBe(
      '```text\nReports: 3\nVersions seen: 1.2.3, @someone www.example.test\n```',
    );
  });
  it('accepts a release version or custom as the version, and never free text', async () => {
    for (const version of [
      '@someone',
      'see www.example.test',
      'other/repo#1',
      '1.2',
      '1.2.3-nightly',
      '1.2.3 @someone',
    ])
      expect((await post('/bugs', report({ version }))).status).toBe(400);
    expect(hits).toHaveLength(0);
    expect(await db.prepare('SELECT count(*) AS n FROM bug_reports').first()).toEqual({ n: 0 });
    for (const version of ['custom', '0.95.0', '1.2.3-rc.1', '0.1.0-dev'])
      expect((await post('/bugs', report({ version }))).status).toBe(200);
    expect(await db.prepare('SELECT count(*) AS n FROM bug_versions').first()).toEqual({ n: 4 });
  });
  it('keeps at most twenty versions for a fingerprint and still counts later reports', async () => {
    for (let index = 0; index < 22; index += 1)
      expect((await post('/bugs', report({ version: `1.0.${index}` }))).status).toBe(200);
    expect(await db.prepare('SELECT count(*) AS n FROM bug_versions').first()).toEqual({ n: 20 });
    expect(await db.prepare('SELECT count FROM bug_reports').first()).toEqual({ count: 22 });
  });
  it('caps comments across every issue per UTC day, including zero, and leaves the rest for a later day', async () => {
    await runtime.dispose();
    await initialize({ BUG_COMMENTS_PER_DAY: '1' });
    const fingerprints = ['b'.repeat(64), 'c'.repeat(64)];
    for (const fingerprint of fingerprints) await post('/bugs', report({ fingerprint }));
    await db.prepare("UPDATE bug_reports SET last_comment_day = '2026-01-01'").run();
    hits.length = 0;
    for (const fingerprint of fingerprints)
      expect((await post('/bugs', report({ fingerprint }))).status).toBe(200);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.url).toMatch(/\/42\/comments$/);
    expect(
      await db.prepare("SELECT fingerprint FROM bug_reports WHERE last_comment_day = '2026-01-01'").first(),
    ).toEqual({ fingerprint: fingerprints[1] });
    await db.prepare('DELETE FROM bug_comment_days').run();
    expect((await post('/bugs', report({ fingerprint: fingerprints[1] }))).status).toBe(200);
    expect(hits).toHaveLength(2);
    await runtime.dispose();
    await initialize({ BUG_COMMENTS_PER_DAY: '0' });
    await post('/bugs', report());
    await db.prepare("UPDATE bug_reports SET last_comment_day = '2026-01-01'").run();
    expect((await post('/bugs', report())).status).toBe(200);
    expect(hits).toHaveLength(1);
  });
  it('enforces the 16 KB cap on bytes and accepts the exact boundary', async () => {
    const text = JSON.stringify(report());
    const padded = text + ' '.repeat(16 * 1024 - Buffer.byteLength(text));
    expect(
      (await runtime.dispatchFetch('https://hub.test/bugs', { method: 'POST', body: padded })).status,
    ).toBe(200);
    expect(
      (await runtime.dispatchFetch('https://hub.test/bugs', { method: 'POST', body: padded + ' ' })).status,
    ).toBe(413);
  });
});

describe('address throttle', () => {
  it('limits bug reports per network address, whatever install ID and fingerprint each one names', async () => {
    await runtime.dispose();
    await initialize({}, { limit: 2, period: 60 });
    await startOfMinute();
    expect((await post('/bugs', numbered(1), '203.0.113.7')).status).toBe(200);
    expect((await post('/bugs', numbered(2), '203.0.113.7')).status).toBe(200);
    expect((await post('/bugs', numbered(3), '203.0.113.7')).status).toBe(429);
    expect((await post('/bugs', { invalid: true }, '203.0.113.7')).status).toBe(429);
    expect(hits).toHaveLength(2);
    expect(await db.prepare('SELECT count(*) AS n FROM bug_reports').first()).toEqual({ n: 2 });
    expect(await db.prepare('SELECT count(*) AS n FROM bug_install_days').first()).toEqual({ n: 2 });
    expect((await post('/bugs', numbered(4), '203.0.113.8')).status).toBe(200);
    expect((await runtime.dispatchFetch(`https://hub.test/bugs/${numbered(1).fingerprint}`)).status).toBe(
      200,
    );
  });
  it('counts a whole IPv6 /64 as one address', async () => {
    await runtime.dispose();
    await initialize({}, { limit: 2, period: 60 });
    await startOfMinute();
    expect((await post('/bugs', numbered(1), '2001:db8:1:2::1')).status).toBe(200);
    expect((await post('/bugs', numbered(2), '2001:db8:1:2:ffff:0:0:9')).status).toBe(200);
    expect((await post('/bugs', numbered(3), '2001:DB8:1:2:aaaa::9')).status).toBe(429);
    expect((await post('/bugs', numbered(4), '2001:0db8:0001:0002::5')).status).toBe(429);
    expect((await post('/bugs', numbered(5), '2001:db8:1:3::1')).status).toBe(200);
    expect((await post('/bugs', numbered(6), '2001:db8:1::2:1')).status).toBe(200);
  });
  it('limits usage counts per network address, apart from bug reports', async () => {
    await runtime.dispose();
    await initialize({}, { limit: 2, period: 60 });
    await startOfMinute();
    expect((await post('/bugs', numbered(1), '203.0.113.7')).status).toBe(200);
    expect((await post('/telemetry', telemetry(), '203.0.113.7')).status).toBe(204);
    expect((await post('/telemetry', telemetry(), '203.0.113.7')).status).toBe(204);
    expect((await post('/telemetry', telemetry(), '203.0.113.7')).status).toBe(429);
    expect(await db.prepare('SELECT count(*) AS n FROM telemetry').first()).toEqual({ n: 2 });
    expect((await post('/telemetry', telemetry(), '203.0.113.8')).status).toBe(204);
  });
  it('refuses reports and usage counts when the limiter binding is missing, and stores nothing', async () => {
    await runtime.dispose();
    await initialize({}, null);
    expect((await post('/bugs', report(), '203.0.113.7')).status).toBe(503);
    expect((await post('/telemetry', telemetry(), '203.0.113.7')).status).toBe(503);
    expect(hits).toHaveLength(0);
    expect(await db.prepare('SELECT count(*) AS n FROM bug_reports').first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT count(*) AS n FROM telemetry').first()).toEqual({ n: 0 });
    expect((await runtime.dispatchFetch('https://hub.test/health')).status).toBe(200);
  });
});

describe('shipped limits', () => {
  const address = (index: number) => `203.0.113.${index}`;
  const queued = () => db.prepare("SELECT count(*) AS n FROM bug_reports WHERE state = 'queued'").first();
  /** Filed on an earlier day, so each one is due a comment today. */
  async function filedEarlier(total: number) {
    await db.batch(
      Array.from({ length: total }, (_, index) =>
        db
          .prepare(
            `INSERT INTO bug_reports (fingerprint, title, description, platform, state, issue_number, issue_url, last_comment_day)
          VALUES (?, 'Grid freezes', 'Grid freezes', 'Linux', 'filed', 42, ?, '2026-01-01')`,
          )
          .bind(numbered(1_000 + index).fingerprint, issueUrl),
      ),
    );
  }

  it('runs the committed configuration: five reports a minute per address, 20 new issues and 50 comments a day', async () => {
    const config = readConfig({ config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)) });
    expect(config.ratelimits).toEqual([
      { name: 'WRITE_LIMITER', namespace_id: '1001', simple: { limit: 5, period: 60 } },
    ]);
    expect(config.vars).toEqual({
      BUG_REPORTS_PER_INSTALL_DAY: '10',
      BUG_NEW_ISSUES_PER_DAY: '20',
      BUG_COMMENTS_PER_DAY: '50',
    });
    await runtime.dispose();
    await initialize(
      { BUG_REPORTS_PER_INSTALL_DAY: undefined, BUG_NEW_ISSUES_PER_DAY: undefined, ...config.vars },
      config.ratelimits[0]!.simple,
    );
    await startOfMinute();
    for (let index = 1; index <= 5; index += 1)
      expect((await post('/bugs', numbered(index), address(1))).status).toBe(200);
    expect((await post('/bugs', numbered(6), address(1))).status).toBe(429);
    for (let index = 6; index <= 20; index += 1)
      expect((await post('/bugs', numbered(index), address(index))).status).toBe(200);
    const beyond = await post('/bugs', numbered(21), address(21));
    expect(beyond.status).toBe(202);
    expect(await beyond.json()).toEqual({ issueUrl: null });
    expect(hits).toHaveLength(20);
    expect(await queued()).toEqual({ n: 1 });
    await filedEarlier(51);
    hits.length = 0;
    for (let index = 0; index < 51; index += 1)
      expect((await post('/bugs', numbered(1_000 + index), address(100 + index))).status).toBe(200);
    expect(hits).toHaveLength(50);
    expect(hits.every((hit) => hit.url.endsWith('/42/comments'))).toBe(true);
  });
  it('keeps the same daily caps when no variable sets them', async () => {
    await runtime.dispose();
    await initialize({ BUG_REPORTS_PER_INSTALL_DAY: undefined, BUG_NEW_ISSUES_PER_DAY: undefined });
    for (let index = 1; index <= 20; index += 1)
      expect((await post('/bugs', numbered(index))).status).toBe(200);
    expect((await post('/bugs', numbered(21))).status).toBe(202);
    expect(hits).toHaveLength(20);
    expect(await queued()).toEqual({ n: 1 });
    await filedEarlier(51);
    hits.length = 0;
    for (let index = 0; index < 51; index += 1)
      expect((await post('/bugs', numbered(1_000 + index))).status).toBe(200);
    expect(hits).toHaveLength(50);
    const repeated = numbered(1);
    for (let attempt = 1; attempt <= 10; attempt += 1)
      expect((await post('/bugs', repeated)).status).toBe(200);
    expect((await post('/bugs', repeated)).status).toBe(429);
  });
});

describe('maintainer statistics', () => {
  it('fails closed when the stats secret is absent', async () => {
    await runtime.dispose();
    await initialize({ STATS_TOKEN: undefined });
    expect(
      (
        await runtime.dispatchFetch('https://hub.test/stats', {
          headers: { authorization: 'Bearer undefined' },
        })
      ).status,
    ).toBe(401);
  });
  it('requires the exact bearer token, and reports aggregates for the completed week without install IDs', async () => {
    for (const token of ['', 'Bearer wrong', `bearer ${statsToken}`, `Bearer ${statsToken}-extra`])
      expect(
        (await runtime.dispatchFetch('https://hub.test/stats', { headers: { authorization: token } })).status,
      ).toBe(401);
    const payload = telemetry();
    await post('/telemetry', payload);
    await post('/telemetry', { ...telemetry(), version: '2.0.0', install: 'helm' });
    await post('/telemetry', { ...telemetry(), week: '2026-01-05' });
    const response = await runtime.dispatchFetch('https://hub.test/stats', {
      headers: { authorization: `Bearer ${statsToken}` },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      installs: 2,
      versions: { '1.2.3': 1, '2.0.0': 1 },
      platforms: { compose: 1, helm: 1 },
    });
    expect(JSON.parse(text).features.automations).toBe(2);
    expect(text).not.toContain(payload.installId);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
