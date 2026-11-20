import {
  PlatformBases,
  PlatformImport,
  PlatformImportList,
  PlatformPreview,
  type ImportPlatform,
  type PlatformBase,
  type PlatformBasesRequest,
  type PlatformImportRequest,
} from '@riosoma/contracts';
import { api } from '../../../api';

/**
 * The server's routes for importing from database and task services.  Tokens and
 * passwords go in request bodies only, never in an address, and nothing here keeps them.
 */

export async function listBases(
  platform: ImportPlatform,
  request: PlatformBasesRequest,
  signal?: AbortSignal,
): Promise<PlatformBase[]> {
  const answer = await api<unknown>(`/api/imports/${platform}/bases`, {
    method: 'POST',
    body: request,
    ...(signal ? { signal } : {}),
  });
  return PlatformBases.parse(answer).bases;
}

export async function startImport(
  platform: ImportPlatform,
  request: PlatformImportRequest,
): Promise<PlatformImport> {
  return PlatformImport.parse(
    await api<unknown>(`/api/imports/${platform}`, { method: 'POST', body: request }),
  );
}

export async function previewImport(
  platform: ImportPlatform,
  request: PlatformImportRequest,
): Promise<PlatformPreview> {
  return PlatformPreview.parse(
    await api<unknown>(`/api/imports/${platform}/preview`, { method: 'POST', body: request }),
  );
}

export async function recentImports(platform: ImportPlatform): Promise<PlatformImport[]> {
  return PlatformImportList.parse(await api<unknown>(`/api/imports/${platform}`)).imports;
}

/** The import once it has moved past `since`, or as it is after a while without news. */
export async function watchImport(
  platform: ImportPlatform,
  id: string,
  since: number,
  signal?: AbortSignal,
): Promise<PlatformImport> {
  return PlatformImport.parse(
    await api<unknown>(`/api/imports/${platform}/${id}?since=${since}`, signal ? { signal } : {}),
  );
}

export async function cancelImport(platform: ImportPlatform, id: string): Promise<PlatformImport> {
  return PlatformImport.parse(
    await api<unknown>(`/api/imports/${platform}/${id}/cancel`, { method: 'POST', body: {} }),
  );
}

/** The imports from any of the tools that made a database, newest first.  None when the answer isn't one. */
export async function databaseImports(databaseId: string): Promise<PlatformImport[]> {
  const parsed = PlatformImportList.safeParse(
    await api<unknown>(`/api/databases/${databaseId}/platform-imports`),
  );
  return parsed.success ? parsed.data.imports : [];
}
