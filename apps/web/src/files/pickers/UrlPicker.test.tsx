import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import { renderSharing } from '../../screens/database/share/testing';
import { UrlPicker } from './UrlPicker';
import { AddFromMenu } from './AddFromMenu';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';

afterEach(cleanup);
it('opens only the record selected by the picker link when panels share a field', async () => {
  const first = vi.fn(async () => {});
  const second = vi.fn(async () => {});
  const fieldId = 'fld00000000000001';
  const recordId = 'rec00000000000002';
  const root = createRootRoute({
    component: () => (
      <>
        <AddFromMenu
          locale="en-US"
          fieldId={fieldId}
          recordId="rec00000000000001"
          onFiles={() => {}}
          onPicks={() => {}}
          onUrl={first}
        />
        <AddFromMenu
          locale="en-US"
          fieldId={fieldId}
          recordId={recordId}
          onFiles={() => {}}
          onPicks={() => {}}
          onUrl={second}
        />
      </>
    ),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: [`/?fileSource=${fieldId}&fileRecord=${recordId}`] }),
  });
  renderSharing(<RouterProvider router={router} />);
  await screen.findAllByRole('dialog', { name: 'From a web address' });
  expect(screen.getAllByRole('dialog', { name: 'From a web address' })).toHaveLength(1);
  await userEvent.type(screen.getByLabelText('Web address'), 'https://example.test/report.pdf');
  await userEvent.click(screen.getByRole('button', { name: 'Add file' }));
  await waitFor(() => expect(second).toHaveBeenCalledOnce());
  expect(first).not.toHaveBeenCalled();
});

it('offers the web-address source even without a camera or cloud drive', async () => {
  renderSharing(<AddFromMenu locale="en-US" onFiles={() => {}} onPicks={() => {}} onUrl={async () => {}} />);
  await userEvent.click(screen.getByRole('button', { name: 'More ways to add' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'From a web address' }));
  expect(screen.getByRole('dialog', { name: 'From a web address' })).toBeTruthy();
});

it('rejects credentials and invalid protocols, then submits with Enter and closes on success', async () => {
  const add = vi.fn(async () => {});
  const close = vi.fn();
  const user = userEvent.setup();
  renderSharing(<UrlPicker onAdd={add} onClose={close} />);
  const address = screen.getByLabelText('Web address');
  await waitFor(() => expect(document.activeElement).toBe(address));
  for (const value of ['file:///secret', 'https://person:password@example.test/file']) {
    await user.clear(address);
    await user.type(address, value);
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toBeTruthy();
  }
  expect(add).not.toHaveBeenCalled();
  await user.clear(address);
  await user.type(address, 'https://example.test/report.pdf');
  await user.type(screen.getByLabelText('File name (optional)'), 'Report.pdf');
  await user.keyboard('{Enter}');
  await waitFor(() => expect(add).toHaveBeenCalledWith('https://example.test/report.pdf', 'Report.pdf'));
  expect(close).toHaveBeenCalledOnce();
});

it('keeps a failed download open with a translated refusal and allows retry', async () => {
  const add = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError(422, {
        code: 'validation_failed',
        messageKey: 'api.file.notFound',
        params: { address: 'https://example.test/missing' },
        userFault: true,
      }),
    )
    .mockResolvedValueOnce(undefined);
  const close = vi.fn();
  renderSharing(<UrlPicker onAdd={add} onClose={close} />);
  await userEvent.type(screen.getByLabelText('Web address'), 'https://example.test/missing');
  await userEvent.click(screen.getByRole('button', { name: 'Add file' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Nothing was found');
  expect(close).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Add file' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});
