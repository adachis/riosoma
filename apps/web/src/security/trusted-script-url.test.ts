import { afterEach, describe, expect, it, vi } from 'vitest';
import { trustedScriptURL } from './trusted-script-url';

const key = Symbol.for('rio.trusted-types.script-url');
const htmlKey = Symbol.for('rio.trusted-types');
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, key);
  Reflect.deleteProperty(window, htmlKey);
});

function policyFactory() {
  return vi.fn((name: string, rules: Record<string, (input: string) => string>) => ({
    name,
    createHTML: (input: string) => rules.createHTML?.(input),
    createScriptURL: (input: string) => rules.createScriptURL?.(input),
  }));
}

// The window cache is a non-configurable property, so each creation-order test gets its own
// window instead of trying to delete the previous test's policies.
function stubWindow(createPolicy: ReturnType<typeof policyFactory>) {
  vi.stubGlobal('window', {
    location: { href: 'https://riosoma.test/', origin: 'https://riosoma.test' },
    trustedTypes: { createPolicy, isHTML: () => false },
  });
}

describe('script URL boundary', () => {
  it('accepts the service worker and a shipped asset without browser support', () => {
    for (const input of ['/sw.js', '/assets/worker-a12.js']) expect(trustedScriptURL(input)).toBe(input);
  });

  it('rejects cross-origin, queried, hashed, and unshipped script URLs', () => {
    for (const input of [
      'https://evil.test/worker.js',
      '//evil.test/worker.js',
      '/sw.js?other',
      '/assets/worker-a12.js?other',
      '/sw.js#fragment',
      '/api/files/a.js',
      '/elsewhere/worker.js',
    ])
      expect(() => trustedScriptURL(input)).toThrow('Unapproved script URL');
  });

  it('creates rio-script-url once when the script module loads before the sanitizer', async () => {
    const createPolicy = policyFactory();
    stubWindow(createPolicy);
    expect(trustedScriptURL('/sw.js')).toBe('/sw.js');
    vi.resetModules();
    const scripts = await import('./trusted-script-url');
    const html = await import('./trusted-types');
    expect(scripts.trustedScriptURL('/assets/worker-a12.js')).toBe('/assets/worker-a12.js');
    // Loading the sanitizer module afterward must reuse the cached script policy.
    expect(html.trustedScriptURL('/sw.js')).toBe('/sw.js');
    html.trustedHTML('<p>Text</p>');
    expect(createPolicy.mock.calls.map(([name]) => name)).toEqual([
      'rio-script-url',
      'rio-sanitizer',
      'rio-html',
    ]);
  });

  it('creates rio-script-url once when the sanitizer module loads first', async () => {
    const createPolicy = policyFactory();
    stubWindow(createPolicy);
    vi.resetModules();
    const html = await import('./trusted-types');
    const scripts = await import('./trusted-script-url');
    expect(html.trustedScriptURL('/sw.js')).toBe('/sw.js');
    expect(scripts.trustedScriptURL('/assets/worker-a12.js')).toBe('/assets/worker-a12.js');
    html.trustedHTML('<p>Text</p>');
    expect(createPolicy.mock.calls.map(([name]) => name)).toEqual([
      'rio-script-url',
      'rio-sanitizer',
      'rio-html',
    ]);
  });
});
