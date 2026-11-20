import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, openTable, runCommands, signIn, visit } from '../helpers';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

for (const phone of [false, true])
  test(`icon sets save, announce bands, and deep-link${phone ? ' on a phone' : ''}`, async ({
    page,
  }, info) => {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'card' });
    const db = await createDatabase(page, 'Scorecards', [
      {
        name: 'Scores',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Score', type: 'number' },
        ],
        records: [
          { Name: 'Low', Score: -1 },
          { Name: 'Middle', Score: 0 },
          { Name: 'High', Score: 100 },
        ],
      },
    ]);
    const grid = await openTable(page, db, 'Scores');
    const table = db.tables.Scores!;
    const url = `${base()}/${db.id}/${table.id}/${table.viewId}?colors=open`;
    await visit(page, url);
    const editor = page.getByRole('dialog', { name: /^(Color|\d+ color rules?)$/ });
    await editor.getByRole('button', { name: 'Add icon set' }).click();
    const high = grid.getByRole('gridcell', { name: '100', exact: true });
    await expect(high).toHaveAccessibleDescription('High (100 or more)');
    const threshold = editor.getByRole('textbox', { name: 'High threshold' });
    await threshold.fill('50');
    await threshold.press('Tab');
    await editor.getByRole('textbox', { name: 'Band 3 text alternative' }).fill('Excellent');
    const style = editor.getByRole('button', { name: /Icon style/ });
    await style.press('Enter');
    await page.getByRole('option', { name: 'Flags' }).click();
    await expect(high).toHaveAccessibleDescription('Excellent');
    await expect(high).toHaveAttribute('title', 'Excellent');
    await expect(high.locator('.rio-color-icon')).toHaveText('⚑');
    await style.click();
    await page.getByRole('option', { name: 'Ratings' }).click();
    await expect(high.locator('.rio-color-icon')).toHaveText('★★★');
    await expect
      .poll(async () => {
        const response = await page.request.get(`${base()}/api/databases/${db.id}/schema`);
        const schema = await response.json();
        return schema.views.find((view: { id: string }) => view.id === table.viewId).config.iconSets[0];
      })
      .toMatchObject({ style: 'ratings', thresholds: [0, 50], labels: ['', '', 'Excellent'] });
    await editor.screenshot({ path: info.outputPath(phone ? 'phone.png' : 'desktop.png') });
    await editor.getByRole('textbox', { name: 'Band 3 text alternative' }).press('Escape');
    await expect(editor).toBeHidden();
    await expect(page).not.toHaveURL(/colors=open/);
    await expect(grid.getByRole('gridcell', { name: '-1', exact: true })).toHaveAccessibleDescription(
      'Low (below 0)',
    );
    await expect(grid.getByRole('gridcell', { name: '0', exact: true })).toHaveAccessibleDescription(
      'Middle (0 to below 50)',
    );
    await runCommands(page, db.id, [
      {
        kind: 'view.update',
        viewId: table.viewId,
        config: {
          colorRules: [
            {
              id: 'over-budget',
              name: 'Over budget',
              target: 'cell',
              condition: { id: 'budget', fieldId: table.fields.Score, operator: 'gte', value: 50 },
              color: 'red',
            },
          ],
        },
      },
    ]);
    await grid.getByRole('button', { name: 'Expand row 3' }).click();
    const record = page.getByRole('dialog', { name: 'High', exact: true });
    await expect(record.getByRole('img', { name: 'Excellent', exact: true })).toBeVisible();
    await expect(record.getByRole('img', { name: 'Over budget, Excellent', exact: true })).toBeVisible();
    await record.screenshot({ path: info.outputPath(phone ? 'record-phone.png' : 'record-desktop.png') });
    await record.press('Escape');
    await expect(record).toBeHidden();
    await visit(page, url);
    await expect(editor.getByRole('textbox', { name: 'Band 3 text alternative' })).toHaveValue('Excellent');
    await editor.getByRole('button', { name: 'Remove icon set' }).click();
    await expect(grid.locator('.rio-color-icon')).toHaveCount(0);
  });
