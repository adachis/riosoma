import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { renderSharing } from '../screens/database/share/testing';
import { SettingsDraftPage, SettingsDraftProvider, SettingsSaveBar } from '../screens/settings/SettingsDraft';
import { ShellFooter } from './ShellFooter';

afterEach(cleanup);

it('reserves a branding zone before page status and actions', async () => {
  renderSharing(
    <SettingsDraftProvider>
      <SettingsDraftPage page="test">
        <span />
      </SettingsDraftPage>
      <ShellFooter brand={<span data-testid="platform-mark" />} page={<SettingsSaveBar />} />
    </SettingsDraftProvider>,
  );
  const bar = await screen.findByRole('region', { name: 'Save changes' });
  const brand = screen.getByTestId('platform-mark').parentElement;
  expect(brand?.className).toBe('rio-shell__footer-brand');
  expect(brand?.nextElementSibling).toBe(bar.parentElement);
  // Rio opens from the header, so nothing follows the page's actions.
  expect(bar.parentElement?.nextElementSibling).toBeNull();
});

it('keeps the branding zone when the page has no actions', () => {
  const rendered = renderSharing(<ShellFooter brand={<span data-testid="platform-mark" />} />);
  expect(screen.getByTestId('platform-mark').parentElement?.className).toBe('rio-shell__footer-brand');
  expect(rendered.container.querySelector('.rio-shell__footer-page')?.children.length).toBe(0);
});

it('places settings status and actions in the page zone', async () => {
  renderSharing(
    <SettingsDraftProvider>
      <SettingsDraftPage page="test">
        <span />
      </SettingsDraftPage>
      <ShellFooter page={<SettingsSaveBar />} />
    </SettingsDraftProvider>,
  );
  const bar = await screen.findByRole('region', { name: 'Save changes' });
  expect(bar.parentElement?.className).toBe('rio-shell__footer-page');
  expect(within(bar).getByRole('status')).toBeTruthy();
  expect(within(bar).getByRole('button', { name: 'Save' })).toBeTruthy();
  expect(within(bar).getByRole('button', { name: 'Discard' })).toBeTruthy();
});
