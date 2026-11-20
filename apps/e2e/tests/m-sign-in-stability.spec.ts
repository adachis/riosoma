import { test, expect } from '../accessibility';
import { base } from '../base';
import { asOwner, OWNER, signIn, visit } from '../helpers';

test('identifies replacement documents when navigation timestamps repeat', async ({ page }) => {
  const roundClock = () => Object.defineProperty(performance, 'timeOrigin', { value: 0 });
  // A privacy setting can make two documents' timestamps indistinguishable.  Readiness must use
  // the document itself, including on the first visit from the browser's blank page.
  await page.addInitScript(roundClock);
  await page.evaluate(roundClock);
  await signIn(page);
  await visit(page, `${base()}/`);
  await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
});

test('signs in parallel browser contexts and completes the fixture preferences', async ({
  browser,
  page,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  const owner = await asOwner<{ user: { id: string } }>(page, 'GET', '/api/auth/session');
  const existingContexts = browser.contexts();
  // Six concurrent visitors are intentional; each wave must release its browser resources.
  // The fixtures must also exercise their first sign-in preference update and document visit.
  for (let wave = 0; wave < 3; wave++) {
    await asOwner(page, 'PATCH', '/api/me/preferences', { level: null });
    const contexts = await Promise.all(
      Array.from({ length: 6 }, () => browser.newContext({ serviceWorkers: 'block' })),
    );
    try {
      const pages = await Promise.all(contexts.map((context) => context.newPage()));
      const errors: string[] = [];
      for (const current of pages) {
        current.on('pageerror', (error) => errors.push(error.message));
        current.on('response', (response) => {
          if (response.url().startsWith(base()) && response.status() >= 400)
            errors.push(`${response.status()} ${response.url()}`);
        });
      }
      await Promise.all(pages.map((current) => signIn(current)));
      const tokens = await Promise.all(
        pages.map(async (current) => {
          const session = await current.request.get(`${base()}/api/auth/session`);
          expect(session.ok(), await session.text()).toBe(true);
          const info = await session.json();
          expect(info.user).toMatchObject({ id: owner.user.id, email: OWNER.email });
          expect(info.preferences.level).toBe('advanced');
          await expect(current.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
          // Theme families can change, and earlier specs can save another theme.  Check used faces,
          // since unused ranges and italics remain unloaded.
          const fonts = await current.evaluate(async () => {
            await document.fonts.ready;
            return [document.body, document.querySelector('h1')!].map((element) => {
              const style = getComputedStyle(element);
              const family = style.fontFamily
                .split(',')[0]!
                .trim()
                .replace(/^['"]|['"]$/g, '');
              const faces = [...document.fonts].filter(
                (face) => face.family.replace(/^['"]|['"]$/g, '') === family && face.status !== 'unloaded',
              );
              return {
                family,
                loaded:
                  faces.length > 0 &&
                  faces.every((face) => face.status === 'loaded') &&
                  document.fonts.check(
                    `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
                    element.textContent ?? '',
                  ),
              };
            });
          });
          expect(fonts).toEqual([
            { family: expect.any(String), loaded: true },
            { family: expect.any(String), loaded: true },
          ]);
          expect(new Set(fonts.map((font) => font.family)).size).toBe(2);
          return info.csrfToken;
        }),
      );
      expect(new Set(tokens).size).toBe(contexts.length);
      expect(errors).toEqual([]);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
      expect(browser.contexts()).toEqual(existingContexts);
    }
  }
});
