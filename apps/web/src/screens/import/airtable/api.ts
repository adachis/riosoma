import {
  AirtableBases,
  AirtableImport,
  AirtableImportList,
  type AirtableBase,
  type AirtableImportRequest,
} from '@riosoma/contracts';
import { api } from '../../../api';

/**
 * The server's Airtable import routes.  The token goes in request bodies only, never in an
 * address, and nothing here keeps it.
 */

export async function listBases(token: string, signal?: AbortSignal): Promise<AirtableBase[]> {
  const answer = await api<unknown>('/api/imports/airtable/bases', {
    method: 'POST',
    body: { token },
    ...(signal ? { signal } : {}),
  });
  return AirtableBases.parse(answer).bases;
}

export async function startImport(request: AirtableImportRequest): Promise<AirtableImport> {
  return AirtableImport.parse(await api<unknown>('/api/imports/airtable', { method: 'POST', body: request }));
}

export async function recentImports(): Promise<AirtableImport[]> {
  return AirtableImportList.parse(await api<unknown>('/api/imports/airtable')).imports;
}

/** The import once it has moved past `since`, or as it is after a while without news. */
export async function watchImport(id: string, since: number, signal?: AbortSignal): Promise<AirtableImport> {
  return AirtableImport.parse(
    await api<unknown>(`/api/imports/airtable/${id}?since=${since}`, signal ? { signal } : {}),
  );
}

export async function cancelImport(id: string): Promise<AirtableImport> {
  return AirtableImport.parse(
    await api<unknown>(`/api/imports/airtable/${id}/cancel`, { method: 'POST', body: {} }),
  );
}

/** The imports that made a database, newest first.  None when the answer isn't one. */
export async function databaseImports(databaseId: string): Promise<AirtableImport[]> {
  const parsed = AirtableImportList.safeParse(
    await api<unknown>(`/api/databases/${databaseId}/imports/airtable`),
  );
  return parsed.success ? parsed.data.imports : [];
}
