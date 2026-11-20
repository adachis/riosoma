// Riosoma theme switching. Every theme follows the same contract (see themes/README.md):
// one stylesheet per theme, plus data-scheme, data-mode, and data-surface attributes.
//
//   <script src="themes/rio-theme.js"></script>
//   await RioTheme.setTheme('panic-play', { scheme: 'midnight' });
//   RioTheme.setScheme('lagoon');                    // on <html>
//   RioTheme.setScheme('ember', someContainer);      // just that subtree
//   RioTheme.setMode('dark');                        // only for themes whose theme.json lists modes
(function () {
  let base = new URL('./', (document.currentScript && document.currentScript.src) || location.href).href;
  const manifests = {};

  async function getJSON(path) {
    const res = await fetch(new URL(path, base));
    if (!res.ok) throw new Error(`Couldn't load ${path} (${res.status})`);
    return res.json();
  }

  async function manifest(themeId) {
    manifests[themeId] = manifests[themeId] || await getJSON(`${themeId}/theme.json`);
    return manifests[themeId];
  }

  // Load the new stylesheet before removing the old one so the page never renders unstyled.
  function swapStylesheet(href) {
    const current = document.getElementById('rio-theme');
    if (current && current.href === href) return Promise.resolve();
    const next = Object.assign(document.createElement('link'), { rel: 'stylesheet', href });
    return new Promise((resolve, reject) => {
      const done = () => {
        if (current) current.remove();
        next.id = 'rio-theme';
        resolve();
      };
      next.onload = done;
      // Browsers also fire error when an @import inside the sheet fails (say, Google Fonts while
      // offline). The theme still applies in that case, so only a missing sheet counts as a failure.
      next.onerror = () => {
        if (next.sheet) return done();
        next.remove();
        reject(new Error(`Couldn't load ${href}`));
      };
      document.head.append(next);
    });
  }

  function setScheme(schemeId, el = document.documentElement) {
    if (schemeId) el.dataset.scheme = schemeId;
    else delete el.dataset.scheme;
  }

  function setMode(mode, el = document.documentElement) {
    if (mode) el.dataset.mode = mode;
    else delete el.dataset.mode;
  }

  async function setTheme(themeId, { scheme, mode } = {}) {
    const m = await manifest(themeId);
    await swapStylesheet(new URL(`${themeId}/${m.css}`, base).href);
    const root = document.documentElement;
    root.dataset.theme = themeId;
    setScheme(m.schemes.some((s) => s.id === scheme) ? scheme : m.defaultScheme);
    setMode(m.modes.length ? (m.modes.includes(mode) ? mode : m.defaultMode) : null);
    return m;
  }

  window.RioTheme = {
    setTheme,
    setScheme,
    setMode,
    manifest,
    list: () => getJSON('index.json'),
    setBase(url) { base = new URL(url, location.href).href; },
  };
})();
