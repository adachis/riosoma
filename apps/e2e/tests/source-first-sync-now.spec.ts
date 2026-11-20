import { randomBytes } from 'node:crypto';
import { expect, test } from '../accessibility';
import { labelName, asOwner, createDatabase, openTable, signIn } from '../helpers';
import { connection, sql } from '../sql';

test.use({ serviceWorkers: 'block' });

for (const fails of [false, true]) {
  test(`a first copy ${fails ? 'fails visibly and retries on a phone' : 'reports progress and shows 50,000 rows without a reload'}`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const schema = `source_first_${randomBytes(8).toString('hex')}`;
    await sql(`CREATE SCHEMA "${schema}";
      CREATE TABLE "${schema}".state (fails boolean);
      INSERT INTO "${schema}".state VALUES (${fails});
      CREATE FUNCTION "${schema}".name_for(row_id integer) RETURNS text LANGUAGE plpgsql AS $$
      BEGIN
        IF row_id = 5001 THEN
          PERFORM pg_sleep(3);
          IF (SELECT state.fails FROM "${schema}".state) THEN
            RAISE EXCEPTION 'The source is temporarily unavailable';
          END IF;
        END IF;
        RETURN 'Order ' || lpad(row_id::text, 5, '0');
      END $$;
      CREATE VIEW "${schema}".orders AS
        SELECT id, "${schema}".name_for(id) AS name FROM generate_series(1, 50000) id;`);
    try {
      let creating = 0;
      let startedMs: number | null = null;
      page.on('websocket', (socket) => {
        socket.on('framereceived', ({ payload }) => {
          const body = payload.toString();
          if (
            creating &&
            startedMs === null &&
            body.includes('Orders with a long name for narrow screens') &&
            body.includes('"state":"running"')
          )
            startedMs = Date.now() - creating;
        });
      });
      await signIn(page);
      if (fails) await page.setViewportSize({ width: 390, height: 844 });
      const { password: _password, ...address } = connection();
      const input = {
        name: `Source ${schema}`,
        access: 'creators',
        connection: { kind: 'postgres', ...address, schema, tls: { mode: 'disable' } },
        secrets: { password: randomBytes(24).toString('hex') },
      };
      const checking = Date.now();
      const checked = await asOwner<{ ok: boolean }>(page, 'POST', '/api/sources/test', input);
      expect(checked.ok).toBe(true);
      const connectionMs = Date.now() - checking;
      await asOwner(page, 'POST', '/api/sources', input);
      const database = await createDatabase(page, `Copy ${schema}`, [
        { name: 'Notes', fields: [{ name: 'Name', type: 'text' }] },
      ]);
      await openTable(page, database, 'Notes');
      const menu = page.getByRole('button', { name: 'Menu', exact: true });
      if (await menu.isVisible()) await menu.click();
      await page.getByRole('button', { name: 'Add a table' }).click();
      await page.getByRole('menuitem', { name: 'Sync from a data source' }).click();
      const wizard = page.getByRole('dialog', { name: 'Sync from a data source' });
      await wizard.getByRole('button', { name: /Choose a data source/ }).click();
      await page.getByRole('option', { name: input.name, exact: true }).click();
      await wizard.getByRole('button', { name: 'Next', exact: true }).click();
      await wizard.getByRole('searchbox', { name: 'Search tables and views' }).fill('orders');
      await wizard.getByRole('option', { name: labelName('orders'), exact: true }).click();
      const previewing = Date.now();
      await wizard.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(wizard.getByRole('table', { name: 'Preview' })).toContainText('Order 00001');
      const previewMs = Date.now() - previewing;
      const key = wizard
        .getByRole('group', { name: 'Key columns' })
        .getByRole('checkbox', { name: 'id', exact: true });
      await key.focus();
      await page.keyboard.press('Space');
      await expect(key).toBeChecked();
      await wizard.getByRole('button', { name: 'Next', exact: true }).click();
      await wizard
        .getByRole('textbox', { name: 'Table name' })
        .fill('Orders with a long name for narrow screens');
      let reloads = 0;
      page.on('request', (request) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) reloads++;
      });
      const status = page.locator('.rio-synced-status [role="status"]');
      const progress = status.getByText('Copy started.', { exact: true });
      creating = Date.now();
      // The action's accessibility scan can outlast the copy, so observe progress while it runs.
      const [, { dispatchMs, sawProgress }] = await Promise.all([
        wizard.getByRole('button', { name: 'Create synced table', exact: true }).click(),
        (async () => {
          await expect(wizard).toBeHidden();
          if (fails) await expect(page.getByRole('dialog', { name: 'Menu', exact: true })).toBeHidden();
          // Record the result before asserting latency, so an old scheduler produces useful evidence.
          await expect(status).toContainText(/Copy started\.|Synced from|The last sync failed/, {
            timeout: 45_000,
          });
          const dispatchMs = Date.now() - creating;
          const sawProgress = await progress.isVisible();
          if (sawProgress) {
            await expect(status).toContainText('5,000 rows read');
            await expect(page.getByText(/seconds? elapsed/)).toBeVisible();
          }
          return { dispatchMs, sawProgress };
        })(),
      ]);
      if (fails) {
        await expect(status).toContainText('The last sync failed.', { timeout: 45_000 });
        await expect(status).toContainText('The source is temporarily unavailable');
        await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
          true,
        );
        await sql(`UPDATE "${schema}".state SET fails = false`);
        await Promise.all([
          page.getByRole('button', { name: 'Try again', exact: true }).click(),
          expect(progress).toBeVisible({ timeout: 2_000 }),
        ]);
      }
      const grid = page.getByRole('grid', { name: 'Grid', exact: true });
      await expect(grid.getByRole('gridcell', { name: 'Order 00001', exact: true })).toBeVisible({
        timeout: 45_000,
      });
      await expect(page.getByText('50,000 records', { exact: true })).toBeVisible();
      const rowsMs = Date.now() - creating;
      const finding = Date.now();
      await page.getByRole('button', { name: 'Find links', exact: true }).click();
      const joins = page.getByRole('dialog', { name: 'Suggested links', exact: true });
      await expect(joins.getByRole('progressbar')).toHaveCount(0);
      await expect(joins.getByText(/Nothing obvious to link/)).toBeVisible();
      const joinsMs = Date.now() - finding;
      console.log(
        JSON.stringify({
          browser: test.info().project.name,
          fails,
          connectionMs,
          previewMs,
          startedMs,
          progressMs: dispatchMs,
          rowsMs,
          joinsMs,
        }),
      );
      expect(reloads).toBe(0);
      expect(sawProgress).toBe(true);
      expect(dispatchMs).toBeLessThan(2_000);
    } finally {
      await sql(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });
}
