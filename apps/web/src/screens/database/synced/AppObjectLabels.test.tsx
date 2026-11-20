import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { SourceObject } from '@riosoma/contracts';
import { api } from '../../../api';
import type * as ApiModule from '../../../api';
import type { DatabaseSession } from '../../../data';
import { sourceMeta, ENDPOINT_PREVIEW } from '../../settings/sources/testing';
import { serverMessage } from '../../../messages/shellMessage';
import { patchTreeWalkerPreviousNode } from '../../../../../../packages/ui/src/test/tree-walker';
import { SyncWizard } from './SyncWizard';

vi.mock('../../../api', async (original) => ({
  ...(await original<typeof ApiModule>()),
  api: vi.fn(),
}));
patchTreeWalkerPreviousNode();
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('translates static and discovered app labels while preserving account names and selection IDs', async () => {
  const objects: SourceObject[] = [
    {
      schema: null,
      name: 'projects',
      type: 'endpoint',
      rowEstimate: null,
      labelMessageId: 'sources.app.gitlab.projects',
    },
    {
      schema: null,
      name: 'project-1/issues',
      type: 'endpoint',
      rowEstimate: null,
      labelMessageId: 'sources.app.gitlab.issues',
      labelParams: { parent: 'sample/Example project' },
    },
    {
      schema: null,
      name: 'user-1',
      label: 'Example Person',
      type: 'endpoint',
      rowEstimate: null,
      labelMessageId: 'sources.app.zoom.meetings',
      labelParams: { parent: 'Example Person' },
    },
  ];
  vi.mocked(api).mockImplementation(
    async (path) => (path.endsWith('/preview') ? ENDPOINT_PREVIEW : objects) as never,
  );
  const i18n = setupI18n({
    locale: 'es',
    messages: {
      es: {
        'sources.app.gitlab.projects': 'Proyectos',
        'sources.app.gitlab.issues': '{parent}: incidencias',
        'sources.app.zoom.meetings': '{label}: reuniones',
      },
    },
  });
  render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <SyncWizard
          sources={[sourceMeta({ kind: 'app', name: 'Project data', connection: null })]}
          admin
          session={{} as DatabaseSession}
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Choose a data source/ }));
  await user.click(screen.getByRole('option', { name: /^Project data(?: |$)/ }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(false),
  );
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(await screen.findByRole('option', { name: /^Proyectos(?: |$)/ })).toBeDefined();
  expect(screen.getByRole('option', { name: /^sample\/Example project: incidencias(?: |$)/ })).toBeDefined();
  expect(screen.getByRole('option', { name: /^Example Person: reuniones(?: |$)/ })).toBeDefined();
  await user.click(screen.getByRole('option', { name: /^sample\/Example project: incidencias(?: |$)/ }));
  expect(
    screen
      .getByRole('option', { name: /^sample\/Example project: incidencias(?: |$)/ })
      .getAttribute('aria-selected'),
  ).toBe('true');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(vi.mocked(api).mock.calls.at(-1)?.[1]?.body).toEqual({
    select: { kind: 'object', object: { schema: null, name: 'project-1/issues' } },
  });
});

it('translates permission advice and its object label without inventing an Okta permission', () => {
  const i18n = setupI18n({
    locale: 'en-US',
    messages: {
      'en-US': {
        'sources.app.okta.applications': 'Applications',
        'sources.app.gitlab.issues': '{parent} issues',
        'sources.app.zoom.meetings': '{label} meetings',
      },
    },
  });
  expect(
    serverMessage(i18n, 'sources.app.okta.objectNotAllowed', {
      object: 'applications',
      objectMessageId: 'sources.app.okta.applications',
      permission: '',
      hasPermission: false,
    }),
  ).toBe('The token’s admin cannot read Applications.');
  expect(
    serverMessage(i18n, 'sources.app.objectNotAllowed', {
      object: 'project-1/issues',
      objectMessageId: 'sources.app.gitlab.issues',
      parent: 'sample/Example project',
      permission: 'api, read_api',
      hasPermission: true,
    }),
  ).toBe('The key cannot read sample/Example project issues.  Required permissions: api, read_api.');
  expect(
    serverMessage(i18n, 'sources.app.objectNotAllowed', {
      object: 'user-1',
      objectMessageId: 'sources.app.zoom.meetings',
      parent: 'Example Person',
      permission: 'meeting:read:list_meetings:admin',
      hasPermission: true,
    }),
  ).toBe(
    'The key cannot read Example Person meetings.  Required permissions: meeting:read:list_meetings:admin.',
  );
});
