import { demoNotice, demoRefusal } from './demo';
import { I18nProvider } from '@lingui/react';
import { useLingui } from '@lingui/react/macro';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { lazy, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast, toastQueue } from '@riosoma/ui';
import { LazyBoundary } from './shell/lazy';
import { recoverImport } from './asset-recovery';
import { ApiError, observeAuthenticationLoss, observeDemoRefusal } from './api';
import { keepConnectionsToPerson } from './files/pickers/connection-store';
import { i18n } from './i18n';
import { onUpdateReady } from './pwa';
import { makeRouter } from './router';
import { keepRioToSession } from './features/rio/conversation-session';
import { sessionQuery } from './session';

// Toast content is already localized.  A notice must not require an unopened feature catalog.
const ToastRegion = lazy(() =>
  recoverImport(
    () => import('./shell/ToastRegion').then((module) => ({ default: module.ToastRegion })),
    false,
  ),
);
const subscribeToasts = (listener: () => void) => toastQueue.subscribe(listener);
const currentToasts = () => toastQueue.visibleToasts;

function DeferredToasts() {
  const queued = useSyncExternalStore(subscribeToasts, currentToasts);
  return queued.length ? (
    <LazyBoundary size="controls" fallback={null}>
      <ToastRegion />
    </LazyBoundary>
  ) : null;
}

function makeQueryClient(): QueryClient {
  // Any request answered "sign in first" means the session is gone, wherever it came from.
  const onError = (error: unknown) => {
    if (demoRefusal(error)) return;
    if (error instanceof ApiError && error.status === 401) client.setQueryData(sessionQuery.queryKey, null);
  };
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        // A person's mistake won't fix itself on retry; only the system's might.
        retry: (count, error) => !(error instanceof ApiError && error.info.userFault) && count < 2,
        refetchOnWindowFocus: false,
      },
    },
  });
  observeDemoRefusal(demoNotice);
  observeAuthenticationLoss(() => {
    // An older session read must not restore the expired identity after another request failed.
    void client.cancelQueries({ queryKey: sessionQuery.queryKey });
    client.setQueryData(sessionQuery.queryKey, null);
  });
  // Cloud drive accounts are one person's, so someone else signing in to this tab starts without them.
  keepConnectionsToPerson(client);
  keepRioToSession(client);
  return client;
}

/** Offers a new version once, and applies it only when the person says so. */
export function UpdatePrompt() {
  const { t } = useLingui();
  const offered = useRef<(() => Promise<void>) | null>(null);
  useEffect(
    () =>
      onUpdateReady((update) => {
        // Loading a feature catalog resubscribes this effect to the same version.
        if (offered.current === update) return;
        offered.current = update;
        toast.show({
          title: t({ id: 'app.update.title', message: 'A new version of Riosoma is ready' }),
          tone: 'info',
          timeout: 0,
          action: { label: t({ id: 'app.update.action', message: 'Update' }), onPress: () => void update() },
        });
      }),
    [t],
  );
  return null;
}

export function createAppContext() {
  const queryClient = makeQueryClient();
  return { queryClient, router: makeRouter(queryClient) };
}

export function App({ context }: { context?: ReturnType<typeof createAppContext> }) {
  const [{ queryClient, router }] = useState(() => context ?? createAppContext());
  return (
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <DeferredToasts />
        <UpdatePrompt />
      </QueryClientProvider>
    </I18nProvider>
  );
}
