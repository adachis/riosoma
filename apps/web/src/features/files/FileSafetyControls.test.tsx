import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { json } from '../../screens/database/share/testing';
import { renderSettings } from '../../screens/settings/testing';
import { FileSafetyControls } from './FileSafetyControls';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('shows the default policy, explains its tradeoff, and saves changes through the shared save bar', async () => {
  const changes: unknown[] = [];
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const change: unknown = JSON.parse(String(init.body));
      changes.push(change);
      return json(change);
    }
    return json({ outsideFiles: 'requireScanner', allowOutsideMacros: false });
  });
  const { container } = renderSettings(<FileSafetyControls />);
  await screen.findByText('Require a scanner');
  expect(screen.getByText(/Built-in checks alone cannot detect known viruses or other malware/)).toBeTruthy();
  const macros = (await screen.findByRole('checkbox', {
    name: 'Allow macros in outside Office files',
  })) as HTMLInputElement;
  expect(macros.checked).toBe(false);
  expect(container.querySelector('[data-setting-id="outside-files"]')).toBeTruthy();
  expect(container.querySelector('[data-setting-id="outside-macros"]')).toBeTruthy();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Files from outside the organization/ }));
  await user.click(await screen.findByRole('option', { name: 'Built-in checks only' }));
  await user.click(macros);
  expect(changes).toEqual([]);
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(changes).toEqual([{ outsideFiles: 'builtInChecksOnly', allowOutsideMacros: true }]),
  );
});
