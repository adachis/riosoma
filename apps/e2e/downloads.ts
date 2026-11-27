import { expect, type Download, type Locator, type Page, type Response } from './accessibility';

export function expectSuggestedFilename(download: Download, name: string): void {
  // Linux WebKit 2370 uses libsoup 3.6.6.  Its soup_message_headers_get_content_disposition()
  // replaces internal spaces with underscores in the filename it returns to WebKit's
  // ResourceResponse::platformSuggestedFilename(), including for synthetic blob headers.
  // The canary in m-downloads.spec.ts fails when WebKit starts returning spaces again.
  const browser = download.page().context().browser()?.browserType().name();
  const usesLibsoup = browser === 'webkit' && process.platform === 'linux';
  expect(download.suggestedFilename()).toBe(usesLibsoup ? name.replaceAll(' ', '_') : name);
}

export async function downloadNamedBlob(page: Page, press: Locator, name: string): Promise<Download> {
  const clicked = await page.evaluateHandle(() => {
    const names = new Map<string, string>();
    const listener = new AbortController();
    document.addEventListener(
      'click',
      (event) => {
        if (!(event.target instanceof Element)) return;
        const anchor = event.target.closest<HTMLAnchorElement>('a[download]');
        if (anchor?.protocol === 'blob:') names.set(anchor.href, anchor.download);
      },
      { capture: true, signal: listener.signal },
    );
    return { names, listener };
  });
  const dispositions: string[] = [];
  const origin = new URL(page.url()).origin;
  const record = (response: Response) => {
    const disposition = response.headers()['content-disposition'];
    if (disposition && response.url().startsWith(`${origin}/api/`)) dispositions.push(disposition);
  };
  page.on('response', record);
  try {
    const [file] = await Promise.all([page.waitForEvent('download'), press.click()]);
    expect(await clicked.evaluate(({ names }, url) => names.get(url), file.url())).toBe(name);
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0]?.split('; ').slice(1)).toEqual([
      `filename="${name}"`,
      `filename*=UTF-8''${encodeURIComponent(name)}`,
    ]);
    expectSuggestedFilename(file, name);
    return file;
  } finally {
    page.off('response', record);
    await clicked.evaluate(({ listener }) => listener.abort());
    await clicked.dispose();
  }
}
