import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { LOGO_MAX_BYTES } from '@riosoma/contracts';
import { sanitizeLogo, sanitizeSvg } from './sanitize.js';

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40">${body}</svg>`;

describe('logo sanitation', () => {
  it.each([
    '<script>alert(1)</script>',
    '<g onload="alert(1)"><path d="M0 0"/></g>',
    '<foreignObject><div>content</div></foreignObject>',
    '<image href="https://example.invalid/image.png"/>',
    '<use href="//example.invalid/logo.svg#x"/>',
    '<image href="data:image/svg+xml;base64,PHN2Zz4="/>',
    '<image href="data:text/html;base64,PHN2Zz4="/>',
    '<path fill="url(https://example.invalid/x)"/>',
    '<path style="fill:u\\72l(https://example.invalid/x)"/>',
    '<path style="fill:var(--outside)"/>',
    '<style>body { display: none }</style>',
    '<animate attributeName="href" to="https://example.invalid"/>',
    '<set attributeName="href" to="https://example.invalid"/>',
    '<a href="javascript:alert(1)"><path d="M0 0"/></a>',
    '<g xmlns="http://www.w3.org/1999/xhtml"><script/></g>',
    '<use href="&#x6a;avascript:alert(1)"/>',
    '<path style="fill:red;behavior:url(x)"/>',
    '<path xml:base="https://example.invalid"/>',
    '<image href="data:image/png;base64,AAAA"/>',
  ])('refuses active or unsafe markup %s', async (body) => {
    await expect(sanitizeSvg(svg(body))).rejects.toMatchObject({ code: 'validation_failed' });
  });
  it('refuses entity declarations, processing instructions, malformed XML, oversized files, and excessive nesting', async () => {
    for (const source of [
      '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + svg('&x;'),
      '<?xml-stylesheet href="x"?>' + svg(''),
      '<svg>',
      ' ',
      '<?xml version="1.0"?>',
      svg('<g>'.repeat(45) + '</g>'.repeat(45)),
      svg(' '.repeat(LOGO_MAX_BYTES)),
    ])
      await expect(sanitizeSvg(source)).rejects.toMatchObject({ code: 'validation_failed' });
  });
  it('preserves ordinary drawing order, gradients, local references, inline styles, and text', async () => {
    const source = svg(
      '<defs><linearGradient id="ink"><stop offset="0" stop-color="#123456"/></linearGradient></defs><rect width="100" height="40" fill="url(#ink)"/><path id="mark" style="fill:#fff;transform-box:fill-box;transform-origin:center" d="M0 0 L10 10"/><text x="12" y="20">A &amp; B</text><use href="#mark"/>',
    );
    const result = await sanitizeSvg(source);
    expect(result).toContain('viewBox="0 0 100 40"');
    expect(result).toContain('fill="url(#ink)"');
    expect(result.indexOf('<rect')).toBeLessThan(result.indexOf('<path'));
    expect(result).toContain('A &amp; B');
    expect(result).toContain('transform-box:fill-box');
    expect(await sanitizeSvg(result)).toBe(result);
  });
  it('inlines safe drawing rules so stylesheet selectors cannot reach outside the image', async () => {
    const result = await sanitizeSvg(
      svg(
        '<style>.mark { fill:red } #mark { stroke:blue }</style><path id="mark" class="mark" style="fill:green" d="M0 0 L10 10"/>',
      ),
    );
    expect(result).not.toContain('<style');
    expect(result).not.toContain('class=');
    expect(result).toContain('style="fill:red;stroke:blue;fill:green"');
  });
  it('preserves the pixels of exported artwork with alpha masks and clipping paths', async () => {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="48" viewBox="0 0 120 48"><defs><clipPath id="bounds" clipPathUnits="objectBoundingBox"><rect width=".75" height="1"/></clipPath><mask id="ink" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width="120" height="48" style="mask-type:alpha"><rect width="120" height="48" fill="black"/></mask></defs><rect width="120" height="48" fill="#247abc" style="clip-path:url(#bounds);mask:url(#ink)"/></svg>';
    const result = await sanitizeSvg(source);
    const originalPixels = await sharp(Buffer.from(source)).ensureAlpha().raw().toBuffer();
    const sanitizedPixels = await sharp(Buffer.from(result)).ensureAlpha().raw().toBuffer();
    expect(originalPixels.some((value) => value !== 0)).toBe(true);
    expect(sanitizedPixels).toEqual(originalPixels);
    expect(result).toContain('mask-type:alpha');
    expect(result).toContain('clipPathUnits="objectBoundingBox"');
  });
  it('preserves ordinary exported artwork while dropping editor metadata and annotations', async () => {
    const result = await sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:editor="urn:editor" version="1.1" viewBox="0 0 100 40" editor:document="logo"><metadata><editor:description>Exported drawing</editor:description><script/></metadata><text x="10" y="20" xml:space="preserve">A B</text><path id="mark" fill="#123456" d="M0 0 L10 10"/></svg>',
    );
    expect(result).not.toContain('metadata');
    expect(result).not.toContain('editor');
    expect(result).not.toContain('script');
    expect(result).toContain('xml:space="preserve"');
    expect(result).toContain('id="mark"');
    expect(await sanitizeSvg(result)).toBe(result);
  });
  it('decodes PNGs and embedded safe raster images before preserving them', async () => {
    const bytes = await sharp({ create: { width: 12, height: 8, channels: 4, background: '#123456' } })
      .png()
      .toBuffer();
    const data = bytes.toString('base64');
    const clean = await sanitizeLogo({ type: 'image/png', data });
    expect((await sharp(clean).metadata()).format).toBe('png');
    expect(
      await sanitizeSvg(svg(`<image width="12" height="8" href="data:image/png;base64,${data}"/>`)),
    ).toContain('data:image/png;base64,');
    await expect(
      sanitizeLogo({ type: 'image/png', data: Buffer.from('bad').toString('base64') }),
    ).rejects.toMatchObject({ messageKey: 'branding.raster' });
  });
});
