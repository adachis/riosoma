import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

interface Node {
  type: string;
  start: number;
  end: number;
  name?: string;
  value?: unknown;
  object?: Node;
  init?: Node;
  operator?: string;
  computed?: boolean;
  property?: Node;
  left?: Node;
  right?: Node;
  id?: Node;
  callee?: Node;
  arguments?: Node[];
  [key: string]: unknown;
}

const dependencies = [
  '@tiptap/core',
  'prosemirror-view',
  'prosemirror-model',
  '@tiptap/react',
  '@tiptap/extension-list',
  'maplibre-gl',
  'echarts',
  'zrender',
  '@react-aria/live-announcer',
  'react-aria',
  'react-dom',
  '@tanstack/router-core',
  '@tanstack/query-core',
  '@dnd-kit/core',
  '@dnd-kit/utilities',
  'pdfmake',
  'zod',
];
const callbackModule = fileURLToPath(new URL('../src/security/function-callback.ts', import.meta.url));
const runtimeModule = fileURLToPath(new URL('../src/security/trusted-types-runtime.ts', import.meta.url));
const policyModule = fileURLToPath(new URL('../src/security/trusted-types.ts', import.meta.url));

/** The adapter is scoped to explicitly adapted dependencies and operates on syntax, including minified bundles. */
export function adaptTrustedTypes(source: string, id: string, parse: (input: string) => unknown) {
  if (!dependencies.some((name) => id.includes(`/node_modules/${name}/`)) || !/\.[mc]?js$/.test(id)) return;
  let callbacks = false;
  const helpers = new Set<string>();
  const edits: { start: number; end: number; text: string }[] = [];
  const wrap = (node: Node | undefined, helper: string) => {
    if (!node) return;
    helpers.add(helper);
    edits.push(
      { start: node.start, end: node.start, text: `${helper}(` },
      { start: node.end, end: node.end, text: ')' },
    );
  };
  const member = (node: Node | undefined, name: string) =>
    node?.type === 'MemberExpression' && !node.computed && node.property?.name === name;
  const functionAliases = new Set(['Function']);
  const findAliases = (node: Node) => {
    if (
      node.type === 'VariableDeclarator' &&
      node.id?.name &&
      node.init?.name &&
      functionAliases.has(node.init.name)
    )
      functionAliases.add(node.id.name);
    for (const value of Object.values(node)) {
      if (Array.isArray(value))
        for (const child of value) {
          if (child && typeof child === 'object' && 'type' in child) findAliases(child as Node);
        }
      else if (value && typeof value === 'object' && 'type' in value) findAliases(value as Node);
    }
  };
  const tree = parse(source) as Node;
  findAliases(tree);
  const walk = (node: Node) => {
    if (
      (node.type === 'CallExpression' || node.type === 'NewExpression') &&
      functionAliases.has(node.callee?.name ?? '') &&
      /\/node_modules\/(?:pdfmake|zod)\//.test(id)
    ) {
      // Modern engines provide globalThis and native bind.  Legacy global lookup stays equivalent,
      // and optional code generation fails closed rather than acquiring a script capability.
      const globalLookup =
        node.arguments?.length === 1 && /^return this;?$/.test(String(node.arguments[0]?.value));
      edits.push({
        start: node.start,
        end: node.end,
        text: globalLookup
          ? '(() => globalThis)'
          : '(() => { throw new TypeError("Dynamic code generation is disabled"); })()',
      });
      return;
    }
    if (
      node.type === 'CallExpression' &&
      ['setTimeout', 'setInterval'].includes(node.callee?.name ?? node.callee?.property?.name ?? '')
    ) {
      if (!['ArrowFunctionExpression', 'FunctionExpression'].includes(node.arguments?.[0]?.type ?? '')) {
        wrap(node.arguments?.[0], '__rioCallback');
        callbacks = true;
      }
    }
    if (
      node.type === 'CallExpression' &&
      member(node.callee, 'setAttribute') &&
      node.arguments?.length === 2
    ) {
      const [name, value] = node.arguments;
      const element = node.callee?.object;
      const literalName =
        name?.value ??
        (name?.type === 'TemplateLiteral' && !(name.expressions as Node[]).length
          ? ((name.quasis as Node[])[0]?.value as { cooked?: string })?.cooked
          : undefined);
      if (
        element &&
        name &&
        value &&
        (typeof literalName !== 'string' || ['src', 'text', 'srcdoc'].includes(literalName.toLowerCase()))
      ) {
        helpers.add('__rioSetAttribute');
        edits.push(
          { start: node.callee!.start, end: node.callee!.end, text: '__rioSetAttribute' },
          { start: name.start, end: name.start, text: `${source.slice(element.start, element.end)}, ` },
        );
      }
    }
    if (
      node.type === 'CallExpression' &&
      id.includes('/node_modules/pdfmake/') &&
      ['activeXDocument', 'iframeDocument'].includes(node.callee?.object?.name ?? '') &&
      member(node.callee, 'write')
    ) {
      // Object.create's obsolete ActiveX and iframe polyfills are outside the supported engines.
      edits.push({
        start: node.start,
        end: node.end,
        text: '(() => { throw new TypeError("Legacy document polyfills are disabled"); })()',
      });
      return;
    }
    if (
      node.type === 'AssignmentExpression' &&
      id.includes('/node_modules/react-dom/') &&
      member(node.left, 'innerHTML') &&
      node.right?.value === '<script></script>'
    ) {
      // React's inert-script parser trick requires a script-producing policy.  App script elements
      // are unsupported, so reject that branch instead of creating an execution capability.
      edits.push({
        start: node.start,
        end: node.end,
        text: '(() => { throw new TypeError("React script elements are disabled"); })()',
      });
      return;
    }
    if (
      node.type === 'CallExpression' &&
      id.includes('/node_modules/maplibre-gl/') &&
      member(node.callee, 'eval')
    ) {
      // Remote classic worker plugins are unsupported.  Removing evaluation makes that boundary
      // safe even if a caller accidentally enables the optional loader later.
      edits.push({
        start: node.start,
        end: node.end,
        text: '(() => { throw new TypeError("Remote worker scripts are disabled"); })()',
      });
      return;
    }
    if (
      node.type === 'AssignmentExpression' &&
      node.operator === '=' &&
      (member(node.left, 'innerHTML') || member(node.left, 'outerHTML')) &&
      node.right?.value === ''
    ) {
      // Removing children or the element cannot parse or execute HTML.  Keep the assignment's
      // empty-string result for callers that use it as an expression.
      const element = node.left!.object!;
      const method = member(node.left, 'innerHTML') ? 'replaceChildren' : 'replaceWith';
      edits.push({
        start: node.start,
        end: node.end,
        text: `(${source.slice(element.start, element.end)}.${method}(), '')`,
      });
      return;
    }
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'maybeWrapTrusted') {
      // ProseMirror's own pass-through policy must never enter the browser bundle.
      edits.push({ start: node.start, end: node.end, text: '' });
      return;
    }
    if (node.type === 'CallExpression' && node.callee?.name === 'maybeWrapTrusted') {
      helpers.add('__rioHTML');
      edits.push({ start: node.callee.start, end: node.callee.end, text: '__rioHTML' });
    } else if (
      node.type === 'AssignmentExpression' &&
      (member(node.left, 'innerHTML') || member(node.left, 'outerHTML'))
    ) {
      if (node.right?.callee?.name !== 'maybeWrapTrusted') wrap(node.right, '__rioHTML');
    }
    if (node.type === 'CallExpression') {
      if (member(node.callee, 'parseFromString') || member(node.callee, 'createContextualFragment'))
        wrap(node.arguments?.[0], '__rioHTML');
      if (member(node.callee, 'insertAdjacentHTML')) wrap(node.arguments?.[1], '__rioHTML');
    }
    if (
      node.type === 'NewExpression' &&
      (node.callee?.name === 'Worker' || node.callee?.name === 'SharedWorker')
    )
      wrap(node.arguments?.[0], '__rioScriptURL');
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value)
          if (child && typeof child === 'object' && 'type' in child) walk(child as Node);
      } else if (value && typeof value === 'object' && 'type' in value) walk(value as Node);
    }
  };
  walk(tree);
  if (!edits.length) return;
  let code = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  const reactDOM = id.includes('/node_modules/react-dom/');
  const policyImports = [
    helpers.has('__rioHTML') ? `${reactDOM ? 'runtimeHTML' : 'trustedHTML'} as __rioHTML` : '',
    helpers.has('__rioScriptURL') ? 'trustedScriptURL as __rioScriptURL' : '',
    helpers.has('__rioSetAttribute')
      ? `${reactDOM ? 'setRuntimeAttribute' : 'setTrustedAttribute'} as __rioSetAttribute`
      : '',
  ].filter(Boolean);
  return {
    code: `${callbacks ? `import { functionCallback as __rioCallback } from ${JSON.stringify(callbackModule)};\n` : ''}${policyImports.length ? `import { ${policyImports.join(', ')} } from ${JSON.stringify(reactDOM ? runtimeModule : policyModule)};\n` : ''}${code}`,
    map: null,
  };
}

/** Adapt shipped sinks without changing browser prototypes or installing a default policy. */
export function trustedTypesDependencies(): Plugin {
  return {
    name: 'trusted-types-dependencies',
    enforce: 'pre',
    config: () => ({ optimizeDeps: { exclude: dependencies } }),
    transform(source, id) {
      return adaptTrustedTypes(source, id, (input) => this.parse(input));
    },
  };
}
