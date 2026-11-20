import type * as Router from '@tanstack/react-router';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { json, renderSharing, session } from '../screens/database/share/testing';
import { sessionQuery } from '../session';
import { ReauthenticationDialog } from './ReauthenticationDialog';
import { api, ApiError } from '../api';
import { openDatabase } from '../data/session';
import { FakeServer } from '../data/testing';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof Router>()),
  useNavigate: () => navigate,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function start(result = session) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/auth/methods') return json({ password: true, link: true, passkey: false });
      if (url === '/api/auth/second-step') return json({ secondStep: null });
      return json(result);
    }),
  );
  return renderSharing(<ReauthenticationDialog identity={session} />, null);
}

it('resumes the same account without navigating away or allowing a different email', async () => {
  const { client } = start();
  const user = userEvent.setup();
  const email = await screen.findByLabelText('Email address');
  expect((email as HTMLInputElement).readOnly).toBe(true);
  expect((email as HTMLInputElement).value).toBe(session.user.email);
  await user.click(screen.getByLabelText(/^Password/));
  await user.paste('密碼 📚 كلمة مرور');
  await user.keyboard('{Enter}');
  await waitFor(() => expect(client.getQueryData(sessionQuery.queryKey)).toEqual(session));
  expect(navigate).not.toHaveBeenCalled();
});

it('checks a sign-in completed in another tab without leaving the draft', async () => {
  const { client } = start();
  await userEvent.click(await screen.findByRole('button', { name: 'I signed in in another tab' }));
  await waitFor(() => expect(client.getQueryData(sessionQuery.queryKey)).toEqual(session));
  expect(navigate).not.toHaveBeenCalled();
});

it.each(['person', 'organization'])(
  'reloads before a different %s can inherit the draft',
  async (difference) => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    const other =
      difference === 'person'
        ? { ...session, user: { ...session.user, id: 'other-user' } }
        : { ...session, org: { ...session.org, id: 'other-organization' } };
    const { client } = start(other);
    await userEvent.click(await screen.findByRole('button', { name: 'I signed in in another tab' }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(client.getQueryData(sessionQuery.queryKey)).toBeNull();
  },
);

it('recovers retained database saves after the same person signs back in and deliberately edits again', async () => {
  const server = new FakeServer();
  const fixture = server.createDatabase();
  const identity = { ...session, user: { ...session.user, id: server.userId } };
  const { client } = start(identity);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options: RequestInit) => {
      if (path.startsWith('/api/auth/')) {
        if (path === '/api/auth/methods') return json({ password: true, link: true, passkey: false });
        if (path === '/api/auth/second-step') return json({ secondStep: null });
        return json(identity);
      }
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
  const database = await openDatabase(fixture.databaseId, server.deps({ http: api }));
  try {
    server.failNext(401, '/commands');
    database.run([{ kind: 'database.update', name: 'Private draft' }]);
    await waitFor(() => expect(database.saveState().status).toBe('error'));
    // The dialog must compare the identity that owned this database session.
    cleanup();
    const rendered = renderSharing(<ReauthenticationDialog identity={identity} />, null);
    await userEvent.click(await screen.findByRole('button', { name: 'I signed in in another tab' }));
    await waitFor(() => expect(rendered.client.getQueryData(sessionQuery.queryKey)).toEqual(identity));
    expect(server.requests.filter((request) => request.path.endsWith('/commands'))).toHaveLength(1);
    expect(database.getSchema().database.name).toBe('Private draft');
    database.run([{ kind: 'database.update', name: 'Retried draft' }]);
    await waitFor(() =>
      expect(server.requests.filter((request) => request.path.endsWith('/commands'))).toHaveLength(2),
    );
    await waitFor(() => expect(database.saveState().pending).toBe(0));
    expect(server.database(fixture.databaseId).schema.database.name).toBe('Retried draft');
  } finally {
    database.close();
    client.clear();
  }
});
