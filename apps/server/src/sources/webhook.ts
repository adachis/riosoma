import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import {
  WEBHOOK_OBJECT,
  WEBHOOK_SOURCE_LIMITS,
  type CellValue,
  type SourceSelect,
  type SourceTestResult,
  type WebhookConnection,
  type WebhookRefusalCode,
  type WebhookSignature,
} from '@riosoma/contracts';
import {
  cellsOf,
  ConnectorError,
  isRecordObject,
  KeyScan,
  parseJson,
  registerConnector,
  Sampler,
  valueAt,
  type Connector,
  type ConnectorContext,
} from '@riosoma/connectors';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { randomToken, tokenHash } from '../auth/database.js';
import { dataStore, type DataSchemas } from '../data/context.js';

/**
 * Incoming webhooks: a source another system posts JSON to.  Its address carries a token made
 * here, shown once, and kept only as its hash, so a leaked database can't post as anyone.  Each post
 * is checked (its size, its type, its signature when the source asks for one, and the pace of posts
 * to the address), then queued, answered with `202`, and written to the tables that sync from the
 * source in the order it came.  See `inbound.ts` for the address and `inbound-writer.ts` for the
 * writing.
 */

export const INBOUND_PREFIX = '/api/inbound/';
export const INBOUND_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function inboundPath(token: string): string {
  return `${INBOUND_PREFIX}${token}`;
}

export interface HookRow {
  source_id: string;
  org_id: string;
  token_hash: string;
  token_created_at: Date;
  rate_window: Date | null;
  rate_count: number;
  last_post_at: Date | null;
  bodies_until: Date | null;
  samples_until: Date | null;
}

const hooks = (schemas: DataSchemas) => ident(schemas.app, 'source_hooks');

/**
 * A new address for a webhook source, replacing the one it had at once: a post to the old address
 * finds nothing.  The token comes back this once and is never kept.
 */
export async function newHookAddress(
  db: Queryable,
  schemas: DataSchemas,
  source: { id: string; orgId: string },
): Promise<string> {
  const token = randomToken();
  await query(
    db,
    sql`INSERT INTO ${hooks(schemas)} (source_id, org_id, token_hash) VALUES (${source.id}, ${source.orgId}, ${tokenHash(token)})
    ON CONFLICT (source_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, token_created_at = statement_timestamp()`,
  );
  return inboundPath(token);
}

/** The webhook an address's token belongs to, or null when none does. */
export async function hookByToken(
  db: Queryable,
  schemas: DataSchemas,
  token: string,
): Promise<HookRow | null> {
  if (!INBOUND_TOKEN.test(token)) return null;
  const result = await query<HookRow>(
    db,
    sql`SELECT h.* FROM ${hooks(schemas)} h JOIN ${ident(schemas.app, 'sources')} s ON s.id = h.source_id
    WHERE h.token_hash = ${tokenHash(token)} AND s.kind = 'webhook'`,
  );
  return result.rows[0] ?? null;
}

/**
 * Counts one post against its webhook's pace, whether it's taken or refused, so trying costs a
 * sender too.  A window starts with the first post and lasts a minute.  Answers the seconds to wait,
 * or 0 when the post may go ahead.
 */
export async function admitPost(
  db: Queryable,
  schemas: DataSchemas,
  sourceId: string,
  perMinute: number,
): Promise<number> {
  const result = await query<{ rate_count: number; wait: number }>(
    db,
    sql`UPDATE ${hooks(schemas)} SET
      rate_window = CASE WHEN rate_window > clock_timestamp() - interval '1 minute' THEN rate_window ELSE clock_timestamp() END,
      rate_count = CASE WHEN rate_window > clock_timestamp() - interval '1 minute' THEN rate_count + 1 ELSE 1 END
    WHERE source_id = ${sourceId}
    RETURNING rate_count, GREATEST(1, ceil(extract(epoch FROM rate_window + interval '1 minute' - clock_timestamp())))::int AS wait`,
  );
  const row = result.rows[0];
  return row && row.rate_count > perMinute ? row.wait : 0;
}

