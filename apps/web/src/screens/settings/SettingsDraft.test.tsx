import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { act, cleanup, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { Button, ListBoxItem, Select, TextField, toastQueue } from '@riosoma/ui';
import { ApiError } from '../../api';
import { useSettingsDraft, useSettingsLeaveGuard } from './SettingsDraft';
import { renderSettings } from './testing';

afterEach(() => {
  cleanup();
  for (const item of toastQueue.visibleToasts) toastQueue.close(item.key);
});

function Field({
  stored,
  persist,
  required = false,
}: {
  stored: string;
  persist(value: string): Promise<unknown>;
  required?: boolean;
}) {
  const { t } = useLingui();
  const draft = useSettingsDraft(stored, persist, {
    validate: (value) =>
      required && !value.trim() ? t({ id: 'settings.test.required', message: 'Enter a value.' }) : null,
  });
  return (
    <TextField
      label={t({ id: 'settings.test.value', message: 'Value' })}
      value={draft.value}
      onChange={draft.setValue}
      isInvalid={required && !draft.value.trim()}
      errorMessage={t({ id: 'settings.test.required', message: 'Enter a value.' })}
    />
  );
}

function Leave({ continued }: { continued(): void }) {
  const requestLeave = useSettingsLeaveGuard();
  return (
    <Button
      onPress={() => {
        void requestLeave().then((accepted) => {
          if (accepted) continued();
        });
      }}
    >
      <Trans id="settings.test.leave">Leave</Trans>
    </Button>
  );
}

const save = () =>
  within(screen.getByRole('region', { name: 'Save changes' })).getByRole('button', { name: 'Save' });
const discard = () =>
  within(screen.getByRole('region', { name: 'Save changes' })).getByRole('button', { name: 'Discard' });

it('stages changes, returns to idle when reverted, and restores the stored value on discard', async () => {
  const persist = vi.fn().mockResolvedValue(undefined);
  const user = userEvent.setup();
  renderSettings(<Field stored="one" persist={persist} />);
  expect(save()).toHaveProperty('disabled', true);
  const input = screen.getByRole('textbox');
  await user.clear(input);
  await user.type(input, 'two');
  expect(persist).not.toHaveBeenCalled();
  expect(save()).toHaveProperty('disabled', false);
  await user.clear(input);
  await user.type(input, 'one');
  expect(save()).toHaveProperty('disabled', true);
  await user.clear(input);
  await user.type(input, 'two');
  await user.click(discard());
  expect(input).toHaveProperty('value', 'one');
  expect(screen.getByText('No unsaved changes')).toBeTruthy();
});

it('validates before writing any section and focuses the first invalid field', async () => {
  const persist = vi.fn().mockResolvedValue(undefined);
  const user = userEvent.setup();
  renderSettings(
    <>
      <Field stored="one" persist={persist} required />
      <Field stored="two" persist={persist} />
    </>,
  );
  const [first, second] = screen.getAllByRole('textbox');
  await user.clear(first!);
  await user.type(second!, ' changed');
  await user.click(save());
  expect(persist).not.toHaveBeenCalled();
  await waitFor(() => expect(document.activeElement).toBe(first));
  expect(within(screen.getByRole('region', { name: 'Save changes' })).getByRole('status').textContent).toBe(
    'Enter a value.',
  );
});

it('disables both buttons while saving and retains the draft after a failed request', async () => {
  let reject!: (cause: unknown) => void;
  const persist = vi.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const user = userEvent.setup();
  renderSettings(<Field stored="one" persist={persist} />);
  await user.type(screen.getByRole('textbox'), ' changed');
  await user.click(save());
  expect(save()).toHaveProperty('disabled', true);
  expect(discard()).toHaveProperty('disabled', true);
  reject(new ApiError(503, { code: 'unavailable', messageKey: 'errors.unavailable', userFault: false }));
  await waitFor(() => expect(save()).toHaveProperty('disabled', false));
  expect(screen.getByRole('textbox')).toHaveProperty('value', 'one changed');
});

it('focuses an invalid selection when saving refuses missing input', async () => {
  const persist = vi.fn().mockResolvedValue(undefined);
  function Choice() {
    const { t } = useLingui();
    const draft = useSettingsDraft<string>('saved', persist, {
      validate: (value) =>
        value === 'missing' ? t({ id: 'settings.test.required', message: 'Enter a value.' }) : null,
    });
    return (
      <Select
        label={t({ id: 'settings.test.value', message: 'Value' })}
        selectedKey={draft.value}
        onSelectionChange={(key) => draft.setValue(String(key))}
        isInvalid={draft.value === 'missing'}
        errorMessage={t({ id: 'settings.test.required', message: 'Enter a value.' })}
      >
        <ListBoxItem id="saved">
          <Trans id="settings.test.value">Value</Trans>
        </ListBoxItem>
        <ListBoxItem id="missing">
          <Trans id="ui.select.placeholder">Choose…</Trans>
        </ListBoxItem>
      </Select>
    );
  }
  const user = userEvent.setup();
  renderSettings(<Choice />);
  const trigger = screen.getByRole('button', { name: /Value/ });
  await user.click(trigger);
  await user.click(screen.getByRole('option', { name: 'Choose…' }));
  await user.click(save());
  expect(persist).not.toHaveBeenCalled();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it('preserves a draft when stored data changes and reloads only when asked', async () => {
  const persist = vi.fn().mockResolvedValue(undefined);
  function Live() {
    const [stored, setStored] = useState('one');
    return (
      <>
        <Field stored={stored} persist={persist} />
        <Button onPress={() => setStored('new')}>
          <Trans id="settings.test.refresh">Refresh</Trans>
        </Button>
      </>
    );
  }
  const user = userEvent.setup();
  renderSettings(<Live />);
  await user.type(screen.getByRole('textbox'), ' changed');
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(screen.getByRole('textbox')).toHaveProperty('value', 'one changed');
  await user.click(save());
  expect(persist).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Reload stored values' }));
  expect(screen.getByRole('textbox')).toHaveProperty('value', 'new');
});

it('requires reloading stored values after a server version conflict before retrying a save', async () => {
  const persist = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError(409, { code: 'conflict', messageKey: 'errors.conflict', userFault: true }),
    )
    .mockResolvedValue(undefined);
  const user = userEvent.setup();
  renderSettings(<Field stored="one" persist={persist} />);
  await user.type(screen.getByRole('textbox'), ' changed');
  await user.click(save());
  await screen.findByRole('button', { name: 'Reload stored values' });
  expect(screen.getByRole('textbox')).toHaveProperty('value', 'one changed');
  await user.click(save());
  expect(persist).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Reload stored values' }));
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveProperty('value', 'one'));
  await user.type(screen.getByRole('textbox'), ' revised');
  await user.click(save());
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(2));
});

