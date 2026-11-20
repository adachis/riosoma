import {
  newId,
  type AdminRoutine,
  type Routine,
  type RoutineApproval,
  type RoutineApprove,
  type RoutineDraft,
  type RoutineDraftRequest,
  type RoutineInput,
  type RoutineRun,
  type RoutineSitesRequest,
  type RoutineUpdate,
  type UndoResult,
} from '@riosoma/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { clientId } from '../../data/deps';

/** Routines: a person's own, one routine's runs, what waits for them, and the admin's list. */

const one = (routineId: string) => `/api/rio/routines/${encodeURIComponent(routineId)}`;
const approval = (approvalId: string) => `/api/rio/routine-approvals/${encodeURIComponent(approvalId)}`;

export const routinesKey = ['routines'] as const;
export const listKey = (databaseId?: string) => ['routines', 'list', databaseId ?? 'all'] as const;
export const routineKey = (routineId: string) => ['routines', 'one', routineId] as const;
export const runsKey = (routineId: string) => ['routines', 'runs', routineId] as const;
export const adminKey = ['routines', 'admin'] as const;

export const listRoutines = (databaseId?: string, signal?: AbortSignal) =>
  api<Routine[]>(
    `/api/rio/routines${databaseId ? `?${new URLSearchParams({ databaseId }).toString()}` : ''}`,
    signal ? { signal } : {},
  );
export const getRoutine = (routineId: string, signal?: AbortSignal) =>
  api<Routine>(one(routineId), signal ? { signal } : {});
export const routineRuns = (routineId: string, signal?: AbortSignal) =>
  api<RoutineRun[]>(`${one(routineId)}/runs`, signal ? { signal } : {});
export const draftRoutine = (body: RoutineDraftRequest) =>
  api<RoutineDraft>('/api/rio/routines/draft', { body });
/** The sites named in the fields a plan reads sites from, for the owner to approve when saving */
export const routineSites = (body: RoutineSitesRequest, signal?: AbortSignal) =>
  api<{ sites: string[] }>('/api/rio/routines/sites', { body, ...(signal ? { signal } : {}) });
export const createRoutine = (body: RoutineInput) => api<Routine>('/api/rio/routines', { body });
export const updateRoutine = (routineId: string, body: RoutineUpdate) =>
  api<Routine>(one(routineId), { method: 'PATCH', body });
export const deleteRoutine = (routineId: string) => api<void>(one(routineId), { method: 'DELETE' });
export const pauseRoutine = (routineId: string, pause: boolean) =>
  api<Routine>(`${one(routineId)}/${pause ? 'pause' : 'resume'}`, { method: 'POST' });
export const runRoutine = (routineId: string) => api<RoutineRun>(`${one(routineId)}/run`, { method: 'POST' });

export const approve = (approvalId: string, body: RoutineApprove = {}) =>
  api<RoutineApproval>(`${approval(approvalId)}/approve`, { body });
export const skip = (approvalId: string) =>
  api<RoutineApproval>(`${approval(approvalId)}/skip`, { method: 'POST' });
export const change = (approvalId: string, note: string) =>
  api<RoutineRun>(`${approval(approvalId)}/change`, { body: { note } });

export const adminRoutines = (signal?: AbortSignal) =>
  api<AdminRoutine[]>('/api/admin/routines', signal ? { signal } : {});
/** An admin's pause, which only an admin lifts */
export const adminPause = (routineId: string, pause: boolean) =>
  api<AdminRoutine>(`/api/admin/routines/${encodeURIComponent(routineId)}/${pause ? 'pause' : 'resume'}`, {
    method: 'POST',
  });

/** Deletes a routine, which for one an admin paused only an admin may do */
export const adminDelete = (routineId: string) =>
  api<void>(`/api/admin/routines/${encodeURIComponent(routineId)}`, { method: 'DELETE' });

/** Takes back, in one step, the changes a run or an approved plan made. */
export const undoChanges = (databaseId: string, groupId: string) =>
  api<UndoResult>(`/api/databases/${encodeURIComponent(databaseId)}/undo`, {
    body: { clientId: clientId(), groupId, commandId: newId('command') },
  });

/** Everything about routines reads fresh after a change, wherever it's shown. */
export function refreshRoutines(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: routinesKey });
}
