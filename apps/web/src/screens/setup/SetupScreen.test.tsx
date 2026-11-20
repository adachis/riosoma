import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { storeSetupToken } from '../../api';
import { setupStatusQuery } from '../../session';
import { renderHome } from '../home/test-support';
import { SetupScreen } from './SetupScreen';
import logoArtwork from '../../../public/brand/riosoma-wordmark.svg?raw';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

afterEach(() => {
  cleanup();
  storeSetupToken(null);
  vi.unstubAllGlobals();
});

it('clears an invalid token error on editing and submits a corrected setup link', async () => {
  storeSetupToken(null);
  const token = 'setup-token-0123456789abcdef';
  const fetcher = vi.fn(
    async () =>
      new Response('{}', {
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    // Static artwork is separate from the setup requests this form validates.
    if (input === '/brand/riosoma-wordmark.svg')
      return Promise.resolve(new Response(logoArtwork, { headers: { 'content-type': 'image/svg+xml' } }));
    return (fetcher as typeof fetch)(input, init);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(setupStatusQuery.queryKey, { stage: 'database', databaseManaged: false });
  renderHome(
    <QueryClientProvider client={client}>
      <SetupScreen />
    </QueryClientProvider>,
  );
  const input = await screen.findByRole('textbox', { name: 'Setup link or token' });
  await userEvent.type(input, 'invalid');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(fetcher).not.toHaveBeenCalled();
  await userEvent.clear(input);
  await userEvent.type(input, `https://example.test/setup#token=${token}`);
  expect(input.getAttribute('aria-invalid')).not.toBe('true');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('heading', { name: 'Connect a database' });
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      '/api/setup/unlock',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-setup-token': token }),
      }),
    ),
  );
});
