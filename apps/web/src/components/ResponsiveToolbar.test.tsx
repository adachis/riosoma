import { act, cleanup, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@lingui/react';
import { setupI18n } from '@lingui/core';
import { faFilter } from '@fortawesome/free-solid-svg-icons';
import { afterEach, expect, it, vi } from 'vitest';
import { MenuItem } from '@riosoma/ui';
import { ResponsiveToolbar, type ResponsiveToolbarItem } from './ResponsiveToolbar';

let resize: (width: number) => void;
function mount(locale = 'en-US', dir = 'ltr') {
  const reads = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const width = this.classList.contains('rio-responsive-toolbar')
      ? 600
      : this.dataset.fit === 'full'
        ? 120
        : this.dataset.fit === 'short'
          ? 70
          : 40;
    return { width, height: 40, top: 0, left: 0, right: width, bottom: 40, x: 0, y: 0, toJSON: () => ({}) };
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(element: Element) {
        if (element.classList.contains('rio-responsive-toolbar')) {
          resize = (width) =>
            act(() =>
              this.callback(
                [{ contentRect: { width } } as ResizeObserverEntry],
                this as unknown as ResizeObserver,
              ),
            );
        }
      }
      disconnect() {}
      unobserve() {}
    },
  );
  const action = vi.fn();
  const labels =
    locale === 'de'
      ? [
          'Gefiltert nach Vertragsabschluss',
          'Sortiert nach Vertragsabschluss',
          'Felder ausblenden',
          'Zeilenhöhe',
        ]
      : ['Filtered by Deal', 'Sorted by Deal', 'Hide fields', 'Row height'];
  const items: ResponsiveToolbarItem[] = labels.map((label, index) => ({
    id: String(index),
    label,
    icon: faFilter,
    priority: [100, 90, 70, 10][index]!,
    shortLabel: index < 2 ? `${index + 1}` : undefined,
    count: index < 2 ? index + 1 : undefined,
    onAction: () => action(index),
  }));
  const i18n = setupI18n({
    locale,
    messages: { [locale]: { 'toolbar.more': locale === 'de' ? 'Mehr' : 'More' } },
  });
  const ui = (values: ResponsiveToolbarItem[]) => (
    <I18nProvider i18n={i18n}>
      <div dir={dir}>
        <ResponsiveToolbar label="Controls" items={values} />
      </div>
    </I18nProvider>
  );
  const result = render(ui(items));
  const modes = () =>
    [...result.container.querySelectorAll('.rio-responsive-toolbar__item[data-item]')].map((node) =>
      node.getAttribute('data-fit'),
    );
  return { ...result, modes, reads, action, labels, items, ui };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ['en-US', 'ltr'],
  ['de', 'ltr'],
  ['de', 'rtl'],
])('fits whole labels, short state, icons, and overflow in %s with %s direction', async (locale, dir) => {
  const { modes, reads, labels, action } = mount(locale, dir);
  expect(modes()).toEqual(['full', 'full', 'full', 'full']);
  const measured = reads.mock.calls.length;
  resize(400);
  expect(modes()).toEqual(['full', 'full', 'full', 'icon']);
  resize(300);
  expect(modes()).toEqual(['full', 'short', 'icon', 'icon']);
  resize(220);
  expect(modes()).toEqual(['short', 'icon', 'icon', 'icon']);
  resize(180);
  expect(modes()).toEqual(['icon', 'icon', 'icon', 'icon']);
  const filter = screen.getByRole('button', { name: `${labels[0]}, 1` });
  expect(filter.querySelector('.rio-responsive-toolbar__badge')?.textContent).toBe('1');
  expect(reads.mock.calls.length).toBe(measured);
  resize(130);
  expect(modes()).toEqual(['icon', 'icon', 'overflow', 'overflow']);
  const more = screen.getByRole('button', { name: locale === 'de' ? 'Mehr' : 'More' });
  await userEvent.click(more);
  expect(
    within(screen.getByRole('menu'))
      .getAllByRole('menuitem')
      .map((node) => node.textContent),
  ).toEqual(labels.slice(2));
  screen.getAllByRole('menuitem')[0]!.focus();
  await userEvent.keyboard('{ArrowDown}{Enter}');
  expect(action).toHaveBeenCalledWith(3);
  await waitFor(() => expect(document.activeElement).toBe(more));
  resize(600);
  expect(modes()).toEqual(['full', 'full', 'full', 'full']);
});

it('remeasures a changed label set and keeps full names on shortened controls', () => {
  const { items, rerender, ui, reads } = mount();
  const measured = reads.mock.calls.length;
  const changed = items.map((item, index) =>
    index ? item : { ...item, label: 'Filtered by Contract renewal', shortLabel: '3', count: 3 },
  );
  rerender(ui(changed));
  expect(reads.mock.calls.length).toBeGreaterThan(measured);
  resize(180);
  const button = screen.getByRole('button', { name: 'Filtered by Contract renewal, 3' });
  expect(button.querySelector('.rio-responsive-toolbar__badge')?.textContent).toBe('3');
});

