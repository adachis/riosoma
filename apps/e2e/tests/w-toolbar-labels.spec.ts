import { expect, test, type Page } from '../accessibility';
import {
  labelName,
  asOwner,
  createDatabase,
  createView,
  newId,
  offlineMap,
  openTable,
  runCommands,
  signIn,
  tick,
  visit,
} from '../helpers';
import { base } from '../base';
import { invite, share } from '../people';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

test.beforeEach(async ({ page }) => {
  // The owner's English assertions must not inherit language changes from neighboring specs.
  // Translation cases use their own people and browser contexts below.
  await page.route('**/api/auth/session', async (route) => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const session = (await response.json()) as { preferences: { locale?: string } };
    session.preferences.locale = 'en-US';
    await route.fulfill({ response, json: session });
  });
});

function clippedLabels(page: Page) {
  return page.locator('.rio-responsive-toolbar > [role="toolbar"]').evaluateAll((toolbars) =>
    toolbars.flatMap((toolbar) => {
      const bounds = toolbar.getBoundingClientRect();
      const labels = [...toolbar.querySelectorAll<HTMLElement>('.rio-responsive-toolbar__label')].filter(
        (label) => label.getClientRects().length,
      );
      const clipped = labels.filter(
        (label) =>
          label.scrollWidth > label.clientWidth || getComputedStyle(label).textOverflow === 'ellipsis',
      );
      const outside = [...toolbar.querySelectorAll<HTMLElement>('button')].filter((button) => {
        if (!button.getClientRects().length) return false;
        const rect = button.getBoundingClientRect();
        return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
      });
      const clippedAncestors: Element[] = [];
      const fullWidth = parseFloat(
        (toolbar.parentElement as HTMLElement).style.getPropertyValue('--rio-toolbar-full'),
      );
      if (innerWidth >= 768 && fullWidth <= bounds.width) {
        clippedAncestors.push(
          ...toolbar.querySelectorAll(
            '[data-item]:not([data-fit="full"]):has(.rio-responsive-toolbar__label)',
          ),
        );
      }
      let ancestor = toolbar.parentElement;
      while (ancestor) {
        const style = getComputedStyle(ancestor);
        const rect = ancestor.getBoundingClientRect();
        if (
          /(hidden|clip|auto|scroll)/.test(style.overflowX) &&
          (bounds.left < rect.left - 1 || bounds.right > rect.right + 1)
        )
          clippedAncestors.push(ancestor);
        if (
          /(hidden|clip|auto|scroll)/.test(style.overflowY) &&
          (bounds.top < rect.top - 1 || bounds.bottom > rect.bottom + 1)
        )
          clippedAncestors.push(ancestor);
        ancestor = ancestor.parentElement;
      }
      if (
        bounds.left < -1 ||
        bounds.right > innerWidth + 1 ||
        bounds.top < -1 ||
        bounds.bottom > innerHeight + 1
      )
        clippedAncestors.push(toolbar);
      for (const label of labels) {
        const rect = label.getBoundingClientRect();
        const button = label.closest('button, [role="img"]')!.getBoundingClientRect();
        if (rect.left < button.left || rect.right > button.right) clippedAncestors.push(label);
      }
      return [...clipped, ...outside, ...clippedAncestors].map(
        (node) => node.textContent || node.getAttribute('aria-label'),
      );
    }),
  );
}

async function wholeLabels(page: Page) {
  await expect.poll(() => clippedLabels(page)).toEqual([]);
}