function headerOf(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function hmac(secret: string, prefix: string | null, body: Buffer): Buffer {
  const mac = createHmac('sha256', secret);
  if (prefix !== null) mac.update(`${prefix}.`);
  return mac.update(body).digest();
}

/** Whether hex text is this digest, compared in constant time. */
function sameDigest(hex: string, digest: Buffer): boolean {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  return timingSafeEqual(Buffer.from(hex, 'hex'), digest);
}

/**
 * Why a post's signature doesn't hold, or null when it does.  The signature is checked before the
 * time, so a post someone signed long ago and a sender replays is refused for its time.
 */
export function signatureProblem(
  signature: WebhookSignature,
  secret: string,
  headers: IncomingHttpHeaders,
  body: Buffer,
  now = Date.now(),
): WebhookRefusalCode | null {
  const value = headerOf(headers, signature.header)?.trim();
  if (!value) return 'signature_missing';
  let timestamp: string | null = null;
  if (signature.format === 'timestamped') {
    const parts = value.split(',').map((part) => part.trim());
    timestamp = parts.find((part) => part.startsWith('t='))?.slice(2) ?? null;
    const signed = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
    if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !signed.length) return 'signature_missing';
    const digest = hmac(secret, timestamp, body);
    if (!signed.some((hex) => sameDigest(hex, digest))) return 'signature_invalid';
  } else {
    if (signature.timestampHeader) {
      timestamp = headerOf(headers, signature.timestampHeader)?.trim() ?? null;
      if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return 'signature_missing';
    }
    const digest = hmac(secret, timestamp, body);
    if (!sameDigest(value.replace(/^sha256=/i, ''), digest)) return 'signature_invalid';
  }
  if (timestamp !== null && Math.abs(now / 1000 - Number(timestamp)) > signature.toleranceSeconds)
    return 'timestamp_expired';
  return null;
}

/**
 * The records a post holds, or why it holds none it can give.  The records are the post itself, or
 * what's at the source's path in it.  A list makes a record of each item when the source splits
 * lists, and each record has to be an object, so its fields have names.
 */
export function postRecords(
  connection: Pick<WebhookConnection, 'records' | 'split'>,
  document: unknown,
): { records: Array<Record<string, unknown>> } | { refusal: WebhookRefusalCode } {
  const found = valueAt(document, connection.records);
  if (found === undefined) return { refusal: 'records_missing' };
  const items = Array.isArray(found) && connection.split ? found : [found];
  if (items.length > WEBHOOK_SOURCE_LIMITS.recordsPerPost) return { refusal: 'too_many_records' };
  if (!items.every(isRecordObject)) return { refusal: 'record_not_object' };
  return { records: items as Array<Record<string, unknown>> };
}

/**
 * The records in a post's text, read the way the address read it, so whole numbers too long for a
 * JavaScript number stay exact.  Null when the text holds none, as a post that was changed or a
 * source whose settings changed might.
 */
export function readPost(
  connection: Pick<WebhookConnection, 'records' | 'split'>,
  body: string,
): Array<Record<string, unknown>> | null {
  let document: unknown;
  try {
    document = parseJson(body);
  } catch {
    return null;
  }
  const found = postRecords(connection, document);
  return 'records' in found ? found.records : null;
}

/**
 * Keeps a post as a sample for the mapping step, only while it's open, and only the last few
 * posts.  It's kept as the text that arrived, and read again when the step asks.
 */
export async function keepSample(
  db: Queryable,
  schemas: DataSchemas,
  sourceId: string,
  body: string,
): Promise<void> {
  const samples = ident(schemas.app, 'source_hook_samples');
  const kept = await query(
    db,
    sql`INSERT INTO ${samples} (source_id, body, received_at)
    SELECT ${sourceId}, ${body}, statement_timestamp()
    FROM ${hooks(schemas)} WHERE source_id = ${sourceId} AND samples_until > statement_timestamp()`,
  );
  if (!kept.rowCount) return;
  await query(
    db,
    sql`DELETE FROM ${samples} WHERE source_id = ${sourceId} AND id NOT IN (
      SELECT id FROM ${samples} WHERE source_id = ${sourceId} ORDER BY id DESC LIMIT ${WEBHOOK_SOURCE_LIMITS.samples})`,
  );
}

/**
 * Forgets what a webhook keeps only for a while, so no post's words linger: the samples of every
 * mapping step that has closed, and the bodies in every log whose hour of keeping them has ended.
 */
export async function pruneHooks(db: Queryable, schemas: DataSchemas): Promise<void> {
  await query(
    db,
    sql`DELETE FROM ${ident(schemas.app, 'source_hook_samples')} s USING ${hooks(schemas)} h
    WHERE h.source_id = s.source_id AND (h.samples_until IS NULL OR h.samples_until <= statement_timestamp())`,
  );
  await query(
    db,
    sql`UPDATE ${ident(schemas.app, 'source_hook_deliveries')} d SET body = NULL FROM ${hooks(schemas)} h
    WHERE h.source_id = d.source_id AND d.body IS NOT NULL
    AND (h.bodies_until IS NULL OR h.bodies_until <= statement_timestamp())`,
  );
}

/**
 * The samples the mapping step reads, which it keeps coming while it's open.  A step that opens
 * after the last one closed starts with none, so it only ever shows posts sent while it's open.
 * Each is read from the text that arrived, with the source's settings as they are now.
 */
