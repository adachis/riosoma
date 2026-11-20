import type { FeedbackHubSettings, FeedbackItem } from '../../../packages/contracts/src/index.js';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });

test('pending upstream reports refresh by keyboard on a phone and retain their eventual issue link', async ({
  page,
}) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const item: FeedbackItem = {
    id: 'fbkAAAAAAAAAAAAAA',
    kind: 'broken',
    status: 'new',
    message: 'The grid freezes when pasting rows',
    context: {
      path: '/',
      appVersion: '1.2.3',
      browser: '',
      platform: 'Linux',
      theme: '',
      language: 'en-US',
      errors: [],
    },
    screenshot: null,
    sender: { id: 'usrAAAAAAAAAAAAAA', name: 'Mira' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    replies: [],
    issue: null,
    upstreamIssueUrl: null,
  };
  const settings: FeedbackHubSettings = {
    enabled: true,
    canChange: true,
    url: 'https://hub.test/bugs',
    preview: {
      installId: crypto.randomUUID(),
      fingerprint: 'a'.repeat(64),
      version: '1.2.3',
      platform: 'Linux',
      title: 'Grid freezes',
      description: 'Grid freezes with [secret]',
    },
  };
  let sends = 0;
  await page.route('**/api/admin/feedback**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/admin/feedback') return route.fulfill({ json: { items: [item], next: null } });
    if (path === '/api/admin/feedback/count') return route.fulfill({ json: { new: 1 } });
    if (path === '/api/admin/feedback/hub') return route.fulfill({ json: settings });
    if (path === '/api/admin/feedback/github')
      return route.fulfill({ json: { enabled: false, repository: null, hasToken: false, canChange: false } });
    if (path.endsWith('/hub/preview'))
      return route.fulfill({ json: { url: settings.url, payload: settings.preview } });
    if (path === `/api/admin/feedback/${item.id}/hub`) {
      expect(route.request().method()).toBe('POST');
      expect(route.request().postDataJSON()).toEqual({ softwareBug: true });
      sends += 1;
      Object.assign(item, {
        upstreamPending: sends === 1,
        upstreamIssueUrl: sends === 1 ? null : 'https://github.com/adachis/riosoma/issues/42',
      });
      return route.fulfill({ json: item });
    }
    return route.continue();
  });
  await page.goto(`${base()}/settings/feedback`);
  const report = page.getByRole('listitem').filter({ hasText: item.message });
  await report.getByRole('button', { name: 'Send upstream' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send upstream' });
  await expect(dialog.locator('pre')).toContainText('[secret]');
  const send = dialog.getByRole('button', { name: 'Send upstream' });
  await expect(send).toBeDisabled();
  const confirmation = dialog.getByRole('checkbox', { name: /I have confirmed this is a software bug/ });
  await confirmation.focus();
  await page.keyboard.press('Space');
  await expect(confirmation).toBeChecked();
  await send.click();
  await expect(dialog).toBeHidden();
  await page.reload();
  const refresh = report.getByRole('button', { name: 'Refresh upstream issue' });
  await expect(refresh).toBeVisible();
  await refresh.focus();
  await page.keyboard.press('Enter');
  const issue = report.getByRole('link', { name: 'Upstream issue' });
  await expect(issue).toHaveAttribute('href', 'https://github.com/adachis/riosoma/issues/42');
  await expect(refresh).toBeHidden();
  expect(sends).toBe(2);
  await page.reload();
  await expect(issue).toBeVisible();
});
