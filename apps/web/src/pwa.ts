import { onPublicDomain } from './public-domain';
import { reloadPage } from './asset-recovery';
import { trustedScriptURL } from './security/trusted-script-url';

/**
 * Registers the service worker that makes Riosoma installable and keeps its shell available
 * offline.  A new worker takes control without changing the code running in an open page.
 */
type Listener = (update: () => Promise<void>) => void;
const listeners = new Set<Listener>();
let pendingUpdate: (() => Promise<void>) | null = null;
let pendingWorker: ServiceWorker | null = null;

async function currentBuild(worker: ServiceWorker): Promise<boolean> {
  const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;
  if (!entry) return false;
  const channel = new MessageChannel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 1_000);
      channel.port1.onmessage = (event) => {
        resolve(event.data?.current === true);
      };
      worker.postMessage({ type: 'check-page-build', entry }, [channel.port2]);
    });
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    channel.port1.close();
    channel.port2.close();
  }
}

/** The worker can confirm a missing deployment asset before a newer worker takes control. */
export function markPageOutdated(): void {
  if (pendingUpdate) return;
  pendingUpdate = async () => {
    const container = navigator.serviceWorker;
    if (!container) {
      reloadPage();
      return;
    }
    await applyWorkerUpdate(
      container,
      async () => {
        const registration = await container.getRegistration();
        registration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
      },
      reloadPage,
    );
  };
  for (const listener of listeners) listener(pendingUpdate);
}

/**
 * A view shared by link never installs the app: its page can sit inside another site's page, and
 * a worker installed there would answer later visits with a copy lacking the page's frame policy.
 */
export function installsApp(location: Pick<Location, 'pathname'>, framed: boolean): boolean {
  return !framed && !location.pathname.startsWith('/v/');
}

function isFramed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export function startServiceWorker(): void {
  if (onPublicDomain()) return;
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  if (!installsApp(window.location, isFramed())) return;
  const container = navigator.serviceWorker;
  let previous = container.controller;
  container.addEventListener('controllerchange', () => {
    const older = previous;
    previous = container.controller;
    void offerUpdate(container, async () => reloadPage(), older);
  });
  void container.register(trustedScriptURL('/sw.js')).catch(() => undefined);
  // Startup's catalog and theme arrive before a new worker controls the page.  Keep those already
  // requested assets available offline without downloading unopened features or other locales.
  void navigator.serviceWorker.ready
    .then((registration) => {
      const assets = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => {
          const url = new URL(name, window.location.href);
          return (
            url.origin === window.location.origin &&
            (/^\/assets\/[^/]+\.(?:js|css)$/.test(url.pathname) || url.pathname.startsWith('/themes/'))
          );
        });
      registration.active?.postMessage({ type: 'cache-loaded-assets', assets });
    })
    .catch(() => undefined);
}

/** An accepted update reloads after takeover, including a worker found after a first install. */
export async function applyWorkerUpdate(
  container: Pick<
    ServiceWorkerContainer,
    'controller' | 'getRegistration' | 'addEventListener' | 'removeEventListener'
  >,
  activate: () => Promise<void>,
  reload: () => void,
): Promise<void> {
  const registration = await container.getRegistration();
  if (!registration?.waiting) {
    reload();
    return;
  }
  const previous = container.controller;
  let reloaded = false;
  const changed = () => {
    if (reloaded || container.controller === previous) return;
    reloaded = true;
    container.removeEventListener('controllerchange', changed);
    reload();
  };
  container.addEventListener('controllerchange', changed);
  try {
    await activate();
    changed();
  } catch (error) {
    container.removeEventListener('controllerchange', changed);
    throw error;
  }
}

/**
 * Offers an update after a newer worker replaces the controller of an already controlled page.
 * A waiting worker is also offered when an older installation has not activated yet.  Firefox
 * can report a waiting version on a first install with nothing waiting,
 * which would ask people to update to the version they already have.
 */
export async function offerUpdate(
  container: Pick<ServiceWorkerContainer, 'controller' | 'getRegistration'>,
  apply: () => Promise<void>,
  previous?: ServiceWorker | null,
): Promise<void> {
  if (!container.controller) return;
  const registration = await container.getRegistration();
  const next =
    previous === undefined
      ? registration?.waiting
      : previous && previous !== container.controller
        ? container.controller
        : null;
  if (!next || next === pendingWorker) return;
  // Runtime caches retain older files.  Only this worker's build list identifies the page's version.
  if (await currentBuild(next)) return;
  if (next === pendingWorker) return;
  // A missing asset can offer recovery before this worker finishes installing.
  // That existing action finds the current worker when the person accepts it.
  const alreadyOffered = pendingUpdate !== null && pendingWorker === null;
  pendingWorker = next;
  if (alreadyOffered) return;
  pendingUpdate = apply;
  for (const listener of listeners) listener(pendingUpdate);
}

/** Subscribe to "a new version is ready"; the callback receives a function that applies it. */
export function onUpdateReady(listener: Listener): () => void {
  listeners.add(listener);
  if (pendingUpdate) listener(pendingUpdate);
  return () => listeners.delete(listener);
}

/** Browser permission is requested only from a person's explicit subscription action. */
export async function pushRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}
export async function subscribeDevice(publicKey: string): Promise<PushSubscription> {
  const registration = await pushRegistration();
  if (!registration) throw new Error('notifications.push.unavailable');
  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing;
  const encoded = publicKey.replace(/-/g, '+').replace(/_/g, '/');
  const applicationServerKey = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
}
export async function pushDeviceId(subscription: PushSubscription): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscription.endpoint));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}
