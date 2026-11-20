import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { Level, OrgSettings, Preferences, SessionInfo } from '@riosoma/contracts';
import { ConfirmProvider, ToastRegion } from '@riosoma/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { I18nProvider as LocaleProvider } from 'react-aria-components';
import { sessionQuery, useSession } from '../session';
import { patchTreeWalkerPreviousNode } from '../../../../packages/ui/src/test/tree-walker';
import { LevelProvider } from './context';

patchTreeWalkerPreviousNode();

export interface PersonOptions {
  kind?: SessionInfo['membership']['kind'];
  level?: Level;
  settings?: OrgSettings;
  preferences?: Preferences;
  adminRoles?: string[];
}

/** A JSON answer, as the server gives one */
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

/** Someone signed in, at a level of their own choosing or at the one their kind starts at. */
export function personAt({
  kind = 'member',
  level,
  settings = {},
  preferences = {},
  adminRoles = [],
}: PersonOptions = {}): SessionInfo {
  return {
    user: { id: 'usr_level_person', name: 'Ada', email: 'ada@example.com', locale: 'en-US' },
    org: { id: 'org_test', name: 'Garden', settings },
    membership: { kind, adminRoles },
    preferences: { ...preferences, ...(level ? { level } : {}) },
    csrfToken: 'session-csrf',
  };
}

/** The level of whoever is signed in now, following their session as it changes, as the shell does. */
export function LiveLevel({ children }: { children: ReactNode }) {
  const session = useSession();
  return session ? <LevelProvider session={session}>{children}</LevelProvider> : <>{children}</>;
}

/** Renders inside the providers a signed-in screen has, for a person at a level. */
export function renderAtLevel(children: ReactNode, person: SessionInfo = personAt()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(sessionQuery.queryKey, person);
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  const result = render(
    <I18nProvider i18n={i18n}>
      <LocaleProvider locale="en-US">
        <QueryClientProvider client={client}>
          <ConfirmProvider>
            <LiveLevel>{children}</LiveLevel>
          </ConfirmProvider>
          <ToastRegion />
        </QueryClientProvider>
      </LocaleProvider>
    </I18nProvider>,
  );
  return { ...result, client };
}

/** A fetch that answers preference saves the way the server does, and records every request. */
export function preferencesServer(person: SessionInfo) {
  let saved: Preferences = { ...person.preferences };
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ url, method: init?.method ?? 'GET', body });
    const headers = { 'content-type': 'application/json' };
    if (url === '/api/me/preferences') {
      // As on the server, a null clears a preference.
      const next: Record<string, unknown> = { ...saved, ...(body as object) };
      for (const [key, value] of Object.entries(next)) if (value === null) delete next[key];
      saved = next as Preferences;
      return new Response(JSON.stringify(saved), { headers });
    }
    if (url === '/api/admin/levels') {
      return new Response(JSON.stringify({ ...person.org.settings, ...(body as object) }), { headers });
    }
    return new Response(JSON.stringify(null), { headers });
  };
  return { fetcher, requests };
}
