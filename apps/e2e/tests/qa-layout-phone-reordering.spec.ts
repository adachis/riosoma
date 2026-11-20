import { expect, test, type Page } from '../accessibility';
import type { DashboardMeta, InterfaceMeta } from '../../../packages/contracts/src/index';
import { base } from '../base';
import { asOwner, createDatabase, newId, runCommands, signIn, visit } from '../helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });

for (const kind of ['dashboard', 'interface'] as const) {
  for (const scenario of ['last rows', 'gap'] as const) {
    test(`${kind} phone reordering saves and reloads after a drop at ${scenario}`, async ({ page }) => {
      await signIn(page);
      const database = await createDatabase(page, 'Phone layouts', [
        {
          name: 'Tasks',
          fields: [{ name: 'Name', type: 'text' }],
          records: [],
        },
      ]);
      const id = `${kind === 'dashboard' ? 'dsh' : 'itf'}${newId('rec').slice(3)}`;
      const places =
        scenario === 'last rows'
          ? [
              { x: 5, y: 991, w: 1, h: 2 },
              { x: 5, y: 995, w: 3, h: 6 },
              { x: 9, y: 995, w: 3, h: 6 },
            ]
          : [
              { x: 0, y: 0, w: 4, h: 2 },
              { x: 4, y: 0, w: 4, h: 2 },
              { x: 8, y: 0, w: 4, h: 2 },
            ];
      const items = ['First', 'Second', 'Third'].map((title, index) => ({
        id: `note000${index}`,
        kind: 'text' as const,
        title,
        text: title,
        place: places[index]!,
      }));
      await runCommands(
        page,
        database.id,
        kind === 'dashboard'
          ? [
              {
                kind: 'dashboard.create',
                dashboard: { id, name: 'Phone layout', config: { tiles: items } },
              },
            ]
          : [
              {
                kind: 'interface.create',
                interface: {
                  id,
                  name: 'Phone layout',
                  pages: [
                    {
                      id: 'pageMain01',
                      name: 'Notes',
                      blocks: items.map((item) => ({ ...item, style: 'paragraph' })),
                    },
                  ],
                },
              },
            ],
      );
      const href = `${base()}/${database.id}/${kind === 'dashboard' ? 'dashboards' : 'interfaces'}/${id}${kind === 'interface' ? '/pageMain01' : ''}`;
      await visit(page, href);
      await page
        .getByRole('button', {
          name: kind === 'dashboard' ? 'Edit layout' : 'Edit interface',
          exact: true,
        })
        .tap();
      const surface = page.getByRole('article', { name: 'First', exact: true });
      const origin = (await surface.boundingBox())!;
      const second = (await page.getByRole('article', { name: 'Second', exact: true }).boundingBox())!;
      const third = (await page.getByRole('article', { name: 'Third', exact: true }).boundingBox())!;
      const targetY =
        scenario === 'gap' ? (second.y + second.height + third.y) / 2 : second.y + second.height / 2;
      if (scenario === 'gap') expect(third.y).toBeGreaterThan(second.y + second.height);
      const pointer = {
        button: 0,
        pointerId: 29,
        pointerType: 'touch',
        isPrimary: true,
        clientX: origin.x + 8,
        clientY: origin.y + 8,
      };
      await surface.dispatchEvent('pointerdown', pointer);
      await page.waitForTimeout(250);
      await page.dispatchEvent('body', 'pointermove', { ...pointer, clientY: targetY });
      await page.dispatchEvent('body', 'pointerup', { ...pointer, clientY: targetY });
      const order = (current: Page) =>
        current
          .getByRole('article')
          .evaluateAll((articles) =>
            articles.map(
              (article) => article.querySelector('h3')?.textContent ?? article.getAttribute('aria-label'),
            ),
          );
      await expect.poll(() => order(page)).toEqual(['Second', 'First', 'Third']);
      await expect
        .poll(async () => {
          const schema = await asOwner<{ dashboards: DashboardMeta[]; interfaces: InterfaceMeta[] }>(
            page,
            'GET',
            `/api/databases/${database.id}/schema`,
          );
          const saved =
            kind === 'dashboard'
              ? schema.dashboards.find((value) => value.id === id)!.config.tiles
              : schema.interfaces.find((value) => value.id === id)!.pages[0]!.blocks;
          return [...saved]
            .sort((a, b) => a.place.y - b.place.y || a.place.x - b.place.x)
            .map((item) => item.title);
        })
        .toEqual(['Second', 'First', 'Third']);
      await visit(page, href);
      await expect.poll(() => order(page)).toEqual(['Second', 'First', 'Third']);
    });
  }
}
