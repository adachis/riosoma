import { SettingsTestPage } from './testing';
import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { json } from '../database/share/testing';
import { FileSettings } from './FileSettings';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const fileView = (maxUploadBytes: number | null) => ({
  maxUploadBytes,
  revision: String(maxUploadBytes ?? 0).padStart(64, '0'),
});

function renderSettings(cached?: number | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cached !== undefined) client.setQueryData(['organization', 'files'], fileView(cached));
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <SettingsTestPage>
          <FileSettings />
        </SettingsTestPage>
      </QueryClientProvider>
    </I18nProvider>,
  );
  return client;
}

const input = () => screen.getByRole('textbox', { name: 'Maximum upload size (bytes)' }) as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: 'Save' });

function pendingResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function withScanner(fetchFiles: (url: string, init?: RequestInit) => Promise<Response>) {
  return (url: string, init?: RequestInit) =>
    url.endsWith('/safety')
      ? Promise.resolve(json({ outsideFiles: 'requireScanner', allowOutsideMacros: false }))
      : url.endsWith('/scanner')
        ? Promise.resolve(
            json({
              settings: { enabled: false, address: null, oversizedPolicy: 'quarantine' },
              status: {
                address: null,
                reachable: false,
                tested: false,
                signatureDate: null,
                lastError: null,
              },
            }),
          )
        : fetchFiles(url, init).then(async (response) => {
            if (init?.method !== 'POST') return response;
            const result = await response.json();
            return json({ ...result, fileSettings: fileView(JSON.parse(String(init.body)).maxUploadBytes) });
          });
}

it('submits the refreshed cap when reopening an unedited cached form', async () => {
  const refreshed = pendingResponse();
  const commands: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    withScanner(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        commands.push(JSON.parse(String(init.body)));
        return json({});
      }
      return (await refreshed.promise).clone();
    }),
  );
  renderSettings(null);
  expect(input().value).toBe('');
  await act(async () => refreshed.resolve(json(fileView(1024))));
  await waitFor(() => expect(input().value).toBe('1024'));
  expect(saveButton().hasAttribute('disabled')).toBe(true);
  expect(commands).toEqual([]);
  await userEvent.setup().clear(input());
  await userEvent.setup().type(input(), '2048');
  await userEvent.setup().click(saveButton());
  await waitFor(() =>
    expect(commands).toEqual([
      { kind: 'organization.files', maxUploadBytes: 2048, revision: fileView(1024).revision },
    ]),
  );
});

it('preserves an explicit unsaved blank cap when settings refresh', async () => {
  const refreshed = pendingResponse();
  vi.stubGlobal(
    'fetch',
    withScanner(() => refreshed.promise),
  );
  const client = renderSettings(1024);
  await userEvent.setup().clear(input());
  await act(async () => refreshed.resolve(json(fileView(2048))));
  await waitFor(() => expect(client.getQueryData(['organization', 'files'])).toEqual(fileView(2048)));
  expect(input().value).toBe('');
});

it('keeps an edit made during a save unsaved until that edit is submitted', async () => {
  const pending = pendingResponse();
  let stored: number | null = null;
  let holdSave = true;
  const commands: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    withScanner(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const command = JSON.parse(String(init.body)) as { maxUploadBytes: number | null };
        commands.push(command);
        stored = command.maxUploadBytes;
        return holdSave ? pending.promise : json({});
      }
      return json(fileView(stored));
    }),
  );
  const client = renderSettings();
  await screen.findByRole('textbox', { name: 'Maximum upload size (bytes)' });
  const user = userEvent.setup();
  await user.type(input(), '1024');
  await user.click(saveButton());
  await user.clear(input());
  await user.type(input(), '2048');
  await act(async () => pending.resolve(json({})));
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(stored).toBe(1024);
  expect(input().value).toBe('2048');
  expect(within(input().closest('form')!).getByRole('status').textContent).toBe('');

  holdSave = false;
  await waitFor(() => expect(saveButton()).toHaveProperty('disabled', false));
  await user.click(saveButton());
  await waitFor(() =>
    expect(commands, screen.getByRole('region', { name: 'Save changes' }).textContent ?? '').toHaveLength(2),
  );
  expect(stored).toBe(2048);
  await screen.findByText('Upload limit saved.');
  expect(stored).toBe(2048);
  expect(commands).toEqual([
    { kind: 'organization.files', maxUploadBytes: 1024, revision: fileView(null).revision },
    { kind: 'organization.files', maxUploadBytes: 2048, revision: fileView(1024).revision },
  ]);

  await act(async () => client.setQueryData(['organization', 'files'], fileView(4096)));
  await waitFor(() => expect(input().value).toBe('4096'));
  expect(within(input().closest('form')!).getByRole('status').textContent).toBe('');
});

it('clears the saved status when another submission is pending', async () => {
  const pending = pendingResponse();
  let holdSave = false;
  let stored = 1024;
  vi.stubGlobal(
    'fetch',
    withScanner(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        stored = JSON.parse(String(init.body)).maxUploadBytes;
        return holdSave ? pending.promise : json({});
      }
      return json(fileView(stored));
    }),
  );
  renderSettings();
  await screen.findByRole('textbox', { name: 'Maximum upload size (bytes)' });
  await userEvent.setup().clear(input());
  await userEvent.setup().type(input(), '2048');
  await userEvent.setup().click(saveButton());
  await screen.findByText('Upload limit saved.');
  holdSave = true;
  await userEvent.setup().clear(input());
  await userEvent.setup().type(input(), '4096');
  fireEvent.submit(input().closest('form')!);
  expect(within(input().closest('form')!).getByRole('status').textContent).toBe('');
  await act(async () => pending.resolve(json({})));
  await screen.findByText('Upload limit saved.');
});

