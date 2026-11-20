import { sitePreviewRoutes } from './preview.js';
import { requireSiteQuestions } from './forms.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { themesRoot } from '../app.js';
import { AppError, InterfaceId, SiteSettings, type InterfacePage } from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireActor } from '../auth/sessions.js';
import { AccessScope } from '../data/access.js';
import { dataStore } from '../data/context.js';
import { loadFields, loadView } from '../data/metadata.js';
import { publicQuestions, shareForm } from '../data/public-forms.js';
import { loadInterface } from '../data/interfaces/store.js';
import { parse } from '../http/validate.js';
import { requirePolicy } from '../org-units/policy.js';
import { organizationAdmin } from '../org-units/store.js';
import { invalid } from './reads.js';
import { siteAudit, siteView, unavailable, type SiteRow } from './store.js';

export async function siteManagementRoutes(app: FastifyInstance): Promise<void> {
  const session = { config: { policy: { kind: 'session' as const } }, bodyLimit: 128 * 1024 };
  const path = '/api/interfaces/:interfaceId/site';
  const params = z.object({ interfaceId: InterfaceId });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  await sitePreviewRoutes(app);
  for (const method of ['GET', 'PUT', 'DELETE'] as const) {
    app.route({
      method,
      url: path,
      ...session,
      handler: async (request, reply) => {
        const { interfaceId } = parse(params, request.params);
        const actor = requireActor(request);
        const input = method === 'PUT' ? parse(SiteSettings, request.body) : null;
        if (input) {
          const root = themesRoot(app.ctx.config);
          if (!root) invalid();
          const manifest = await readFile(join(root, input.theme.id, 'theme.json'), 'utf8').catch(() => null);
          if (!manifest) invalid();
          const theme = z
            .object({ schemes: z.array(z.object({ id: z.string() })) })
            .parse(JSON.parse(manifest));
          if (!theme.schemes.some((scheme) => scheme.id === input.theme.scheme)) invalid();
        }
        const { pool, schemas } = dataStore(app.ctx);
        const result = await withTransaction(pool, async (db) => {
          await query(db, sql`SELECT pg_advisory_xact_lock(hashtextextended(${`site:${interfaceId}`}, 0))`);
          const stored = await loadInterface(db, schemas, interfaceId);
          if (!stored || stored.trashed || stored.orgId !== actor.orgId) unavailable();
          const scope = new AccessScope(db, schemas, actor);
          await scope.require(stored.databaseId, 'manage');
          const previous = (
            await query<SiteRow>(
              db,
              sql`SELECT * FROM ${ident(schemas.app, 'published_sites')} WHERE interface_id = ${interfaceId}`,
            )
          ).rows[0];
          if (method === 'GET') return previous ? siteView(previous) : null;
          if (method === 'DELETE') {
            if (previous?.published) {
              // An unpublished site keeps its address but lets its domain go, so the domain's
              // other public pages answer again at once.
              await query(
                db,
                sql`UPDATE ${ident(schemas.app, 'published_sites')} SET published = false, domain_id = NULL,
                  settings = settings || '{"domainId": null}'::jsonb, updated_at = statement_timestamp()
                WHERE interface_id = ${interfaceId}`,
              );
              await siteAudit(db, schemas, previous, actor.userId, 'data.site.unpublished');
            }
            return null;
          }
          if (!input) invalid();
          if (previous && previous.slug !== input.slug) invalid();
          // A site is a public link, which the publisher's unit or organization may turn off.
          await requirePolicy(db, `"${schemas.app}"`, actor, 'publicLinks');
          await new AccessScope(db, schemas, actor).requireUse(stored.databaseId, 'public');
          // A domain serves a site in place of every other public page on it, so only the owner or
          // an Integrations admin, who manage the organization's domains, chooses one.  Anyone
          // else who publishes keeps the domain the site has.
          const domainId = previous?.domain_id ?? null;
          if (input.domainId !== domainId && !organizationAdmin(actor, 'integrations'))
            throw new AppError('forbidden', 'errors.adminOnly');
          const pages = input.pages.map((setting): InterfacePage => {
            const page = stored.pages.find((candidate) => candidate.id === setting.pageId) ?? unavailable();
            if (
              setting.slugFieldId &&
              !page.blocks.some(
                (block) => block.kind === 'records' && block.fieldIds.includes(setting.slugFieldId!),
              )
            )
              invalid();
            return page;
          });
          for (const page of pages)
            for (const block of page.blocks) {
              if (block.kind !== 'button' || block.action.kind !== 'form') continue;
              const view = await loadView(db, schemas, block.action.viewId);
              if (
                !view ||
                view.trashed ||
                view.databaseId !== stored.databaseId ||
                view.view.tableId !== block.action.tableId ||
                view.view.type !== 'form'
              )
                unavailable();
              const fields = scope.visibleFields(
                block.action.tableId,
                await loadFields(db, schemas, [block.action.tableId]),
              );
              requireSiteQuestions(publicQuestions(view.view.config.form, fields).questions, fields);
              await shareForm(db, schemas, actor, {
                databaseId: stored.databaseId,
                tableId: block.action.tableId,
                viewId: block.action.viewId,
              });
            }
          if (input.domainId && input.domainId !== domainId) {
            const domain = await query(
              db,
              sql`SELECT 1 FROM ${ident(schemas.app, 'custom_domains')}
            WHERE id = ${input.domainId} AND org_id = ${actor.orgId} AND verified_at IS NOT NULL
              AND removed_at IS NULL AND 'sites' = ANY(kinds)`,
            );
            if (!domain.rowCount) unavailable();
          }
          const collision = await query(
            db,
            sql`SELECT 1 FROM ${ident(schemas.app, 'published_sites')}
          WHERE interface_id <> ${interfaceId} AND (slug = ${input.slug} OR domain_id = ${input.domainId})`,
          );
          if (collision.rowCount) throw new AppError('conflict', 'errors.conflict');
          const saved = await query<SiteRow>(
            db,
            sql`INSERT INTO ${ident(schemas.app, 'published_sites')}
          (slug, org_id, database_id, interface_id, publisher_id, domain_id, settings, pages)
          VALUES (${input.slug}, ${actor.orgId}, ${stored.databaseId}, ${interfaceId}, ${actor.userId}, ${input.domainId}, ${JSON.stringify(input)}::jsonb, ${JSON.stringify(pages)}::jsonb)
          ON CONFLICT (interface_id) DO UPDATE SET publisher_id = EXCLUDED.publisher_id, domain_id = EXCLUDED.domain_id,
            settings = EXCLUDED.settings, pages = EXCLUDED.pages, published = true, updated_at = statement_timestamp() RETURNING *`,
          );
          const row = saved.rows[0]!;
          await siteAudit(
            db,
            schemas,
            row,
            actor.userId,
            previous?.published ? 'data.site.pagesChanged' : 'data.site.published',
            input.domainId === domainId ? {} : { previousDomainId: domainId },
          );
          return siteView(row);
        });
        // Acknowledging before commit lets an immediate public read see the site still published.
        if (method === 'DELETE') return reply.code(204).send();
        return result;
      },
    });
  }
}
