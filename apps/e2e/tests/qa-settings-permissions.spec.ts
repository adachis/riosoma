import { saveUploadPolicy } from '../settings-policy';
import { collectSettings } from '../../web/build/settings-registry';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, signIn, visit } from '../helpers';
import { invite } from '../people';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

const areas = [
  { role: 'people', label: 'People', page: 'people', api: '/api/org/invitations' },
  { role: 'security', label: 'File uploads', page: 'files', api: '/api/org/files' },
  { role: 'data_sources', label: 'Drivers', page: 'source-drivers', api: '/api/source-drivers' },
  { role: 'ai', label: 'AI', page: 'ai', api: '/api/ai/settings' },
  { role: 'integrations', label: 'MCP', page: 'mcp', api: '/api/admin/mcp/settings' },
  { role: 'audit', label: 'Audit', page: 'audit', api: '/api/org/audit' },
];

test('members and guests cannot open administration controls by menu, address, or API', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await signIn(page);
  const member = await invite(page, browser, 'Settings member');
  const guest = await invite(page, browser, 'Settings guest', 'guest');
  const adminPages = [
    ...new Map(
      collectSettings()
        .filter((setting) => setting.area === 'admin')
        .map((setting) => [setting.page, `admin/${setting.section}/${setting.page}`]),
    ).values(),
  ];
  try {
    for (const person of [member, guest]) {
      await person.page.setViewportSize({ width: 390, height: 844 });
      for (const path of adminPages) {
        await visit(person.page, `${base()}/${path}`);
        const navigation = person.page.getByRole('navigation', { name: 'Settings sections', exact: true });
        await expect(navigation).toBeVisible();
        for (const area of areas)
          await expect(navigation.getByRole('link', { name: area.label, exact: true })).toHaveCount(0);
        await expect(
          person.page
            .getByRole('region', { name: 'Save changes', exact: true })
            .getByRole('button', { name: 'Save', exact: true }),
        ).toBeDisabled();
      }
      for (const area of areas) {
        const response = await person.page.request.get(`${base()}${area.api}`);
        expect(response.status(), `${person.name}: ${area.api}`).toBe(403);
      }
      await visit(person.page, `${base()}/settings/appearance`);
      const search = person.page.getByRole('combobox', { name: 'Search settings', exact: true });
      await search.fill('maximum upload size');
      await expect(person.page.getByRole('option', { name: /Maximum upload size/ })).toHaveCount(0);
    }
  } finally {
    await member.context.close();
    await guest.context.close();
  }
});

test('each organization admin role exposes only its area by menu, address, and API reads', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await signIn(page);
  const person = await invite(page, browser, 'Scoped settings');
  try {
    for (const granted of areas) {
      await asOwner(page, 'POST', '/api/org/admin-commands', {
        kind: 'organization.roles',
        userId: person.id,
        roles: [granted.role],
      });
      await visit(person.page, `${base()}/settings/${granted.page}`);
      const navigation = person.page.getByRole('navigation', { name: 'Settings sections', exact: true });
      await expect(navigation).toBeVisible();
      for (const area of areas) {
        await expect(navigation.getByRole('link', { name: area.label, exact: true })).toHaveCount(
          area.role === granted.role ? 1 : 0,
        );
        const response = await person.page.request.get(`${base()}${area.api}`);
        expect(response.status(), `${granted.role}: ${area.api}`).toBe(
          area.role === granted.role ? 200 : 403,
        );
      }
      await expect(
        person.page.getByRole('heading', { name: granted.label, level: 1, exact: true }),
      ).toBeVisible();
      for (const denied of areas.filter((area) => area.role !== granted.role)) {
        await visit(person.page, `${base()}/settings/${denied.page}`);
        await expect(
          person.page
            .locator(`[data-setting-page="${denied.page}"]`)
            .locator('input, textarea, select, [role="checkbox"], [role="switch"]'),
        ).toHaveCount(0);
        await expect(
          person.page
            .getByRole('region', { name: 'Save changes', exact: true })
            .getByRole('button', { name: 'Save', exact: true }),
        ).toBeDisabled();
      }
    }
  } finally {
    await asOwner(page, 'POST', '/api/org/admin-commands', {
      kind: 'organization.roles',
      userId: person.id,
      roles: [],
    });
    await person.context.close();
  }
});

