import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, openTable, signIn, visit } from '../helpers';

test.use({ serviceWorkers: 'block' });
test.setTimeout(90_000);

/** A file button is named by its visible text: the file name, then its size or scan state. */
const fileButton = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`);

for (const phone of [false, true]) {
  test(`attachment inputs, previews, ordering, downloads, and undo at ${phone ? 'phone' : 'desktop'} width`, async ({
    page,
  }) => {
    await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    await signIn(page);
    const database = await createDatabase(page, 'Attachment review', [
      {
        name: 'Tasks',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Files', type: 'attachment' },
        ],
        records: [{ Name: 'Review 記録 🧭' }],
      },
    ]);
    const table = database.tables.Tasks!;
    await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}/${table.records[0]}/page`);
    const record = page.getByRole('region', { name: 'Review 記録 🧭', exact: true });
    const files = record.getByRole('group', { name: 'Files', exact: true });
    await expect(files.getByText('No files yet', { exact: true })).toBeVisible();
    const imageData = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#2468ac';
      context.fillRect(0, 0, 64, 64);
      return canvas.toDataURL('image/png').split(',')[1]!;
    });
    const require = createRequire(new URL('../../server/package.json', import.meta.url));
    const { PDFDocument } = require('pdf-lib') as {
      PDFDocument: { create(): Promise<{ addPage(): void; save(): Promise<Uint8Array> }> };
    };
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const audio = Buffer.alloc(1644);
    audio.write('RIFF');
    audio.writeUInt32LE(audio.length - 8, 4);
    audio.write('WAVEfmt ', 8);
    audio.writeUInt32LE(16, 16);
    audio.writeUInt16LE(1, 20);
    audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(8000, 24);
    audio.writeUInt32LE(16000, 28);
    audio.writeUInt16LE(2, 32);
    audio.writeUInt16LE(16, 34);
    audio.write('data', 36);
    audio.writeUInt32LE(audio.length - 44, 40);
    // A committed silent clip stands in for a recording.  Linux WebKit ships without MediaRecorder,
    // and the feature under test is attachments, not capture, so every browser attaches this file.
    const videoName = 'Silent.mp4';
    const videoFile = readFileSync(fileURLToPath(new URL('./fixtures/silent.mp4', import.meta.url)));
    const input = files.locator('input[type="file"]').first();
    await input.setInputFiles([
      { name: 'Image 中文 🧭.png', mimeType: 'image/png', buffer: Buffer.from(imageData, 'base64') },
      { name: 'Paper.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) },
      { name: 'Silent.wav', mimeType: 'audio/wav', buffer: audio },
      { name: videoName, mimeType: 'video/mp4', buffer: videoFile },
    ]);
    for (const name of ['Image 中文 🧭.png', 'Paper.pdf', 'Silent.wav', videoName]) {
      await expect(files.getByRole('button', { name: fileButton(name) })).toBeVisible();
    }
    for (const kind of ['drop', 'paste'] as const) {
      await files.evaluate((element, eventKind) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([`Attachment from ${eventKind}`], `${eventKind}.txt`, { type: 'text/plain' }),
        );
        const event =
          eventKind === 'drop'
            ? new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
            : new Event('paste', { bubbles: true, cancelable: true });
        if (eventKind === 'paste') Object.defineProperty(event, 'clipboardData', { value: transfer });
        element.dispatchEvent(event);
      }, kind);
      await expect(files.getByRole('button', { name: fileButton(`${kind}.txt`) })).toBeVisible();
    }
    const image = files.getByRole('button', { name: /^Image 中文 🧭\.png(?: |$)/ });
    await image.click();
    const preview = page.getByRole('dialog', { name: 'Preview of Image 中文 🧭.png', exact: true });
    const picture = preview.getByRole('img', { name: 'Image 中文 🧭.png', exact: true });
    await expect(picture).toBeVisible();
    await expect
      .poll(() => picture.evaluate((element) => (element as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await expect(preview.getByRole('link', { name: /^Open original/ })).toBeVisible();
    await preview.press('ArrowRight');
    const paper = page.getByRole('dialog', { name: 'Preview of Paper.pdf', exact: true });
    await expect(paper.getByRole('link', { name: /^Open in a new tab/ })).toBeVisible();
    await paper.press('ArrowRight');
    const sound = page.getByRole('dialog', { name: 'Preview of Silent.wav', exact: true });
    await expect(sound.locator('audio[controls]')).toBeVisible();
    await sound.press('ArrowRight');
    const video = page.getByRole('dialog', { name: `Preview of ${videoName}`, exact: true });
    await expect(video.locator('video[controls]')).toBeVisible();
    await video.locator('video').evaluate((element) => {
      (element as HTMLVideoElement).muted = true;
    });
    await video.locator('video').press('ArrowRight');
    await expect(video).toBeVisible();
    await video.press('Escape');
    await image.focus();
    await image.press('Alt+ArrowDown');
    const names = () =>
      files
        .locator('.rio-files__file .rio-files__name')
        .evaluateAll((elements) => elements.map((element) => element.textContent));
    await expect
      .poll(names)
      .toEqual(['Paper.pdf', 'Image 中文 🧭.png', 'Silent.wav', videoName, 'drop.txt', 'paste.txt']);
    await files.getByRole('button', { name: 'Remove paste.txt', exact: true }).click();
    await expect(files.getByRole('button', { name: /^paste\.txt(?: |$)/ })).toHaveCount(0);
    await record.getByRole('button', { name: 'Close', exact: true }).click();
    const undone = page.waitForResponse((response) =>
      response.url().endsWith(`/api/databases/${database.id}/undo`),
    );
    await page.locator('.rio-grid__input').focus();
    await page.locator('.rio-grid__input').press('ControlOrMeta+z');
    expect((await undone).ok()).toBe(true);
    await page
      .getByRole('grid', { name: 'Grid', exact: true })
      .getByRole('button', { name: 'Expand row 1' })
      .click();
    const card = page.getByRole('dialog', { name: 'Review 記録 🧭', exact: true });
    await expect(card.getByRole('button', { name: /^paste\.txt(?: |$)/ })).toBeVisible();
    const row = await asOwner<{ values: Record<string, string[]> }>(
      page,
      'GET',
      `/api/tables/${table.id}/records/${table.records[0]}`,
    );
    const details = await asOwner<Array<{ name: string; url: string }>>(
      page,
      'GET',
      `/api/files?ids=${row.values[table.fields.Files!]!.join(',')}`,
    );
    const dropped = details.find((file) => file.name === 'drop.txt')!;
    const download = await page.request.get(`${base()}${dropped.url}`);
    expect(download.ok()).toBe(true);
    expect(await download.text()).toBe('Attachment from drop');
    await page.reload();
    await expect(card.getByRole('button', { name: /^paste\.txt(?: |$)/ })).toBeVisible();
  });
}

