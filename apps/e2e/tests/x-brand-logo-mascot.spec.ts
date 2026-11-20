import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, OWNER, signIn, visit } from '../helpers';
import { invite } from '../people';

const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50"><path fill="#123456" d="M0 5 H195 V45 H0 Z"/></svg>',
);
const png = readFileSync(fileURLToPath(new URL('../../web/public/icons/icon-192.png', import.meta.url)));
const choices = [
  { theme: 'nature', scheme: 'grove', label: 'nature-light' },
  { theme: 'nature', scheme: 'night-grove', label: 'nature-dark' },
  { theme: 'synthwave', scheme: 'synthwave', label: 'synthwave' },
];

test.use({ serviceWorkers: 'block' });

for (const choice of choices)
  for (const width of [1280, 375])
    for (const custom of [false, true]) {
      test(`${choice.label} at ${width} shows ${custom ? 'organization' : 'platform'} identity`, async ({
        page,
      }, info) => {
        test.setTimeout(90_000);
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await signIn(page);
        const manifest = (await (
          await page.request.get(`${base()}/themes/${choice.theme}/theme.json`)
        ).json()) as { defaultScheme: string; schemes: { id: string }[] };
        expect(manifest.schemes.map((scheme) => scheme.id)).toContain(choice.scheme);
        const scheme = choice.scheme;
        await asOwner(page, 'PATCH', '/api/me/preferences', { theme: choice.theme, scheme });
        await asOwner(page, 'POST', '/api/org/admin-commands', {
          kind: 'organization.logo',
          main: custom ? { type: 'image/svg+xml', data: svg.toString('base64') } : null,
          compact: null,
          mode: 'theme',
        });
        await visit(page, `${base()}/`);
        await expect(page.locator('html')).toHaveAttribute('data-theme', choice.theme);
        await expect(page.locator('html')).toHaveAttribute('data-scheme', choice.scheme);
        await expect(
          page
            .locator('.rio-shell__brand')
            .getByRole('img', { name: custom ? OWNER.org : 'Riosoma', exact: true }),
        ).toBeVisible();
        if (custom)
          await expect(
            page.locator('.rio-shell__footer').getByRole('img', { name: 'Riosoma' }),
          ).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        if (info.project.name === 'chromium' && width === 1280)
          await page.screenshot({
            path: info.outputPath(
              `shell-${choice.label}-${width}-${custom ? 'organization' : 'platform'}.png`,
            ),
          });
        await asOwner(page, 'POST', '/api/auth/sign-out');
        await visit(page, `${base()}/sign-in`);
        await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
        await expect(
          page
            .locator('.rio-setup__brand')
            .getByRole('img', { name: custom ? OWNER.org : 'Riosoma', exact: true }),
        ).toBeVisible();
        if (custom)
          await expect(
            page.locator('.rio-sign-in-platform').getByRole('img', { name: 'Riosoma' }),
          ).toBeVisible();
        expect(
          await page
            .locator('.rio-brand')
            .evaluateAll(
              (elements) => elements.flatMap((element) => element.getAnimations({ subtree: true })).length,
            ),
        ).toBe(0);
        if (info.project.name === 'chromium' && width === 1280)
          await page.screenshot({
            path: info.outputPath(
              `sign-in-${choice.label}-${width}-${custom ? 'organization' : 'platform'}.png`,
            ),
          });
      });
    }

