import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DestinationLookup,
  DestinationPlaces,
  SyncOutCommand,
  SyncOutCommandResult,
  SyncOutPreview,
  SyncOutPreviewRequest,
  SyncOutRuns,
  ViewSyncOut,
} from '@riosoma/contracts';
import { api, ApiError } from '../../api';

/** Query keys and thin request functions for Sync out.  The list polls; the rest are one-off. */

export const viewSyncOutKey = (viewId: string) => ['views', viewId, 'sync-out'] as const;
export const syncOutRunsKey = (syncId: string) => ['sync-out', syncId, 'runs'] as const;

export const listViewSyncOut = (viewId: string, signal?: AbortSignal) =>
  api<ViewSyncOut>(`/api/views/${encodeURIComponent(viewId)}/sync-out`, signal ? { signal } : {});

export const listSyncOutRuns = (syncId: string, signal?: AbortSignal) =>
  api<SyncOutRuns>(`/api/sync-out/${encodeURIComponent(syncId)}/runs`, signal ? { signal } : {});

/**
 * The command route.  The update, delete, and run actions reach it through a mutation, which keeps
 * no token.  The create action carries the token, so it goes through `useRequest` instead, never a
 * cache.
 */
export const sendSyncOutCommand = (databaseId: string, command: SyncOutCommand, signal?: AbortSignal) =>
  api<SyncOutCommandResult>(`/api/databases/${encodeURIComponent(databaseId)}/sync-out/commands`, {
    method: 'POST',
    body: command,
    ...(signal ? { signal } : {}),
  });

export const lookupPlaces = (viewId: string, body: DestinationLookup, signal: AbortSignal) =>
  api<DestinationPlaces>(`/api/views/${encodeURIComponent(viewId)}/sync-out/places`, {
    method: 'POST',
    body,
    signal,
  });

export const previewSyncOut = (viewId: string, body: SyncOutPreviewRequest, signal: AbortSignal) =>
  api<SyncOutPreview>(`/api/views/${encodeURIComponent(viewId)}/sync-out/preview`, {
    method: 'POST',
    body,
    signal,
  });

export type RequestState<T> =
  | { state: 'idle'; data?: undefined; error?: undefined }
  | { state: 'loading'; data?: T; error?: undefined }
  | { state: 'failed'; data?: T; error: ApiError }
  | { state: 'done'; data: T; error?: undefined };

export type Request<I, T> = RequestState<T> & {
  send(input: I): Promise<T>;
  reset(): void;
};

/**
 * A small hook over `useState` and an `AbortController` for the requests that carry a token: places,
 * preview, and create.  It keeps the request's state in the component, so the token never lands in
 * a query key or a mutation's variables, and a new send always cancels the one before it.
 */
export function useRequest<I, T>(fn: (input: I, signal: AbortSignal) => Promise<T>): Request<I, T> {
  const [status, setStatus] = useState<RequestState<T>>({ state: 'idle' });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const send = useCallback(
    (input: I) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setStatus((current) => ({ state: 'loading', data: current.data }));
      return fn(input, controller.signal).then(
        (data) => {
          if (!controller.signal.aborted) setStatus({ state: 'done', data });
          return data;
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setStatus((current) => ({
              state: 'failed',
              data: current.data,
              error:
                error instanceof ApiError
                  ? error
                  : new ApiError(0, { code: 'internal', messageKey: 'errors.internal', userFault: false }),
            }));
          throw error;
        },
      );
    },
    [fn],
  );
  const reset = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setStatus({ state: 'idle' });
  }, []);
  return { ...status, send, reset };
}
