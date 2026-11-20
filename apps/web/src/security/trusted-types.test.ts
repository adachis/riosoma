import { afterEach, describe, expect, it, vi } from 'vitest';
import { trustedAttribute, trustedDocument, trustedHTML, trustedScriptURL } from './trusted-types';

const key = Symbol.for('rio.trusted-types');
const scriptKey = Symbol.for('rio.trusted-types.script-url');
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, key);
  Reflect.deleteProperty(window, scriptKey);
});

describe('Trusted Types boundaries', () => {
  it('sanitizes clipboard HTML, SVG, and map attribution without browser support', () => {
    const html = trustedHTML(
      '<p onclick="attack()">Text<a href="javascript:attack()">link</a></p><script>attack()</script>',
    );
    expect(html).toBe('<p>Text<a>link</a></p>');
    expect(trustedHTML('<svg onload="attack()"><path d="M0 0L1 1"/></svg>')).toContain('<path');
    expect(trustedHTML('<svg onload="attack()"><path d="M0 0L1 1"/></svg>')).not.toContain('onload');
    expect(trustedHTML('<table><tr><td data-rio-file-ids="[]">File</td></tr></table>')).toContain(
      'data-rio-file-ids="[]"',
    );
  });

  it('keeps sandboxed preview document structure while removing executable content and refreshes', () => {
    const document = trustedDocument(
      `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src 'none'"><meta http-equiv="refresh" content="0;url=/api"><link rel="stylesheet" href="/theme.css"></head><body><h1>Preview</h1><script>attack()</script></body></html>`,
    );
    expect(document).toContain('<html><head>');
    expect(document).toContain('Content-Security-Policy');
    expect(document).toContain('<link rel="stylesheet" href="/theme.css">');
    expect(document).toContain('<h1>Preview</h1>');
    expect(document).not.toContain('http-equiv="refresh"');
    expect(document).not.toContain('<script');
  });

  it('allows only shipped scripts and the exact Picker entry point', () => {
    for (const input of ['/sw.js', '/assets/worker-a12.js', 'https://apis.google.com/js/api.js'])
      expect(trustedScriptURL(input)).toBe(input);
    for (const input of [
      'javascript:attack()',
      'data:text/javascript,attack()',
      'blob:https://example.com/worker',
      '//evil.test/worker.js',
      '/api/files/a.js',
      '/sw.js?other',
      'https://apis.google.com/js/api.js?other',
    ])
      expect(() => trustedScriptURL(input)).toThrow('Unapproved script URL');
  });

  it('reuses policies across module reloads and never creates a default policy', async () => {
    const createPolicy = vi.fn((name: string, rules: Record<string, (input: string) => string>) => ({
      name,
      createHTML: (input: string) => rules.createHTML?.(input),
      createScriptURL: (input: string) => rules.createScriptURL?.(input),
    }));
    vi.stubGlobal('trustedTypes', { createPolicy, isHTML: () => false });
    trustedHTML('<p>Text</p>');
    trustedScriptURL('/sw.js');
    vi.resetModules();
    const reloaded = await import('./trusted-types');
    reloaded.trustedHTML('<p>Text</p>');
    reloaded.trustedScriptURL('/sw.js');
    expect(createPolicy.mock.calls.map(([name]) => name)).toEqual([
      'rio-sanitizer',
      'rio-html',
      'rio-script-url',
    ]);
    const parser = createPolicy.mock.results[0]!.value;
    expect(() => parser.createScriptURL('/sw.js')).toThrow('The sanitizer cannot load scripts');
  });
});

it('protects generic attributes according to the element and attribute name', () => {
  const script = document.createElement('script');
  const image = document.createElement('img');
  const frame = document.createElement('iframe');
  expect(trustedAttribute(script, 'SRC', '/assets/worker.js')).toBe('/assets/worker.js');
  expect(() => trustedAttribute(script, 'src', 'https://evil.test/script.js')).toThrow(
    'Unapproved script URL',
  );
  expect(() => trustedAttribute(script, 'text', 'attack()')).toThrow('Executable script text is disabled');
  expect(trustedAttribute(image, 'src', '/api/files/image')).toBe('/api/files/image');
  expect(trustedAttribute(image, 'aria-label', 'Preview of photo')).toBe('Preview of photo');
  expect(trustedAttribute(frame, 'srcdoc', '<h1>Safe</h1><script>attack()</script>')).toContain(
    '<h1>Safe</h1>',
  );
  expect(trustedAttribute(frame, 'srcdoc', '<script>attack()</script>')).not.toContain('<script');
});