it('keeps phone actions visible until their icons need overflow', () => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList);
  const { modes } = mount();
  expect(modes()).toEqual(['icon', 'icon', 'icon', 'icon']);
  expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  resize(130);
  expect(modes()).toEqual(['icon', 'icon', 'overflow', 'overflow']);
  expect(screen.getByRole('button', { name: 'More' })).toBeDefined();
});

it('keeps a single phone action directly available and omits empty toolbars', () => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList);
  const { items, ui, rerender, modes } = mount();
  rerender(ui(items.slice(0, 1)));
  resize(44);
  expect(modes()).toEqual(['icon']);
  expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  rerender(ui([]));
  expect(screen.queryByRole('toolbar')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

it('does not shadow theme mode tokens and publishes its measured full width', () => {
  const { container } = mount();
  expect(container.querySelector('[data-mode]')).toBeNull();
  expect(
    container
      .querySelector<HTMLElement>('.rio-responsive-toolbar')
      ?.style.getPropertyValue('--rio-toolbar-full'),
  ).toBe('480px');
});

it('names short controls with their visible text and keeps the full tooltip', async () => {
  const { labels } = mount();
  resize(220);
  const button = screen.getByRole('button', { name: '1' });
  await userEvent.tab();
  expect(document.activeElement).toBe(button);
  expect((await screen.findByRole('tooltip')).textContent).toBe(labels[0]);
});

it('returns focus to the last visible item when More disappears', async () => {
  const { labels } = mount();
  resize(130);
  const more = screen.getByRole('button', { name: 'More' });
  act(() => more.focus());
  expect(document.activeElement).toBe(more);
  resize(600);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: labels[3] })));
});

it('describes More with a tooltip and leaves overflow usable during downloads', async () => {
  const { items, rerender } = mount();
  rerender(
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
      <ResponsiveToolbar
        label="Controls"
        items={items}
        morePending
        moreItems={<MenuItem isDisabled>Download</MenuItem>}
      />
    </I18nProvider>,
  );
  resize(130);
  const more = screen.getByRole('button', { name: 'More' });
  act(() => more.focus());
  expect((await screen.findByRole('tooltip')).textContent).toBe('More');
  await userEvent.click(more);
  expect(screen.getByRole('menuitem', { name: 'Row height' }).getAttribute('aria-disabled')).not.toBe('true');
  expect(screen.getByRole('menuitem', { name: 'Download' }).getAttribute('aria-disabled')).toBe('true');
});

it('shows supplemental menu entries only on phones or when actions overflow', () => {
  const { items, rerender } = mount();
  rerender(
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
      <ResponsiveToolbar label="Controls" items={items} moreItems={<MenuItem>Download</MenuItem>} />
    </I18nProvider>,
  );
  expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  resize(130);
  expect(screen.getByRole('button', { name: 'More' })).toBeDefined();
});

it('keeps focus in the toolbar when the phone download trigger disappears', () => {
  const media = vi.spyOn(window, 'matchMedia');
  const match = (matches: boolean) =>
    media.mockReturnValue({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
  match(true);
  const { items, rerender, labels } = mount();
  const ui = () => (
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
      <ResponsiveToolbar label="Controls" items={items} moreItems={<MenuItem>Download</MenuItem>} />
    </I18nProvider>
  );
  rerender(ui());
  const more = screen.getByRole('button', { name: 'More' });
  act(() => more.focus());
  match(false);
  rerender(ui());
  expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: labels[3] }));
});

it('publishes the icon row width on phones without reserving full labels', () => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList);
  const { container } = mount();
  const root = container.querySelector<HTMLElement>('.rio-responsive-toolbar')!;
  expect(root.style.getPropertyValue('--rio-toolbar-full')).toBe('160px');
  expect(root.style.getPropertyValue('--rio-toolbar-icons')).toBe('160px');
});

it('preserves action variants as controls shrink', () => {
  const { items, rerender, ui } = mount();
  rerender(ui(items.map((item, index) => ({ ...item, variant: index ? 'secondary' : 'primary' }))));
  for (const width of [600, 180]) {
    resize(width);
    expect(screen.getAllByRole('button')[0]!.getAttribute('data-variant')).toBe('primary');
    expect(screen.getAllByRole('button')[1]!.getAttribute('data-variant')).toBe('secondary');
  }
});

it('keeps status labels out of live regions across resize thresholds', () => {
  const { items, rerender, ui } = mount();
  rerender(ui([{ ...items[0]!, label: 'Locked view', status: true }]));
  for (const width of [600, 40, 600]) {
    resize(width);
    expect(screen.queryByRole('status')).toBeNull();
    const marker = screen.getByRole('img', { name: 'Locked view' });
    expect(marker.tabIndex).toBe(0);
  }
});
