import { expect, test } from '../accessibility';
import { base } from '../base';
import { signIn, visit } from '../helpers';

for (const phone of [false, true]) {
  test(`cloud providers are accessible on ${phone ? 'a phone' : 'a desktop'}`, async ({ page }) => {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await visit(page, `${base()}/settings/ai`);
    for (const name of ['Amazon Bedrock', 'Vertex AI', 'Azure OpenAI', 'FAL']) {
      const region = page.getByRole('region', { name, exact: true });
      await expect(region.getByLabel('API key', { exact: true })).toHaveAttribute('type', 'password');
      const toggle = region.getByRole('switch', { name, exact: true });
      await toggle.focus();
      await page.keyboard.press('Space');
      await expect(toggle).toBeChecked();
      await page.keyboard.press('Space');
      await expect(toggle).not.toBeChecked();
    }
    const azure = page.getByRole('region', { name: 'Azure OpenAI', exact: true });
    await azure.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect(azure.getByRole('alert')).toBeVisible();
    await expect(azure.getByRole('status')).toHaveCount(0);
    for (const name of ['Amazon Bedrock', 'FAL']) {
      const region = page.getByRole('region', { name, exact: true });
      await region
        .getByLabel('API key', { exact: true })
        .fill(await page.evaluate(() => crypto.randomUUID()));
      await page
        .getByRole('region', { name: 'Save changes', exact: true })
        .getByRole('button', { name: 'Save', exact: true })
        .click();
      await expect(region.getByText('Stored', { exact: true })).toBeVisible();
      try {
        await region.getByRole('button', { name: 'Test connection', exact: true }).click();
        await expect(region.getByRole('status')).toHaveText('Credentials not verified');
        await expect(region.getByText('Connected', { exact: true })).toHaveCount(0);
      } finally {
        await region.getByRole('button', { name: 'Remove key', exact: true }).click();
        await expect(region.getByText('Stored', { exact: true })).toHaveCount(0);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
