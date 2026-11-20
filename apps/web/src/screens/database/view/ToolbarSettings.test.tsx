import { faCalendarDay, faSliders } from '@fortawesome/free-solid-svg-icons';
import { Fragment, useState } from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@lingui/react';
import { setupI18n } from '@lingui/core';
import { Dialog } from 'react-aria-components';
import { afterEach, expect, it, vi } from 'vitest';
import { GridConfig } from '@riosoma/contracts';
import { Button, Checkbox, Dialog as ModalDialog, DialogTitle, Modal, Popover } from '@riosoma/ui';
import { ViewToolbar } from './ViewToolbar';
import { SettingsAction, SettingsTrigger, ToolbarSettings } from './ToolbarSettings';
import { HELP_REQUEST } from '../../../docs/help-request';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('opens form-sharing help from a dialog named by its title and closes the dialog', async () => {
  const requested = vi.fn();
  document.addEventListener(HELP_REQUEST, requested);
  try {
    render(
      <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
        <SettingsTrigger
          label="Share publicly"
          helpTopic={{ id: 'forms', section: 'sharing-a-form-by-link', anchorId: 'forms.public.theme' }}
        >
          <Button>Share publicly</Button>
          <Modal isDismissable size="sm">
            <ModalDialog>
              <DialogTitle>Share publicly</DialogTitle>
            </ModalDialog>
          </Modal>
        </SettingsTrigger>
      </I18nProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Share publicly' }));
    const dialog = screen.getByRole('dialog', { name: 'Share publicly' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Help with Share publicly' }));
    expect((requested.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      id: 'forms',
      section: 'sharing-a-form-by-link',
    });
    expect(screen.queryByRole('dialog', { name: 'Share publicly' })).toBeNull();
  } finally {
    document.removeEventListener(HELP_REQUEST, requested);
  }
});

it('opens the documented view settings section and closes its popover', async () => {
  const requested = vi.fn();
  document.addEventListener(HELP_REQUEST, requested);
  try {
    render(
      <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
        <SettingsTrigger
          label="Calendar settings"
          helpTopic={{ id: 'calendar', section: 'choosing-dates', anchorId: 'view.settings.calendar' }}
        >
          <Button>Calendar settings</Button>
          <Popover>
            <Dialog aria-label="Calendar settings">
              <Checkbox>Include weekends</Checkbox>
            </Dialog>
          </Popover>
        </SettingsTrigger>
      </I18nProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Calendar settings' }));
    await userEvent.click(screen.getByRole('button', { name: 'Help with Calendar settings' }));
    expect((requested.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      id: 'calendar',
      section: 'choosing-dates',
    });
    expect(screen.queryByRole('dialog', { name: 'Calendar settings' })).toBeNull();
  } finally {
    document.removeEventListener(HELP_REQUEST, requested);
  }
});

it('fits view settings last and preserves dialog state, updates, and focus through overflow', async () => {
  let resize = (_width: number) => {};
  let available = 1000;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = this.classList.contains('rio-responsive-toolbar')
      ? available
      : this.dataset.fit === 'full'
        ? 100
        : 40;
    return { width, height: 40, top: 0, left: 0, right: width, bottom: 40, x: 0, y: 0, toJSON: () => ({}) };
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(element: Element) {
        if (element.classList.contains('rio-responsive-toolbar'))
          resize = (width) => {
            available = width;
            act(() =>
              this.callback(
                [{ contentRect: { width } } as ResizeObserverEntry],
                this as unknown as ResizeObserver,
              ),
            );
          };
      }
      disconnect() {}
      unobserve() {}
    },
  );
  const today = vi.fn();
  function Settings() {
    const [selected, setSelected] = useState(false);
    return (
      <>
        <SettingsAction icon={faCalendarDay} label="Today" onAction={today}>
          Today
        </SettingsAction>
        <SettingsTrigger label={selected ? 'Cards with covers' : 'Cards'}>
          <Button>Cards</Button>
          <Popover>
            <Dialog aria-label="Cards">
              <Checkbox isSelected={selected} onChange={setSelected}>
                Show covers
              </Checkbox>
              <SettingsTrigger label="Cover details">
                <Button>Cover details</Button>
                <Popover>
                  <Dialog aria-label="Cover details">Details</Dialog>
                </Popover>
              </SettingsTrigger>
            </Dialog>
          </Popover>
        </SettingsTrigger>
      </>
    );
  }
  const ui = (settings = true) => (
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
      <ToolbarSettings>
        <ViewToolbar config={GridConfig.parse({})} fields={[]} primaryFieldId="" onConfigChange={vi.fn()} />
        {settings && <Settings />}
      </ToolbarSettings>
    </I18nProvider>
  );
  const { rerender } = render(ui());
  const toolbar = screen.getByRole('toolbar');
  expect(
    within(toolbar).getByRole('button', { name: 'Cards' }).closest('[data-item]')?.getAttribute('data-fit'),
  ).toBe('full');
  resize(600);
  expect(within(toolbar).getByRole('button', { name: 'Cards' }).getAttribute('data-fit')).toBe('icon');
  expect(within(toolbar).getByRole('button', { name: 'Filter' }).getAttribute('data-fit')).toBe('full');
  resize(240);
  expect(within(toolbar).getByRole('button', { name: 'Cards' }).getAttribute('data-fit')).toBe('overflow');
  const more = within(toolbar).getByRole('button', { name: 'More' });
  await userEvent.click(more);
  await userEvent.click(screen.getByRole('menuitem', { name: 'Cards' }));
  await userEvent.click(
    within(screen.getByRole('dialog', { name: 'Cards' })).getByRole('checkbox', { name: 'Show covers' }),
  );
  expect(screen.getByRole('dialog', { name: 'Cards' })).toBeDefined();
  expect(toolbar.querySelectorAll('[data-item]')).toHaveLength(7);
  await userEvent.keyboard('{Escape}');
  await vi.waitFor(() => expect(document.activeElement).toBe(more));
  await userEvent.click(more);
  await userEvent.click(screen.getByRole('menuitem', { name: 'Cards with covers' }));
  expect((screen.getByRole('checkbox', { name: 'Show covers' }) as HTMLInputElement).checked).toBe(true);
  await userEvent.keyboard('{Escape}');
  await userEvent.click(more);
  await userEvent.click(screen.getByRole('menuitem', { name: 'Today' }));
  expect(today).toHaveBeenCalledOnce();
  rerender(ui(false));
  expect(toolbar.querySelectorAll('[data-item]')).toHaveLength(5);
  resize(1000);
  expect(within(toolbar).queryByRole('button', { name: 'Cards with covers' })).toBeNull();
});

it('drops the Sync out label first, before any view setting', () => {
  let available = 1000;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = this.classList.contains('rio-responsive-toolbar')
      ? available
      : this.dataset.fit === 'full'
        ? 100
        : 40;
    return { width, height: 40, top: 0, left: 0, right: width, bottom: 40, x: 0, y: 0, toJSON: () => ({}) };
  });
  let resize = (_width: number) => {};
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(element: Element) {
        if (element.classList.contains('rio-responsive-toolbar'))
          resize = (width) => {
            available = width;
            act(() =>
              this.callback(
                [{ contentRect: { width } } as ResizeObserverEntry],
                this as unknown as ResizeObserver,
              ),
            );
          };
      }
      disconnect() {}
      unobserve() {}
    },
  );
  render(
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
      <ToolbarSettings>
        <ViewToolbar
          config={GridConfig.parse({})}
          fields={[]}
          primaryFieldId=""
          syncOut={{ label: 'Sync out', onAction: vi.fn() }}
          onConfigChange={vi.fn()}
        />
      </ToolbarSettings>
    </I18nProvider>,
  );
  const toolbar = screen.getByRole('toolbar');
  // At full width the control keeps its label like every other item.
  expect(within(toolbar).getByRole('button', { name: 'Sync out' }).getAttribute('data-fit')).toBe('full');
  // As room runs out, Sync out's lower priority means it loses its label before Filter does.
  resize(560);
  expect(within(toolbar).getByRole('button', { name: 'Sync out' }).getAttribute('data-fit')).toBe('icon');
  expect(within(toolbar).getByRole('button', { name: 'Filter' }).getAttribute('data-fit')).toBe('full');
});

it('keeps late and reordered settings in their rendered position', () => {
  const ui = (ids: string[]) => (
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
      <ToolbarSettings>
        <ViewToolbar
          usesToolbar={false}
          config={GridConfig.parse({})}
          fields={[]}
          primaryFieldId=""
          onConfigChange={vi.fn()}
        />
        {ids.map((id) => (
          <Fragment key={id}>
            <SettingsAction icon={faSliders} label={id} onAction={vi.fn()}>
              {id}
            </SettingsAction>
          </Fragment>
        ))}
      </ToolbarSettings>
    </I18nProvider>
  );
  const { rerender } = render(ui(['Value', 'Options']));
  const labels = () =>
    within(screen.getByRole('toolbar'))
      .getAllByRole('button')
      .map((button) => button.textContent);
  expect(labels()).toEqual(['Value', 'Options']);
  rerender(ui(['Value', 'Of', 'Options']));
  expect(labels()).toEqual(['Value', 'Of', 'Options']);
  rerender(ui(['Options', 'Value', 'Of']));
  expect(labels()).toEqual(['Options', 'Value', 'Of']);
});
