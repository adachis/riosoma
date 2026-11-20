import { parseDomFromString } from '@node-saml/node-saml/lib/xml.js';
import sharp from 'sharp';
import { AppError, LOGO_MAX_BYTES, type LogoUpload } from '@riosoma/contracts';

const elements = new Set(
  'svg g defs path rect circle ellipse line polyline polygon text tspan title desc linearGradient radialGradient stop clipPath mask pattern image use symbol'.split(
    ' ',
  ),
);
const attributes = new Set(
  'id viewBox width height x y x1 y1 x2 y2 cx cy r rx ry fx fy fr d points pathLength transform color fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-opacity stroke-dasharray stroke-dashoffset opacity clip-path clip-rule clipPathUnits mask mask-type maskUnits maskContentUnits preserveAspectRatio gradientUnits gradientTransform spreadMethod offset stop-color stop-opacity patternUnits patternContentUnits patternTransform font-family font-size font-weight text-anchor dominant-baseline vector-effect'.split(
    ' ',
  ),
);
const properties = new Set(
  'color fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-opacity stroke-dasharray stroke-dashoffset opacity clip-path clip-rule mask mask-type stop-color stop-opacity font-family font-size font-weight text-anchor dominant-baseline vector-effect transform transform-box transform-origin'.split(
    ' ',
  ),
);
const escape = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const refuse = (key: string): never => {
  throw new AppError('validation_failed', `branding.${key}`);
};

