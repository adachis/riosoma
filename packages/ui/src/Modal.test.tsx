import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { Dialog, DialogTitle } from './Dialog';
import { Modal } from './Modal';

// Components translate their own text through Lingui, which needs the provider above them.
function renderOverlay(element: ReactElement) {
  return render(<I18nProvider i18n={i18n}>{element}</I18nProvider>);
}

function panel() {
  return document.querySelector('.rio-modal');
}

function scrim() {
  return document.querySelector('.rio-modal-overlay');
}

describe('Modal', () => {
  it('renders nothing while closed', () => {
    renderOverlay(
      <Modal isOpen={false}>
        <Dialog aria-label="Settings">
          <p>Body</p>
        </Dialog>
      </Modal>,
    );
    expect(panel()).toBeNull();
    expect(scrim()).toBeNull();
    expect(screen.queryByText('Body')).toBeNull();
  });

  it('puts the dialog on a panel over a scrim and moves focus into it', () => {
    renderOverlay(
      <Modal isOpen>
        <Dialog>
          <DialogTitle>Settings</DialogTitle>
          <p>Body</p>
        </Dialog>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog.parentElement).toBe(panel());
    expect(dialog.closest('.rio-modal-overlay')).toBe(scrim());
    expect(document.activeElement).toBe(dialog);
  });

  it.each([
    { size: 'sm' as const, expected: 'sm' },
    { size: undefined, expected: 'md' },
    { size: 'lg' as const, expected: 'lg' },
  ])('sizes the panel $expected', ({ size, expected }) => {
    renderOverlay(
      <Modal isOpen size={size}>
        <Dialog aria-label="Settings">
          <p>Body</p>
        </Dialog>
      </Modal>,
    );
    expect(panel()?.getAttribute('data-size')).toBe(expected);
  });

  it('closes on Escape', async () => {
    const onOpenChange = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <Modal
          isOpen={open}
          onOpenChange={(next) => {
            setOpen(next);
            onOpenChange(next);
          }}
        >
          <Dialog aria-label="Settings">
            <p>Body</p>
          </Dialog>
        </Modal>
      );
    }
    renderOverlay(<Harness />);
    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps focus inside while tabbing', async () => {
    renderOverlay(
      <>
        <Button>Behind</Button>
        <Modal isOpen>
          <Dialog aria-label="Settings">
            <p>Body</p>
            <Button>First</Button>
            <Button>Second</Button>
          </Dialog>
        </Modal>
      </>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    for (let step = 0; step < 5; step += 1) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('returns focus to what opened it', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onPress={() => setOpen(true)}>Open</Button>
          <Modal isOpen={open} onOpenChange={setOpen}>
            <Dialog aria-label="Settings">
              <p>Body</p>
            </Dialog>
          </Modal>
        </>
      );
    }
    renderOverlay(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open' }));
  });

  it('ignores a press on the scrim by default', async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <Modal isOpen={open} onOpenChange={setOpen}>
          <Dialog aria-label="Settings">
            <p>Body</p>
          </Dialog>
        </Modal>
      );
    }
    renderOverlay(<Harness />);
    await userEvent.click(scrim()!);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('closes on a press on the scrim when dismissable', async () => {
    const onOpenChange = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <Modal
          isOpen={open}
          isDismissable
          onOpenChange={(next) => {
            setOpen(next);
            onOpenChange(next);
          }}
        >
          <Dialog aria-label="Settings">
            <p>Body</p>
          </Dialog>
        </Modal>
      );
    }
    renderOverlay(<Harness />);
    await userEvent.click(scrim()!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('marks the drawer variant on the scrim and the panel', () => {
    renderOverlay(
      <Modal isOpen variant="drawer">
        <Dialog aria-label="Settings">
          <p>Body</p>
        </Dialog>
      </Modal>,
    );
    expect(scrim()?.getAttribute('data-variant')).toBe('drawer');
    expect(panel()?.getAttribute('data-variant')).toBe('drawer');
  });
});
