import { expect, test } from '../accessibility';
import { base } from '../base';
import { signIn } from '../helpers';

test('primary buttons retain keyboard focus while hovered and pressed', async ({ page }) => {
  await signIn(page);
  await page.goto(`${base()}/sign-in`);
  const button = page.getByRole('button', { name: 'Sign in', exact: true });
  await page.getByLabel('Password', { exact: true }).focus();
  await page.keyboard.press('Tab');
  await button.focus();
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute('data-focus-visible');
  const focusRing = await button.evaluate((element) =>
    getComputedStyle(element).getPropertyValue('--rio-focus-ring').trim(),
  );
  expect(focusRing).not.toBe('');
  // The pointer may still sit where the previous sign-in button was before navigation.
  // Enter the hydrated button so Firefox delivers the hover event as a new interaction.
  await page.mouse.move(0, 0);
  await button.hover();
  await expect(button).toHaveAttribute('data-hovered');
  const hasFocusRing = () =>
    button.evaluate((element) => {
      const style = getComputedStyle(element);
      return (
        style.outlineStyle !== 'none' ||
        style.boxShadow.replace(/rgba?\([^)]*\)/g, 'color').split(',').length > 1
      );
    });
  expect(await hasFocusRing()).toBe(true);
  // Keyboard pressing retains focus visibility, without submitting the form until key release.
  await page.keyboard.down('Space');
  try {
    await expect(button).toHaveAttribute('data-pressed');
    expect(await hasFocusRing()).toBe(true);
  } finally {
    await page.keyboard.up('Space');
  }
});

test.describe('phone header controls', () => {
  test.use({ serviceWorkers: 'block' });

  test('keeps every control in reach with a long usage summary', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.route('**/api/ai/footprint/mine', (route) =>
      route.fulfill({
        json: {
          used: true,
          month: `${new Date().toISOString().slice(0, 7)}-01`,
          calls: 12,
          estimatedCalls: 12,
          pricedCalls: 12,
          costUsd: 0.42,
          energyWh: { min: 5.3, max: 12.6 },
          gwpG: { min: 2.5, max: 6 },
          byFeature: [],
        },
      }),
    );
    await signIn(page);
    const header = page.getByRole('banner');
    // AI spending is shown in Rio's panel, so the app's header carries no usage control.
    await expect(header.getByRole('button', { name: /^Your AI use this month:/ })).toHaveCount(0);
    for (const button of await header.getByRole('button').all()) {
      await expect(button).toBeInViewport({ ratio: 1 });
    }
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 375);
    await header.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
    const panel = page.locator('.rio-assistant__panel');
    await expect(panel.getByRole('textbox', { name: 'Ask Rio anything about your data' })).toBeVisible();
    const usage = panel.getByRole('button', { name: /^Your AI use this month:/ });
    await expect(usage).toBeVisible();
    for (const button of await panel.locator('.rio-assistant__header').getByRole('button').all()) {
      await expect(button).toBeInViewport({ ratio: 1 });
    }
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 375);
    await usage.click();
    const details = page.getByRole('dialog', { name: 'Your AI use this month', exact: true });
    await expect(details).toBeVisible();
    await expect(details).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Escape');
    await expect(details).toHaveCount(0);
    await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();
  });
});
