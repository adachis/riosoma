import { renderSettings as renderSharing } from '../../screens/settings/testing';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteServerConfig, type RemoteServer } from '@riosoma/contracts';
import { json } from '../../screens/database/share/testing';
import { RemoteTools } from './RemoteTools';

const clients: Array<() => void> = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

function connection(allowPrivate: boolean): RemoteServer {
  return {
    id: crypto.randomUUID(),
    config: RemoteServerConfig.parse({
      name: 'Outside',
      address: 'https://tools.example.com/mcp',
      auth: 'none',
      allowPrivate,
      audience: { everyone: true },
    }),
    tools: [],
    revision: 2,
    refreshedAt: null,
    errorKey: null,
    hasCredential: false,
    skippedTools: [],
  };
}

async function open(server: RemoteServer) {
  window.history.replaceState(null, '', `/settings/ai?tab=tools&server=${server.id}`);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/audiences')
        ? json({ groups: [], units: [], privateHostsAllowed: false, localDevelopment: false })
        : json([server]),
    ),
  );
  const view = renderSharing(<RemoteTools />);
  clients.push(() => view.client.clear());
  await screen.findByRole('textbox', { name: 'Server name' });
  await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(2));
}

it('keeps a saved private network switch visible after the operator stops allowing private hosts', async () => {
  await open(connection(true));
  const toggle = await screen.findByRole('switch', { name: 'Allow private network addresses' });
  expect((toggle as HTMLInputElement).checked).toBe(true);
});

it('hides the private network switch when it is off and the operator does not allow it', async () => {
  await open(connection(false));
  expect(screen.queryByRole('switch', { name: 'Allow private network addresses' })).toBeNull();
});

it('reopens a connection after its form was closed', async () => {
  const server = connection(false);
  await open(server);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('textbox', { name: 'Server name' })).toBeNull();
  await user.click(screen.getByRole('link', { name: server.config.name }));
  expect(await screen.findByRole('textbox', { name: 'Server name' })).toBeTruthy();
});

it('preserves an unsaved draft and its revision when another administrator saves the connection', async () => {
  const server = connection(false);
  await open(server);
  const user = userEvent.setup();
  const name = screen.getByRole('textbox', { name: 'Server name' });
  await user.clear(name);
  await user.type(name, '未保存 🧭 مسودة');
  const changed = { ...server, revision: server.revision + 1, config: { ...server.config, name: 'Updated' } };
  let saved: { revision: number; config: { name: string } } | undefined;
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/commands')) {
      saved = JSON.parse(String(init?.body)) as typeof saved;
      return json({});
    }
    return json([changed]);
  });
  window.dispatchEvent(new Event('remoteToolsChanged'));
  await screen.findByRole('link', { name: 'Updated' });
  expect((name as HTMLInputElement).value).toBe('未保存 🧭 مسودة');
  expect(screen.getByRole('textbox', { name: 'Server name' })).toBe(name);
  await user.click(screen.getByRole('button', { name: /^Save$/ }));
  expect(saved).toBeUndefined();
  expect(screen.getByRole('button', { name: 'Reload stored values' })).toBeTruthy();
  expect(name).toHaveProperty('value', '未保存 🧭 مسودة');
});

it('updates a pristine form when another administrator saves the connection', async () => {
  const server = connection(false);
  await open(server);
  vi.mocked(fetch).mockImplementation(async () =>
    json([{ ...server, revision: server.revision + 1, config: { ...server.config, name: 'Updated' } }]),
  );
  window.dispatchEvent(new Event('remoteToolsChanged'));
  await waitFor(() =>
    expect((screen.getByRole('textbox', { name: 'Server name' }) as HTMLInputElement).value).toBe('Updated'),
  );
});

it('uses the committed revision for a second save and for discard', async () => {
  const server = connection(false);
  await open(server);
  let stored = server;
  const revisions: number[] = [];
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/commands')) {
      const command = JSON.parse(String(init?.body)) as { revision: number; config: RemoteServer['config'] };
      revisions.push(command.revision);
      stored = { ...stored, revision: stored.revision + 1, config: command.config };
      return json({});
    }
    return json([stored]);
  });
  const user = userEvent.setup();
  const name = screen.getByRole('textbox', { name: 'Server name' });
  await user.clear(name);
  await user.type(name, 'First name');
  await user.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveProperty('textContent', 'No unsaved changes'));
  await user.clear(name);
  await user.type(name, 'Second name');
  await user.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(revisions).toEqual([2, 3]));
  await waitFor(() => expect(screen.getByRole('status')).toHaveProperty('textContent', 'No unsaved changes'));
  await user.clear(name);
  await user.type(name, 'Discarded name');
  await user.click(screen.getByRole('button', { name: 'Discard' }));
  expect(name).toHaveProperty('value', 'Second name');
  expect(screen.queryByRole('button', { name: 'Reload stored values' })).toBeNull();
});

it.each([false, true])(
  'cancels pending removal after a live update with an unsaved draft of %s',
  async (draft) => {
    const server = connection(false);
    await open(server);
    const user = userEvent.setup();
    const name = screen.getByRole('textbox', { name: 'Server name' });
    if (draft) {
      await user.clear(name);
      await user.type(name, '未保存 🧭 مسودة');
    }
    await user.click(screen.getByRole('button', { name: 'Remove server' }));
    expect(screen.getByRole('group', { name: 'Remove this connection?' })).toBeTruthy();
    const changed = {
      ...server,
      revision: server.revision + 1,
      config: { ...server.config, name: 'Updated' },
    };
    let removed: unknown;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/commands')) {
        removed = JSON.parse(String(init?.body));
        return json({});
      }
      return json([changed]);
    });
    window.dispatchEvent(new Event('remoteToolsChanged'));
    await screen.findByRole('link', { name: 'Updated' });
    expect(screen.queryByRole('group', { name: 'Remove this connection?' })).toBeNull();
    expect(removed).toBeUndefined();
    expect((name as HTMLInputElement).value).toBe(draft ? '未保存 🧭 مسودة' : 'Updated');
    await user.click(screen.getByRole('button', { name: 'Remove server' }));
    await user.click(screen.getByRole('button', { name: 'Confirm removal' }));
    await waitFor(() =>
      expect(removed).toMatchObject({
        kind: 'remote.remove',
        serverId: server.id,
        revision: changed.revision,
      }),
    );
  },
);
