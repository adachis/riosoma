import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '../accessibility';
import { paragraphs, part, slides, tableRows, texts, unzip } from '../files';
import { asOwner, createDatabase, openTable, signIn } from '../helpers';

/**
 * Word documents and PowerPoint decks, downloaded as people do: a view from its menu, after the
 * dialog that asks for a title and, for a deck, a layout, and one record from its card's menu.
 * Each file is unzipped here and read for its title, a record's values, and its slides.
 */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

const CROSSINGS = [
  { Name: 'Morning run', Vessel: 'Kittiwake', Passengers: 112 },
  { Name: 'Noon run', Vessel: 'Gannet', Passengers: 64 },
  { Name: 'Evening run', Vessel: 'Kittiwake', Passengers: 97 },
];

/** Waits for the browser to save the file a press starts, and returns its name and bytes. */
async function saved(page: Page, press: Locator): Promise<{ name: string; bytes: Buffer }> {
  const [file] = await Promise.all([page.waitForEvent('download'), press.click()]);
  return { name: file.suggestedFilename(), bytes: readFileSync((await file.path())!) };
}

/** Chooses a download from the view's menu, which opens the dialog for a title. */
async function fromViewMenu(page: Page, item: 'Word document' | 'PowerPoint deck', dialog: string) {
  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('button', { name: 'More for Grid' })
    .click();
  await page.getByRole('menuitem', { name: item }).click();
  const opened = page.getByRole('dialog', { name: dialog });
  await expect(opened.getByRole('textbox', { name: 'Title' })).toHaveValue('Grid');
  return opened;
}

test('a view downloads as a Word document and a PowerPoint deck, and one record as Word', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  // The record download is exercised in the card, independent of the saved layout.
  await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'card' });
  const database = await createDatabase(page, 'Ferry Schedule', [
    {
      name: 'Crossings',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Vessel', type: 'singleSelect', choices: ['Kittiwake', 'Gannet'] },
        { name: 'Passengers', type: 'number' },
      ],
      records: CROSSINGS,
    },
  ]);
  const grid = await openTable(page, database, 'Crossings');
  await expect(grid.getByRole('gridcell', { name: 'Evening run' })).toBeVisible();

  // A Word document of the view: its title, then a table of the view's fields and records.
  const word = await fromViewMenu(page, 'Word document', 'Download a Word document');
  await word.getByRole('textbox', { name: 'Title' }).fill('Crossings this week');
  const document = await saved(page, word.getByRole('button', { name: 'Download', exact: true }));
  await expect(word).toBeHidden();
  expect(document.name).toBe('Crossings - Grid.docx');
  const docx = part(unzip(document.bytes), 'word/document.xml');
  expect(paragraphs(docx)[0]).toBe('Crossings this week');
  expect(paragraphs(docx).join('\n')).toContain('3 records');
  const rows = tableRows(docx);
  expect(rows[0]).toEqual(['Name', 'Vessel', 'Passengers']);
  expect(rows).toContainEqual(['Noon run', 'Gannet', '64']);
  expect(rows).toHaveLength(1 + CROSSINGS.length);

  // A deck with a slide for each record, after a title slide.
  const deck = await fromViewMenu(page, 'PowerPoint deck', 'Download a PowerPoint deck');
  await deck.getByRole('textbox', { name: 'Title' }).fill('Ferry briefing');
  await expect(deck.getByRole('radio', { name: /^A slide for each record/ })).toBeChecked();
  const presentation = await saved(page, deck.getByRole('button', { name: 'Download', exact: true }));
  expect(presentation.name).toBe('Crossings - Grid.pptx');
  const pages = slides(unzip(presentation.bytes));
  expect(pages).toHaveLength(1 + CROSSINGS.length);
  expect(texts(pages[0]!, 'a:t')).toContain('Ferry briefing');
  const perRecord = pages.slice(1).map((slide) => texts(slide, 'a:t'));
  expect(perRecord.map((words) => words[0])).toEqual(CROSSINGS.map((crossing) => crossing.Name));
  expect(perRecord[1]!.join('\n')).toContain('Gannet');
  expect(perRecord[1]!.join('\n')).toContain('64');

  // The same view as a table, twelve records to a slide, fits on one slide after the title.
  const table = await fromViewMenu(page, 'PowerPoint deck', 'Download a PowerPoint deck');
  await table.getByText('A table', { exact: true }).click();
  await expect(table.getByRole('radio', { name: /^A table/ })).toBeChecked();
  const tabled = slides(
    unzip((await saved(page, table.getByRole('button', { name: 'Download', exact: true }))).bytes),
  );
  expect(tabled).toHaveLength(2);
  expect(texts(tabled[1]!, 'a:t')).toEqual(
    expect.arrayContaining(['Name', 'Vessel', 'Passengers', 'Noon run']),
  );

  // One record as Word, from its card: titled with its primary field, then each field and value.
  await grid.getByRole('button', { name: 'Expand row 2' }).click();
  const card = page.getByRole('dialog', { name: 'Noon run' });
  await card.getByRole('button', { name: 'More for this record' }).click();
  await page.getByRole('menuitem', { name: 'Download as Word' }).click();
  const asWord = page.getByRole('dialog', { name: 'Download as Word' });
  const record = await saved(page, asWord.getByRole('button', { name: 'Download', exact: true }));
  await expect(asWord).toBeHidden();
  expect(record.name).toBe('Crossings - Noon run.docx');
  const lines = paragraphs(part(unzip(record.bytes), 'word/document.xml'));
  expect(lines[0]).toBe('Noon run');
  const body = lines.join('\n');
  for (const text of ['Vessel', 'Gannet', 'Passengers', '64']) expect(body).toContain(text);
  expect(body).not.toContain('Morning run');
});
