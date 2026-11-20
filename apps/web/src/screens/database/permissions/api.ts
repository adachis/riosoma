import { useQuery } from '@tanstack/react-query';
import type {
  PermissionAudience,
  RecordRule,
  SetFieldPermissions,
  TablePermissions,
} from '@riosoma/contracts';
import { api } from '../../../api';

/**
 * Field permissions and record rules, which live beside the schema rather than in it: only the
 * people who manage them read them, and saving one reloads every open tab of the database.
 */

export const permissionsKey = (tableId: string) => ['tables', tableId, 'permissions'] as const;

export function useTablePermissions(tableId: string) {
  return useQuery({
    queryKey: permissionsKey(tableId),
    queryFn: ({ signal }) =>
      api<TablePermissions>(`/api/tables/${encodeURIComponent(tableId)}/permissions`, { signal }),
  });
}

export function saveFieldPermissions(fieldId: string, body: SetFieldPermissions): Promise<TablePermissions> {
  return api<TablePermissions>(`/api/fields/${encodeURIComponent(fieldId)}/permissions`, {
    method: 'PUT',
    body,
  });
}

export function saveRecordRules(tableId: string, rules: readonly RecordRule[]): Promise<TablePermissions> {
  return api<TablePermissions>(`/api/tables/${encodeURIComponent(tableId)}/record-rules`, {
    method: 'PUT',
    body: { rules },
  });
}

export const emptyAudience = (): PermissionAudience => ({ roles: [], users: [] });