it('saves scanner address and quarantine policy together from the page bar', async () => {
  const address = `tcp://127.0.0.1:${3300 + Math.floor(Math.random() * 100)}`;
  const settings = { enabled: true, address, oversizedPolicy: 'allow' };
  const status = { address, reachable: false, tested: false, signatureDate: null, lastError: null };
  const changes: unknown[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith('/scanner')) {
      if (init?.method === 'PUT') {
        const updated = JSON.parse(String(init.body));
        changes.push(updated);
        return json({ settings: updated, status });
      }
      return json({ settings, status });
    }
    return json(fileView(null));
  });
  renderSettings();
  const field = await screen.findByRole('textbox', { name: 'Scanner address' });
  const user = userEvent.setup();
  await user.clear(field);
  await user.type(field, address.replace(/\d+$/, '9000'));
  await user.click(
    screen.getByRole('checkbox', { name: 'Allow downloads of files that are too large to scan' }),
  );
  expect(changes).toEqual([]);
  await user.click(saveButton());
  await waitFor(() =>
    expect(changes).toEqual([
      { ...settings, address: address.replace(/\d+$/, '9000'), oversizedPolicy: 'quarantine' },
    ]),
  );
});

it('preserves a scanner address edited after the submitted snapshot', async () => {
  const pending = pendingResponse();
  let settings = { enabled: false, address: null as string | null, oversizedPolicy: 'quarantine' };
  const status = { address: null, reachable: false, tested: false, signatureDate: null, lastError: null };
  const changes: unknown[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (!url.endsWith('/scanner')) return json(fileView(null));
    if (init?.method === 'PUT') {
      settings = JSON.parse(String(init.body));
      changes.push(settings);
      return changes.length === 1 ? pending.promise : json({ settings, status });
    }
    return json({ settings, status });
  });
  renderSettings();
  const field = await screen.findByRole('textbox', { name: 'Scanner address' });
  fireEvent.change(field, { target: { value: 'tcp://127.0.0.1:3311' } });
  await userEvent.setup().click(saveButton());
  fireEvent.change(field, { target: { value: 'tcp://127.0.0.1:3312' } });
  await act(async () => pending.resolve(json({ settings, status })));
  await waitFor(() => expect(saveButton()).toHaveProperty('disabled', false));
  expect(field).toHaveProperty('value', 'tcp://127.0.0.1:3312');
  await userEvent.setup().click(saveButton());
  await waitFor(() => expect(changes).toHaveLength(2));
  expect(changes[1]).toMatchObject({ address: 'tcp://127.0.0.1:3312' });
});

it('clears an upload limit validation error when its invalid draft is discarded', async () => {
  vi.stubGlobal(
    'fetch',
    withScanner(async () => json(fileView(1024))),
  );
  renderSettings();
  await screen.findByRole('textbox', { name: 'Maximum upload size (bytes)' });
  const user = userEvent.setup();
  await user.clear(input());
  await user.type(input(), '-1');
  await user.click(saveButton());
  await waitFor(() => expect(input().getAttribute('aria-invalid')).toBe('true'));
  await user.click(screen.getByRole('button', { name: 'Discard' }));
  expect(input().value).toBe('1024');
  expect(input().getAttribute('aria-invalid')).not.toBe('true');
  expect(screen.queryByText('Enter a positive whole number of bytes, or leave this blank.')).toBeNull();
});

it('reconciles a normalized upload cap without blocking a newer edit', async () => {
  const pending = pendingResponse();
  let stored = 1024;
  vi.stubGlobal(
    'fetch',
    withScanner(async (_url, init) => {
      if (init?.method === 'POST') {
        stored = JSON.parse(String(init.body)).maxUploadBytes;
        return (await pending.promise).clone();
      }
      return json(fileView(stored));
    }),
  );
  renderSettings();
  await screen.findByRole('textbox', { name: 'Maximum upload size (bytes)' });
  fireEvent.change(input(), { target: { value: '02048' } });
  await userEvent.setup().click(saveButton());
  fireEvent.change(input(), { target: { value: '4096' } });
  await act(async () => pending.resolve(json({})));
  await waitFor(() => expect(saveButton()).toHaveProperty('disabled', false));
  expect(stored).toBe(2048);
  expect(input().value).toBe('4096');
  expect(within(screen.getByRole('region', { name: 'Save changes' })).getByRole('status').textContent).toBe(
    'Unsaved changes',
  );
  expect(screen.queryByRole('button', { name: 'Reload stored values' })).toBeNull();
  await userEvent.setup().click(saveButton());
  await screen.findByText('Upload limit saved.');
  expect(stored).toBe(4096);
  expect(within(screen.getByRole('region', { name: 'Save changes' })).getByRole('status').textContent).toBe(
    'No unsaved changes',
  );
});
