import { budgetReached } from '../../ai/budget.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  AppError,
  ImageSearchTarget,
  type ImageSearchResult,
  type ImageSearchStatus,
} from '@riosoma/contracts';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { settingsFor, spent } from '../../ai/settings.js';
import { readablePage, sourceUrl } from '../../ai/knowledge-calls.js';
import { callOut, systemResolve } from '../../automations/outbound.js';
import type { Actor } from '../../http/policy.js';
import { organizationAdmin } from '../../org-units/store.js';
import { AccessScope } from '../access.js';
import { dataStore } from '../context.js';
import { checkFileSafety, requireSafeFile } from './safety.js';
import { knowledgeSettings } from '../knowledge.js';
import { recordKnowledgeUse } from '../knowledge-usage.js';
import { zoneFor } from '../../ai/footprint.js';
import { loadFields, loadTable } from '../metadata.js';
import { writeGuard } from '../permissions/enforce.js';
import { addressSettings } from '../../api-v1/attachments.js';
import { download } from '../imports/download.js';
import { detectType } from './detect.js';

type Target = z.infer<typeof ImageSearchTarget>;
const Selection = ImageSearchTarget.extend({
  orgId: z.string(),
  userId: z.string(),
  expires: z.number(),
  url: z.string(),
  sourceUrl: z.string(),
  thumbnail: z.string(),
  license: z.string().optional(),
});
const unavailable = () => new AppError('unavailable', 'knowledge.searchUnavailable');
const invalidSelection = () => new AppError('forbidden', 'knowledge.searchUnavailable');

async function target(ctx: AppContext, actor: Actor, input: Target) {
  const { pool, schemas } = dataStore(ctx);
  const table = await loadTable(pool, schemas, input.tableId);
  if (!table || table.trashed) throw new AppError('not_found', 'errors.notFound');
  const scope = new AccessScope(pool, schemas, actor);
  await scope.require(table.databaseId, 'editRecords');
  const fields = await loadFields(pool, schemas, [table.id]);
  const guard = writeGuard(pool, schemas, scope, table.id, fields);
  const field = guard.visible.find((entry) => entry.id === input.fieldId && entry.type === 'attachment');
  if (!field) throw new AppError('not_found', 'errors.notFound');
  await guard.requireVisible([input.recordId]);
  await guard.requireEditable([{ id: input.recordId, values: { [input.fieldId]: [] } }]);
  await scope.requireUse(table.databaseId, 'provider', { fieldIds: [input.fieldId] });
  await scope.requireUse(table.databaseId, 'external', { fieldIds: [input.fieldId] });
}

export async function imageSearchStatus(
  ctx: AppContext,
  actor: Actor,
  input: Target,
): Promise<ImageSearchStatus> {
  await target(ctx, actor, input);
  const allowed = await settingsFor(ctx, actor.orgId, actor);
  const { search } = await knowledgeSettings(ctx, actor);
  const reason = !allowed.enabled
    ? 'rio.disabled'
    : allowed.monthlyBudgetUsd !== null &&
        budgetReached(await spent(ctx, actor.orgId), allowed.monthlyBudgetUsd)
      ? 'rio.paused'
      : !search.enabled || search.engine !== 'searxng' || !search.address
        ? 'knowledge.searchUnavailable'
        : undefined;
  return { available: !reason, reason, canConfigure: organizationAdmin(actor, 'ai') };
}

function signature(ctx: AppContext, payload: string) {
  return createHmac('sha256', ctx.config.secretKey).update(`image-selection:${payload}`).digest();
}

