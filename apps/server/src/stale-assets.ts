/**
 * A browser keeps the app it loaded until the person accepts an update, so after a new version is
 * deployed an open page can still ask for a build file only the older version had.  Answering
 * with the app's page would hand the browser HTML where it expects code: the import fails, the
 * page empties, and the browser's cache keeps the wrong answer.  A missing script gets this small
 * module instead, which moves the page to the current version, and any other missing build file
 * gets a plain 404.
 */

/** Marks an answer for a build file this version does not have, so nothing stores it as the file. */
export const STALE_ASSET_HEADER = 'x-riosoma-stale-asset';

/** The cache the app's worker keeps build files in (`apps/web/public/notification-worker.js`). */
const ASSET_CACHE = 'rio-app-assets';

/** A page tries this at most once in this long, so a build that truly lacks a file cannot loop. */
export const STALE_ASSET_RETRY_MS = 30_000;

/**
 * The module's statements, kept apart from its export so a test can run them.  It drops the
 * cached build files, wakes the newer worker that is waiting to take over, and loads the page
 * again once that worker has, or after a short wait when there is none.  `retrying` says whether
 * the page is on its way, because this run started that or an earlier missing file of the same
 * page did.
 */
export const STALE_ASSET_STATEMENTS = `
const key = 'rio.stale-asset';
let last = 0;
// A page often misses several files at once.  Only the first starts the move, and the rest wait for it.
let retrying = window.__rioStaleAssetRetry === true;
try {
  last = Number(sessionStorage.getItem(key)) || 0;
} catch {}
if (!retrying && Date.now() - last > ${STALE_ASSET_RETRY_MS}) {
  retrying = true;
  window.__rioStaleAssetRetry = true;
  try {
    sessionStorage.setItem(key, String(Date.now()));
  } catch {}
  (async () => {
    try {
      await caches.delete('${ASSET_CACHE}');
    } catch {}
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        await registration.update().catch(() => undefined);
        const next = registration.waiting || registration.installing;
        if (next) {
          const taken = new Promise((resolve) => {
            navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
            setTimeout(resolve, 4000);
          });
          const ask = () => next.postMessage({ type: 'SKIP_WAITING' });
          if (next.state === 'installed') ask();
          else
            next.addEventListener('statechange', () => {
              if (next.state === 'installed') ask();
            });
          await taken;
        }
      }
    } catch {}
    location.reload();
  })();
}
`;

/**
 * What a missing script under the build folder is answered with.  While the page is on its way to
 * the current version the import stays unfinished, so the older page shows no error in the moment
 * before it loads again.  When that was already tried, the import finishes with nothing, and the
 * page reports that it could not load.
 */
export const STALE_ASSET_SCRIPT = `// This file belonged to an older version of Riosoma.  The page that asked for it moves to the
// current version.
${STALE_ASSET_STATEMENTS}
if (retrying) await new Promise(() => undefined);
export default undefined;
`;

/** Whether an address names a build file, which exists exactly or belongs to another version. */
export function isBuildAsset(url: string): boolean {
  return url.startsWith('/assets/');
}

/** Whether an address names a script, with any query set aside. */
export function isScript(url: string): boolean {
  return /\.m?js$/.test(url.split('?', 1)[0]!);
}
