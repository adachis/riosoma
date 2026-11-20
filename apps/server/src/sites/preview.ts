import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, InterfaceId, SiteSettings, type InterfacePage } from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, sql, withTransaction } from '@riosoma/db';
import { themesRoot } from '../app.js';
import { requireActor } from '../auth/sessions.js';
import { AccessScope } from '../data/access.js';
import { dataStore } from '../data/context.js';
import { loadInterface } from '../data/interfaces/store.js';
import { parse } from '../http/validate.js';
import { requirePolicy } from '../org-units/policy.js';
import { serveImage } from './media.js';
import { sitePolicy } from './headers.js';
import { invalid, readPage, SITE_LIMITS } from './reads.js';
import { escape, renderPage } from './render.js';
import { unavailable, type LiveSite } from './store.js';
import { readSiteTheme, siteCss } from './site.css.js';

/** Preview drafts expire quickly, stay bounded, and belong only to the person who requested them. */
export async function sitePreviewRoutes(app: FastifyInstance): Promise<void> {
  const drafts = new Map<
    string,
    { userId: string; interfaceId: string; settings: SiteSettings; pages: InterfacePage[]; expires: number }
  >();
  const session = { config: { policy: { kind: 'session' as const } }, bodyLimit: 128 * 1024 };
  const root = '/api/interfaces/:interfaceId/site/preview';
  const params = z.object({ interfaceId: InterfaceId });
  const load = async (
    interfaceId: string,
    userId: string,
    settings: SiteSettings,
    pages: InterfacePage[] | null,
    request: Parameters<typeof requireActor>[0],
  ) => {
    const actor = requireActor(request);
    if (actor.userId !== userId) unavailable();
    const { pool, schemas } = dataStore(app.ctx);
    const stored = await loadInterface(pool, schemas, interfaceId);
    if (!stored || stored.trashed || stored.orgId !== actor.orgId) unavailable();
    const scope = new AccessScope(pool, schemas, actor);
    await scope.require(stored.databaseId, 'manage');
    await scope.requireUse(stored.databaseId, 'public');
    await requirePolicy(pool, `"${schemas.app}"`, actor, 'publicLinks');
    const selected =
      pages ??
      settings.pages.map(
        (setting) => stored.pages.find((page) => page.id === setting.pageId) ?? unavailable(),
      );
    const live: LiveSite = {
      settings,
      pages: selected,
      scope,
      version: '',
      row: {
        slug: settings.slug,
        org_id: actor.orgId,
        database_id: stored.databaseId,
        interface_id: interfaceId,
        publisher_id: actor.userId,
        domain_id: null,
        settings,
        pages: selected,
        published: false,
        updated_at: new Date(),
      },
    };
    return { live, pool, schemas };
  };
  app.post(root, session, async (request) => {
    const { interfaceId } = parse(params, request.params);
    const { settings, pageId } = parse(
      z.object({ settings: SiteSettings, pageId: z.string() }),
      request.body,
    );
    const actor = requireActor(request);
    const { live, pool, schemas } = await load(interfaceId, actor.userId, settings, null, request);
    const themeRoot = themesRoot(app.ctx.config);
    if (!themeRoot) invalid();
    const manifest = await readFile(join(themeRoot, settings.theme.id, 'theme.json'), 'utf8').catch(
      () => null,
    );
    if (
      !manifest ||
      !z
        .object({ schemes: z.array(z.object({ id: z.string() })) })
        .parse(JSON.parse(manifest))
        .schemes.some((scheme) => scheme.id === settings.theme.scheme)
    )
      invalid();
    const pageSettings = settings.pages.find((page) => page.pageId === pageId) ?? unavailable();
    const page = live.pages.find((item) => item.id === pageId) ?? unavailable();
    const content = await withTransaction(pool, async (db) => {
      await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      await query(db, sql`SELECT set_config('statement_timeout', '2000', true)`);
      return readPage(
        db,
        schemas,
        live,
        page,
        pageSettings,
        {},
        undefined,
        request.log,
        (id) =>
          createHmac('sha256', app.ctx.config.secretKey)
            .update(`preview:${settings.slug}:${id}`)
            .digest('base64url')
            .slice(0, 22),
        app.ctx.config,
      );
    });
    const token = randomBytes(24).toString('hex');
    const base = `/api/interfaces/${interfaceId}/site/preview/${token}`;
    let html = renderPage(
      settings,
      page,
      pageSettings,
      content,
      base,
      new URL(app.ctx.config.baseUrl || 'https://site.invalid').origin,
      {},
    );
    // The preview uses the public policy inside a sandbox with scripts disabled.
    html = html
      .replace(
        '<head>',
        `<head><meta http-equiv="Content-Security-Policy" content="${escape(sitePolicy())}">`,
      )
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
    if (Buffer.byteLength(html) > SITE_LIMITS.bytes)
      throw new AppError('payload_too_large', 'errors.tooLarge');
    for (const [key, draft] of drafts) if (draft.expires <= Date.now()) drafts.delete(key);
    while (drafts.size >= 100) drafts.delete(drafts.keys().next().value!);
    drafts.set(token, {
      userId: actor.userId,
      interfaceId,
      settings,
      pages: live.pages,
      expires: Date.now() + 10 * 60_000,
    });
    return { html };
  });
  app.get(`${root}/:token/*`, session, async (request, reply) => {
    const {
      interfaceId,
      token,
      '*': suffix,
    } = parse(params.extend({ token: z.string().regex(/^[a-f0-9]{48}$/), '*': z.string() }), request.params);
    const draft = drafts.get(token);
    if (!draft || draft.expires <= Date.now() || draft.interfaceId !== interfaceId) unavailable();
    const { live } = await load(interfaceId, draft.userId, draft.settings, draft.pages, request);
    reply.header('content-security-policy', sitePolicy()).header('x-content-type-options', 'nosniff');
    if (suffix === 'assets/site.css') return reply.type('text/css').send(siteCss(live.settings.motion));
    if (suffix === 'assets/theme.css')
      return reply
        .type('text/css')
        .send(await readSiteTheme(themesRoot(app.ctx.config) ?? unavailable(), live.settings.theme.id));
    if (/^media\/[^/]+$/.test(suffix)) return serveImage(request, reply, live, suffix.slice(6));
    unavailable();
  });
}
