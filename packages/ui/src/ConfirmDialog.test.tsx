import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { ConfirmDialog, ConfirmProvider, useConfirm, type ConfirmDialogProps } from './ConfirmDialog';

// Components translate their own text through Lingui, which needs the provider above them.
function renderOverlay(element: ReactElement) {
  return render(<I18nProvider i18n={i18n}>{element}</I18nProvider>);
}

/** An open confirm dialog that closes itself, so the tests can watch it go away. */
function OpenConfirm(props: Omit<ConfirmDialogProps, 'isOpen' | 'onOpenChange' | 'defaultOpen'>) {
  const [open, setOpen] = useState(true);
  return <ConfirmDialog {...props} isOpen={open} onOpenChange={setOpen} />;
}

/** Work the test settles by hand, so the pending state can be looked at while it runs. */
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function confirmButton() {
  return screen.getByRole('button', { name: 'Delete' });
}

describe('ConfirmDialog', () => {
  it('asks the question and defaults the cancel label', () => {
    renderOverlay(
      <ConfirmDialog
        isOpen
        title="Delete row?"
        message="The row is dropped from every query that reads it."
        confirmLabel="Delete"
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Delete row?' })).toBeTruthy();
    expect(screen.getByText('The row is dropped from every query that reads it.')).toBeTruthy();
    expect(confirmButton()).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    // Nothing but the two answers: the question has to be answered, not put aside.
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('takes a custom cancel label', () => {
    renderOverlay(<ConfirmDialog isOpen title="Delete row?" confirmLabel="Delete" cancelLabel="Keep it" />);
    expect(screen.getByRole('button', { name: 'Keep it' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('leaves the message out when there is none', () => {
    renderOverlay(<ConfirmDialog isOpen title="Delete row?" confirmLabel="Delete" />);
    expect(document.querySelector('.rio-dialog__body')).toBeNull();
  });

  it.each([
    { tone: undefined, expected: 'primary' },
    { tone: 'danger' as const, expected: 'danger' },
  ])('answers with the $expected button', ({ tone, expected }) => {
    renderOverlay(<ConfirmDialog isOpen title="Delete row?" confirmLabel="Delete" tone={tone} />);
    expect(confirmButton().getAttribute('data-variant')).toBe(expected);
  });

  it('reports the answer to the caller', async () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    renderOverlay(
      <ConfirmDialog
        isOpen
        onOpenChange={onOpenChange}
        title="Delete row?"
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />,
    );
    await userEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes without running the work when canceled', async () => {
    const onConfirm = vi.fn();
    renderOverlay(<OpenConfirm title="Delete row?" confirmLabel="Delete" onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes without running the work when dismissed with Escape', async () => {
    const onConfirm = vi.fn();
    renderOverlay(<OpenConfirm title="Delete row?" confirmLabel="Delete" onConfirm={onConfirm} />);
    await userEvent.keyboard('{Escape}');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stays pending while the work runs and closes once it settles', async () => {
    const work = deferred();
    const onConfirm = vi.fn(() => work.promise);
    renderOverlay(<OpenConfirm title="Delete row?" confirmLabel="Delete" onConfirm={onConfirm} />);
    const confirm = confirmButton();
    await userEvent.click(confirm);

    expect(confirm.getAttribute('data-pending')).toBe('true');
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('data-disabled')).toBe(true);
    // A second press must not start the work again, and Escape must not abandon it.
    await userEvent.click(confirm);
    await userEvent.keyboard('{Escape}');
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(screen.getByRole('dialog', { name: 'Delete row?' })).toBeTruthy();

    await act(async () => {
      work.resolve();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stays open when the work fails', async () => {
    const work = deferred();
    const onConfirm = vi.fn(() => work.promise);
    renderOverlay(<OpenConfirm title="Delete row?" confirmLabel="Delete" onConfirm={onConfirm} />);
    const confirm = confirmButton();
    await userEvent.click(confirm);

    await act(async () => {
      work.reject(new Error('the connection dropped'));
    });

    expect(screen.getByRole('dialog', { name: 'Delete row?' })).toBeTruthy();
    expect(confirm.getAttribute('data-pending')).toBeNull();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel.hasAttribute('data-disabled')).toBe(false);
    await userEvent.click(cancel);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens on its own when uncontrolled', async () => {
    renderOverlay(<ConfirmDialog defaultOpen title="Delete row?" confirmLabel="Delete" />);
    expect(screen.getByRole('dialog', { name: 'Delete row?' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('useConfirm', () => {
  function Asker({ onResult }: { onResult: (confirmed: boolean) => void }) {
    const confirm = useConfirm();
    return (
      <Button
        onPress={() => {
          void confirm({ title: 'Delete row?', confirmLabel: 'Delete', tone: 'danger' }).then(onResult);
        }}
      >
        Delete row
      </Button>
    );
  }

  it('resolves true when the answer is yes', async () => {
    const onResult = vi.fn();
    renderOverlay(
      <ConfirmProvider>
        <Asker onResult={onResult} />
      </ConfirmProvider>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Delete row' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('resolves false when the answer is no', async () => {
    const onResult = vi.fn();
    renderOverlay(
      <ConfirmProvider>
        <Asker onResult={onResult} />
      </ConfirmProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete row' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  it('resolves false when dismissed with Escape', async () => {
    const onResult = vi.fn();
    renderOverlay(
      <ConfirmProvider>
        <Asker onResult={onResult} />
      </ConfirmProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete row' }));
    await screen.findByRole('dialog', { name: 'Delete row?' });
    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  it('asks one question at a time', async () => {
    const results: string[] = [];
    function Pair() {
      const confirm = useConfirm();
      return (
        <Button
          onPress={() => {
            void confirm({ title: 'First?', confirmLabel: 'First' }).then((yes) =>
              results.push(`first:${yes}`),
            );
            void confirm({ title: 'Second?', confirmLabel: 'Second' }).then((yes) =>
              results.push(`second:${yes}`),
            );
          }}
        >
          Ask twice
        </Button>
      );
    }
    renderOverlay(
      <ConfirmProvider>
        <Pair />
      </ConfirmProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ask twice' }));
    expect(await screen.findByRole('dialog', { name: 'First?' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Second?' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'First' }));
    expect(await screen.findByRole('dialog', { name: 'Second?' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(results).toEqual(['first:true', 'second:false']));
  });

  it('settles an open question when the provider goes away', async () => {
    const onResult = vi.fn();
    const { unmount } = renderOverlay(
      <ConfirmProvider>
        <Asker onResult={onResult} />
      </ConfirmProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete row' }));
    await screen.findByRole('dialog', { name: 'Delete row?' });

    unmount();

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  it('needs a provider above it', () => {
    const onResult = vi.fn();
    expect(() => renderOverlay(<Asker onResult={onResult} />)).toThrow(/ConfirmProvider/);
  });
});
