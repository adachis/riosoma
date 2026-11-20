import { installTrustedTypesBoundaries } from './trusted-types-runtime';
import { trustedScriptURL } from './trusted-script-url';
import { parse, parseFragment, serialize, type DefaultTreeAdapterTypes } from 'parse5';
import DOMPurify, { type Config } from 'dompurify';

type Policy = NonNullable<Config['TRUSTED_TYPES_POLICY']>;
interface Factory {
  createPolicy(
    name: string,
    rules: Partial<{
      createHTML(input: string, mode?: 'document'): string;
      createScriptURL(input: string): string;
    }>,
  ): Policy;
  isHTML(value: unknown): boolean;
}
interface Policies {
  html: Policy;
}

export { trustedScriptURL };

const key = Symbol.for('rio.trusted-types');
const sanitizeOptions: Config = { ADD_ATTR: ['focusable'], RETURN_TRUSTED_TYPE: false };
DOMPurify.addHook('uponSanitizeAttribute', (node, attribute) => {
  if (
    node.nodeName.toLowerCase() === 'meta' &&
    attribute.attrName === 'http-equiv' &&
    attribute.attrValue.toLowerCase() !== 'content-security-policy'
  )
    attribute.keepAttr = false;
});

function sanitize(source: string, wholeDocument = false, parser?: Policy): string {
  // Strip executable attributes with an inert tokenizer before the browser sees them.  Chromium
  // reports CSP violations even for event attributes parsed into a detached document.
  const tree = wholeDocument ? parse(source) : parseFragment(source);
  const pending: DefaultTreeAdapterTypes.Node[] = [tree];
  while (pending.length) {
    const node = pending.pop()!;
    if ('attrs' in node)
      node.attrs = node.attrs.filter(
        (attribute) =>
          !/^on/i.test(attribute.name) && !['srcdoc', 'style'].includes(attribute.name.toLowerCase()),
      );
    if ('childNodes' in node) for (const child of node.childNodes) pending.push(child);
    if ('content' in node) pending.push(node.content);
  }
  const clean = DOMPurify.sanitize(serialize(tree).replace(/\r/g, '&#13;'), {
    ...sanitizeOptions,
    ...(wholeDocument
      ? {
          WHOLE_DOCUMENT: true,
          ADD_TAGS: ['link', 'meta'],
          ADD_ATTR: ['focusable', 'http-equiv', 'content', 'charset'],
        }
      : {}),
    ...(parser ? { TRUSTED_TYPES_POLICY: parser } : {}),
  }) as string;
  // Preserve encoded carriage returns across both HTML parsers, including spreadsheet cells.
  return clean.replace(/\r/g, '&#13;');
}

function factory(): Factory | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window as Window & { trustedTypes?: Factory }).trustedTypes;
}

function policies(tt: Factory): Policies {
  const cached = Reflect.get(window, key) as Policies | undefined;
  if (cached) return cached;
  // Only DOMPurify receives the parser capability.  It never leaves this module.
  const parser = tt.createPolicy('rio-sanitizer', {
    createHTML: (input) => input,
    createScriptURL: () => {
      throw new TypeError('The sanitizer cannot load scripts');
    },
  });
  const value = {
    html: tt.createPolicy('rio-html', {
      createHTML: (input, mode) => sanitize(input, mode === 'document', parser),
    }),
  };
  Object.defineProperty(window, key, { value });
  return value;
}

/** The cast preserves the browser's opaque value through DOM and React's string-only declarations. */
export function trustedHTML(input: unknown): string {
  const tt = factory();
  if (tt?.isHTML(input)) return input as string;
  const source = input == null ? '' : String(input);
  if (tt) return policies(tt).html.createHTML(source) as unknown as string;
  return sanitize(source);
}

/** Sandboxed site previews retain their complete document, CSP metadata, and stylesheet links. */
export function trustedDocument(source: string): string {
  const tt = factory();
  return tt
    ? (policies(tt).html.createHTML(source, 'document') as unknown as string)
    : sanitize(source, true);
}

/** Preserve ordinary attributes while protecting React's generic DOM attribute boundary. */
export function trustedAttribute(element: Element, name: string, value: string): string {
  const attribute = name.toLowerCase();
  if (attribute === 'srcdoc') return trustedDocument(value);
  if (element.nodeName.toLowerCase() === 'script') {
    if (attribute === 'src') return trustedScriptURL(value);
    if (attribute === 'text') throw new TypeError('Executable script text is disabled');
  }
  return value;
}

/** Adapt generic dependency dispatch without changing an element's methods or prototypes. */
export function setTrustedAttribute(element: Element, name: string, value: string): void {
  element.setAttribute(name, trustedAttribute(element, name, value));
}

installTrustedTypesBoundaries({ html: trustedHTML, attribute: trustedAttribute });
