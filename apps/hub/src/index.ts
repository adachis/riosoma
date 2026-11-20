import { HubBugReport } from '../../../packages/contracts/src/hub.js';
import { TelemetryPayload, TELEMETRY_FEATURES } from '../../../packages/contracts/src/updates.js';
import { message } from './messages.js';

export interface Env {
  FEED: R2Bucket;
  STATS: D1Database;
  WRITE_LIMITER: RateLimit;
  GITHUB_TOKEN?: string;
  STATS_TOKEN?: string;
  BUG_REPORTS_PER_INSTALL_DAY?: string;
  BUG_NEW_ISSUES_PER_DAY?: string;
  BUG_COMMENTS_PER_DAY?: string;
}

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const empty = (status: number) => new Response(null, { status, headers: { 'cache-control': 'no-store' } });

/** Read incrementally: Content-Length may be absent or false, and UTF-8 can use several bytes. */
async function body(request: Request, cap: number): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > cap) throw 413;
  if (!request.body) throw 400;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > cap) {
        await reader.cancel();
        throw 413;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw error === 413 ? 413 : 400;
  } finally {
    reader.releaseLock();
  }
}

function limit(value: string | undefined, fallback: number): number {
  return value !== undefined && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : fallback;
}

/** Hash both inputs to fixed-size buffers before the runtime's timing-safe comparison. */
async function authorized(request: Request, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const encoder = new TextEncoder();
  const supplied = request.headers.get('authorization') ?? '';
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(supplied)),
    crypto.subtle.digest('SHA-256', encoder.encode(`Bearer ${token}`)),
  ]);
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean };
  return subtle.timingSafeEqual(actual, expected);
}

/** One caller holds a whole IPv6 /64, so that prefix stands for the address.  IPv4 stays as it is. */
function network(address: string): string {
  if (!address.includes(':')) return address;
  const [head = '', tail] = address.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':');
}

/**
 * Install IDs are chosen by the caller, so anonymous writes are also counted per network address.
 * The limiter keeps its counters in memory, and the address never reaches storage.
 */
async function throttled(request: Request, env: Env, route: string): Promise<boolean> {
  const address = request.headers.get('cf-connecting-ip') ?? '';
  return !(await env.WRITE_LIMITER.limit({ key: `${route}:${network(address)}` })).success;
}

/**
 * Relayed text is published only as a code block, where mentions, references, links, and Markdown
 * stay plain text.  The fence is longer than any run of backticks inside, so nothing can close it.
 */
