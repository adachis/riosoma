// A plain script can expose the catalog-backed screen even when the app's module graph cannot link.
(function () {
  var lastAttempt = 0;
  var appReady = false;
  var startupTimer;
  var leaving = false;
  var unloadTimer;
  // Startup cannot rely on the module graph that this screen helps recover.
  window.addEventListener('pagehide', function () {
    clearTimeout(unloadTimer);
    leaving = true;
  });
  window.addEventListener('beforeunload', function (event) {
    leaving = true;
    clearTimeout(unloadTimer);
    // A later navigation guard can keep this same document open.
    unloadTimer = setTimeout(function () {
      if (event.defaultPrevented || (typeof event.returnValue === 'string' && event.returnValue !== ''))
        leaving = false;
    }, 0);
  });
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) {
      clearTimeout(unloadTimer);
      leaving = false;
    }
  });
  window.addEventListener('rio:app-ready', function () {
    appReady = true;
    clearTimeout(startupTimer);
    const screen = document.getElementById('rio-startup-error');
    if (screen) screen.hidden = true;
  });
  navigator.serviceWorker?.addEventListener('message', function (event) {
    if (event.data?.type !== 'asset-repair-guard') return;
    try {
      lastAttempt = Math.max(lastAttempt, Number(sessionStorage.getItem('rio.stale-asset')) || 0);
    } catch {
      // The worker also keeps a guard when this browser disables storage.
    }
    var started = false;
    if (event.data.start && Date.now() - lastAttempt >= 30_000) {
      lastAttempt = Date.now();
      started = true;
      try {
        sessionStorage.setItem('rio.stale-asset', String(lastAttempt));
      } catch {
        // This document still remembers the attempt without storage.
      }
    }
    event.ports[0]?.postMessage({
      lastAttempt: lastAttempt,
      ...(event.data.start ? { started: started } : {}),
    });
  });
  function show() {
    if (leaving) return;
    const screen = document.getElementById('rio-startup-error');
    if (screen) screen.hidden = false;
  }
  function checkStartup() {
    // A missing entry can be a valid recovery module that completes without mounting the app.
    if (!appReady) startupTimer = setTimeout(show, 10_000);
  }
  // The wait starts once the page and its scripts have arrived, so a slow download is never
  // mistaken for an app that will not start.
  if (document.readyState === 'complete') checkStartup();
  else window.addEventListener('load', checkStartup, { once: true });
  window.addEventListener(
    'error',
    function (event) {
      const target = event.target;
      if (target && target.tagName === 'SCRIPT' && target.type === 'module') show();
    },
    true,
  );
  window.addEventListener('unhandledrejection', show);
  window.addEventListener('rio:asset-load-failed', show);
  document.addEventListener('click', function (event) {
    if (event.target.closest?.('#rio-startup-error button')) window.location.reload();
  });
})();
