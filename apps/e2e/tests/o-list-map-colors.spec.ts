import { expect, test, type Locator, type Page } from '../accessibility';
import { base } from '../base';
import { createDatabase, createView, offlineMap, signIn, visit } from '../helpers';

/**
 * A color rule for records, made from the Color control, marks the start of a list's line and
 * colors a map's pin, ahead of the option the pins are otherwise colored by.  Each mark is named
 * by its rule for screen readers.
 */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.  Motion is left out so the map settles at once.
test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

const RULE = 'Needs a crane';

/** Adds a rule from the view's Color control that colors a whole record red when its name has this. */
async function addRecordRule(page: Page, contains: string): Promise<void> {
  await page.getByRole('toolbar', { name: 'View controls' }).getByRole('button', { name: 'Color' }).click();
  // The control, and the settings it opens, are named by how many rules there are.
  const editor = page.getByRole('dialog', { name: /^(Color|\d+ color rules?)$/ });
  await editor.getByRole('button', { name: 'Add rule' }).click();
  // A new rule colors cells red, on the first field, until it's told otherwise.
  await editor.getByRole('radio', { name: 'Record' }).click();
  await editor.getByRole('textbox', { name: 'Name' }).fill(RULE);
  await editor.getByRole('textbox', { name: 'Value' }).fill(contains);
  await editor.getByRole('textbox', { name: 'Value' }).press('Escape');
  await expect(editor).toBeHidden();
}

/** A theme color as the map reads it: the computed color of a variable, as `rgb()` values. */
async function themeColor(within: Locator, variable: string): Promise<[number, number, number]> {
  return within.evaluate((node, name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    node.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    const canvas = document.createElement('canvas').getContext('2d')!;
    canvas.fillStyle = color;
    canvas.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = canvas.getImageData(0, 0, 1, 1).data;
    return [r, g, b] as [number, number, number];
  }, variable);
}

/** How many of the map's pixels are this color, give or take a little for smoothing. */
async function pixelsOf(page: Page, map: Locator, color: [number, number, number]): Promise<number> {
  const shot = (await map.screenshot()).toString('base64');
  return page.evaluate(
    async ({ shot, color }) => {
      const bytes = Uint8Array.from(atob(shot), (char) => char.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      let count = 0;
      for (let at = 0; at < data.length; at += 4)
        if (
          Math.abs(data[at]! - color[0]) <= 8 &&
          Math.abs(data[at + 1]! - color[1]) <= 8 &&
          Math.abs(data[at + 2]! - color[2]) <= 8
        )
          count++;
      return count;
    },
    { shot, color },
  );
}

test('a record rule marks a list line and colors a map pin', async ({ page }) => {
  test.setTimeout(60_000);
  await signIn(page);
  const database = await createDatabase(page, 'Harbor Works', [
    {
      name: 'Projects',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'singleSelect', choices: ['Planned', 'Active', 'Done'] },
        { name: 'Site', type: 'location' },
      ],
      records: [
        { Name: 'Crane refit', Status: 'Active', Site: { lat: 47.6062, lng: -122.3321, label: 'Seattle' } },
        { Name: 'Pier lighting', Status: 'Planned', Site: { lat: 47.2529, lng: -122.4443, label: 'Tacoma' } },
        {
          Name: 'Cold storage wing',
          Status: 'Active',
          Site: { lat: 47.0379, lng: -122.9007, label: 'Olympia' },
        },
      ],
    },
  ]);
  const projects = database.tables.Projects!;
  const listId = await createView(page, database, 'Projects', { name: 'Project list', type: 'list' });
  const mapId = await createView(page, database, 'Projects', {
    name: 'Project sites',
    type: 'map',
    config: { map: { locationFieldId: projects.fields.Site, colorFieldId: projects.fields.Status } },
  });

  // On a list, the rule marks the start of the matching line, and names itself for screen readers.
  await visit(page, `${base()}/${database.id}/${projects.id}/${listId}`);
  const list = page.getByRole('tree', { name: 'Project list' });
  const crane = list.getByRole('treeitem', { name: 'Crane refit' });
  const lighting = list.getByRole('treeitem', { name: 'Pier lighting' });
  await expect(crane).toBeVisible();
  await addRecordRule(page, 'crane');
  await expect(crane).toHaveAccessibleDescription(new RegExp(`^${RULE}`));
  await expect(lighting).not.toHaveAccessibleDescription(new RegExp(RULE));
  const mark = crane.locator('.rio-list-view__color');
  await expect(mark).toBeVisible();
  await expect(lighting.locator('.rio-list-view__color')).toHaveCount(0);
  const red = await themeColor(list, '--rio-aa-choice-red');
  expect(
    await mark.evaluate((node) => {
      const canvas = document.createElement('canvas').getContext('2d')!;
      canvas.fillStyle = getComputedStyle(node).backgroundColor;
      canvas.fillRect(0, 0, 1, 1);
      return [...canvas.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    }),
  ).toEqual(red);

  // On a map, the same kind of rule colors the matching pin red, where its status would make it green.
  await offlineMap(page);
  await visit(page, `${base()}/${database.id}/${projects.id}/${mapId}`);
  const map = page.getByLabel('Project sites map, 3 pins');
  await expect(map).toBeVisible();
  const view = page.locator('.rio-map-view');
  const green = await themeColor(view, '--rio-aa-choice-green');
  await expect
    .poll(() => pixelsOf(page, map, green), { message: 'the active pins are green' })
    .toBeGreaterThan(40);
  expect(await pixelsOf(page, map, red), 'no pin is red yet').toBe(0);
  await addRecordRule(page, 'crane');
  await expect
    .poll(() => pixelsOf(page, map, red), { message: 'the crane’s pin turns red' })
    .toBeGreaterThan(20);

  // The list of places and the pin's card show the rule's mark, named for screen readers.
  await page.getByRole('button', { name: 'List records and places' }).click();
  const places = page.getByRole('table', { name: 'Records and places' });
  await expect(
    places.getByRole('row', { name: /Crane refit/ }).getByRole('img', { name: RULE }),
  ).toBeVisible();
  await expect(places.getByRole('row', { name: /Pier lighting/ }).getByRole('img')).toHaveCount(0);
  await places.getByRole('button', { name: 'Show on map: Crane refit' }).click();
  const card = page.getByRole('region', { name: 'Crane refit' });
  await expect(card.getByRole('img', { name: RULE })).toBeVisible();
});