export async function imageSelection(ctx: AppContext, actor: Actor, input: Target, token: string) {
  const [payload, signed, extra] = token.split('.');
  if (!payload || !signed || extra) throw invalidSelection();
  const expected = signature(ctx, payload);
  const actual = Buffer.from(signed, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalidSelection();
  let selection: z.infer<typeof Selection>;
  try {
    selection = Selection.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
  } catch {
    throw invalidSelection();
  }
  if (
    selection.orgId !== actor.orgId ||
    selection.userId !== actor.userId ||
    selection.expires < Date.now() ||
    selection.tableId !== input.tableId ||
    selection.fieldId !== input.fieldId ||
    selection.recordId !== input.recordId
  )
    throw invalidSelection();
  const status = await imageSearchStatus(ctx, actor, input);
  if (!status.available) throw new AppError('forbidden', status.reason!);
  return selection;
}

export async function searchImages(
  ctx: AppContext,
  actor: Actor,
  input: Target & { query: string },
): Promise<ImageSearchResult[]> {
  const status = await imageSearchStatus(ctx, actor, input);
  if (!status.available) throw new AppError('forbidden', status.reason!);
  const { search } = await knowledgeSettings(ctx, actor);
  const url = new URL(search.address!);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/search`;
  url.searchParams.set('q', input.query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('categories', 'images');
  const started = performance.now();
  try {
    // Only the administrator's search service may use a private address.
    const response = await callOut(
      { url: url.href, method: 'GET', headers: { accept: 'application/json' }, body: null },
      { resolve: systemResolve, allowPrivate: true, responseLimit: 1024 * 1024, timeoutMs: 15000 },
    );
    if (response.status !== 200 || response.truncated) throw unavailable();
    const raw = z.object({ results: z.array(z.unknown()) }).parse(JSON.parse(response.body));
    const results: ImageSearchResult[] = [];
    for (const item of raw.results.slice(0, 100)) {
      const row = z
        .object({
          title: z.string().default(''),
          url: z.string().max(4096),
          img_src: z.string().max(4096),
          thumbnail_src: z.string().max(4096).optional(),
          thumbnail: z.string().max(4096).optional(),
          license: z.string().optional(),
        })
        .safeParse(item);
      if (!row.success) continue;
      const image = sourceUrl(row.data.img_src);
      const source = sourceUrl(row.data.url);
      if (!image || !source || results.some((entry) => entry.url === image)) continue;
      const license = row.data.license ? readablePage(row.data.license).slice(0, 300) : undefined;
      const selection = {
        ...ImageSearchTarget.parse(input),
        orgId: actor.orgId,
        userId: actor.userId,
        expires: Date.now() + 30 * 60 * 1000,
        url: image,
        sourceUrl: source,
        thumbnail: sourceUrl(row.data.thumbnail_src ?? row.data.thumbnail ?? '') ?? image,
        ...(license ? { license } : {}),
      };
      const payload = Buffer.from(JSON.stringify(selection)).toString('base64url');
      const token = `${payload}.${signature(ctx, payload).toString('base64url')}`;
      results.push({
        title: readablePage(row.data.title).slice(0, 300) || new URL(source).hostname,
        sourceUrl: source,
        url: image,
        license,
        token,
        preview: `/api/knowledge/images/preview?token=${encodeURIComponent(token)}`,
      });
      if (results.length === 20) break;
    }
    return results;
  } catch {
    throw unavailable();
  } finally {
    const allowed = await settingsFor(ctx, actor.orgId, actor);
    await recordKnowledgeUse(ctx, actor, 'search', 'searxng', 'images', 0, {
      powerWatts: search.powerWatts,
      durationMs: performance.now() - started,
      zone: zoneFor(ctx, allowed),
    });
  }
}

export async function imagePreview(ctx: AppContext, actor: Actor, token: string) {
  // Decode only to find the destination; signature and access checks still precede the request.
  let input: Target;
  try {
    input = ImageSearchTarget.parse(JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()));
  } catch {
    throw unavailable();
  }
  const selection = await imageSelection(ctx, actor, input, token);
  const settings = addressSettings(ctx);
  const got = await download(selection.thumbnail, {
    resolve: settings.resolve,
    allowPrivate: settings.allowPrivate,
    allowUrl: (url) =>
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
        settings.allowPrivate(url)),
    maxBytes: Math.min(settings.maxBytes, 1024 * 1024),
    timeoutMs: 10000,
    signal: AbortSignal.timeout(15000),
  });
  try {
    const parts: Buffer[] = [];
    for await (const part of got.body) parts.push(Buffer.from(part));
    const body = Buffer.concat(parts);
    const type = detectType(body);
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) throw unavailable();
    const { pool, schemas } = dataStore(ctx);
    requireSafeFile(
      await checkFileSafety(
        { db: pool, schema: schemas.app, orgId: actor.orgId, config: ctx.config },
        { bytes: body, statedType: got.headers['content-type'], origin: 'outside' },
      ),
      {
        invalid: 'knowledge.searchUnavailable',
        infected: 'knowledge.searchUnavailable',
        unavailable: 'knowledge.searchUnavailable',
      },
    );
    return { body, type };
  } finally {
    got.body.destroy();
  }
}
