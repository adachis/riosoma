// Paints the last-used theme before the app loads, so a reload never flashes a different one.
// Plain script because the security policy allows no inline code.
// Zod reads this before it builds any schema: skip its eval probe, which the security policy
// forbids (Firefox reports even the caught attempt).
window.__zod_globalConfig = Object.assign(window.__zod_globalConfig || {}, { jitless: true });

(function () {
  var choice = { theme: 'nature', scheme: 'grove' };
  try {
    var saved = JSON.parse(localStorage.getItem('rio.theme') || 'null');
    if (saved && /^[a-z0-9-]{1,64}$/.test(saved.theme)) choice = saved;
  } catch (e) {
    // Storage unavailable: use the default theme.
  }
  var slug = /^[a-z0-9-]{1,64}$/;
  var root = document.documentElement;
  root.dataset.theme = choice.theme;
  if (choice.scheme && slug.test(choice.scheme)) root.dataset.scheme = choice.scheme;
  if (choice.mode && slug.test(choice.mode)) root.dataset.mode = choice.mode;
  var link = document.createElement('link');
  link.id = 'rio-theme';
  link.setAttribute('data-rio-theme', '');
  link.rel = 'stylesheet';
  link.href = '/themes/' + choice.theme + '/theme.css';
  document.head.appendChild(link);
})();