for (const [locale, reader] of [
  ['en-US', 'Avery Stone'],
  ['de', 'Lena Fischer'],
  ['fr', 'Claire Dubois'],
] as const) {
  test(`keeps toolbar labels whole from desktop to phone in ${locale}`, async ({ page: owner, browser }) => {
    test.setTimeout(90_000);
    await signIn(owner);
    const database = await createDatabase(
      owner,
      'Toolbar projects with a very long database name that must stay inside the fixed header',
      [
        {
          name: 'Projects',
          fields: [
            { name: 'Name', type: 'text' },
            { name: 'Vertragsabschluss und Geschäftsmöglichkeiten', type: 'text' },
          ],
          records: [{ Name: 'First project', 'Vertragsabschluss und Geschäftsmöglichkeiten': 'Deal' }],
        },
      ],
    );
    const table = database.tables.Projects!;
    const fieldId = table.fields['Vertragsabschluss und Geschäftsmöglichkeiten']!;
    await runCommands(owner, database.id, [
      {
        kind: 'view.update',
        viewId: table.viewId,
        config: {
          filter: {
            conjunction: 'and',
            conditions: [{ id: 'deal', fieldId, operator: 'contains', value: 'Deal' }],
          },
          sorts: [{ fieldId, direction: 'asc' }],
          colorRules: [
            {
              id: newId('rul'),
              name: 'Deal',
              color: 'blue',
              target: 'record',
              condition: { id: 'color', fieldId, operator: 'contains', value: 'Deal' },
            },
          ],
        },
      },
    ]);
    // The language is each person's own setting.  Someone of their own reads in it, so specs that
    // run beside this one keep the owner's language.
    const person = await invite(owner, browser, reader);
    const page = person.page;
    try {
      await share(owner, database.id, person, 'owner');
      await asOwner(page, 'PATCH', '/api/me/preferences', { locale, level: 'advanced' });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openTable(page, database, 'Projects');
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      const toolbar = page.locator('[data-anchor="view.toolbar"]');
      await expect(toolbar).toBeVisible();
      const modes = new Set<string>();
      for (const width of [1920, 1440, 1200, 1000, 900, 800, 768, 640, 480, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await wholeLabels(page);
        const name = page.locator('.rio-db-header__name h1');
        await expect(name).toHaveCSS('white-space', 'nowrap');
        if (width >= 1440) {
          await expect(page.locator('.rio-db-header__actions [data-item="share"]')).toHaveAttribute(
            'data-fit',
            'full',
          );
          await expect(
            page.locator('.rio-db-header__actions .rio-responsive-toolbar__label:visible'),
          ).toHaveCount(1);
        }
        if (width < 768) {
          await expect(page.locator('[data-anchor="database.share"]')).toBeVisible();
          await expect
            .poll(() =>
              page
                .locator('.rio-db-header__actions')
                .evaluate((root) =>
                  Math.abs(
                    root.getBoundingClientRect().width -
                      root.querySelector('button')!.getBoundingClientRect().width,
                  ),
                ),
            )
            .toBeLessThanOrEqual(1);
        }
        for (const mode of await toolbar
          .locator('[data-item]')
          .evaluateAll((items) => items.map((item) => item.getAttribute('data-fit')!)))
          modes.add(mode);
        if (width < 768) {
          await expect(toolbar.locator('.rio-responsive-toolbar__label:visible')).toHaveCount(0);
          await expect(
            toolbar.getByRole('button', {
              name: locale === 'de' ? 'Mehr' : locale === 'fr' ? 'Plus' : 'More',
              exact: true,
            }),
          ).toBeVisible();
        }
      }
      expect([...modes]).toEqual(expect.arrayContaining(['full', 'short', 'icon', 'overflow']));
      const filter = toolbar.locator('[data-item="filter"] button');
      await expect(filter.locator('.rio-responsive-toolbar__badge')).toHaveText('1');
      await filter.focus();
      await expect(page.getByRole('tooltip')).toContainText('Vertragsabschluss');
      await filter.press('Enter');
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      const more = toolbar.getByRole('button', {
        name: locale === 'de' ? 'Mehr' : locale === 'fr' ? 'Plus' : 'More',
        exact: true,
      });
      await more.click();
      const height = locale === 'de' ? 'Zeilenhöhe' : locale === 'fr' ? 'Hauteur des lignes' : 'Row height';
      await page.getByRole('menuitem', { name: labelName(height), exact: true }).click();
      await expect(page.getByRole('menu', { name: height })).toBeVisible();
      await page.getByRole('menuitemradio', { name: 'Tall', exact: true }).click();
      await expect(page.getByRole('menu', { name: height })).toBeHidden();
      await page.evaluate(() => {
        document.documentElement.dir = 'rtl';
      });
      for (const width of [320, 800, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await wholeLabels(page);
      }
    } finally {
      await person.context.close();
    }
  });
}

test('fits dashboard, interface, automation, and database actions on phones', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await createDatabase(page, 'Toolbar screens', [
    {
      name: 'Projects',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'First' }],
    },
  ]);
  const table = database.tables.Projects!;
  const dashboardId = `dsh${newId('rec').slice(3)}`;
  const interfaceId = `itf${newId('rec').slice(3)}`;
  const automationId = newId('aut');
  await runCommands(page, database.id, [
    {
      kind: 'dashboard.create',
      dashboard: {
        id: dashboardId,
        name: 'Project dashboard with a long title that must leave room for actions',
        config: {
          tiles: [
            {
              id: 'summary',
              kind: 'text',
              title: 'Summary',
              text: 'Projects',
              place: { x: 0, y: 0, w: 6, h: 2 },
            },
          ],
        },
      },
    },
    {
      kind: 'interface.create',
      interface: {
        id: interfaceId,
        name: 'Project interface with a long title that must leave room for actions',
        pages: [{ id: 'mainpage', name: 'Projects', blocks: [] }],
      },
    },
    {
      kind: 'automation.create',
      automation: {
        id: automationId,
        name: 'Project automation',
        config: {
          trigger: { kind: 'recordCreated', tableId: table.id },
          steps: [],
        },
      },
    },
  ]);
  await openTable(page, database, 'Projects');
  for (const [name, selector, action, role, panel] of [
    [
      'Project dashboard with a long title that must leave room for actions',
      '.rio-dashboard__actions',
      'Add a tile',
      'dialog',
      'Add a tile',
    ],
    [
      'Project interface with a long title that must leave room for actions',
      '.rio-interface__actions',
      'Publish site',
      'dialog',
      'Publish site',
    ],
    [
      'Project automation',
      '.rio-automation-screen__test .rio-responsive-toolbar',
      'Simulate',
      'region',
      'Simulate',
    ],
  ] as const) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('link', { name, exact: true }).click();
    const toolbar = page.locator(selector);
    await expect(toolbar).toBeVisible();
    await expect(toolbar.getByRole('button', { name: action, exact: true })).toHaveAttribute(
      'data-variant',
      'secondary',
    );
    const edit = name.startsWith('Project dashboard')
      ? 'Edit layout'
      : name.startsWith('Project interface')
        ? 'Edit interface'
        : null;
    if (edit) {
      await toolbar.getByRole('button', { name: edit, exact: true }).click();
      await expect(toolbar.getByRole('button', { name: 'Done', exact: true })).toHaveAttribute(
        'data-variant',
        'primary',
      );
      await toolbar.getByRole('button', { name: 'Done', exact: true }).click();
    }
    for (const width of [1440, 900, 640, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await wholeLabels(page);
      if (name !== 'Project automation') {
        const title = page.locator(
          name === 'Project dashboard with a long title that must leave room for actions'
            ? '.rio-dashboard__title'
            : '.rio-interface__title',
        );
        await expect(title).toHaveCSS('white-space', 'nowrap');
        if (width >= 900) {
          for (const item of await toolbar.locator('[data-item]').all())
            await expect(item).toHaveAttribute(
              'data-fit',
              (await item.locator('.rio-responsive-toolbar__label').count()) ? 'full' : 'icon',
            );
        }
        await expect(toolbar.locator('[data-item][data-fit="overflow"]')).toHaveCount(0);
        // Chrome 159 reports flex-end by its new alias, flow-end.  Both name the same packing.
        await expect(toolbar.locator('[role="toolbar"]')).toHaveCSS(
          'justify-content',
          /^(flex-end|flow-end)$/,
        );
        await expect
          .poll(() =>
            toolbar.evaluate((root) => {
              const buttons = [...root.querySelectorAll('button')].filter((button) =>
                button.checkVisibility(),
              );
              const button = buttons.at(-1)!;
              return Math.abs(root.getBoundingClientRect().right - button.getBoundingClientRect().right);
            }),
          )
          .toBeLessThanOrEqual(1);
      }
    }
    if (name.startsWith('Project interface')) {
      await toolbar.getByRole('button', { name: 'Edit interface', exact: true }).click();
      await expect(toolbar.getByRole('button', { name: 'Add a block', exact: true })).toBeVisible();
      await expect(toolbar.locator('[data-item][data-fit="overflow"]')).toHaveCount(0);
      await expect(toolbar.getByRole('button', { name: 'Edit page JSON', exact: true })).toHaveAttribute(
        'data-variant',
        'secondary',
      );
      await wholeLabels(page);
      await toolbar.getByRole('button', { name: 'Done', exact: true }).click();
    }
    const direct = toolbar.getByRole('button', { name: action, exact: true });
    if (await direct.isVisible()) await direct.click();
    else {
      await toolbar.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('menuitem', { name: labelName(action), exact: true }).click();
    }
    await expect(page.getByRole(role, { name: panel, exact: true })).toBeVisible();
    if (action === 'Simulate') await expect(direct).toHaveAttribute('data-variant', 'primary');
    await page.keyboard.press('Escape');
  }
});

