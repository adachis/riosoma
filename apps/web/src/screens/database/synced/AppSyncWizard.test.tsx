import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../../api';
import type * as ApiModule from '../../../api';
import type { DatabaseSession } from '../../../data';
import { sourceMeta, ENDPOINT_PREVIEW } from '../../settings/sources/testing';
import {
  TEST_APP_CATALOG,
  TEST_APP_MESSAGES,
  TEST_APP_OBJECTS,
} from '../../settings/sources/app-catalog.test-support';
import { SyncWizard } from './SyncWizard';
import { patchTreeWalkerPreviousNode } from '../../../../../../packages/ui/src/test/tree-walker';

vi.mock('../../../api', async (original) => ({
  ...(await original<typeof ApiModule>()),
  api: vi.fn(),
}));
patchTreeWalkerPreviousNode();
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

it('tests and saves a catalog app, lists preset and discovered objects, and previews a found object', async () => {
  const saved = sourceMeta({ kind: 'app', name: 'Garden data', connection: null, secrets: ['apiKey'] });
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === '/api/sources/test')
      return { ok: true, steps: [{ step: 'authenticate', status: 'ok', ms: 1 }] } as never;
    if (path === '/api/sources') return saved as never;
    if (path.endsWith('/objects')) return TEST_APP_OBJECTS as never;
    if (path.endsWith('/preview')) return ENDPOINT_PREVIEW as never;
    throw new Error(path);
  });
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': TEST_APP_MESSAGES } });
  render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <SyncWizard
          appCatalog={TEST_APP_CATALOG}
          sources={[]}
          admin
          session={{} as DatabaseSession}
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Connect a new data source' }));
  await user.click(screen.getByRole('option', { name: /^Garden Forms(?: |$)/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Garden data' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Workspace code' }), { target: { value: 'AB' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Account address' }), {
    target: { value: 'https://garden.example.com' },
  });
  await user.click(screen.getByRole('button', { name: /Region/ }));
  await user.click(screen.getByRole('option', { name: /^west(?: |$)/ }));
  fireEvent.change(screen.getByLabelText('Key', { selector: 'input' }), {
    target: { value: ['stand', 'in', 'key'].join('-') },
  });
  await user.click(screen.getByRole('button', { name: 'Test connection' }));
  await screen.findByText('Connected.');
  await user.click(screen.getByRole('button', { name: 'Save and continue' }));
  for (const object of TEST_APP_OBJECTS)
    expect(
      await screen.findByRole('option', {
        name: (accessibleName) =>
          accessibleName === object.label || accessibleName.startsWith(`${object.label} `),
      }),
    ).toBeDefined();
  expect(screen.queryByRole('radio', { name: 'Query' })).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Search objects' })).toBeDefined();
  await user.click(screen.getByRole('option', { name: /^Spring registration(?: |$)/ }));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect((await screen.findByRole('table', { name: 'Preview' })).textContent).toContain('Ada');
  await waitFor(() =>
    expect(vi.mocked(api).mock.calls.find(([path]) => path.endsWith('/preview'))?.[1]?.body).toEqual({
      select: { kind: 'object', object: { schema: null, name: 'forms/spring' } },
    }),
  );
});
