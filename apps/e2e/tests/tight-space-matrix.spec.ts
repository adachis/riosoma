import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { asOwner, createDatabase, createView, signIn, visit } from '../helpers';
import { base } from '../base';
import { recordLayoutAudit, type LayoutFinding } from '../tight-space-audit';

/** The broader sweep is opt-in while the representative folder and phone audit runs on every push. */
if (process.env.RIOSOMA_LAYOUT_MATRIX) {
  const root = fileURLToPath(new URL('../../web/src/', import.meta.url));
  const settings = [
    ...new Set(
      readdirSync(root, { recursive: true })
        .filter(
          (name): name is string =>
            typeof name === 'string' && name.endsWith('.tsx') && !name.endsWith('.test.tsx'),
        )
        .flatMap((name) =>
          [
            ...readFileSync(`${root}/${name}`, 'utf8').matchAll(/defineSettingsPage\(\{([\s\S]*?)\n\}\);/g),
          ].flatMap((match) => {
            const property = (key: string) => match[1]!.match(new RegExp(`${key}:\\s*['"]([^'"]+)`))?.[1];
            const area = property('area');
            const section = property('section');
            const page = property('page');
            return area && section && page
              ? [`/${area === 'admin' ? 'admin' : 'settings'}/${section}/${page}`]
              : [];
          }),
        ),
    ),
  ];
  const themes = [
    { theme: 'nature', scheme: 'grove' },
    { theme: 'bauhaus', scheme: 'midnight' },
    { theme: 'brutalist', scheme: 'raw' },
  ];
  for (const theme of themes)
    test(`audits main views and every settings page in ${theme.theme}`, async ({ page }, info) => {
      test.setTimeout(600_000);
      await signIn(page);
      await asOwner(page, 'PATCH', '/api/me/preferences', { ...theme, locale: 'en-US' });
      const compound = 'PlanningReferenceMaterialAndImplementationRequirementsForTheEntireOrganization';
      const database = await createDatabase(page, compound, [
        {
          name: compound,
          fields: [
            { name: 'Name', type: 'text' },
            { name: 'Status', type: 'singleSelect', choices: [compound, 'Ready'] },
            { name: 'Start', type: 'date' },
            { name: 'End', type: 'date' },
            { name: 'Amount', type: 'currency' },
          ],
          records: [
            { Name: compound, Status: compound, Start: '2026-10-03', End: '2026-10-04', Amount: 25 },
            { Name: 'Planning reference material and implementation requirements', Status: 'Ready' },
            { Name: 'Ready' },
          ],
        },
      ]);
      const table = database.tables[compound]!;
      const views = [{ id: table.viewId, type: 'grid' }];
      for (const type of [
        'gallery',
        'kanban',
        'calendar',
        'timeline',
        'gantt',
        'list',
        'orgChart',
        'pivot',
        'chart',
        'map',
        'form',
      ]) {
        views.push({
          id: await createView(page, database, compound, { name: `${type} ${compound}`, type }),
          type,
        });
      }
      const routes = [
        '/',
        '/home/shared',
        '/home/recent',
        '/home/favorites',
        '/home/trash',
        '/home/tags',
        ...views.map((view) => `/${database.id}/${table.id}/${view.id}`),
        `/${database.id}/named-functions`,
        ...settings,
      ];
      const findings: Array<{ screen: string; findings: LayoutFinding[] }> = [];
      for (const width of [390, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        for (const route of routes) {
          await visit(page, `${base()}${route}`);
          await expect(page.locator('main')).toBeVisible();
          await page.waitForFunction(
            () => document.fonts.status === 'loaded' && !document.querySelector('.rio-feature-loading'),
          );
          const screen = `${theme.theme}-${width}-${route}`;
          const result = await recordLayoutAudit(page, info, screen, page, { reportOnly: true });
          if (width === 1440)
            await page.screenshot({
              path: info.outputPath(`screen-${theme.theme}-${routes.indexOf(route)}.png`),
            });
          if (result.length) findings.push({ screen, findings: result });
        }
      }
      expect(findings).toEqual([]);
    });
}
