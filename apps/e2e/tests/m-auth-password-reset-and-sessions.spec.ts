import { randomBytes, createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect } from '../accessibility';
import { test as it } from '../sign-in-settings';
import { base } from '../base';
import { asOwner, signIn, visit } from '../helpers';
import { invite, mailTo, waitForMail } from '../people';
import { rows } from '../sql';

const password = () => `a strong password ${randomBytes(12).toString('hex')}`;
async function preparePassword(id: string, value: string) {
  const module = (await import(new URL('../../server/dist/auth/passwords.js', import.meta.url).href)) as {
    hashPassword(value: string): Promise<string>;
  };
  await rows('UPDATE rio_app.users SET password_hash = $1 WHERE id = $2', [
    await module.hashPassword(value),
    id,
  ]);
}
async function enter(page: Page, email: string, value: string) {
  await visit(page, `${base()}/sign-in`);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
}
async function requestReset(page: Page, email: string) {
  await visit(page, `${base()}/sign-in`);
  await page.getByRole('link', { name: 'Forgot password' }).click();
  await expect(page).toHaveURL(/sign-in\/forgot-password/);
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send reset link', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'If this address can reset' })).toBeVisible();
}
const linkIn = (text: string) => /https?:\/\/[^\s]+\/sign-in\/reset#token=[\w-]+/.exec(text)?.[0];

