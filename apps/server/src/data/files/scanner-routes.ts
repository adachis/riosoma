import { z } from 'zod';
import {
  FileScannerSettings,
  FileSafetySettings,
  ScannerAddress,
  type FileScannerInfo,
  type FileScannerStatus,
} from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import { requireActor } from '../../auth/sessions.js';
import { parse } from '../../http/validate.js';
import { runOrganizationCommand } from '../commands/organization.js';
import { dataStore } from '../context.js';
import { fileSafetySettingsView, scannerInfo } from './settings.js';

const admin = {
  config: { policy: { kind: 'admin' as const, area: 'security' as const, scope: 'organization' as const } },
};
const Probe = z.object({ address: ScannerAddress.nullable().optional() }).strict();

export async function fileScannerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/org/files/safety', admin, async (request, reply): Promise<FileSafetySettings> => {
    const { pool, schemas } = dataStore(app.ctx);
    reply.header('cache-control', 'no-store');
    return fileSafetySettingsView({ db: pool, schemas, actor: requireActor(request) });
  });
  app.put('/api/org/files/safety', admin, async (request): Promise<FileSafetySettings> => {
    const settings = parse(FileSafetySettings, request.body);
    const result = await runOrganizationCommand(app, requireActor(request), {
      kind: 'organization.files.safety',
      ...settings,
    });
    return result.fileSafety!;
  });
  app.get('/api/org/files/scanner', admin, async (request, reply): Promise<FileScannerInfo> => {
    const { pool, schemas } = dataStore(app.ctx);
    reply.header('cache-control', 'no-store');
    return scannerInfo({ db: pool, schemas, actor: requireActor(request) }, app.ctx.config);
  });
  for (const action of ['detect', 'test'] as const) {
    app.post(`/api/org/files/scanner/${action}`, admin, async (request): Promise<FileScannerStatus> => {
      const input = parse(Probe, request.body ?? {});
      const result = await runOrganizationCommand(app, requireActor(request), {
        kind: `organization.files.scanner.${action}`,
        ...input,
      });
      return result.scannerStatus!;
    });
  }
  app.put('/api/org/files/scanner', admin, async (request): Promise<FileScannerInfo> => {
    const settings = parse(FileScannerSettings, request.body);
    const result = await runOrganizationCommand(app, requireActor(request), {
      kind: 'organization.files.scanner',
      ...settings,
    });
    return result.fileScanner!;
  });
}
