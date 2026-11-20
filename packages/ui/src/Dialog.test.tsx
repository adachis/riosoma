import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { Dialog, DialogBody, DialogFooter, DialogTitle } from './Dialog';
import { Modal } from './Modal';

// Components translate their own text through Lingui, which needs the provider above them.
function renderOverlay(element: ReactElement) {
  return render(<I18nProvider i18n={i18n}>{element}</I18nProvider>);
}

/** A dialog in the modal it is meant to be used in, closing itself through its own state. */
function Harness({ children }: { children: ReactElement }) {
  const [open, setOpen] = useState(true);
  return (
    <Modal isOpen={open} onOpenChange={setOpen}>
      {children}
    </Modal>
  );
}

describe('Dialog', () => {
  it('makes overflowing text keyboard reachable without adding a stop beside usable controls', async () => {
    const { container, rerender } = renderOverlay(
      <DialogBody>
        <p>Details</p>
      </DialogBody>,
    );
    const body = container.querySelector('.rio-dialog__body') as HTMLDivElement;
    Object.defineProperties(body, {
      scrollHeight: { configurable: true, value: 200 },
      clientHeight: { configurable: true, value: 80 },
    });
    await act(async () => {
      body.append(document.createElement('p'));
    });
    await waitFor(() => expect(body.tabIndex).toBe(0));
    await userEvent.tab();
    expect(document.activeElement).toBe(body);
    rerender(
      <I18nProvider i18n={i18n}>
        <DialogBody>
          <button type="button">Choose</button>
        </DialogBody>
      </I18nProvider>,
    );
    await waitFor(() => expect(body.hasAttribute('tabindex')).toBe(false));
    rerender(
      <I18nProvider i18n={i18n}>
        <DialogBody>
          <button type="button" disabled>
            Choose
          </button>
        </DialogBody>
      </I18nProvider>,
    );
    await waitFor(() => expect(body.tabIndex).toBe(0));
  });
  it('is named by its title and holds a body and a footer', () => {
    renderOverlay(
      <Harness>
        <Dialog>
          <DialogTitle>Rename column</DialogTitle>
          <DialogBody>
            <p>Every query that reads this column has to be updated.</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="primary">Rename</Button>
          </DialogFooter>
        </Dialog>
      </Harness>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Rename column' });
    expect(screen.getByRole('heading', { name: 'Rename column' })).toBeTruthy();
    expect(dialog.querySelector('.rio-dialog__body')?.textContent).toContain('Every query');
    expect(dialog.querySelector('.rio-dialog__footer')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Rename' })).toBeTruthy();
  });

  it('names the dialog by a custom heading level', () => {
    renderOverlay(
      <Harness>
        <Dialog>
          <DialogTitle level={4}>Rename column</DialogTitle>
        </Dialog>
      </Harness>,
    );
    expect(screen.getByRole('dialog', { name: 'Rename column' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 4 }).tagName).toBe('H4');
  });

  it('closes through the button in its corner', async () => {
    renderOverlay(
      <Harness>
        <Dialog>
          <DialogTitle>Rename column</DialogTitle>
        </Dialog>
      </Harness>,
    );
    const close = screen.getByRole('button', { name: 'Close' });
    // The icon is decorative next to the accessible name.
    expect(close.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    await userEvent.click(close);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reports the close to the caller', async () => {
    const onOpenChange = vi.fn();
    function Controlled() {
      const [open, setOpen] = useState(true);
      return (
        <Modal
          isOpen={open}
          onOpenChange={(next) => {
            setOpen(next);
            onOpenChange(next);
          }}
        >
          <Dialog>
            <DialogTitle>Rename column</DialogTitle>
          </Dialog>
        </Modal>
      );
    }
    renderOverlay(<Controlled />);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('leaves the corner button out when asked', () => {
    renderOverlay(
      <Harness>
        <Dialog hideCloseButton>
          <DialogTitle>Rename column</DialogTitle>
        </Dialog>
      </Harness>,
    );
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Rename column' })).toBeTruthy();
  });

  it('gives its children a way to close it', async () => {
    renderOverlay(
      <Harness>
        <Dialog>
          {({ close }) => (
            <>
              <DialogTitle>Rename column</DialogTitle>
              <DialogFooter>
                <Button onPress={close}>Done</Button>
              </DialogFooter>
            </>
          )}
        </Dialog>
      </Harness>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape', async () => {
    renderOverlay(
      <Harness>
        <Dialog>
          <DialogTitle>Rename column</DialogTitle>
        </Dialog>
      </Harness>,
    );
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('takes the role it is given', () => {
    renderOverlay(
      <Harness>
        <Dialog role="alertdialog">
          <DialogTitle>Drop database</DialogTitle>
        </Dialog>
      </Harness>,
    );
    expect(screen.getByRole('alertdialog', { name: 'Drop database' })).toBeTruthy();
  });
});
