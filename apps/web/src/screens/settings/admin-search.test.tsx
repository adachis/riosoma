import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { Button, TextField } from '@riosoma/ui';
import { useSettingsDraft } from './SettingsDraft';
import { navigateAdmin, useAdminSearch } from './admin-search';
import { renderSettings } from './testing';

const state = vi.hoisted(() => ({
  href: '/settings/audit',
  listeners: new Set<() => void>(),
  push: vi.fn((href: string) => {
    state.href = href;
    state.listeners.forEach((listener) => listener());
  }),
}));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({
    history: {
      push: state.push,
      block: () => () => undefined,
      subscribe: (listener: () => void) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      get location() {
        return { search: new URL(state.href, window.location.origin).search };
      },
    },
  }),
}));

afterEach(() => {
  cleanup();
  state.href = '/settings/audit';
  state.listeners.clear();
  state.push.mockClear();
});

function Form({ persist }: { persist(value: string): Promise<unknown> }) {
  const { t } = useLingui();
  const [stored, setStored] = useState('original');
  const draft = useSettingsDraft(stored, async (value) => {
    await persist(value);
    setStored(value);
  });
  return (
    <>
      <TextField
        aria-label={t({ id: 'settings.test.value', message: 'Value' })}
        value={draft.value}
        onChange={draft.setValue}
      />
      <Button onPress={() => navigateAdmin('/settings/audit?event=42')}>
        <Trans id="settings.test.leave">Leave</Trans>
      </Button>
    </>
  );
}

it('guards administrative navigation while persistence is pending and preserves a failed draft', async () => {
  let reject!: (cause: Error) => void;
  const persist = vi.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  renderSettings(<Form persist={persist} />);
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox'), ' changed');
  await user.click(
    within(screen.getByRole('region', { name: 'Save changes' })).getByRole('button', { name: /^Save$/ }),
  );
  await user.click(screen.getByRole('button', { name: 'Leave' }));
  expect(state.push).not.toHaveBeenCalled();
  await screen.findByRole('dialog');
  await act(async () => reject(new Error('errors.unavailable')));
  await user.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(state.push).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox')).toHaveProperty('value', 'original changed');
});

it('notifies administrative search consumers after a committed router query change', async () => {
  function Filters() {
    const search = useAdminSearch();
    return <output>{search.get('resource') ?? 'empty'}</output>;
  }
  renderSettings(<Filters />);
  expect(screen.getByText('empty')).toBeTruthy();
  act(() => navigateAdmin('/settings/audit?resource=member'));
  await waitFor(() => expect(screen.getByText('member')).toBeTruthy());
});
