import lockup from '../../public/brand/riosoma-lockup.svg?raw';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { i18n, setupI18n } from '@lingui/core';
import pdfmake from 'pdfmake/build/pdfmake';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportAllPdf, exportModulePdf, pdfContent } from './pdf';
import { parseTokens } from './tokens';

/** Help modules in the docs folder, so adding an article never means editing this test. */
const MODULES = readdirSync(join(import.meta.dirname, '../../../../docs/modules'), { withFileTypes: true })
  .filter((area) => area.isDirectory())
  .flatMap((area) => readdirSync(join(area.parentPath, area.name))).length;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(lockup, { headers: { 'content-type': 'image/svg+xml' } })),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function interceptDownloads() {
  const downloads: { filename: string | undefined; bytes: Uint8Array; definition: TDocumentDefinitions }[] =
    [];
  const create = pdfmake.createPdf.bind(pdfmake);
  vi.spyOn(pdfmake, 'createPdf').mockImplementation((definition, options) => {
    const document = create(definition, options);
    vi.spyOn(document, 'download').mockImplementation(async (filename) => {
      downloads.push({ filename, bytes: await document.getBuffer(), definition });
    });
    return document;
  });
  i18n.load('en-US', { 'shell.nav.settings': 'Settings' });
  i18n.activate('en-US');
  return downloads;
}

describe('help PDF export', () => {
  it('downloads real PDF bytes containing the title and a Letter-sized layout', async () => {
    const downloads = interceptDownloads();
    await exportModulePdf('welcome', 'en-US');
    expect(downloads).toHaveLength(1);
    const result = downloads[0]!;
    const bytes = new TextDecoder().decode(result.bytes);
    expect(result.filename).toBe('riosoma-help-welcome.pdf');
    expect(bytes.startsWith('%PDF')).toBe(true);
    expect(bytes).toContain('Welcome to Riosoma');
    expect(result.definition.pageSize).toBe('LETTER');
    expect(result.definition.defaultStyle?.fontSize).toBe(11);
    expect(JSON.stringify(result.definition.content)).toContain('Settings');
  });

  it('exports every module in a section with its own footer', async () => {
    const downloads = interceptDownloads();
    await exportAllPdf('en-US');
    const result = downloads[0]!;
    expect(result.filename).toBe('riosoma-help.pdf');
    expect(new TextDecoder().decode(result.bytes).startsWith('%PDF')).toBe(true);
    const sections = result.definition.content as {
      section: unknown;
      footer: (page: number, count: number) => unknown;
    }[];
    expect(sections).toHaveLength(MODULES);
    expect(JSON.stringify(sections[0]!.footer(1, 8))).toContain('1 / 8');
    expect(JSON.stringify(sections[0]!.footer(1, 8))).toContain('Signing in and out');
  });

  it('preserves Markdown structure, resolves macros, and omits active links and HTML', () => {
    const translate = setupI18n({
      locale: 'en-US',
      messages: { 'en-US': { 'control.save': 'Save changes' } },
    });
    const tokens = parseTokens(
      '## Heading\n\n*Emphasis* and **strong** and `code` {{ui:control.save}} {{keys:save}} {{doc:themes}} [Link](https://example.com).\n\n- Item\n  - Nested\n\n3. Third\n\n> Quote\n\n```\n  code block\n```\n\n---\n\n<div>Hidden</div>',
    );
    const content = pdfContent(tokens, translate, new Map([['themes', 'Choosing a theme']]));
    const serialized = JSON.stringify(content);
    for (const text of [
      'Heading',
      'Emphasis',
      'strong',
      'code block',
      'Quote',
      'Save changes',
      'Choosing a theme',
      'Nested',
    ])
      expect(serialized).toContain(text);
    for (const key of ['"ul"', '"ol"', '"start":3', '"italics":true', '"bold":true', '"canvas"'])
      expect(serialized).toContain(key);
    for (const text of ['Hidden', 'https:', '{{', '"link":']) expect(serialized).not.toContain(text);
  });

  it('rejects an unknown module without downloading', async () => {
    const downloads = interceptDownloads();
    await expect(exportModulePdf('missing', 'en-US')).rejects.toThrow('Unknown help module');
    expect(downloads).toHaveLength(0);
  });
});
