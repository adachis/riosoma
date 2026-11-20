import { useRef } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { settingsRegistry } from './registry';
import { SettingItem } from './Setting';
import { activateSetting, useSettingTarget } from './useSettingTarget';

vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({
    href: '/admin/security/sign-in-policy/sign-in-policy',
    pathname: '/admin/security/sign-in-policy/sign-in-policy',
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const target = settingsRegistry.find(
  (setting) => setting.page === 'sign-in-policy' && setting.id === 'sign-in-policy',
)!;

function Destination({ gate, pending }: { gate: string; pending: boolean }) {
  const body = useRef<HTMLDivElement>(null);
  useSettingTarget(body, target);
  return (
    <div ref={body}>
      <div
        hidden={gate === 'hidden' && pending}
        aria-hidden={gate === 'aria-hidden' && pending ? true : undefined}
        aria-busy={gate === 'read-only' ? false : gate === 'aria-busy' && pending ? true : undefined}
        inert={gate === 'inert' && pending ? true : undefined}
      >
        <SettingItem definition={target}>
          <div aria-busy={gate === 'busy-content' && pending ? true : undefined}>
            <input type="radio" disabled={gate === 'read-only' || (gate === 'disabled' && pending)} />
          </div>
        </SettingItem>
      </div>
    </div>
  );
}

it.each(['hidden', 'aria-hidden', 'aria-busy', 'inert', 'disabled', 'busy-content'])(
  'waits for a destination gated by %s before focusing and highlighting it',
  async (gate) => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    const view = render(<Destination gate={gate} pending />);
    const control = view.container.querySelector('input')!;
    const row = view.container.querySelector<HTMLElement>('[data-setting-id]')!;
    expect(row.dataset.settingHighlighted).toBeUndefined();
    expect(document.activeElement).not.toBe(control);
    expect(scroll).not.toHaveBeenCalled();
    await act(async () => view.rerender(<Destination gate={gate} pending={false} />));
    await waitFor(() => expect(document.activeElement).toBe(control));
    expect(row.dataset.settingHighlighted).toBe('true');
    expect(scroll).toHaveBeenCalledOnce();
  },
);

it('focuses a read-only row after its loading region is ready', async () => {
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  const view = render(<Destination gate="read-only" pending={false} />);
  const row = view.container.querySelector<HTMLElement>('[data-setting-id]')!;
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(row.dataset.settingHighlighted).toBe('true');
});

it('continues observing when a repeated selection becomes inert before reopening', async () => {
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  const view = render(<Destination gate="inert" pending={false} />);
  const control = view.container.querySelector('input')!;
  await waitFor(() => expect(document.activeElement).toBe(control));
  control.blur();
  await act(async () => view.rerender(<Destination gate="inert" pending />));
  act(() => activateSetting('/admin/security/sign-in-policy/sign-in-policy'));
  expect(document.activeElement).not.toBe(control);
  await act(async () => view.rerender(<Destination gate="inert" pending={false} />));
  await waitFor(() => expect(document.activeElement).toBe(control));
  expect(scroll).toHaveBeenCalledTimes(2);
});
