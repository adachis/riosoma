import { brandingRoutes } from '../branding/routes.js';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { AuditExport, AuditQuery, UnitPreset, type AuditEntry } from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import { requireActor } from '../../auth/sessions.js';
import { parse } from '../../http/validate.js';
import type { AdminArea, AdminPolicy } from '../../http/policy.js';
import { dataStore } from '../context.js';
import { runOrganizationCommand } from '../commands/organization.js';
import { fileSettingsView } from '../files/settings.js';
import { fileScannerRoutes } from '../files/scanner-routes.js';
import {
  auditCeiling,
  auditDetail,
  auditPage,
  checkIntegrity,
  memberRoles,
  previewPreset,
  scope,
  type AdminContext,
} from './store.js';

const admin = (area: AdminArea | readonly AdminArea[]) => ({
  config: { policy: { kind: 'admin', area, scope: 'organization' } as AdminPolicy },
});
const Person = z.object({ userId: z.string().min(1).max(100) });
const Event = z.object({ eventId: z.string().regex(/^[1-9][0-9]{0,18}$/) });

/** Quote every CSV field and neutralize spreadsheet formulas in untrusted text */
export function csvCell(value: unknown): string {
  let text =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  if (/^[\s]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
const columns: Array<keyof AuditEntry> = [
  'id',
  'sequence',
  'at',
  'actorId',
  'actorName',
  'action',
  'resource',
  'metadata',
  'prevHash',
  'hash',
];

async function* exportEvents(c: AdminContext, input: AuditExport, ceiling: string): AsyncGenerator<string> {
  let before: string | undefined;
  let first = true;
  yield input.format === 'json' ? '[' : `${columns.map(csvCell).join(',')}\r\n`;
  do {
    const page = await auditPage(c, { ...input.filters, limit: 100, ...(before ? { before } : {}) }, ceiling);
    for (const entry of page.events) {
      yield input.format === 'json'
        ? `${first ? '' : ','}${JSON.stringify(entry)}`
        : `${columns.map((key) => csvCell(entry[key])).join(',')}\r\n`;
      first = false;
    }
    before = page.next ?? undefined;
  } while (before);
  if (input.format === 'json') yield ']';
}

export async function organizationAdminRoutes(app: FastifyInstance): Promise<void> {
  // Setup can start without a database; resolve the store only when a scanner route is called.
  await app.register(fileScannerRoutes);
  await app.register(brandingRoutes);
  const context = (actor: AdminContext['actor']): AdminContext => {
    const { pool, schemas } = dataStore(app.ctx);
    return { db: pool, schemas, actor };
  };
  app.get('/api/org/files', admin('security'), async (request) => {
    const c = context(requireActor(request));
    return fileSettingsView(c);
  });
  app.get('/api/org/members/:userId/admin-roles', admin('people'), async (request) => {
    const { userId } = parse(Person, request.params);
    return { roles: await memberRoles(context(requireActor(request)), userId) };
  });
  app.post('/api/org/admin-commands', admin(['people', 'security', 'audit']), async (request) =>
    runOrganizationCommand(app, requireActor(request), request.body),
  );
  app.get('/api/org/presets/:preset', admin('security'), async (request) => {
    const { preset } = parse(z.object({ preset: UnitPreset }), request.params);
    const {
      before: _before,
      after: _after,
      ...preview
    } = await previewPreset(context(requireActor(request)), preset, {
      sessionMaxDays: app.ctx.config.sessionMaxDays,
      sessionIdleDays: app.ctx.config.sessionIdleDays,
    });
    return preview;
  });
  app.get('/api/org/audit', admin('audit'), async (request) =>
    auditPage(context(requireActor(request)), parse(AuditQuery, request.query)),
  );
  app.get('/api/org/audit/integrity', admin('audit'), async (request) =>
    checkIntegrity(context(requireActor(request))),
  );
  app.get('/api/org/audit/:eventId', admin('audit'), async (request) =>
    auditDetail(context(requireActor(request)), parse(Event, request.params).eventId),
  );
  app.post('/api/org/audit/export', admin('audit'), async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(AuditExport, request.body);
    const c = context(actor);
    await scope(c).requireOrganizationAdmin('audit');
    const ceiling = await auditCeiling(c);
    await runOrganizationCommand(app, actor, { kind: 'audit.export', ...input });
    reply.header('Content-Disposition', `attachment; filename="audit.${input.format}"`);
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.type(input.format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8');
    // JSON and CSV exports use explicit types, attachment disposition, and nosniff.
    // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
    return reply.send(Readable.from(exportEvents(c, input, ceiling)));
  });
}
