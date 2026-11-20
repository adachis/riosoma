import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, expect, it } from 'vitest';
import { renderSharing } from '../database/share/testing';
import { SettingsSearch } from './SettingsSearch';
import { settingHref, settingsRegistry } from './registry';
import { useSettingTarget } from './useSettingTarget';
import { Setting } from './Setting';

afterEach(cleanup);

it('refocuses a repeated search destination while preserving its database return address', async () => {
  const target = settingsRegistry.find((setting) => setting.id === 'max-upload-bytes')!;
  const pathname = settingHref(target);
  const returnTo = '/database/table/view';
  function Probe() {
    const body = useRef<HTMLElement>(null);
    useSettingTarget(body, target);
    return (
      <>
        <SettingsSearch />
        <section ref={body}>
          <Setting page={target} id={target.id} label={target.label}>
            <input aria-label="Maximum upload size (bytes)" />
          </Setting>
        </section>
      </>
    );
  }
  const root = createRootRoute({ validateSearch: (search: Record<string, unknown>) => search });
  const route = createRoute({ getParentRoute: () => root, path: pathname, component: Probe });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({
      initialEntries: [`${pathname}?returnTo=${encodeURIComponent(returnTo)}`],
    }),
  });
  renderSharing(<RouterProvider router={router} />);
  const control = await screen.findByRole('textbox', { name: 'Maximum upload size (bytes)' });
  await waitFor(() => expect(document.activeElement).toBe(control));
  const user = userEvent.setup();
  const search = screen.getByRole('combobox', { name: 'Search settings' });
  await user.type(search, 'Maximum upload size');
  await user.keyboard('{ArrowDown}{Enter}');
  await waitFor(() => expect(document.activeElement).toBe(control));
  expect(router.state.location.pathname).toBe(pathname);
  expect(router.state.location.search.returnTo).toBe(returnTo);
});