test('detects toolbar clipping by an ancestor and by the viewport', async ({ page }) => {
  // Real labels are flex items.  An inline span has no client width in Firefox.
  await page.setContent(
    '<div class="clip"><div class="rio-responsive-toolbar"><div role="toolbar"><button><span class="rio-responsive-toolbar__label" style="display: inline-block">Geometry</span></button></div></div></div>',
  );
  await wholeLabels(page);
  await page.locator('.clip').evaluate((element) => {
    const container = element as HTMLElement;
    container.style.overflow = 'hidden';
    container.style.width = '100px';
    (container.firstElementChild as HTMLElement).style.width = '200px';
  });
  expect(await clippedLabels(page)).not.toEqual([]);
  await page.locator('.clip').evaluate((element) => {
    const container = element as HTMLElement;
    container.style.overflow = 'visible';
    container.style.transform = 'translateX(-300px)';
  });
  expect(await clippedLabels(page)).not.toEqual([]);
});

for (const [type, kind, name, heading] of [
  ['timeline', 'date', 'Schedule', '1 record has no start date'],
  ['map', 'location', 'Places', '1 record has no location'],
] as const) {
  test(`opens contextual Help and records from the No ${kind} dialog on a phone`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await offlineMap(page);
    const database = await createDatabase(page, 'Records awaiting dates and locations', [
      {
        name: 'Projects',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Start', type: 'date' },
          { name: 'Site', type: 'location' },
        ],
        records: [{ Name: 'Planning reference material' }],
      },
    ]);
    const table = database.tables.Projects!;
    const viewId = await createView(page, database, 'Projects', {
      name,
      type,
      config:
        type === 'timeline'
          ? { timeline: { startFieldId: table.fields.Start } }
          : { map: { locationFieldId: table.fields.Site } },
    });
    await visit(page, `${base()}/${database.id}/${table.id}/${viewId}`);
    const label = `No ${kind}, 1 record`;
    const toolbar = page.getByRole('toolbar', { name: 'View controls', exact: true });
    const trigger = toolbar.getByRole('button', { name: label, exact: true });
    const open = async () => {
      if (await trigger.isVisible()) await trigger.click();
      else {
        await toolbar.getByRole('button', { name: 'More', exact: true }).click();
        await page.getByRole('menuitem', { name: labelName(label), exact: true }).click();
      }
    };
    await open();
    const dialog = page.getByRole('dialog', { name: heading, exact: true });
    await expect(
      dialog.getByRole('button', { name: 'Planning reference material', exact: true }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Planning reference material', exact: true }).click();
    await expect(dialog).toBeHidden();
    const card = page.getByRole('dialog', { name: 'Planning reference material', exact: true });
    await expect(card).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/${table.records[0]}(?:\\?|$)`));
    await card.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(card).toBeHidden();
    await open();
    await dialog.getByRole('button', { name: `Help with ${label}`, exact: true }).click();
    await expect(dialog).toBeHidden();
    const help = page.getByRole('dialog', { name: 'Help', exact: true });
    await expect(help).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`help=${kind === 'date' ? 'timeline-and-gantt' : 'list-and-map'}`),
    );
    await help.getByRole('button', { name: 'Close help', exact: true }).click();
  });
}

test('fits Kanban settings after shared controls and opens them from More', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Board toolbar', [
    {
      name: 'Projects',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Stage', type: 'singleSelect', choices: ['Open', 'Done'] },
      ],
      records: [],
    },
  ]);
  const table = database.tables.Projects!;
  const viewId = newId('viw');
  await runCommands(page, database.id, [
    {
      kind: 'view.create',
      view: {
        tableId: table.id,
        id: viewId,
        name: 'Board',
        type: 'kanban',
        config: { kanban: { stackFieldId: table.fields.Stage } },
      },
    },
  ]);
  await openTable(page, database, 'Projects');
  await page.getByRole('link', { name: 'Board', exact: true }).click();
  const toolbar = page.locator('[data-anchor="view.toolbar"]');
  await expect(toolbar.getByRole('button', { name: 'Cards', exact: true })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Stacked by: Stage', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 900 });
  await wholeLabels(page);
  await expect(toolbar.locator('[data-item="filter"]')).toHaveAttribute('data-fit', 'icon');
  await toolbar.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Cards'), exact: true }).click();
  const cards = page.getByRole('dialog', { name: 'Cards', exact: true });
  await expect(cards).toBeVisible();
  await tick(cards, 'Hide empty stacks');
  await page.keyboard.press('Escape');
  await expect(toolbar.getByRole('button', { name: 'More', exact: true })).toBeFocused();
  await toolbar.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Stacked by: Stage'), exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Stacked by', exact: true });
  await expect(picker.getByRole('button', { name: /Stacked by$/ })).toContainText('Stage');
  await page.keyboard.press('Escape');
  await page.reload();
  await toolbar.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Cards'), exact: true }).click();
  await expect(cards.getByRole('checkbox', { name: 'Hide empty stacks', exact: true })).toBeChecked();
});

test('keeps chart and pivot settings distinct and ordered as fields appear', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await createDatabase(page, 'Summary toolbars', [
    {
      name: 'Projects',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Stage', type: 'text' },
        { name: 'Amount', type: 'number' },
        { name: 'Due', type: 'date' },
      ],
      records: [{ Name: 'First', Stage: 'Open', Amount: 12, Due: '2026-09-30' }],
    },
  ]);
  const table = database.tables.Projects!;
  await runCommands(page, database.id, [
    {
      kind: 'view.create',
      view: {
        id: newId('viw'),
        tableId: table.id,
        name: 'Chart',
        type: 'chart',
        config: { chart: { groupBy: { fieldId: table.fields.Stage } } },
      },
    },
    {
      kind: 'view.create',
      view: {
        id: newId('viw'),
        tableId: table.id,
        name: 'Pivot',
        type: 'pivot',
        config: { pivot: { rows: [{ fieldId: table.fields.Stage }] } },
      },
    },
  ]);
  await openTable(page, database, 'Projects');
  const toolbar = page.locator('[data-anchor="view.toolbar"]');
  async function pick(button: string, panel: string, value: string) {
    await toolbar.getByRole('button', { name: button, exact: true }).click();
    await page
      .getByRole('dialog', { name: panel, exact: true })
      .getByRole('button', { name: new RegExp(`${panel}$`) })
      .and(page.locator('[aria-haspopup="listbox"]'))
      .click();
    await page.getByRole('option', { name: labelName(value), exact: true }).click();
    await page.keyboard.press('Escape');
  }
  for (const name of ['Chart', 'Pivot']) {
    await page.setViewportSize({ width: 2560, height: 900 });
    await page.getByRole('link', { name, exact: true }).click();
    if (name === 'Chart') {
      await pick('Value: Count of records', 'Value', 'Sum');
      await expect(toolbar.locator('.rio-responsive-toolbar__label')).toHaveText([
        'Filter',
        'Chart: Column',
        'Group by: Stage',
        'Value: Sum',
        'Of: Amount',
        'Chart options',
      ]);
      await pick('Group by: Stage', 'Group by', 'Due');
      await expect(toolbar.locator('.rio-responsive-toolbar__label')).toHaveText([
        'Filter',
        'Chart: Column',
        'Group by: Due',
        'Dates by: Month',
        'Value: Sum',
        'Of: Amount',
        'Chart options',
      ]);
    } else {
      await pick('Columns', 'Columns', 'Due');
      await expect(toolbar.locator('.rio-responsive-toolbar__label')).toHaveText([
        'Filter',
        'Rows: Stage',
        'Columns: Due',
        'Dates by: Month',
        'Values',
        'Options',
      ]);
      const download = toolbar.getByRole('button', { name: 'Download table as CSV', exact: true });
      await expect(download).toBeEnabled();
      await expect(download).toHaveAttribute('data-fit', 'icon');
      await expect(download).toHaveAttribute('data-tooltip', 'Download table as CSV');
      await expect(toolbar.locator('button.rio-responsive-toolbar__button').last()).toHaveAccessibleName(
        'Download table as CSV',
      );
    }
    for (const width of [900, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await wholeLabels(page);
      const icons = await toolbar
        .locator('button:visible > .rio-button__content > svg')
        .evaluateAll((nodes) => nodes.map((node) => node.innerHTML));
      expect(new Set(icons).size).toBe(icons.length);
    }
    await expect(toolbar.getByRole('button', { name: 'More', exact: true })).toHaveCount(1);
    await toolbar.getByRole('button', { name: 'More', exact: true }).click();
    if (name === 'Chart') {
      await page.getByRole('menuitem', { name: labelName('Chart options'), exact: true }).click();
      const options = page.getByRole('dialog', { name: 'Chart options', exact: true });
      await expect(options).toBeVisible();
      const tooltip = page.getByRole('tooltip');
      if (await tooltip.isVisible()) {
        await page.keyboard.press('Escape');
        await expect(tooltip).toBeHidden();
      }
      // Reproduce a hover tooltip opening after the visibility check but before Escape.
      await page.mouse.move(0, 0);
      await options.getByRole('button', { name: 'Help with Chart options', exact: true }).hover();
      await expect(tooltip).toBeVisible();
      await page.mouse.move(0, 0);
      await expect(tooltip).toBeHidden();
      await page.keyboard.press('Escape');
      await expect(options).toBeHidden();
    } else {
      await expect(page.getByRole('menuitem', { name: labelName('Download CSV'), exact: true })).toHaveCount(
        1,
      );
      const download = page.waitForEvent('download');
      await page.getByRole('menuitem', { name: labelName('Download table as CSV'), exact: true }).click();
      expect((await download).suggestedFilename()).toContain('Pivot');
    }
  }
});
