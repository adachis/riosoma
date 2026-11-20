import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '../accessibility';
import { standIn } from '../../server/src/mcp-client/stand-in.test-support';
import { asOwner, flip, signIn } from '../helpers';
import { STAND_IN_HOSTS } from '../stack';
import { base, standIn as listener } from '../base';

// The stand-in runs only on a temporary listener and never contacts an outside service.
test.use({ serviceWorkers: 'block' });
for (const width of [1280, 390])
  test(`connects tools and approves one call at ${width} pixels`, async ({ page }) => {
    const outside = await standIn({ ...listener(), hostname: STAND_IN_HOSTS[0]! });
    try {
      await page.setViewportSize({ width, height: 844 });
      await signIn(page);
      await page.goto(`${base()}/settings/ai?tab=tools&server=new`);
      await page.getByRole('textbox', { name: 'Server name', exact: true }).fill('Outside');
      await page.getByRole('textbox', { name: 'Server address', exact: true }).fill(outside.address);
      await flip(page.getByRole('switch', { name: 'Allow private network addresses' }));
      await page.getByText('Everyone', { exact: true }).click();
      await page
        .getByRole('region', { name: 'Save changes', exact: true })
        .getByRole('button', { name: 'Save', exact: true })
        .click();
      await expect(page).toHaveURL(/server=[0-9a-f-]{36}/);
      const id = new URL(page.url()).searchParams.get('server')!;
      await page.getByRole('button', { name: 'Refresh tools for Outside' }).click();
      await flip(page.getByRole('switch', { name: 'inspect', exact: true }));
      await flip(page.getByRole('switch', { name: 'write', exact: true }));
      await expect(page.getByText('The server says this tool only reads', { exact: true })).toBeVisible();
      await flip(page.getByRole('switch', { name: 'Always ask first for inspect', exact: true }));
      await page
        .getByRole('region', { name: 'Save changes', exact: true })
        .getByRole('button', { name: 'Save', exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (
              await asOwner<{ id: string; config: { enabledTools: string[] } }[]>(
                page,
                'GET',
                '/api/admin/remote-tools',
              )
            ).find((server) => server.id === id)?.config.enabledTools,
        )
        .toEqual(['inspect', 'write']);
      await page.reload();
      await expect(page.getByRole('switch', { name: 'write', exact: true })).toBeChecked();
      await expect(
        page.getByRole('switch', { name: 'Always ask first for inspect', exact: true }),
      ).toBeChecked();
      await page.getByRole('textbox', { name: 'Server name', exact: true }).focus();
      await expect(page.getByRole('textbox', { name: 'Server name', exact: true })).toBeFocused();
      await expect(page.locator('body')).toHaveJSProperty('scrollWidth', width);
      const accessibility = await new AxeBuilder({ page }).include('.rio-remote-tools').analyze();
      expect(accessibility.violations).toEqual([]);
      await asOwner(page, 'PUT', '/api/ai/settings', { enabled: true });
      const conversation = await asOwner<{ id: string }>(page, 'POST', '/api/rio/conversations');
      const call = await asOwner<{ data: { href: string; approvalId: string } }>(
        page,
        'POST',
        `/api/rio/conversations/${conversation.id}/remote-tools`,
        { serverId: id, tool: 'write', arguments: { value: randomUUID() } },
      );
      expect(outside.state.calls).toHaveLength(0);
      await page.goto(`${base()}${call.data.href}`);
      await expect(page.locator('.rio-remote-approval pre').first()).toContainText('value');
      const approve = page.getByRole('button', { name: 'Approve this call' });
      await approve.focus();
      await approve.press('Enter');
      await expect(page.locator('.rio-remote-approval').getByRole('status')).toHaveText('Finished');
      expect(outside.state.calls).toHaveLength(1);
      await page.reload();
      await expect(page.locator('.rio-remote-approval').getByRole('status')).toHaveText('Finished');
      expect(outside.state.calls).toHaveLength(1);
      await page.getByRole('button', { name: 'Close Rio', exact: true }).click();
      await page.goto(`${base()}/settings/ai?tab=tools&server=${id}`);
      await page.getByRole('button', { name: 'Remove server', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm removal' }).click();
      await expect(page.getByRole('link', { name: 'Outside', exact: true })).toHaveCount(0);
    } finally {
      await outside.close();
    }
  });
