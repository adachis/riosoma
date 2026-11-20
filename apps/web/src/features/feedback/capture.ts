import { FEEDBACK_LIMITS } from '@riosoma/contracts';

/**
 * Screenshots for feedback, taken in the browser from the page itself, with no library.
 *
 * The page is copied element by element into a fresh tree: each element becomes a plain box
 * carrying the styles the browser computed for it, and nothing else of the original, so no
 * attribute, link, label, or hidden value comes along.  Anywhere a record's values can show, the
 * copy's text is replaced with `x`s and blurred: grid cells, record cards and every view's
 * records, comments, history, dashboards, inputs, and anything marked `data-private`.  Email
 * addresses are masked wherever they appear, and images, canvases, and video become plain boxes.
 * Only then is the copy drawn: serialized inside an SVG `foreignObject`, loaded as an image, and
 * painted onto a canvas, which writes the PNG.  The original page is never touched.
 *
 * The browser can't load fonts or images from inside that SVG, so the screenshot uses the
 * system's fonts.  A browser that won't let the canvas be read after drawing the SVG makes
 * `captureScreenshot` return null, and the dialog offers an upload instead.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/** Where a record's values can show: everything inside these is masked. */
export const REDACT_SELECTOR = [
  '[role="gridcell"]',
  '.rio-card-value',
  '.rio-record-card__header',
  '.rio-record-card__value',
  '.rio-record-card__editor',
  '.rio-record-card__long-text',
  '.rio-record-card__side',
  '.rio-kanban-card',
  '.rio-kanban-stack__header',
  '.rio-gallery-view-card',
  '.rio-list-view__record',
  '.rio-list-view__group-name',
  '.rio-calendar-view__chip',
  '.rio-calendar-view__event',
  '.rio-map-view-list__record',
  '.rio-map-view-card',
  '.rio-timeline-bar',
  '.rio-timeline-chart__cell',
  '.rio-gantt__label',
  '.rio-pivot__value',
  '.rio-chart-view__cell',
  '.rio-dashboard-number__value',
  '.rio-dashboard-records__item',
  '.rio-interface-table__cell',
  '.rio-interface-record',
  '.rio-synced-preview__cell',
  '.rio-shared-view__record',
  '.rio-comments__body',
  '.rio-comments__text',
  '.rio-history__before',
  '.rio-history__after',
  '.rio-history__summary',
  '.rio-dedupe-values',
  '.rio-dedupe-row',
  '.rio-dedupe-group__name',
  '.rio-rich-text__body',
  '.rio-assistant__message',
  '.rio-assistant__records',
  '.rio-notifications__detail',
  '.rio-toast',
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[data-private]',
].join(', ');

/** What's left out entirely: the feedback dialog itself, and what never draws. */
export const SKIP_SELECTOR = [
  '[data-feedback-skip]',
  '.rio-feedback-overlay',
  'script',
  'style',
  'noscript',
  'template',
  'link',
  'meta',
  'title',
  'desc',
].join(', ');