test('the phone-width camera picker captures a silent stream and releases it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const database = await createDatabase(page, 'Camera review', [
    {
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Files', type: 'attachment' },
      ],
      records: [{ Name: 'Photo record' }],
    },
  ]);
  await page.addInitScript(() => {
    const mediaDevices = navigator.mediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
    Object.defineProperty(mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const draw = setInterval(() => canvas.getContext('2d')!.fillRect(0, 0, 64, 64), 50);
        const stream = canvas.captureStream(10);
        const track = stream.getTracks()[0]!;
        const stop = track.stop.bind(track);
        track.stop = () => {
          clearInterval(draw);
          stop();
          document.documentElement.dataset.cameraStopped = 'true';
        };
        return stream;
      },
    });
  });
  const grid = await openTable(page, database, 'Tasks');
  await grid.getByRole('button', { name: 'Expand row 1' }).click();
  const card = page.getByRole('dialog', { name: 'Photo record', exact: true });
  await card.getByRole('button', { name: 'More ways to add', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Take photo', exact: true }).click();
  const capture = page.getByRole('dialog', { name: 'Take a photo', exact: true });
  await expect(capture.getByRole('button', { name: 'Take photo', exact: true })).toBeEnabled();
  await capture.getByRole('button', { name: 'Take photo', exact: true }).click();
  await expect(capture).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-camera-stopped', 'true');
  await expect(card.getByRole('button', { name: /^Photo .*\.jpg(?: |$)/ })).toBeVisible();
});

test.describe('touch camera input', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('the phone photo picker requests the rear camera and attaches the chosen image', async ({ page }) => {
    await signIn(page);
    const database = await createDatabase(page, 'Touch photo review', [
      {
        name: 'Tasks',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Files', type: 'attachment' },
        ],
        records: [{ Name: 'Camera picker' }],
      },
    ]);
    const grid = await openTable(page, database, 'Tasks');
    await grid.getByRole('button', { name: 'Expand row 1' }).click();
    const card = page.getByRole('dialog', { name: 'Camera picker', exact: true });
    await expect(card.locator('input[capture="environment"]')).toHaveAttribute('accept', 'image/*');
    const image = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      canvas.getContext('2d')!.fillRect(0, 0, 32, 32);
      return canvas.toDataURL('image/png').split(',')[1]!;
    });
    await card.getByRole('button', { name: 'More ways to add', exact: true }).click();
    const chosen = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', { name: 'Take photo', exact: true }).click();
    await (
      await chosen
    ).setFiles({ name: 'Camera 記録.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
    await expect(card.getByRole('button', { name: /^Camera 記録\.png(?: |$)/ })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Take a photo', exact: true })).toHaveCount(0);
  });
});