for (const width of [1280, 390]) {
  test(`password recovery navigation keeps theme colors and keyboard focus at ${width} pixels`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    await page.context().clearCookies();
    await page.addInitScript(() => localStorage.setItem('rio.theme', JSON.stringify({ theme: 'synthwave' })));
    await visit(page, `${base()}/sign-in`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'synthwave');
    const recovery = page.getByRole('link', { name: 'Forgot password', exact: true });
    await page.getByRole('button', { name: 'Sign in', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(recovery).toBeFocused();
    await recovery.press('Enter');
    await expect(page).toHaveURL(`${base()}/sign-in/forgot-password`);
    await expect(page.getByRole('heading', { name: 'Forgot password', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Back to sign-in', exact: true }).press('Enter');
    await expect(page).toHaveURL(`${base()}/sign-in`);
    await visit(page, `${base()}/sign-in/reset`);
    await expect(page.getByRole('alert')).toBeVisible();
    await page.getByRole('link', { name: 'Request a new reset link', exact: true }).press('Enter');
    await expect(page).toHaveURL(`${base()}/sign-in/forgot-password`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const width of [1280, 390]) {
  test(`resets a forgotten password through email at ${width} pixels and refuses reused and expired links`, async ({
    page,
    browser,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    const person = await invite(page, browser, 'Password reset');
    const oldPassword = password();
    await preparePassword(person.id, oldPassword);
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height: 900 } });
    const recovery = await context.newPage();
    try {
      await requestReset(recovery, person.email);
      const email = await waitForMail(
        (mail) => mail.to.includes(person.email) && mail.subject === 'Reset your Riosoma password',
        'a password reset link',
      );
      const link = linkIn(email.text)!;
      expect(link).toBeTruthy();
      await visit(recovery, link);
      await expect(recovery.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
      await expect(recovery).toHaveURL(/\/sign-in\/reset$/);
      const fresh = password();
      await recovery.getByLabel('New password', { exact: true }).fill(fresh);
      await recovery.getByRole('button', { name: 'Change password', exact: true }).click();
      await expect(recovery.getByRole('status').filter({ hasText: 'Your password changed' })).toBeVisible();
      expect((await person.page.request.get(`${base()}/api/auth/session`)).status()).toBe(401);
      await waitForMail(
        (mail) => mail.to.includes(person.email) && mail.subject === 'Your Riosoma password changed',
        'a password change notice',
      );
      await enter(recovery, person.email, fresh);
      await visit(recovery, link);
      await recovery.getByLabel('New password', { exact: true }).fill(password());
      await recovery.getByRole('button', { name: 'Change password', exact: true }).click();
      await expect(
        recovery.getByText(
          'That reset link expired, was already used, or was replaced.  Request a new link.',
        ),
      ).toBeVisible();
      const previous = mailTo(person.email).length;
      await requestReset(recovery, person.email);
      await expect.poll(() => mailTo(person.email).length).toBeGreaterThan(previous);
      const latest = mailTo(person.email).at(-1)!;
      const expired = linkIn(latest.text)!;
      const token = new URL(expired).hash.slice('#token='.length);
      await rows(
        "UPDATE rio_app.login_tokens SET expires_at = clock_timestamp() - interval '1 second' WHERE token_hash = $1",
        [createHash('sha256').update(token).digest('hex')],
      );
      await visit(recovery, expired);
      await recovery.getByLabel('New password', { exact: true }).fill(password());
      await recovery.getByRole('button', { name: 'Change password', exact: true }).click();
      await expect(
        recovery.getByText(
          'That reset link expired, was already used, or was replaced.  Request a new link.',
        ),
      ).toBeVisible();
      expect(await recovery.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
        true,
      );
    } finally {
      await context.close();
      await person.context.close();
    }
  });
}

it('explains recovery without email, honors the policy, and lets a People administrator create a link', async ({
  page,
  browser,
}) => {
  await signIn(page);
  const person = await invite(page, browser, 'Copied reset');
  await preparePassword(person.id, password());
  const context = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 390, height: 844 },
  });
  const recovery = await context.newPage();
  try {
    await recovery.route('**/api/auth/password-reset', async (route) => {
      if (route.request().method() === 'GET') await route.fulfill({ json: { enabled: true, email: false } });
      else await route.continue();
    });
    await visit(recovery, `${base()}/sign-in/forgot-password`);
    await expect(recovery.getByText(/Email is not set up on this server/)).toBeVisible();
    await expect(
      recovery.getByText(/server operator can run the owner password reset command/),
    ).toBeVisible();
    await visit(page, `${base()}/settings/people?member=${encodeURIComponent(person.id)}`);
    await page.getByRole('button', { name: `Actions for ${person.name}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Reset password', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Create one-time link', exact: true }).click();
    const link = await dialog.getByLabel('One-time reset link').inputValue();
    expect(linkIn(link)).toBe(link);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            document.documentElement.dataset.copiedLink = text;
          },
        },
      });
    });
    await dialog.getByRole('button', { name: 'Copy link', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('Copied the link.');
    expect(await page.evaluate(() => document.documentElement.dataset.copiedLink)).toBe(link);
    await visit(recovery, link);
    await recovery.getByLabel('New password', { exact: true }).fill(password());
    await recovery.getByRole('button', { name: 'Change password', exact: true }).click();
    await expect(recovery.getByRole('status').filter({ hasText: 'Your password changed' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await visit(page, `${base()}/admin/security/sign-in-policy/password-reset`);
    const resetPolicy = page.getByRole('checkbox', { name: 'Allow password reset', exact: true });
    await expect(resetPolicy).toBeChecked();
    await page.getByText('Allow password reset', { exact: true }).click();
    await expect(resetPolicy).not.toBeChecked();
    await resetPolicy.focus();
    await resetPolicy.press('Space');
    await expect(resetPolicy).toBeChecked();
    await resetPolicy.press('Space');
    await expect(resetPolicy).not.toBeChecked();
    await page
      .getByRole('region', { name: 'Save changes', exact: true })
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect
      .poll(() => asOwner(page, 'GET', '/api/admin/password-reset/policy'))
      .toEqual({ enabled: false });
    await recovery.unroute('**/api/auth/password-reset');
    await visit(recovery, `${base()}/sign-in/forgot-password`);
    await expect(
      recovery.getByText('Your organization has turned password reset off.  Contact an administrator.'),
    ).toBeVisible();
  } finally {
    await context.close();
    await person.context.close();
  }
});

test('lists sessions and signs out one session and every other session across browser contexts', async ({
  page,
  browser,
}) => {
  await signIn(page);
  const person = await invite(page, browser, 'Session controls');
  const value = password();
  await preparePassword(person.id, value);
  const context = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 390, height: 844 },
  });
  const other = await context.newPage();
  try {
    await asOwner(person.page, 'POST', '/api/auth/sign-out', {});
    await enter(person.page, person.email, value);
    await enter(other, person.email, value);
    await person.page.setViewportSize({ width: 390, height: 844 });
    await visit(person.page, `${base()}/settings/account/security/sessions`);
    const section = person.page.getByRole('region', { name: 'Where you’re signed in' });
    await expect(section.getByText('This device', { exact: true })).toHaveCount(1);
    const firstOther = section.getByRole('listitem').filter({ hasNotText: 'This device' }).first();
    await firstOther.getByRole('button', { name: /^Sign out / }).click();
    await person.page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(section.getByRole('listitem')).toHaveCount(1);
    expect((await other.request.get(`${base()}/api/auth/session`)).status()).toBe(401);
    await enter(other, person.email, value);
    await visit(person.page, `${base()}/settings/account/security/sessions`);
    await expect(section.getByRole('listitem')).toHaveCount(2);
    await section.getByRole('button', { name: 'Sign out everywhere else', exact: true }).click();
    await person.page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(section.getByRole('listitem')).toHaveCount(1);
    expect((await other.request.get(`${base()}/api/auth/session`)).status()).toBe(401);
    expect((await person.page.request.get(`${base()}/api/auth/session`)).status()).toBe(200);
    await enter(other, person.email, value);
    await visit(other, `${base()}/settings/account/security/password`);
    await expect(other.getByRole('checkbox', { name: 'Sign out everywhere else' })).toBeChecked();
    await other.getByLabel('Current password', { exact: true }).fill(value);
    await other.getByLabel('New password', { exact: true }).fill(password());
    await other.getByRole('button', { name: 'Change password', exact: true }).click();
    await expect(other.getByRole('status').filter({ hasText: 'Your password changed' })).toBeVisible();
    expect((await person.page.request.get(`${base()}/api/auth/session`)).status()).toBe(401);
    expect(await other.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await visit(page, `${base()}/settings/people?member=${encodeURIComponent(person.id)}`);
    await page.getByRole('button', { name: `Actions for ${person.name}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'End all sessions', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'End all sessions', exact: true }).click();
    expect((await other.request.get(`${base()}/api/auth/session`)).status()).toBe(401);
  } finally {
    await context.close();
    await person.context.close();
  }
});
