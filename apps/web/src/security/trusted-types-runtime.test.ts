import { beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());

it('keeps ordinary attributes available and rejects HTML until the sanitizer loads', async () => {
  const runtime = await import('./trusted-types-runtime');
  const image = document.createElement('img');
  runtime.setRuntimeAttribute(image, 'src', '/api/files/photo');
  expect(image.getAttribute('src')).toBe('/api/files/photo');
  expect(() => runtime.runtimeHTML('<p>Raw</p>')).toThrow('The HTML sanitizer has not loaded');
  expect(() => runtime.setRuntimeAttribute(document.createElement('iframe'), 'srcdoc', '<p>Raw</p>')).toThrow(
    'The attribute sanitizer has not loaded',
  );
  expect(() =>
    runtime.setRuntimeAttribute(document.createElement('script'), 'src', '/assets/entry.js'),
  ).toThrow('The attribute sanitizer has not loaded');
});

it('uses the central policies after their lazy module loads', async () => {
  const runtime = await import('./trusted-types-runtime');
  await import('./trusted-types');
  expect(runtime.runtimeHTML('<p onclick="attack()">Safe</p>')).toBe('<p>Safe</p>');
  const frame = document.createElement('iframe');
  runtime.setRuntimeAttribute(frame, 'srcdoc', '<h1>Safe</h1><script>attack()</script>');
  expect(frame.getAttribute('srcdoc')).toContain('<h1>Safe</h1>');
  expect(frame.getAttribute('srcdoc')).not.toContain('<script');
  expect(() =>
    runtime.setRuntimeAttribute(document.createElement('script'), 'src', 'https://evil.test/code.js'),
  ).toThrow('Unapproved script URL');
});