test('two browser contexts preserve a file policy draft after a live change', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const prior = await asOwner<{ maxUploadBytes: number | null }>(page, 'GET', '/api/org/files');
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    await saveUploadPolicy(page, 1024);
    const other = await context.newPage();
    await signIn(other);
    await visit(page, `${base()}/settings/files`);
    await visit(other, `${base()}/settings/files`);
    const input = page.getByLabel('Maximum upload size (bytes)', { exact: true });
    const otherInput = other.getByLabel('Maximum upload size (bytes)', { exact: true });
    await input.fill('2048');
    await otherInput.fill('4096');
    await other
      .getByRole('region', { name: 'Save changes', exact: true })
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    const bar = page.getByRole('region', { name: 'Save changes', exact: true });
    await expect(bar.getByRole('status')).toHaveText(
      'These settings changed elsewhere.  Reload the stored values before saving.',
      { timeout: 35_000 },
    );
    await expect(input).toHaveValue('2048');
    await bar.getByRole('button', { name: 'Save', exact: true }).click();
    expect(await asOwner(page, 'GET', '/api/org/files')).toEqual({
      maxUploadBytes: 4096,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await bar.getByRole('button', { name: 'Reload stored values', exact: true }).click();
    await expect(input).toHaveValue('4096');
    await expect(bar.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  } finally {
    await saveUploadPolicy(page, prior.maxUploadBytes);
    await context.close();
  }
});

test('audit details and exports record credential actions without their secrets', async ({ page }) => {
  await signIn(page);
  const homepage = new URL('/settings-test-connection', base());
  homepage.protocol = 'https:';
  const app = await asOwner<{ id: string; clientSecret: string }>(page, 'POST', '/api/admin/oauth/apps', {
    name: 'Audit connection 記録🌊مرحبا',
    homepage: homepage.href,
    redirectUris: [new URL('/settings-test-return', base()).href],
    confidential: true,
    scopes: ['data.records:read'],
  });
  try {
    const rotated = await asOwner<{ clientSecret: string }>(
      page,
      'POST',
      `/api/admin/oauth/apps/${app.id}/secret`,
    );
    const filters = { resource: app.id };
    const audit = await asOwner<{
      events: Array<{ id: string; action: string; metadata: Record<string, unknown> }>;
    }>(page, 'GET', `/api/org/audit?${new URLSearchParams(filters)}`);
    expect(audit.events.some((event) => event.action === 'oauth.app.registered')).toBe(true);
    expect(audit.events.some((event) => event.action === 'oauth.app.secret_rotated')).toBe(true);
    for (const event of audit.events) {
      const details = await asOwner(page, 'GET', `/api/org/audit/${event.id}`);
      expect(
        [app.clientSecret, rotated.clientSecret].some((secret) => JSON.stringify(details).includes(secret)),
      ).toBe(false);
    }
    const exported = await asOwner(page, 'POST', '/api/org/audit/export', { filters, format: 'json' });
    expect(
      [app.clientSecret, rotated.clientSecret].some((secret) => JSON.stringify(exported).includes(secret)),
    ).toBe(false);
    await visit(page, `${base()}/settings/audit?${new URLSearchParams(filters)}`);
    await page.getByRole('link', { name: 'oauth.app.secret_rotated', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Event details', exact: true })).toContainText(app.id);
    const content = await page.getByRole('region', { name: 'Event details', exact: true }).textContent();
    expect([app.clientSecret, rotated.clientSecret].some((secret) => content?.includes(secret))).toBe(false);
  } finally {
    await asOwner(page, 'DELETE', `/api/admin/oauth/apps/${app.id}`);
  }
});

test('the owner cannot remove their own account through the people API', async ({ page }) => {
  await signIn(page);
  const session = await asOwner<{ user: { id: string }; csrfToken: string }>(
    page,
    'GET',
    '/api/auth/session',
  );
  const removed = await page.request.delete(`${base()}/api/org/members/${session.user.id}`, {
    headers: { 'x-csrf-token': session.csrfToken },
  });
  expect(removed.status()).toBe(409);
  expect((await removed.json()).error.messageKey).toBe('people.guard.lastOwner');
  await visit(page, `${base()}/settings/people`);
  await expect(page.getByRole('heading', { name: 'People', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove account', exact: true })).toHaveCount(0);
  expect(
    (await asOwner<Array<{ id: string; kind: string }>>(page, 'GET', '/api/org/members')).find(
      (member) => member.id === session.user.id,
    )?.kind,
  ).toBe('owner');
});