it.each(['Keep editing', 'Discard and continue', 'Save and continue'])(
  'handles %s through the shared leave dialog',
  async (choice) => {
    const persisted = vi.fn().mockResolvedValue(undefined);
    const continued = vi.fn();
    const user = userEvent.setup();
    renderSettings(
      <>
        <Field stored="one" persist={persisted} />
        <Leave continued={continued} />
      </>,
    );
    await user.type(screen.getByRole('textbox'), ' changed');
    await user.click(screen.getByRole('button', { name: 'Leave' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep editing' })),
    );
    await user.click(within(dialog).getByRole('button', { name: choice }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(continued).toHaveBeenCalledTimes(choice === 'Keep editing' ? 0 : 1);
    expect(persisted).toHaveBeenCalledTimes(choice === 'Save and continue' ? 1 : 0);
  },
);

it('keeps editing on Escape and saves from a text field with the registered shortcut', async () => {
  const persist = vi.fn().mockResolvedValue(undefined);
  const continued = vi.fn();
  const user = userEvent.setup();
  renderSettings(
    <>
      <Field stored="one" persist={persist} />
      <Leave continued={continued} />
    </>,
  );
  await user.type(screen.getByRole('textbox'), ' changed');
  await user.click(screen.getByRole('button', { name: 'Leave' }));
  await user.keyboard('{Escape}');
  expect(continued).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 's', ctrlKey: true });
  await waitFor(() => expect(persist).toHaveBeenCalledWith('one changed'));
});

it('allows correcting and retrying a duplicate value without discarding the draft', async () => {
  const persist = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError(409, { code: 'conflict', messageKey: 'customDomains.exists', userFault: true }),
    )
    .mockResolvedValue(undefined);
  const user = userEvent.setup();
  renderSettings(<Field stored="one" persist={persist} />);
  const field = screen.getByRole('textbox');
  await user.type(field, ' duplicate');
  await user.click(save());
  await waitFor(() => expect(save()).toHaveProperty('disabled', false));
  expect(screen.queryByRole('button', { name: 'Reload stored values' })).toBeNull();
  await user.clear(field);
  await user.type(field, 'corrected');
  await user.click(save());
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(2));
  expect(persist).toHaveBeenLastCalledWith('corrected');
});

it('retains a return to the original value made while a different value is saving', async () => {
  let finish!: () => void;
  function LiveField() {
    const [stored, setStored] = useState('one');
    return (
      <Field
        stored={stored}
        persist={async (value) => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          setStored(value);
        }}
      />
    );
  }
  const user = userEvent.setup();
  renderSettings(<LiveField />);
  const field = screen.getByRole('textbox');
  await user.clear(field);
  await user.type(field, 'two');
  await user.click(save());
  await user.clear(field);
  await user.type(field, 'one');
  await act(async () => finish());
  await waitFor(() => expect(save()).toHaveProperty('disabled', false));
  expect(field).toHaveProperty('value', 'one');
  expect(within(screen.getByRole('region', { name: 'Save changes' })).getByRole('status').textContent).toBe(
    'Unsaved changes',
  );
});

it('retains a reversion in a section queued behind another save', async () => {
  let finish!: () => void;
  const persisted: string[] = [];
  function Fields() {
    const [first, setFirst] = useState('first');
    const [second, setSecond] = useState('second');
    return (
      <>
        <Field
          stored={first}
          persist={async (value) => {
            await new Promise<void>((resolve) => {
              finish = resolve;
            });
            setFirst(value);
          }}
        />
        <Field
          stored={second}
          persist={async (value) => {
            persisted.push(value);
            setSecond(value);
          }}
        />
      </>
    );
  }
  renderSettings(<Fields />);
  const [first, second] = screen.getAllByRole('textbox');
  fireEvent.change(first!, { target: { value: 'first-change' } });
  fireEvent.change(second!, { target: { value: 'second-change' } });
  await userEvent.setup().click(save());
  expect(persisted).toEqual([]);
  fireEvent.change(second!, { target: { value: 'second' } });
  await act(async () => finish());
  await waitFor(() => expect(persisted).toEqual(['second-change']));
  expect(second).toHaveProperty('value', 'second');
  expect(screen.getByText('Unsaved changes')).toBeTruthy();
  await userEvent.setup().click(save());
  await waitFor(() => expect(persisted).toEqual(['second-change', 'second']));
  expect(screen.getByText('No unsaved changes')).toBeTruthy();
});