/** Boxes that show pictures, which could be anyone's photo or attachment, drawn as plain boxes. */
const PICTURES = new Set(['IMG', 'PICTURE', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED']);
const CONTROLS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * The computed styles a copy keeps.  Inherited ones are kept only where they differ from the
 * parent's, and the rest only where they differ from their initial value, which keeps the copy
 * small enough to draw quickly.
 */
const INHERITED = [
  'color',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-transform',
  'white-space',
  'word-break',
  'overflow-wrap',
  'visibility',
  'direction',
  'list-style-type',
  'fill',
  'stroke',
  'stroke-width',
  'cursor',
] as const;

const OWN: Record<string, string> = {
  position: 'static',
  top: 'auto',
  right: 'auto',
  bottom: 'auto',
  left: 'auto',
  'z-index': 'auto',
  width: 'auto',
  height: 'auto',
  'min-width': '0px',
  'min-height': '0px',
  'max-width': 'none',
  'max-height': 'none',
  'box-sizing': 'content-box',
  'margin-top': '0px',
  'margin-right': '0px',
  'margin-bottom': '0px',
  'margin-left': '0px',
  'padding-top': '0px',
  'padding-right': '0px',
  'padding-bottom': '0px',
  'padding-left': '0px',
  'border-top-width': '0px',
  'border-right-width': '0px',
  'border-bottom-width': '0px',
  'border-left-width': '0px',
  'border-top-style': 'none',
  'border-right-style': 'none',
  'border-bottom-style': 'none',
  'border-left-style': 'none',
  'border-top-color': '',
  'border-right-color': '',
  'border-bottom-color': '',
  'border-left-color': '',
  'border-top-left-radius': '0px',
  'border-top-right-radius': '0px',
  'border-bottom-right-radius': '0px',
  'border-bottom-left-radius': '0px',
  'background-color': 'rgba(0, 0, 0, 0)',
  'background-image': 'none',
  'box-shadow': 'none',
  outline: '',
  opacity: '1',
  overflow: 'visible',
  'overflow-x': 'visible',
  'overflow-y': 'visible',
  'text-overflow': 'clip',
  'text-decoration-line': 'none',
  'vertical-align': 'baseline',
  transform: 'none',
  'transform-origin': '',
  translate: 'none',
  scale: 'none',
  rotate: 'none',
  'flex-direction': 'row',
  'flex-wrap': 'nowrap',
  'flex-grow': '0',
  'flex-shrink': '1',
  'flex-basis': 'auto',
  'align-items': 'normal',
  'align-self': 'auto',
  'align-content': 'normal',
  'justify-content': 'normal',
  'justify-items': 'normal',
  'justify-self': 'auto',
  order: '0',
  'row-gap': 'normal',
  'column-gap': 'normal',
  'grid-template-columns': 'none',
  'grid-template-rows': 'none',
  'grid-auto-flow': 'row',
  'grid-auto-columns': 'auto',
  'grid-auto-rows': 'auto',
  'grid-column-start': 'auto',
  'grid-column-end': 'auto',
  'grid-row-start': 'auto',
  'grid-row-end': 'auto',
  'border-collapse': 'separate',
  'table-layout': 'auto',
  'clip-path': 'none',
  'object-fit': 'fill',
  'aspect-ratio': 'auto',
};

/** An email address anywhere in text. */
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;

/** Text as the screenshot shows it where it's masked: the same shape, none of the letters. */
export function mask(text: string): string {
  return text.replace(/\S/gu, 'x');
}

/** The style a masked run of text wears, so it reads as blurred rather than as a row of x's. */
const BLUR = 'filter: blur(4px); color: currentColor; opacity: 0.7;';

interface CopyState {
  document: Document;
  view: Window;
  /** The theme's sunken surface, which a picture's stand-in is filled with */
  placeholder: string;
}

/** The most of a control's value a masked box shows the shape of */
const MASKED_VALUE = 200;

function styleText(computed: CSSStyleDeclaration, parent: CSSStyleDeclaration | null): string {
  const parts = [`display: ${computed.getPropertyValue('display') || 'block'}`];
  for (const name of INHERITED) {
    const value = computed.getPropertyValue(name);
    if (value && (!parent || parent.getPropertyValue(name) !== value)) parts.push(`${name}: ${value}`);
  }
  for (const [name, initial] of Object.entries(OWN)) {
    const value = computed.getPropertyValue(name);
    if (!value || value === initial) continue;
    // A picture a style points at could be anyone's, and couldn't load inside the copy anyway.
    if (name === 'background-image' && /url\(/i.test(value)) continue;
    parts.push(`${name}: ${value}`);
  }
  return parts.join('; ');
}

/** A plain box the size and look of the original, standing in for a picture or a control. */
function stand(
  element: Element,
  computed: CSSStyleDeclaration,
  parent: CSSStyleDeclaration | null,
  state: CopyState,
  text = '',
): Element {
  const box = state.document.createElementNS(XHTML_NS, 'div');
  const rect = element.getBoundingClientRect();
  const picture = PICTURES.has(element.tagName) ? `; background-color: ${state.placeholder}` : '';
  box.setAttribute(
    'style',
    `${styleText(computed, parent)}; width: ${rect.width}px; height: ${rect.height}px; overflow: hidden; background-image: none${picture}`,
  );
  if (text) {
    const run = state.document.createElementNS(XHTML_NS, 'span');
    run.setAttribute('style', BLUR);
    run.textContent = mask(Array.from(text).slice(0, MASKED_VALUE).join(''));
    box.appendChild(run);
  }
  return box;
}

/** A text node's copy: masked in a masked place, and with any address masked everywhere else. */
function copyText(text: string, masked: boolean, state: CopyState, svg: boolean): Node {
  if (!text.trim()) return state.document.createTextNode(text);
  // Text drawn inside an SVG is usually a chart's labels and values, and a span wouldn't draw
  // there, so it's always masked in place.
  if (svg) return state.document.createTextNode(mask(text));
  if (masked) {
    const run = state.document.createElementNS(XHTML_NS, 'span');
    run.setAttribute('style', BLUR);
    run.textContent = mask(text);
    return run;
  }
  EMAIL.lastIndex = 0;
  const addresses = [...text.matchAll(EMAIL)];
  if (!addresses.length) return state.document.createTextNode(text);
  const fragment = state.document.createDocumentFragment();
  let at = 0;
  for (const match of addresses) {
    fragment.appendChild(state.document.createTextNode(text.slice(at, match.index)));
    const run = state.document.createElementNS(XHTML_NS, 'span');
    run.setAttribute('style', BLUR);
    run.textContent = mask(match[0]);
    fragment.appendChild(run);
    at = match.index + match[0].length;
  }
  fragment.appendChild(state.document.createTextNode(text.slice(at)));
  return fragment;
}

/** SVG attributes that draw: kept on icons, so they look the same.  Nothing that names or links. */
function keepsSvgAttribute(name: string): boolean {
  return !/^(on|aria-|data-|role$|title$|href$|xlink:href$|id$|class$|tabindex$|focusable$)/i.test(name);
}

function copyElement(
  element: Element,
  parent: CSSStyleDeclaration | null,
  masked: boolean,
  state: CopyState,
  scrolled: { x: number; y: number } | null,
): Node | null {
  if (element.matches(SKIP_SELECTOR)) return null;
  const computed = state.view.getComputedStyle(element);
  if (computed.getPropertyValue('display') === 'none') return null;
  const inside = masked || element.matches(REDACT_SELECTOR);
  if (PICTURES.has(element.tagName)) return stand(element, computed, parent, state);
  if (CONTROLS.has(element.tagName)) {
    const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const value =
      control.tagName === 'SELECT'
        ? ((control as HTMLSelectElement).selectedOptions[0]?.text ?? '')
        : control.tagName === 'INPUT' &&
            ['checkbox', 'radio', 'range', 'color', 'file', 'hidden'].includes(
              (control as HTMLInputElement).type,
            )
          ? ''
          : (control.value ?? '');
    return stand(element, computed, parent, state, value);
  }
  if (element.tagName === 'BR' || element.tagName === 'WBR')
    return state.document.createElementNS(XHTML_NS, element.localName);
  const svg = element.namespaceURI === SVG_NS;
  const copy = svg
    ? state.document.createElementNS(SVG_NS, element.localName)
    : state.document.createElementNS(XHTML_NS, 'div');
  if (svg) {
    for (const attribute of Array.from(element.attributes))
      if (keepsSvgAttribute(attribute.name)) copy.setAttribute(attribute.name, attribute.value);
    // The outermost SVG takes its size from the page's styles, which the copy has to carry.
    if (element.localName === 'svg') {
      const rect = element.getBoundingClientRect();
      copy.setAttribute('width', String(rect.width));
      copy.setAttribute('height', String(rect.height));
      copy.setAttribute('style', styleText(computed, parent));
    }
  } else {
    let style = styleText(computed, parent);
    if (inside && !masked) style += '; background-image: none';
    // A scrolled box is copied at the top, so its children move by as much as it had scrolled.
    const sticky = computed.getPropertyValue('position') === 'sticky';
    if (scrolled && !sticky) style += `; translate: ${-scrolled.x}px ${-scrolled.y}px`;
    copy.setAttribute('style', style);
  }
  const own =
    !svg && (element.scrollTop || element.scrollLeft)
      ? { x: element.scrollLeft, y: element.scrollTop }
      : null;
  for (const child of Array.from(element.childNodes)) {
    let made: Node | null = null;
    if (child.nodeType === 3) made = copyText(child.textContent ?? '', inside, state, svg);
    else if (child.nodeType === 1) made = copyElement(child as Element, computed, inside, state, own);
    if (made) copy.appendChild(made);
  }
  return copy;
}

export interface Snapshot {
  /** The masked copy of the page, as SVG, ready to be drawn */
  markup: string;
  width: number;
  height: number;
}

/**
 * The masked copy of what's on screen, as SVG markup.  This is everything that's drawn, so it's
 * everything the screenshot can show.
 */
export function redactedSnapshot(root: Element = document.body): Snapshot {
  const doc = root.ownerDocument;
  const view = doc.defaultView ?? window;
  const width = Math.max(1, Math.round(view.innerWidth || root.clientWidth || 1));
  const height = Math.max(1, Math.round(view.innerHeight || root.clientHeight || 1));
  const page = view.getComputedStyle(doc.documentElement);
  // The copy can't read the theme's variables, so the two it needs are read here.
  const token = (name: string) => page.getPropertyValue(name).trim();
  const state: CopyState = {
    document: doc,
    view,
    placeholder: token('--rio-surface-sunken') || token('--rio-border') || 'transparent',
  };
  const frame = doc.createElementNS(XHTML_NS, 'div');
  frame.setAttribute(
    'style',
    [
      `width: ${width}px`,
      `height: ${height}px`,
      'overflow: hidden',
      'position: relative',
      `background-color: ${token('--rio-bg') || page.getPropertyValue('background-color')}`,
      `color: ${page.getPropertyValue('color')}`,
      `font-family: ${page.getPropertyValue('font-family')}`,
      `font-size: ${page.getPropertyValue('font-size')}`,
    ].join('; '),
  );
  const body = copyElement(root, page, false, state, null);
  if (body) frame.appendChild(body);
  const xhtml = new XMLSerializer().serializeToString(frame);
  const markup =
    `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  return { markup, width, height };
}

function load(markup: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The page copy could not be drawn'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  });
}

/** Bytes a data URL decodes to. */
export function dataUrlBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * A masked screenshot of the page as a PNG data URL, or JPEG when a PNG would be over 2 MB, or
 * null when this browser won't allow it.
 */
export async function captureScreenshot(root: Element = document.body): Promise<string | null> {
  try {
    const snapshot = redactedSnapshot(root);
    const image = await load(snapshot.markup);
    for (const scale of [1, 0.75, 0.5]) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(snapshot.width * scale);
      canvas.height = Math.round(snapshot.height * scale);
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const png = canvas.toDataURL('image/png');
      if (png.startsWith('data:image/png') && dataUrlBytes(png) <= FEEDBACK_LIMITS.screenshotBytes)
        return png;
      const jpeg = canvas.toDataURL('image/jpeg', 0.85);
      if (jpeg.startsWith('data:image/jpeg') && dataUrlBytes(jpeg) <= FEEDBACK_LIMITS.screenshotBytes)
        return jpeg;
    }
    return null;
  } catch {
    // Most often a canvas the browser won't let be read after drawing the copy.
    return null;
  }
}

/** Reads an image someone chose as a data URL, or null when it isn't one or is over 2 MB. */
export function readImage(file: File): Promise<string | null> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return Promise.resolve(null);
  if (file.size > FEEDBACK_LIMITS.screenshotBytes) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}
