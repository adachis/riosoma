import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { Button } from './Button';
import { Dialog, DialogBody, DialogFooter, DialogTitle } from './Dialog';
import { Drawer } from './Drawer';

// Components translate their own text through Lingui, which needs the provider above them.
function renderOverlay(element: ReactElement) {
  return render(<I18nProvider i18n={i18n}>{element}</I18nProvider>);
}

/** The drawer the rest of the tests look at: a settings sheet with the usual dialog parts. */
function SettingsDrawer(props: { isDismissable?: boolean; side?: 'start' | 'end' | 'bottom' }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Button>Behind</Button>
      <Drawer isOpen={open} onOpenChange={setOpen} {...props}>
        <Dialog>
          <DialogTitle>Settings</DialogTitle>
          <DialogBody>
            <p>Theme</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="primary" onPress={() => setOpen(false)}>
              Save
            </Button>
          </DialogFooter>
        </Dialog>
      </Drawer>
    </>
  );
}

function sheet() {
  return document.querySelector('.rio-drawer');
}

describe('Drawer', () => {
  it('renders the dialog in a sheet marked as a drawer', () => {
    renderOverlay(<SettingsDrawer />);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog.parentElement).toBe(sheet());
    expect(sheet()?.getAttribute('data-variant')).toBe('drawer');
    expect(dialog.closest('.rio-modal-overlay')?.getAttribute('data-variant')).toBe('drawer');
    // The sheet takes its inline size from the dock token, so no panel size is advertised.
    expect(sheet()?.getAttribute('data-size')).toBeNull();
  });

  it('rises from the bottom as a sheet when asked', () => {
    renderOverlay(<SettingsDrawer side="bottom" />);
    expect(sheet()?.getAttribute('data-side')).toBe('bottom');
    expect(document.querySelector('.rio-modal-overlay')?.getAttribute('data-side')).toBe('bottom');
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  });

  it('holds a title, a body, a footer, and the corner close button', () => {
    renderOverlay(<SettingsDrawer />);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog.querySelector('.rio-dialog__body')?.textContent).toBe('Theme');
    expect(dialog.querySelector('.rio-dialog__footer')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('closes on Escape', async () => {
    renderOverlay(<SettingsDrawer />);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sheet()).toBeNull();
  });

  it('closes through its own action', async () => {
    renderOverlay(<SettingsDrawer />);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on a press on the scrim when dismissable', async () => {
    renderOverlay(<SettingsDrawer isDismissable />);
    await userEvent.click(document.querySelector('.rio-modal-overlay')!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ignores a press on the scrim by default', async () => {
    renderOverlay(<SettingsDrawer />);
    await userEvent.click(document.querySelector('.rio-modal-overlay')!);
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  });

  it('keeps focus inside while tabbing', async () => {
    renderOverlay(<SettingsDrawer />);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    for (let step = 0; step < 4; step += 1) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    // The page behind the sheet stays out of reach.
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Behind' }));
  });
});
