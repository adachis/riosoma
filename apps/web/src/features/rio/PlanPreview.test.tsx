import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { FakeServer } from '../../data/testing';
import { endSandbox, inSandbox } from '../../data/sandbox';
import { json, renderSharing } from '../../screens/database/share/testing';
import { PLAN_APPLIED, PlanPreview } from './PlanPreview';

afterEach(() => {
  cleanup();
  endSandbox();
  vi.unstubAllGlobals();
});

it.each(['offline', 'server'])('keeps a failed %s approval reviewable and allows retry', async (failure) => {
  const server = new FakeServer();
  const f = server.createDatabase(0);
  const snapshot = {
    schema: server.database(f.databaseId).schema,
    targets: [],
    dashboards: {},
    interfaces: {},
    records: {},
    views: {},
    rowLimit: 200,
  };
  let attempts = 0;
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes('/preview')) return json(snapshot);
    if (url.endsWith('/apply')) {
      if (++attempts === 1) {
        if (failure === 'offline') throw new TypeError('Connection lost');
        return json({ error: { code: 'internal', messageKey: 'errors.internal' } }, 500);
      }
      return json({ kind: 'receipt', planId: 'pending-plan', groupId: 'saved-action' });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const root = createRootRoute({ component: PlanPreview });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/?rioPreview=pending-plan'] }),
  });
  const app = renderSharing(<RouterProvider router={router} />);
  const user = userEvent.setup();
  const applied = vi.fn();
  window.addEventListener(PLAN_APPLIED, applied);
  try {
    const apply = await screen.findByRole('button', { name: 'Apply' });
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
    expect(inSandbox()).toBe(true);
    await user.click(apply);
    await screen.findByRole('alert');
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
    expect(inSandbox()).toBe(true);
    expect(attempts).toBe(1);
    await user.click(apply);
    await waitFor(() => expect(applied).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(attempts).toBe(2);
    expect(inSandbox()).toBe(false);
  } finally {
    window.removeEventListener(PLAN_APPLIED, applied);
    app.client.clear();
  }
});

it('recovers the receipt when approval saves but its response is lost', async () => {
  const server = new FakeServer();
  const f = server.createDatabase(0);
  const snapshot = {
    schema: server.database(f.databaseId).schema,
    targets: [],
    dashboards: {},
    interfaces: {},
    records: {},
    views: {},
    rowLimit: 200,
  };
  const receipt = { kind: 'receipt', planId: 'saved-plan', groupId: 'saved-action' };
  let saved = false;
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes('/preview'))
      return saved
        ? json({ error: { code: 'conflict', messageKey: 'rio.plan.stale', userFault: true } }, 409)
        : json(snapshot);
    if (url.endsWith('/apply')) {
      if (saved) return json(receipt);
      saved = true;
      throw new TypeError('Response lost');
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const root = createRootRoute({ component: PlanPreview });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/?rioPreview=saved-plan'] }),
  });
  const app = renderSharing(<RouterProvider router={router} />);
  const applied = vi.fn();
  window.addEventListener(PLAN_APPLIED, applied);
  try {
    const apply = await screen.findByRole('button', { name: 'Apply' });
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
    await userEvent.setup().click(apply);
    await waitFor(() => expect(applied).toHaveBeenCalledTimes(1));
    expect(applied.mock.calls[0]![0].detail).toEqual(receipt);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(inSandbox()).toBe(false);
  } finally {
    window.removeEventListener(PLAN_APPLIED, applied);
    app.client.clear();
  }
});