test('administrators save SVGs and PNGs in both color modes, discard changes, refuse hostile SVGs, and remove logos', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  await asOwner(page, 'POST', '/api/org/admin-commands', {
    kind: 'organization.logo',
    main: null,
    compact: null,
    mode: 'theme',
  });
  await page.goto(`${base()}/admin/organization/organization-appearance/logo`);
  const search = page.getByRole('combobox', { name: 'Search settings' });
  await search.fill('organization logo');
  await page.getByRole('option', { name: /Organization logo/ }).click();
  await expect(page).toHaveURL(`${base()}/admin/organization/organization-appearance/logo`);
  await page.reload();
  await expect(page.getByLabel('Upload a logo', { exact: true })).toBeVisible();
  const save = page.getByRole('region', { name: 'Save changes', exact: true });
  for (const [type, bytes, name] of [
    ['image/svg+xml', svg, 'logo.svg'],
    ['image/png', png, 'logo.png'],
  ] as const) {
    await page
      .getByLabel('Upload a logo', { exact: true })
      .setInputFiles({ name, mimeType: type, buffer: bytes });
    await expect(save.getByRole('status')).toHaveText('Unsaved changes');
    await save.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(
      page.locator(`.rio-shell__brand ${type === 'image/svg+xml' ? '.rio-brand' : '.rio-org-logo'}`),
    ).toBeVisible();
    await page
      .getByLabel('Upload a logo', { exact: true })
      .setInputFiles({ name, mimeType: type, buffer: bytes });
    await page
      .getByLabel('Optional compact mark', { exact: true })
      .setInputFiles({ name, mimeType: type, buffer: bytes });
    await save.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(save.getByRole('status')).toHaveText('No unsaved changes');
    await expect(page.locator('.rio-shell__brand .rio-org-logo')).toHaveAttribute(
      'data-logo-colors',
      'theme',
    );
    await page.getByRole('button', { name: 'Logo colors' }).click();
    await page.getByRole('option', { name: 'Keep the logo’s own colors', exact: true }).click();
    await save.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(save.getByRole('status')).toHaveText('No unsaved changes');
    await expect(page.locator('.rio-shell__brand .rio-org-logo img')).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator('.rio-shell__brand .rio-org-logo img')
          .evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    await expect(page.locator('.rio-shell__footer .rio-brand')).toBeVisible();
    await page.getByRole('button', { name: 'Logo colors' }).click();
    await page.getByRole('option', { name: 'Match the theme', exact: true }).click();
    await save.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(save.getByRole('status')).toHaveText('No unsaved changes');
  }
  await page.getByLabel('Upload a logo', { exact: true }).setInputFiles({
    name: 'hostile.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
  });
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(save).toContainText('The SVG contains scripts, animation, or unsupported elements.');
  await save.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.getByRole('button', { name: 'Remove logo', exact: true }).click();
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.rio-shell__brand .rio-brand')).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await page
    .getByLabel('Upload a logo', { exact: true })
    .setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(256 * 1024 + 1) });
  await expect(page.getByText('Choose a logo no larger than 256 KB.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test('Rio displays all six moods at both companion sizes', async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await signIn(page);
  for (const choice of choices) {
    await asOwner(page, 'PATCH', '/api/me/preferences', { theme: choice.theme, scheme: choice.scheme });
    await page.goto(`${base()}/gallery`);
    for (const size of [32, 48])
      for (const mood of ['idle', 'thinking', 'happy', 'oops', 'napping', 'celebrating']) {
        const avatar = page
          .locator(
            `[data-example="rio.avatar.size-${size}"] .rio-avatar[data-mood="${mood}"] svg[width="${size}"]`,
          )
          .first();
        await avatar.scrollIntoViewIfNeeded();
        await expect(avatar).toBeVisible();
        await expect(avatar).toHaveAccessibleName(`Rio, ${mood}`);
        expect(await avatar.locator('path, use').count()).toBeGreaterThan(10);
        if (mood === 'idle')
          expect(await avatar.evaluate((svg) => svg.getAnimations({ subtree: true }).length)).toBe(0);
        await expect
          .poll(() =>
            avatar
              .locator('.rio-avatar__face')
              .first()
              .evaluate((face) => getComputedStyle(face).transitionDuration),
          )
          .toContain('0.4s');
      }
  }
});

test('a member can read the organization logo and cannot change it', async ({ page, browser }) => {
  await signIn(page);
  await asOwner(page, 'POST', '/api/org/admin-commands', {
    kind: 'organization.logo',
    main: { type: 'image/svg+xml', data: svg.toString('base64') },
    mode: 'theme',
  });
  const person = await invite(page, browser, 'Logo Reader');
  try {
    await expect(
      person.page.locator('.rio-shell__brand').getByRole('img', { name: OWNER.org }),
    ).toBeVisible();
    await person.page.goto(`${base()}/admin/organization/organization-appearance/logo`);
    await expect(person.page.getByLabel('Upload a logo', { exact: true })).toHaveCount(0);
    const session = (await (await person.page.request.get(`${base()}/api/auth/session`)).json()) as {
      csrfToken: string;
    };
    const denied = await person.page.request.post(`${base()}/api/org/admin-commands`, {
      headers: { 'x-csrf-token': session.csrfToken },
      data: { kind: 'organization.logo', main: null, mode: 'theme' },
    });
    expect(denied.status()).toBe(403);
  } finally {
    await person.context.close();
    await asOwner(page, 'POST', '/api/org/admin-commands', {
      kind: 'organization.logo',
      main: null,
      mode: 'theme',
    });
  }
});

test('Rio blends an outgoing animated body pose to idle for 400 milliseconds', async ({ page }) => {
  await signIn(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`${base()}/gallery`);
  const picker = page.getByRole('button', { name: 'happy', exact: true }).locator('../..');
  const happy = page.getByRole('button', { name: 'happy', exact: true });
  await happy.scrollIntoViewIfNeeded();
  const avatar = picker.locator('.rio-avatar');
  const blend = await picker.evaluate(async (picker) => {
    const choose = (mood: string) =>
      Array.from(picker.querySelectorAll('button'))
        .find((button) => button.textContent === mood)!
        .click();
    choose('happy');
    await new Promise(requestAnimationFrame);
    const body = picker.querySelector('.rio-avatar__body')!;
    const animation = body.getAnimations()[0]!;
    animation.pause();
    animation.currentTime = 250;
    await new Promise(requestAnimationFrame);
    const outgoing = getComputedStyle(body).transform;
    choose('idle');
    await new Promise(requestAnimationFrame);
    const transition = body.getAnimations().find((item) => item.effect?.getTiming().duration === 400);
    return {
      outgoing,
      transform: getComputedStyle(body).transform,
      duration: transition?.effect?.getTiming().duration,
    };
  });
  expect(blend.outgoing).not.toBe('none');
  expect(blend.duration).toBe(400);
  expect(blend.transform).not.toBe('none');
  await expect
    .poll(() => avatar.locator('.rio-avatar__body').evaluate((body) => body.getAnimations().length))
    .toBe(0);
  expect(await avatar.locator('.rio-avatar__body').evaluate((body) => getComputedStyle(body).transform)).toBe(
    'none',
  );
});
