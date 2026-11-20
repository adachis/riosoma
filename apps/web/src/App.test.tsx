import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { toast } from '@riosoma/ui';
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import { openDatabase } from './data/session';
import { FakeServer } from './data/testing';
import { json, session } from './screens/database/share/testing';
import { sessionQuery } from './session';

const { offerUpdate } = await import('./pwa');
const { createAppContext, UpdatePrompt } = await import('./App');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['read', 'write'])(
  'reports a database %s authentication failure outside the query caches',
  async (request) => {
    const server = new FakeServer();
    const fixture = server.createDatabase();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, options: RequestInit) => {
        try {
          return json(
            await server.http(path, {
              method: options.method as 'GET' | 'POST',
              ...(options.body ? { body: JSON.parse(String(options.body)) } : {}),
            }),
          );
        } catch (error) {
          if (error instanceof ApiError) return json({ error: error.info }, error.status);
          throw error;
        }
      }),
    );
    const { queryClient } = createAppContext();
    queryClient.setQueryData(sessionQuery.queryKey, session);
    const database = await openDatabase(fixture.databaseId, server.deps({ http: api }));
    try {
      server.failNext(401, request === 'read' ? '/records/search' : '/commands');
      if (request === 'read') {
        await expect(database.searchRecords(fixture.tableId, 'Record')).rejects.toMatchObject({
          status: 401,
        });
      } else {
        database.run([{ kind: 'database.update', name: 'Retained draft' }]);
        await waitFor(() => expect(database.saveState().status).toBe('error'));
      }
      expect(queryClient.getQueryData(sessionQuery.queryKey)).toBeNull();
    } finally {
      database.close();
      queryClient.clear();
    }
  },
);

it('offers the same waiting update once when a catalog change resubscribes the prompt', async () => {
  const show = vi.spyOn(toast, 'show').mockReturnValue('update');
  const apply = vi.fn(async () => {});
  await offerUpdate(
    {
      controller: {} as ServiceWorker,
      getRegistration: vi.fn(async () => ({ waiting: {} }) as ServiceWorkerRegistration),
    },
    apply,
  );
  const first = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  const second = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  const { rerender } = render(
    <I18nProvider i18n={first}>
      <UpdatePrompt />
    </I18nProvider>,
  );
  await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
  rerender(
    <I18nProvider i18n={second}>
      <UpdatePrompt />
    </I18nProvider>,
  );
  expect(show).toHaveBeenCalledTimes(1);
});
