import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from '@riosoma/ui';
import { demoPreferences, demoRefusal, isDemoSession, saveDemoPreferences, setDemoSession } from './demo';
import { sessionQuery } from './session';
import { useSavePreferences } from './screens/settings/usePreferences';
import { session } from './screens/database/share/testing';
import { openDatabase } from './data/session';
import { FakeServer } from './data/testing';
import type { SessionEvent } from './data/types';

afterEach(() => {
  cleanup();
  localStorage.clear();
  setDemoSession(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps demo appearance choices in this browser without any request or account preference change', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient();
  const identity = { ...session, demo: true, preferences: { level: 'advanced' as const } };
  client.setQueryData(sessionQuery.queryKey, identity);
  setDemoSession(identity);
  const hook = renderHook(() => useSavePreferences(), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await act(async () => {
    await hook.result.current.mutateAsync({
      theme: 'midcentury',
      mode: 'dark',
      level: null,
      recordLayout: 'panel',
    });
  });
  expect(isDemoSession()).toBe(true);
  expect(await demoPreferences(identity.preferences)).toEqual({
    theme: 'midcentury',
    mode: 'dark',
    recordLayout: 'panel',
  });
  expect(identity.preferences).toEqual({ level: 'advanced' });
  expect(fetch).not.toHaveBeenCalled();
  client.clear();
});

it('keeps preferences usable when browser storage is unavailable', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Storage unavailable');
  });
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('Storage unavailable');
  });
  saveDemoPreferences({ scheme: 'warm', level: 'simple' });
  expect(await demoPreferences()).toEqual({ scheme: 'warm', level: 'simple' });
});

it('explains repeated refusals with one calm toast every four seconds', () => {
  let now = 10_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const show = vi.spyOn(toast, 'show').mockImplementation(() => 'demo-test');
  const refusal = { info: { messageKey: 'demo.readOnly' } };
  expect(demoRefusal(refusal)).toBe(true);
  expect(demoRefusal(refusal)).toBe(true);
  expect(show).toHaveBeenCalledTimes(1);
  expect(show).toHaveBeenCalledWith(expect.objectContaining({ tone: 'info' }));
  now += 4000;
  demoRefusal(refusal);
  expect(show).toHaveBeenCalledTimes(2);
  expect(demoRefusal({ info: { messageKey: 'errors.forbidden' } })).toBe(false);
});

it('gives editors the canonical handled refusal without changing schema or sending a command', async () => {
  vi.spyOn(toast, 'show').mockImplementation(() => 'demo-test');
  setDemoSession({ ...session, demo: true });
  const server = new FakeServer();
  const fixture = server.createDatabase(0);
  const database = await openDatabase(fixture.databaseId, server.deps());
  const events: SessionEvent[] = [];
  const unsubscribe = database.subscribeEvents((event) => events.push(event));
  try {
    const before = database.getSchema().fieldById.get(fixture.textFieldId)?.name;
    const requests = server.requests.length;
    const outcome = await database.run([
      { kind: 'field.update', fieldId: fixture.textFieldId, name: 'Unsaved field' },
    ]).done;
    expect(outcome).toEqual({ applied: 0, rejected: 1 });
    expect(events).toEqual([{ kind: 'rejected', handled: true, messageKey: 'demo.readOnly' }]);
    expect(database.getSchema().fieldById.get(fixture.textFieldId)?.name).toBe(before);
    expect(server.requests).toHaveLength(requests);
  } finally {
    unsubscribe();
    database.close();
  }
});