function safeValue(value: string): string {
  // A deliberately small CSS grammar prevents escaped URLs, imports, and custom-property indirection.
  if (
    /[\\@<>]/.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    /(?:https?:|data:|javascript:|expression|var\s*\()/i.test(value)
  )
    refuse('references');
  const remainder = value.replace(/url\(\s*['"]?#[a-zA-Z_][\w.-]*['"]?\s*\)/g, '');
  if (/url\s*\(/i.test(remainder)) refuse('references');
  return value;
}

async function raster(bytes: Buffer, type: 'png' | 'jpeg' | 'webp'): Promise<Buffer> {
  try {
    const image = sharp(bytes, { limitInputPixels: 16_777_216, animated: false });
    const info = await image.metadata();
    if (info.format !== type || !info.width || !info.height || (info.pages ?? 1) > 1) refuse('raster');
    return await image.png().toBuffer();
  } catch {
    return refuse('raster');
  }
}

function drawingStyle(value: string): string {
  return value
    .split(';')
    .filter((item) => item.trim())
    .map((item) => {
      const split = item.indexOf(':');
      const property = item.slice(0, split).trim();
      if (split < 0 || !properties.has(property)) return refuse('style');
      return `${property}:${safeValue(item.slice(split + 1).trim())}`;
    })
    .join(';');
}

/** Serializing a whitelist from parsed XML preserves drawing order without retaining active markup. */
export async function sanitizeSvg(source: string): Promise<string> {
  if (Buffer.byteLength(source) > LOGO_MAX_BYTES) refuse('size');
  if (/<!DOCTYPE|<!ENTITY|<\?(?!xml\s)/i.test(source)) refuse('xml');
  let doc: Awaited<ReturnType<typeof parseDomFromString>>;
  try {
    doc = await parseDomFromString(source);
  } catch {
    return refuse('xml');
  }
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg') refuse('xml');
  const rules: { selector: string; declarations: string; rank: number }[] = [];
  const sheets = root.getElementsByTagName('style');
  while (sheets.length) {
    const sheet = sheets.item(0)!;
    if (
      sheet.namespaceURI !== root.namespaceURI ||
      sheet.attributes.length > 1 ||
      (sheet.attributes.length === 1 && sheet.getAttribute('type') !== 'text/css')
    )
      refuse('style');
    const css: string = (sheet.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    const pattern = /([^{}]+)\{([^{}]*)\}/g;
    let consumed = 0;
    for (const match of css.matchAll(pattern)) {
      if (css.slice(consumed, match.index).trim()) refuse('style');
      for (const selector of match[1]!.split(',').map((selector) => selector.trim())) {
        if (
          !/^(?:\.[\w-]+|#[\w-]+|[a-zA-Z][\w-]*)$/.test(selector) ||
          (!selector.startsWith('.') && !selector.startsWith('#') && !elements.has(selector))
        )
          refuse('style');
        if (rules.length >= 500) refuse('complex');
        rules.push({
          selector,
          declarations: drawingStyle(match[2]!),
          rank: selector.startsWith('#') ? 2 : selector.startsWith('.') ? 1 : 0,
        });
      }
      consumed = match.index + match[0].length;
    }
    if (css.slice(consumed).trim()) refuse('style');
    sheet.parentNode!.removeChild(sheet);
  }
  rules.sort((left, right) => left.rank - right.rank);
  let count = 0;
  const render = async (node: typeof root, depth: number): Promise<string> => {
    if (++count > 4000 || depth > 40) refuse('complex');
    const tag = node.localName;
    if (tag === 'metadata' && node.namespaceURI === root.namespaceURI) return '';
    if (node.namespaceURI !== root.namespaceURI || !elements.has(tag)) refuse('elements');
    const attrs: string[] = tag === 'svg' ? ['xmlns="http://www.w3.org/2000/svg"'] : [];
    for (let i = 0; i < node.attributes.length; i++) {
      const attr = node.attributes.item(i)!;
      const name = attr.name;
      const value: string = attr.value;
      if (name === 'xmlns' || name.startsWith('xmlns:') || (tag === 'svg' && name === 'version')) continue;
      if (/^on/i.test(name)) refuse('events');
      if (name === 'xml:base') refuse('references');
      if (name === 'xml:space' && ['default', 'preserve'].includes(value)) {
        attrs.push(`xml:space="${value}"`);
      } else if (attr.prefix && !['xml', 'xlink'].includes(attr.prefix)) {
        // Editor annotations carry no drawing instructions and do not survive serialization.
        continue;
      } else if (name === 'style') {
        attrs.push(`style="${escape(drawingStyle(value))}"`);
      } else if (name === 'href' || name === 'xlink:href') {
        if (/^#[a-zA-Z_][\w.-]*$/.test(value)) attrs.push(`href="${escape(value)}"`);
        else if (tag === 'image') {
          const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(value);
          if (!match) return refuse('references');
          const bytes = await raster(Buffer.from(match[2]!, 'base64'), match[1] as 'png' | 'jpeg' | 'webp');
          if (bytes.length > LOGO_MAX_BYTES) refuse('size');
          attrs.push(`href="data:image/png;base64,${bytes.toString('base64')}"`);
        } else refuse('references');
      } else if (attributes.has(name) && !attr.prefix) attrs.push(`${name}="${escape(safeValue(value))}"`);
      else if (name.startsWith('aria-') || name === 'role' || name === 'class') continue;
      else refuse('attributes');
    }
    const declarations = rules
      .filter((rule) =>
        rule.selector.startsWith('#')
          ? node.getAttribute('id') === rule.selector.slice(1)
          : rule.selector.startsWith('.')
            ? (node.getAttribute('class') ?? '').split(/\s+/).includes(rule.selector.slice(1))
            : tag === rule.selector,
      )
      .map((rule) => rule.declarations);
    if (declarations.length) {
      const own = node.getAttribute('style');
      const combined = [...declarations, ...(own ? [drawingStyle(own)] : [])].join(';');
      const existing = attrs.findIndex((attr) => attr.startsWith('style='));
      if (existing >= 0) attrs.splice(existing, 1);
      attrs.push(`style="${escape(combined)}"`);
    }
    const children: string[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) children.push(await render(child as typeof root, depth + 1));
      else if (child.nodeType === 3 || child.nodeType === 4) children.push(escape(child.nodeValue ?? ''));
      else if (child.nodeType !== 8) refuse('xml');
    }
    return `<${tag} ${attrs.join(' ')}>${children.join('')}</${tag}>`;
  };
  const result = await render(root, 0);
  if (Buffer.byteLength(result) > LOGO_MAX_BYTES) refuse('size');
  return result;
}

export async function sanitizeLogo(upload: LogoUpload): Promise<Buffer> {
  const bytes = Buffer.from(upload.data, 'base64');
  if (!bytes.length || bytes.length > LOGO_MAX_BYTES) refuse('size');
  const sanitized =
    upload.type === 'image/png'
      ? await raster(bytes, 'png')
      : Buffer.from(await sanitizeSvg(bytes.toString('utf8')));
  if (sanitized.length > LOGO_MAX_BYTES) refuse('size');
  return sanitized;
}
