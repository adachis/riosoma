import { act, cleanup, render, screen } from '@testing-library/react';
import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DocsWindow } from './DocsWindow';

const positionKey = 'rio-docs-window-position';

afterEach(() => {
  cleanup();
  localStorage.removeItem(positionKey);
  vi.unstubAllGlobals();
});

it.each([
  { width: 390, height: 844 },
  { width: 800, height: 480 },
])('restores saved desktop geometry after opening at $width by $height', ({ width, height }) => {
  const saved = { x: 200, y: 100, width: 600, height: 500 };
  localStorage.setItem(positionKey, JSON.stringify(saved));
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('innerHeight', height);
  render(
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
      <DocsWindow>{null}</DocsWindow>
    </I18nProvider>,
  );
  const window = screen.getByRole('region', { name: 'Documentation window' });
  expect(Number.parseFloat(window.style.width)).toBeLessThanOrEqual(width);
  expect(Number.parseFloat(window.style.height)).toBeLessThanOrEqual(height);
  act(() => {
    vi.stubGlobal('innerWidth', 1280);
    vi.stubGlobal('innerHeight', 900);
    globalThis.window.dispatchEvent(new Event('resize'));
  });
  expect({
    x: Number.parseFloat(window.style.left),
    y: Number.parseFloat(window.style.top),
    width: Number.parseFloat(window.style.width),
    height: Number.parseFloat(window.style.height),
  }).toEqual(saved);
  expect(JSON.parse(localStorage.getItem(positionKey)!)).toEqual(saved);
});
