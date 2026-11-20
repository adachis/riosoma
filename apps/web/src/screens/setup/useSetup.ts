import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type {
  CreateOwner,
  DatabaseProfile,
  DiagnosticReport,
  SessionInfo,
  SetupStatus,
} from '@riosoma/contracts';
import { api, setCsrfToken, setupToken, storeSetupToken } from '../../api';
import { sessionQuery, setupStatusQuery } from '../../session';

/**
 * Takes the setup token out of the page address (`/setup#token=…`), keeps it for this tab only,
 * and removes it from the address bar so it isn't bookmarked or shared by accident.
 */
export function captureSetupToken(): string | null {
  const match = /(?:^|[#&])token=([A-Za-z0-9_-]{16,})/.exec(window.location.hash);
  if (match) {
    storeSetupToken(match[1]!);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  return setupToken();
}

/** Accepts a pasted setup link or a bare token. */
export function tokenFromInput(value: string): string | null {
  const trimmed = value.trim();
  const fromLink = /token=([A-Za-z0-9_-]{16,})/.exec(trimmed);
  if (fromLink) return fromLink[1]!;
  return /^[A-Za-z0-9_-]{16,}$/.test(trimmed) ? trimmed : null;
}

export function useSetupFlow() {
  const queryClient = useQueryClient();
  const status = useQuery(setupStatusQuery);
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [importRequested, setImportRequested] = useState(false);
  // Set once this tab creates the owner, so the usage counts step shows before setup ends.
  const [ownerCreated, setOwnerCreated] = useState(false);
  const [telemetryChosen, setTelemetryChosen] = useState(false);
  const [scannerChosen, setScannerChosen] = useState(false);

  const unlock = useMutation({
    mutationFn: async (token: string) => {
      storeSetupToken(token);
      await api('/api/setup/unlock', { method: 'POST' });
    },
    onSuccess: () => setUnlocked(true),
    onError: () => {
      storeSetupToken(null);
      setUnlocked(false);
    },
  });

  const testDatabase = useMutation({
    // A fresh check replaces the result and errors from the previous connect attempt.
    onMutate: (): void => saveDatabase.reset(),
    mutationFn: (profile: DatabaseProfile) =>
      api<{ report: DiagnosticReport }>('/api/setup/database/test', { body: profile }).then((r) => r.report),
  });

  const saveDatabase = useMutation({
    onMutate: (): void => testDatabase.reset(),
    mutationFn: (profile: DatabaseProfile) =>
      api<{ report: DiagnosticReport } & SetupStatus>('/api/setup/database', { body: profile }),
    onSuccess: (result) => {
      if (result.report.ok)
        queryClient.setQueryData(setupStatusQuery.queryKey, {
          stage: result.stage,
          databaseManaged: result.databaseManaged,
        });
    },
  });

  const createOwner = useMutation({
    mutationFn: (input: CreateOwner) => api<SessionInfo>('/api/setup/owner', { body: input }),
    onSuccess: (session) => {
      setCsrfToken(session.csrfToken);
      storeSetupToken(null);
      setOwnerCreated(true);
      queryClient.setQueryData(sessionQuery.queryKey, session);
      queryClient.setQueryData(setupStatusQuery.queryKey, {
        stage: 'ready',
        databaseManaged: status.data?.databaseManaged ?? false,
      });
    },
  });

  return {
    status,
    unlocked,
    setUnlocked,
    unlock,
    testDatabase,
    saveDatabase,
    createOwner,
    importRequested,
    setImportRequested,
    ownerCreated,
    telemetryChosen,
    setTelemetryChosen,
    scannerChosen,
    setScannerChosen,
  };
}

export { errorInfo } from '../../messages/errorInfo';