function fenced(text: string): string {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

const GITHUB = 'https://api.github.com/repos/adachis/riosoma/issues';
/** Bounds the daily comment on an issue, whatever number of versions its reports name. */
const VERSIONS_PER_FINGERPRINT = 20;

async function github(env: Env, path: string, value: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${GITHUB}${path}`, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'Riosoma-Hub',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify(value),
  });
  if (response.status !== 201) {
    await response.body?.cancel();
    throw 502;
  }
  const result = await body(
    new Request('https://response.invalid', { method: 'POST', body: response.body }),
    32 * 1024,
  );
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw 502;
  return result as Record<string, unknown>;
}

interface BugRow {
  count: number;
  state: string;
  title: string;
  description: string;
  platform: string;
  issue_number: number | null;
  issue_url: string | null;
}

async function bugs(request: Request, env: Env): Promise<Response> {
  if (await throttled(request, env, 'bugs')) return empty(429);
  const parsed = HubBugReport.safeParse(await body(request, 16 * 1024));
  if (!parsed.success) return empty(400);
  const report = parsed.data;
  const day = new Date().toISOString().slice(0, 10);
  const db = env.STATS;
  const quota = await db
    .prepare(
      `INSERT INTO bug_install_days (install_id, day, count)
    SELECT ?, ?, 1 WHERE ? > 0
    ON CONFLICT (install_id, day) DO UPDATE SET count = count + 1 WHERE count < ?
    RETURNING count`,
    )
    .bind(
      report.installId,
      day,
      limit(env.BUG_REPORTS_PER_INSTALL_DAY, 10),
      limit(env.BUG_REPORTS_PER_INSTALL_DAY, 10),
    )
    .first();
  if (!quota) return empty(429);
  await db.batch([
    db
      .prepare(
        `INSERT INTO bug_reports (fingerprint, title, description, platform) VALUES (?, ?, ?, ?)
      ON CONFLICT (fingerprint) DO UPDATE SET count = count + 1`,
      )
      .bind(report.fingerprint, report.title, report.description, report.platform),
    db
      .prepare(
        `INSERT OR IGNORE INTO bug_versions (fingerprint, version)
      SELECT ?, ? WHERE (SELECT count(*) FROM bug_versions WHERE fingerprint = ?) < ?`,
      )
      .bind(report.fingerprint, report.version, report.fingerprint, VERSIONS_PER_FINGERPRINT),
    db.prepare('DELETE FROM bug_install_days WHERE day < ?').bind(day),
    db.prepare('DELETE FROM bug_issue_days WHERE day < ?').bind(day),
    db.prepare('DELETE FROM bug_comment_days WHERE day < ?').bind(day),
  ]);
  if (env.GITHUB_TOKEN) {
    const claim = crypto.randomUUID();
    // The claim and daily slot share a transaction, so concurrent requests cannot file twice or exceed the cap.
    const claimed = await db.batch([
      db
        .prepare(
          `UPDATE bug_reports SET state = 'filing', claim = ? WHERE fingerprint = ? AND state = 'queued'
        AND COALESCE((SELECT count FROM bug_issue_days WHERE day = ?), 0) < ? RETURNING title, description, platform`,
        )
        .bind(claim, report.fingerprint, day, limit(env.BUG_NEW_ISSUES_PER_DAY, 20)),
      db
        .prepare(
          `INSERT INTO bug_issue_days (day, count) SELECT ?, 1
        WHERE EXISTS (SELECT 1 FROM bug_reports WHERE fingerprint = ? AND claim = ?)
        ON CONFLICT (day) DO UPDATE SET count = count + 1`,
        )
        .bind(day, report.fingerprint, claim),
    ]);
    const first = claimed[0]!.results[0] as Pick<BugRow, 'title' | 'description' | 'platform'> | undefined;
    if (first) {
      try {
        const issue = await github(env, '', {
          title: first.title,
          body: `${fenced(first.description)}\n\n${fenced(message('hub.issue.context', { version: report.version, platform: first.platform, fingerprint: report.fingerprint }))}`,
          labels: ['bug', 'from-installs'],
        });
        if (
          !Number.isSafeInteger(issue.number) ||
          Number(issue.number) < 1 ||
          issue.html_url !== `https://github.com/adachis/riosoma/issues/${issue.number}`
        )
          throw 502;
        await db
          .prepare(
            `UPDATE bug_reports SET state = 'filed', issue_number = ?, issue_url = ?, last_comment_day = ?
          WHERE fingerprint = ? AND claim = ?`,
          )
          .bind(issue.number, issue.html_url, day, report.fingerprint, claim)
          .run();
      } catch {
        // GitHub may have accepted a request whose answer was lost. Leave it for review instead of risking another issue.
        await db
          .prepare("UPDATE bug_reports SET state = 'review' WHERE fingerprint = ? AND claim = ?")
          .bind(report.fingerprint, claim)
          .run();
        return empty(502);
      }
    }
    const commentClaim = crypto.randomUUID();
    // The claim and daily slot share a transaction here too, so comments across every issue stay under the cap.
    const commented = await db.batch([
      db
        .prepare(
          `UPDATE bug_reports SET last_comment_day = ?, claim = ?
        WHERE fingerprint = ? AND state = 'filed' AND last_comment_day < ?
        AND COALESCE((SELECT count FROM bug_comment_days WHERE day = ?), 0) < ? RETURNING issue_number, count`,
        )
        .bind(day, commentClaim, report.fingerprint, day, day, limit(env.BUG_COMMENTS_PER_DAY, 50)),
      db
        .prepare(
          `INSERT INTO bug_comment_days (day, count) SELECT ?, 1
        WHERE EXISTS (SELECT 1 FROM bug_reports WHERE fingerprint = ? AND claim = ?)
        ON CONFLICT (day) DO UPDATE SET count = count + 1`,
        )
        .bind(day, report.fingerprint, commentClaim),
    ]);
    const comment = commented[0]!.results[0] as { issue_number: number; count: number } | undefined;
    if (comment) {
      const versions = await db
        .prepare('SELECT version FROM bug_versions WHERE fingerprint = ? ORDER BY version')
        .bind(report.fingerprint)
        .all<{ version: string }>();
      try {
        await github(env, `/${comment.issue_number}/comments`, {
          body: fenced(
            message('hub.issue.count', {
              count: comment.count,
              versions: versions.results.map((entry) => entry.version).join(', '),
            }),
          ),
        });
      } catch {
        return empty(502);
      }
    }
  }
  const row = await db
    .prepare('SELECT issue_url FROM bug_reports WHERE fingerprint = ?')
    .bind(report.fingerprint)
    .first<{ issue_url: string | null }>();
  return json({ issueUrl: row?.issue_url ?? null }, row?.issue_url ? 200 : 202);
}