async function openSamples(
  db: Queryable,
  schemas: DataSchemas,
  sourceId: string,
  settings: WebhookConnection,
): Promise<unknown[]> {
  await query(
    db,
    sql`DELETE FROM ${ident(schemas.app, 'source_hook_samples')} s USING ${hooks(schemas)} h
    WHERE s.source_id = ${sourceId} AND h.source_id = s.source_id
    AND (h.samples_until IS NULL OR h.samples_until <= statement_timestamp())`,
  );
  await query(
    db,
    sql`UPDATE ${hooks(schemas)} SET samples_until = statement_timestamp() + make_interval(secs => ${WEBHOOK_SOURCE_LIMITS.sampleSeconds})
    WHERE source_id = ${sourceId}`,
  );
  const result = await query<{ body: string }>(
    db,
    sql`SELECT body FROM ${ident(schemas.app, 'source_hook_samples')} WHERE source_id = ${sourceId}
    ORDER BY id DESC LIMIT ${WEBHOOK_SOURCE_LIMITS.samples}`,
  );
  return result.rows.flatMap((row) => readPost(settings, row.body) ?? []);
}

function settingsOf(ctx: ConnectorContext): WebhookConnection {
  if (ctx.connection.kind !== 'webhook')
    throw new ConnectorError('sources.sync.read', 'not a webhook source');
  return ctx.connection;
}

function checkSelect(select: SourceSelect): void {
  if (select.kind !== 'object' || select.object.name !== WEBHOOK_OBJECT)
    throw new ConnectorError('sources.sync.objectMissing', undefined, {
      object: select.kind === 'object' ? select.object.name : '',
    });
}

/**
 * The connector the rest of Data Source sees: a webhook offers its posts, whose columns are the
 * paths the posts received while the mapping step is open hold.  It never reads on its own, since
 * posts arrive by themselves.
 */
export function createWebhookConnector(ctx: AppContext): Connector {
  const store = () => dataStore(ctx);
  async function samples(connector: ConnectorContext): Promise<unknown[]> {
    if (!connector.sourceId) return [];
    const { pool, schemas } = store();
    return openSamples(pool, schemas, connector.sourceId, settingsOf(connector));
  }
  function sampled(settings: WebhookConnection, records: unknown[]) {
    const sampler = new Sampler(settings);
    for (const record of records) {
      if (sampler.full) break;
      sampler.add(record);
    }
    return sampler.describe();
  }
  return {
    kind: 'webhook',
    async test(connector): Promise<SourceTestResult> {
      if (!connector.sourceId)
        return {
          ok: true,
          steps: [{ step: 'posts', status: 'skipped', ms: null, messageKey: 'sources.webhook.saveFirst' }],
        };
      const { pool, schemas } = store();
      const started = Date.now();
      const hook = await query<{ last_post_at: Date | null }>(
        pool,
        sql`SELECT last_post_at FROM ${hooks(schemas)} WHERE source_id = ${connector.sourceId}`,
      );
      const posted = Boolean(hook.rows[0]?.last_post_at);
      return {
        ok: posted,
        steps: [
          posted
            ? { step: 'posts', status: 'ok', ms: Date.now() - started }
            : {
                step: 'posts',
                status: 'failed',
                ms: Date.now() - started,
                messageKey: 'sources.webhook.noPosts',
              },
        ],
      };
    },
    async listObjects() {
      return [{ schema: null, name: WEBHOOK_OBJECT, type: 'posts', rowEstimate: null }];
    },
    async describe(connector, select) {
      checkSelect(select);
      return sampled(settingsOf(connector), await samples(connector)).map((entry) => entry.column);
    },
    async preview(connector, select, limit) {
      checkSelect(select);
      const settings = settingsOf(connector);
      const records = await samples(connector);
      const columns = sampled(settings, records);
      const rows: CellValue[][] = records.slice(0, Math.max(1, Math.min(limit, 100))).map((record) => {
        const cells = cellsOf(record, settings);
        return columns.map((entry) =>
          entry.column.suggested
            ? entry.value(cells.get(entry.column.name), entry.column.suggested.type)
            : null,
        );
      });
      return { columns: columns.map((entry) => entry.column), rows, rowEstimate: null };
    },
    async keyCandidates(connector) {
      const settings = settingsOf(connector);
      const records = await samples(connector);
      const scan = new KeyScan(sampled(settings, records));
      for (const record of records) scan.add(cellsOf(record, settings));
      return scan.candidates();
    },
    // eslint-disable-next-line require-yield
    async *read() {
      throw new ConnectorError('sources.webhook.noSync');
    },
  };
}

export function installWebhookSources(app: FastifyInstance): void {
  registerConnector(createWebhookConnector(app.ctx));
}
