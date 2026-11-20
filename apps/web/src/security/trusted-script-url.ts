// The script-URL policy stays separate from the HTML sanitizer so a cold home screen can
// register the service worker without loading parse5 or DOMPurify.

interface Policy {
  createScriptURL(input: string): string;
}
interface Factory {
  createPolicy(name: string, rules: { createScriptURL(input: string): string }): Policy;
}
interface Policies {
  scripts: Policy;
}

const key = Symbol.for('rio.trusted-types.script-url');

function factory(): Factory | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window as Window & { trustedTypes?: Factory }).trustedTypes;
}

function scriptAddress(input: string): string {
  const url = new URL(input, window.location.href);
  if (url.href === 'https://apis.google.com/js/api.js') return input;
  if (url.origin !== window.location.origin || url.username || url.password || url.hash)
    throw new TypeError('Unapproved script URL');
  if (url.pathname === '/sw.js' && !url.search) return input;
  if (/^\/assets\/[\w.-]+\.js$/.test(url.pathname) && !url.search) return input;
  if (
    import.meta.env.DEV &&
    /\/(?:rowsWorker\.ts|maplibre-gl-worker\.mjs)$/.test(url.pathname) &&
    url.searchParams.has('worker_file')
  )
    return input;
  throw new TypeError('Unapproved script URL');
}

function policies(tt: Factory): Policies {
  const cached = Reflect.get(window, key) as Policies | undefined;
  if (cached) return cached;
  const value = { scripts: tt.createPolicy('rio-script-url', { createScriptURL: scriptAddress }) };
  Object.defineProperty(window, key, { value });
  return value;
}

/** Only shipped scripts and the Picker entry point can receive an execution capability. */
export function trustedScriptURL(input: string | URL): string {
  const source = scriptAddress(String(input));
  const tt = factory();
  return tt ? (policies(tt).scripts.createScriptURL(source) as unknown as string) : source;
}
