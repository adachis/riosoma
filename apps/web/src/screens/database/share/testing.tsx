import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { SessionInfo } from '@riosoma/contracts';
import { sessionQuery } from '../../../session';
import { patchTreeWalkerPreviousNode } from '../../../../../../packages/ui/src/test/tree-walker';

patchTreeWalkerPreviousNode();

export const session: SessionInfo = {
  user: { id: 'user_ada', name: 'Ada', email: 'ada@example.com', locale: 'en-US' },
  org: { id: 'org_test', name: 'Garden', settings: {} },
  membership: { kind: 'owner', adminRoles: [] },
  preferences: {},
  csrfToken: 'session-csrf',
};

export function renderSharing(children: ReactNode, identity: SessionInfo | null = session) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(sessionQuery.queryKey, identity);
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  const result = render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </I18nProvider>,
  );
  return { ...result, client };
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

export function failure(messageKey: string, status = 400): Response {
  return json({ error: { code: 'forbidden', messageKey, userFault: true } }, status);
}
