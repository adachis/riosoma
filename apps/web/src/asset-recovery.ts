import { markPageOutdated } from './pwa';
const RETRY_MS = 30_000;
const RETRY_KEY = 'rio.stale-asset';
let lastAttempt = 0;
type RecoveryResult = 'blocked' | 'leaving' | 'reloading';
let pending: Promise<RecoveryResult> | null = null;
const reloadFlushes = new Set<() => void>();
let requiredImports = 0;
let speculativeImports = 0;
let speculativeFailure = false;
let leaving = false;
const heldImports = new Set<() => void>();

/** Earlier error listeners must also ignore module loads canceled by navigation. */
export function isPageLeaving(): boolean {
  return leaving;
}

function resumeImports(): void {
  leaving = false;
  for (const resume of heldImports) resume();
  heldImports.clear();
}

async function waitForLivePage(): Promise<void> {
  while (leaving) await new Promise<void>((resolve) => heldImports.add(resolve));
}

export class AssetLoadError extends Error {
  constructor() {
    // The router's built-in missing-module reload must defer to the shared recovery guard.
    super('app.load.failed');
  }
}

export function isAssetLoadError(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if (
      error instanceof AssetLoadError ||
      /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to load module script|Unable to preload CSS/i.test(
        error.message,
      )
    )
      return true;
    error = error.cause;
  }
  return false;
}

export function beforeReload(flush: () => void): () => void {
  reloadFlushes.add(flush);
  return () => reloadFlushes.delete(flush);
}

export function reloadPage(): void {
  for (const flush of reloadFlushes) flush();
  window.location.reload();
}

/** Only a needed import or an unhandled rejection starts a repair. */
export function recoverAssets(reload = reloadPage): Promise<boolean> {
  return repairAssets(reload).then((result) => result !== 'blocked');
}

function repairAssets(reload: () => void): Promise<RecoveryResult> {
  // Navigation is already in progress.  Callers must not render a blocked-repair error.
  if (leaving) return Promise.resolve('leaving');
  if (pending) return pending;
  let previous = lastAttempt;
  try {
    previous = Math.max(previous, Number(sessionStorage.getItem(RETRY_KEY)) || 0);
  } catch {
    /* Storage can be disabled. */
  }
  if (navigator.onLine === false || Date.now() - previous < RETRY_MS) {
    return Promise.resolve('blocked');
  }
  pending = (async (): Promise<RecoveryResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      // Network availability alone cannot tell whether this server can supply a fresh page.
      const response = await fetch('/healthz', {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok || (await response.json()).status !== 'ok') return leaving ? 'leaving' : 'blocked';
    } catch {
      return leaving ? 'leaving' : 'blocked';
    } finally {
      clearTimeout(timer);
    }
    if (leaving) return 'leaving';
    try {
      await globalThis.caches?.delete('rio-app-assets').catch(() => undefined);
      const registration = await navigator.serviceWorker?.getRegistration();
      if (registration) {
        await registration.update().catch(() => undefined);
        const next = registration.waiting || registration.installing;
        if (next)
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              navigator.serviceWorker.removeEventListener('controllerchange', finish);
              next.removeEventListener('statechange', ask);
              resolve();
            };
            const ask = () => {
              if (next.state === 'installed') next.postMessage({ type: 'SKIP_WAITING' });
            };
            const timer = setTimeout(finish, 4_000);
            navigator.serviceWorker.addEventListener('controllerchange', finish);
            next.addEventListener('statechange', ask);
            ask();
          });
      }
    } catch {
      /* A server without a worker can still serve the current page. */
    }
    if (leaving) return 'leaving';
    lastAttempt = Date.now();
    try {
      sessionStorage.setItem(RETRY_KEY, String(lastAttempt));
    } catch {
      /* The in-memory guard still applies. */
    }
    reload();
    return 'reloading';
  })().finally(() => {
    pending = null;
  });
  return pending;
}

export async function recoverImport<T>(load: () => Promise<T>, reportBlocked = true): Promise<T> {
  requiredImports++;
  try {
    return await load();
  } catch (error) {
    if (!isAssetLoadError(error)) throw error;
    // Hold the same promise so a restored lazy screen can resume without remounting.
    let result: RecoveryResult;
    do {
      await waitForLivePage();
      result = await repairAssets(reloadPage);
    } while (result === 'leaving' || leaving);
    if (result === 'reloading') return new Promise<T>(() => {});
    // Actions may catch the rejection.  Rendering boundaries already provide a Reload control.
    if (reportBlocked) window.dispatchEvent(new Event('rio:asset-load-failed'));
    throw new AssetLoadError();
  } finally {
    requiredImports--;
  }
}

/** Intent may discover a deployment, but it must leave a working page alone. */
export async function preloadImport<T>(load: () => Promise<T>): Promise<T> {
  speculativeImports++;
  try {
    return await load();
  } catch (error) {
    if (isAssetLoadError(error)) {
      await waitForLivePage();
      // Required imports recover on rejection.  A late worker reply or an unrelated notice import
      // must not turn this page's speculative discovery into a forced reload.
      speculativeFailure = true;
    }
    throw error;
  } finally {
    speculativeImports--;
  }
}

export function preloadAssets(load: () => Promise<unknown>): Promise<void> {
  return preloadImport(load).then(
    () => undefined,
    () => undefined,
  );
}

export function installAssetRecovery(): void {
  let unloadTimer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener('pagehide', () => {
    clearTimeout(unloadTimer);
    leaving = true;
  });
  window.addEventListener('beforeunload', (event) => {
    leaving = true;
    clearTimeout(unloadTimer);
    // Later guards can cancel this event.  An ordinary unload can still be between tasks before pagehide.
    unloadTimer = setTimeout(() => {
      if (event.defaultPrevented || (typeof event.returnValue === 'string' && event.returnValue !== ''))
        resumeImports();
    }, 0);
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      clearTimeout(unloadTimer);
      resumeImports();
    }
  });
  window.addEventListener('vite:preloadError', () => {
    // Preserve Vite's rejection so tracked callers receive the original asset error.
    if (leaving) return;
    // Speculative imports leave a working page alone.  Only the worker can confirm a removed asset.
    // Tracked required imports report through their caller, including boundaries with their own message.
    if (requiredImports || speculativeImports || speculativeFailure) return;
    void recoverAssets().then((reloading) => {
      if (!reloading && !leaving) window.dispatchEvent(new Event('rio:asset-load-failed'));
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    if (!isAssetLoadError(event.reason)) return;
    event.preventDefault();
    if (leaving) return;
    void recoverAssets().then((reloading) => {
      if (!reloading && !leaving) window.dispatchEvent(new Event('rio:asset-load-failed'));
    });
  });
  navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.data?.type !== 'repair-stale-assets') return;
    if (leaving) {
      event.ports[0]?.postMessage({ handled: true });
      return;
    }
    if (!pending && (speculativeImports || speculativeFailure)) {
      markPageOutdated();
      event.ports[0]?.postMessage({ deferred: true });
      return;
    }
    const repair = recoverAssets();
    // Updating can depend on this fetch finishing, so acknowledge once repair has started.
    if (pending) event.ports[0]?.postMessage({ handled: true });
    void repair.then((reloading) => {
      if (!reloading) {
        if (!leaving) window.dispatchEvent(new Event('rio:asset-load-failed'));
        event.ports[0]?.postMessage({ handled: true });
      }
    });
  });
}
