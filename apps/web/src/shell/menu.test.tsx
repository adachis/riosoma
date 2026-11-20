import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { Button } from '@riosoma/ui';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { Menu, MenuItem, MenuTrigger } from './menu';

afterEach(cleanup);

it('keeps its trigger mounted and restores keyboard focus after the first lazy opening', async () => {
  const user = userEvent.setup();
  render(
    <I18nProvider i18n={i18n}>
      <MenuTrigger>
        <Button>
          <Trans id="shell.menu">Menu</Trans>
        </Button>
        <Menu aria-label={i18n._('shell.menu')}>
          <MenuItem id="help">
            <Trans id="shell.help">Help</Trans>
          </MenuItem>
        </Menu>
      </MenuTrigger>
    </I18nProvider>,
  );
  const trigger = screen.getByRole('button', { name: 'Menu' });
  trigger.focus();
  await user.keyboard('{ArrowDown}');
  const item = await screen.findByRole('menuitem', { name: 'Help' });
  await waitFor(() => expect(document.activeElement).toBe(item));
  expect(screen.getByRole('button', { name: 'Menu', hidden: true })).toBe(trigger);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
