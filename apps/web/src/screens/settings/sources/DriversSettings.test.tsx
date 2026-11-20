import type { ReactNode } from 'react';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { SourceDriver } from '@riosoma/contracts';
import { json, renderSharing } from '../../database/share/testing';
import { DriversSettings } from './DriversSettings';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ params, children }: { params: { section: string }; children: ReactNode }) => (
    <a href={`/settings/${params.section}`}>{children}</a>
  ),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const driver = (): SourceDriver => ({
  id: 'teradatasql',
  version: '1.0.0',
  platforms: ['linux-x64'],
  licenseName: 'Test license',
  licenseUrl: 'https://example.com/license',
  licenseText: 'The complete license begins here.\n\nThe final license paragraph is also displayed.',
  licenseHash: 'a'.repeat(64),
  catalogHash: 'b'.repeat(64),
  supported: true,
  ready: true,
  artifacts: [
    {
      id: 'teradatasql',
      version: '1.0.0',
      url: 'https://example.com/archive.tgz',
      integrity: 'sha512-' + 'c'.repeat(86) + '==',
    },
  ],
  installed: null,
});

it('shows the entire license and requires explicit acceptance before installation', async () => {
  const item = driver();
  const calls: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls.push(JSON.parse(String(init.body)));
        return json({});
      }
      return json({ enabled: true, platform: 'linux-x64', drivers: [item] });
    }),
  );
  renderSharing(<DriversSettings />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Review license and install' }));
  expect(screen.getByText(/The final license paragraph is also displayed/)).toBeTruthy();
  const install = screen.getByRole('button', { name: 'Accept license and install' });
  expect(install.hasAttribute('disabled')).toBe(true);
  await user.click(
    screen.getByRole('checkbox', { name: 'I have read the full license and accept it for this instance.' }),
  );
  await user.click(install);
  await waitFor(() =>
    expect(calls).toEqual([{ licenseHash: item.licenseHash, catalogHash: item.catalogHash }]),
  );
});

it('uploads each archive as its own stream of bytes before installing from them', async () => {
  const item = driver();
  item.artifacts.push({ ...item.artifacts[0]!, id: 'koffi' });
  const calls: Array<{ method: string; url: string; type: string | null; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return json({ enabled: true, platform: 'linux-x64', drivers: [item] });
      const type = new Headers(init?.headers).get('content-type');
      calls.push({ method, url, type, body: method === 'PUT' ? init?.body : JSON.parse(String(init?.body)) });
      return method === 'PUT' ? new Response(null, { status: 204 }) : json({});
    }),
  );
  renderSharing(<DriversSettings />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Review license and install' }));
  await user.click(
    screen.getByRole('checkbox', { name: 'I have read the full license and accept it for this instance.' }),
  );
  await user.click(
    screen.getByRole('checkbox', { name: 'Upload the pinned archives from an offline computer' }),
  );
  const files = item.artifacts.map(
    (artifact) =>
      new File([`archive for ${artifact.id}`], `${artifact.id}.tgz`, { type: 'application/gzip' }),
  );
  const inputs = screen.getAllByLabelText('Driver archive');
  for (const [index, input] of inputs.entries()) await user.upload(input, files[index]!);
  await user.click(screen.getByRole('button', { name: 'Accept license and install' }));
  await waitFor(() => expect(calls).toHaveLength(3));
  expect(calls.slice(0, 2)).toEqual(
    item.artifacts.map((artifact, index) => ({
      method: 'PUT',
      url: `/api/source-drivers/teradatasql/uploads/${artifact.id}`,
      type: 'application/octet-stream',
      body: files[index],
    })),
  );
  expect(calls[2]).toMatchObject({
    method: 'POST',
    url: '/api/source-drivers/teradatasql/install',
    body: { licenseHash: item.licenseHash, catalogHash: item.catalogHash, offline: true },
  });
});

it('shows a changed license again for an installed driver', async () => {
  const item = driver();
  item.installed = {
    version: '0.9.0',
    licenseHash: 'd'.repeat(64),
    catalogHash: 'e'.repeat(64),
    installedAt: new Date().toISOString(),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ enabled: true, platform: 'linux-x64', drivers: [item] })),
  );
  renderSharing(<DriversSettings />);
  const user = userEvent.setup();
  expect(await screen.findByText('An update is available')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Review license and install' }));
  expect(
    screen
      .getByRole('checkbox', { name: 'I have read the full license and accept it for this instance.' })
      .getAttribute('aria-checked'),
  ).not.toBe('true');
  expect(screen.getByRole('button', { name: 'Accept license and install' }).hasAttribute('disabled')).toBe(
    true,
  );
});

it('tells an arm64 Linux server why IBM’s driver can’t be installed there', async () => {
  const item: SourceDriver = {
    ...driver(),
    id: 'ibm_db',
    platforms: ['linux-x64', 'darwin-arm64'],
    supported: false,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ enabled: true, platform: 'linux-arm64', drivers: [item] })),
  );
  renderSharing(<DriversSettings />);
  expect(await screen.findByText(/IBM ships no client for Linux on arm64/)).toBeTruthy();
  expect(screen.getByText('This server’s platform does not support this driver.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Review license and install' }).hasAttribute('disabled')).toBe(
    true,
  );
});
