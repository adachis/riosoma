import { documentIdentity, expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, flip, signIn, visit } from '../helpers';

for (const phone of [false, true]) {
  test(`stored credentials need provider consent on ${phone ? 'a phone' : 'a desktop'}`, async ({ page }) => {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    const before = await asOwner<{ settings: Record<string, unknown> }>(page, 'GET', '/api/ai/settings');
    await asOwner(page, 'PUT', '/api/ai/settings', {
      enabled: false,
      providers: [],
      models: { everyday: null, power: null },
    });
    try {
      await visit(page, `${base()}/settings/ai`);
      await flip(page.getByRole('switch', { name: 'Turn on AI', exact: true }));
      await expect(
        page.getByText('Rio stays off until you turn on a provider and save settings.'),
      ).toBeVisible();
      const provider = page.getByRole('region', { name: 'Amazon Bedrock', exact: true });
      await provider
        .getByLabel('API key', { exact: true })
        .fill(await page.evaluate(() => crypto.randomUUID()));
      await page
        .getByRole('region', { name: 'Save changes', exact: true })
        .getByRole('button', { name: 'Save', exact: true })
        .click();
      await expect(provider.getByText('Turn on Amazon Bedrock so Rio can use it')).toBeVisible();
      const consent = provider.getByRole('switch', { name: 'Amazon Bedrock', exact: true });
      await expect(consent).not.toBeChecked();
      await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
      await expect(page.getByText('Rio is off because no provider is turned on.')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Review providers in AI settings' })).toHaveAttribute(
        'href',
        '/settings/ai#providers',
      );
      await page.getByRole('button', { name: 'Close Rio', exact: true }).click();
      await flip(consent);
      await expect(provider.getByText('Turn on Amazon Bedrock so Rio can use it')).toHaveCount(0);
      await page
        .getByRole('region', { name: 'Save changes', exact: true })
        .getByRole('button', { name: 'Save', exact: true })
        .click();
      await expect(
        page.getByText('Rio stays off until you turn on a provider and save settings.'),
      ).toHaveCount(0);
      await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Ask Rio anything about your data' })).toBeEnabled();
      await expect(page.getByText('Rio is off because no provider is turned on.')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      await asOwner(page, 'DELETE', '/api/ai/keys/bedrock');
      const { gateways: _gateways, ...settings } = before.settings;
      await asOwner(page, 'PUT', '/api/ai/settings', settings);
    }
  });
}

for (const phone of [false, true]) {
  test(`help preserves unsaved settings and document links ask before leaving on ${phone ? 'a phone' : 'a desktop'}`, async ({
    page,
  }) => {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await visit(page, `${base()}/settings/ai`);
    const budget = page.getByRole('textbox', { name: 'Monthly budget (US dollars)' });
    await budget.fill('23');
    const documentId = await documentIdentity(page);
    const prompt = page.getByRole('dialog', { name: 'You have unsaved changes on this page.' });
    for (const [name, topic] of [
      ['Help with knowledge', 'knowledge-libraries'],
      ['Help with document imports', 'importing'],
      ['Help with web search', 'web-search'],
      ['Help with embeddings', 'similar-records'],
    ]) {
      await page.getByRole('link', { name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`[?&]help=${topic}(?:&|$)`));
      await expect(page.getByRole('button', { name: 'Close help', exact: true })).toBeVisible();
      await expect(prompt).toHaveCount(0);
      expect(await documentIdentity(page)).toBe(documentId);
      await page.getByRole('button', { name: 'Close help', exact: true }).click();
      await expect(budget).toHaveValue('23');
    }
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: 'Keep editing' }).click();
    await expect(budget).toHaveValue('23');
    // A document endpoint stands in for a link that replaces the app's document.
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = '/healthz';
      link.textContent = link.pathname;
      document.querySelector('main')!.append(link);
    });
    const documentLink = page.getByRole('link', { name: '/healthz', exact: true });
    const nativeDialogs: string[] = [];
    page.on('dialog', (dialog) => {
      nativeDialogs.push(dialog.type());
      void dialog.dismiss();
    });
    await documentLink.click();
    await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: 'Keep editing' }).click();
    await expect(budget).toHaveValue('23');
    expect(await documentIdentity(page)).toBe(documentId);
    await documentLink.click();
    await prompt.getByRole('button', { name: 'Discard and continue' }).click();
    await expect(page).toHaveURL(`${base()}/healthz`);
    expect(await documentIdentity(page)).not.toBe(documentId);
    expect(nativeDialogs).toEqual([]);
  });
}

test('unsaved settings ask before switching tabs, going Back, or leaving through navigation', async ({
  page,
}) => {
  await signIn(page);
  await visit(page, `${base()}/settings/ai`);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('button', { name: 'General', exact: true }).click();
  const budget = page.getByRole('textbox', { name: 'Monthly budget (US dollars)' });
  const before = await budget.inputValue();
  await budget.fill('17');
  const prompt = page.getByRole('dialog', { name: 'You have unsaved changes on this page.' });
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Keep editing' }).click();
  await expect(budget).toHaveValue('17');
  await page.goBack();
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page).toHaveURL(`${base()}/settings/ai`);
  await expect(budget).toHaveValue('17');
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Keep editing' }).click();
  await budget.fill(before);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(prompt).toHaveCount(0);
});
