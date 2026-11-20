import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { activateLocale, i18n } from '../i18n';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { I18nProvider } from '@lingui/react';
import { ErrorBanner } from '../shell/ShellErrorBanner';
import { errorInfo } from './errorInfo';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('keeps denied background update requests from loading feature translations', async () => {
  await activateLocale('en-US');
  const load = vi.spyOn(i18n, 'load');
  const error = { code: 'forbidden', messageKey: 'errors.adminOnly', userFault: true };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error }, { status: 403 })),
  );

  await expect(api('/api/admin/updates')).rejects.toMatchObject({ status: 403, info: error });

  expect(load).not.toHaveBeenCalled();
});

it('loads the specific translation when a shell error is displayed', async () => {
  await activateLocale('en-US');
  render(
    createElement(I18nProvider, {
      i18n,
      children: createElement(ErrorBanner, { error: { key: 'errors.adminOnly' } }),
    }),
  );
  expect(await screen.findByText('Only an administrator can do that.')).toBeTruthy();
});

it('omits demo refusal banners, including their error references', async () => {
  await activateLocale('en-US');
  const { container } = render(
    createElement(I18nProvider, {
      i18n,
      children: createElement(ErrorBanner, { error: { key: 'demo.readOnly', reference: 'demo-request' } }),
    }),
  );
  expect(container.querySelector('.rio-banner')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(/demo-request/)).toBeNull();
});

it('omits demo refusals from shared inline error presentation', () => {
  const refusal = new ApiError(403, {
    code: 'forbidden',
    messageKey: 'demo.readOnly',
    userFault: true,
    reference: 'demo-request',
  });
  expect(errorInfo(refusal)).toBeNull();
  expect(errorInfo(new ApiError(403, { ...refusal.info, messageKey: 'errors.adminOnly' }))).toEqual({
    key: 'errors.adminOnly',
    reference: 'demo-request',
  });
});