function reportingWeek(): string {
  const monday = new Date();
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 7);
  return monday.toISOString().slice(0, 10);
}

async function stats(request: Request, env: Env): Promise<Response> {
  if (!(await authorized(request, env.STATS_TOKEN))) return empty(401);
  // Installs send the completed week on this week's Monday.
  const week = reportingWeek();
  const totals = await env.STATS.prepare(`SELECT count(*) AS installs FROM telemetry WHERE week = ?`)
    .bind(week)
    .first<{ installs: number }>();
  const group = async (field: 'version' | 'install') => {
    const rows = await env.STATS.prepare(
      `SELECT json_extract(payload, '$.${field}') AS name, count(*) AS count
      FROM telemetry WHERE week = ? GROUP BY name ORDER BY name`,
    )
      .bind(week)
      .all<{ name: string; count: number }>();
    return Object.fromEntries(rows.results.map((row) => [row.name, row.count]));
  };
  const columns = TELEMETRY_FEATURES.map(
    (feature) => `COALESCE(sum(json_extract(payload, '$.features.${feature}')), 0) AS "${feature}"`,
  ).join(', ');
  const features = await env.STATS.prepare(`SELECT ${columns} FROM telemetry WHERE week = ?`)
    .bind(week)
    .first();
  return json({
    week,
    installs: totals?.installs ?? 0,
    versions: await group('version'),
    platforms: await group('install'),
    features,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && (path === '/' || path === '/health'))
        return new Response(message(path === '/' ? 'hub.name' : 'hub.health'), {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        });
      if (request.method === 'GET' && path === '/updates.json') {
        const feed = await env.FEED.get('updates.json');
        if (!feed) return empty(404);
        const headers = {
          'content-type': 'application/json',
          'cache-control': 'public, max-age=300',
          etag: feed.httpEtag,
        };
        if (request.headers.get('if-none-match') === feed.httpEtag)
          return new Response(null, { status: 304, headers });
        return new Response(feed.body, { headers });
      }
      if (request.method === 'POST' && path === '/telemetry') {
        if (await throttled(request, env, 'telemetry')) return empty(429);
        const parsed = TelemetryPayload.safeParse(await body(request, 32 * 1024));
        if (!parsed.success) return empty(400);
        await env.STATS.prepare(
          `INSERT INTO telemetry (install_id, week, payload) VALUES (?, ?, ?)
          ON CONFLICT (install_id, week) DO UPDATE SET payload = excluded.payload`,
        )
          .bind(parsed.data.installId, parsed.data.week, JSON.stringify(parsed.data))
          .run();
        return empty(204);
      }
      if (request.method === 'POST' && path === '/bugs') return await bugs(request, env);
      if (request.method === 'GET' && /^\/bugs\/[a-f0-9]{64}$/.test(path)) {
        const row = await env.STATS.prepare('SELECT issue_url FROM bug_reports WHERE fingerprint = ?')
          .bind(path.slice('/bugs/'.length))
          .first<{ issue_url: string | null }>();
        if (!row) return empty(404);
        return json({ issueUrl: row.issue_url }, row.issue_url ? 200 : 202);
      }
      if (request.method === 'GET' && path === '/stats') return await stats(request, env);
      return empty(404);
    } catch (error) {
      return empty(error === 400 || error === 413 ? error : 503);
    }
  },
};
