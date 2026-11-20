import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { safeConstructions } from './trusted-types-safe.ts';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const securityDirectory = fileURLToPath(new URL('../src/security/', import.meta.url));
const policyModule = resolvePath(securityDirectory, 'trusted-types.ts');
const runtimeModule = resolvePath(securityDirectory, 'trusted-types-runtime.ts');

interface Node {
  type: string;
  start: number;
  end: number;
  name?: string;
  value?: unknown;
  computed?: boolean;
  object?: Node;
  property?: Node;
  left?: Node;
  right?: Node;
  callee?: Node;
  arguments?: Node[];
  id?: Node;
  init?: Node;
  params?: Node[];
  [key: string]: unknown;
}

function children(node: Node): Node[] {
  return Object.values(node).flatMap((value) =>
    (Array.isArray(value) ? value : [value]).filter(
      (child): child is Node => !!child && typeof child === 'object' && 'type' in child,
    ),
  );
}

function literal(
  node: Node | undefined,
  resolve: (node: Node | undefined) => Node | undefined = (value) => value,
): unknown {
  node = resolve(node);
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    const left = literal(node.left, resolve);
    const right = literal(node.right, resolve);
    if (typeof left === 'string' && typeof right === 'string') return left + right;
  }
  if (node?.type === 'TemplateLiteral') {
    const expressions = node.expressions as Node[];
    const parts = node.quasis as Node[];
    let result = '';
    for (const [index, part] of parts.entries()) {
      result += (part.value as { cooked?: string })?.cooked ?? '';
      if (index < expressions.length) {
        const value = literal(expressions[index], resolve);
        if (typeof value !== 'string' && typeof value !== 'number') return;
        result += value;
      }
    }
    return result;
  }
  return node?.value;
}

function browserScript(path: string): boolean {
  // These two CJS copies are loaded by the server PDF renderer, not by browser documents.
  return /\.[mc]?js$/.test(path) && !/^pdf-renderer\/(?:pdfmake|vfs_fonts)\.cjs$/.test(path);
}

export interface Sink {
  sink: string;
  snippet: string;
}

/** Check transformed JavaScript, including bracket notation and empty HTML assignments. */
export function unadaptedSinks(source: string, id: string, parse: (source: string) => unknown): Sink[] {
  const tree = parse(source) as Node;
  const policyOwner = id === policyModule;
  const boundaryOwner = policyOwner || id === runtimeModule;
  const helpers = new WeakMap<Node, string>();
  interface Scope {
    parent?: Scope;
    bindings: Map<string, Node | undefined>;
    written: Set<string>;
    functionScope?: boolean;
  }
  const scopes = new WeakMap<Node, Scope>();
  const root: Scope = { bindings: new Map(), written: new Set() };
  const bind = (pattern: Node | undefined, scope: Scope, value?: Node) => {
    if (pattern?.type === 'Identifier') scope.bindings.set(pattern.name!, value);
    else if (pattern) for (const child of children(pattern)) bind(child, scope);
  };
  const declare = (node: Node, parent: Scope, parentNode?: Node) => {
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') bind(node.id, parent, node);
    const functionScope = /Function|ArrowFunction|Program/.test(node.type);
    const scoped =
      functionScope ||
      /^(?:BlockStatement|CatchClause|ForStatement|ForInStatement|ForOfStatement)$/.test(node.type);
    const scope: Scope = scoped ? { parent, bindings: new Map(), written: new Set(), functionScope } : parent;
    scopes.set(node, scope);
    if (node.params)
      for (const [index, param] of node.params.entries()) {
        // A native Promise executor receives callable resolve and reject arguments.
        const executor =
          parentNode?.type === 'NewExpression' && parentNode.callee?.name === 'Promise' && index < 2;
        bind(
          param,
          scope,
          executor
            ? { type: 'PromiseResolver', callee: parentNode?.callee, start: param.start, end: param.end }
            : undefined,
        );
      }
    if (node.type === 'CatchClause') bind(node.param as Node, scope);
    if (node.type === 'VariableDeclarator') {
      let target = scope;
      if (parentNode?.kind === 'var') while (!target.functionScope && target.parent) target = target.parent;
      bind(node.id, target, node.init);
    }
    if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier')
      bind(node.local as Node, scope, node);
    for (const child of children(node)) declare(child, scope, node);
  };
  declare(tree, root);
  const binding = (node: Node): { scope: Scope; value: Node | undefined } | undefined => {
    let scope = scopes.get(node);
    while (scope) {
      if (scope.bindings.has(node.name!)) return { scope, value: scope.bindings.get(node.name!) };
      scope = scope.parent;
    }
  };

  const walk = (node: Node, visit: (node: Node) => void) => {
    visit(node);
    for (const child of children(node)) walk(child, visit);
  };
  walk(tree, (node) => {
    if (boundaryOwner && node.type === 'FunctionDeclaration' && node.id?.name)
      helpers.set(node, node.id.name);
    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
      const markWritten = (target: Node | undefined) => {
        if (target?.type === 'Identifier') binding(target)?.scope.written.add(target.name!);
        else if (
          target &&
          [
            'ObjectPattern',
            'ArrayPattern',
            'AssignmentPattern',
            'RestElement',
            'Property',
            'ObjectProperty',
          ].includes(target.type)
        )
          for (const child of children(target)) markWritten(child);
      };
      markWritten((node.left ?? node.argument) as Node);
    }
    if (
      node.type === 'ImportDeclaration' &&
      ['trusted-types', 'trusted-types-runtime', 'trusted-script-url', 'function-callback'].some((name) => {
        const address = String((node.source as Node)?.value);
        const target = resolvePath(dirname(id), address).replace(/\.(?:ts|js)$/, '');
        return target === resolvePath(securityDirectory, name);
      })
    ) {
      for (const specifier of (node.specifiers as Node[]) ?? []) {
        const imported = (specifier.imported as Node)?.name;
        const local = (specifier.local as Node)?.name;
        if (imported && local) helpers.set(specifier, imported);
      }
    }
  });
  const resolve = (node: Node | undefined, seen = new Set<Node>()): Node | undefined => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.type === 'SequenceExpression') return resolve((node.expressions as Node[]).at(-1), seen);
    if (node.type === 'ChainExpression') return resolve(node.expression as Node, seen);
    if (node.type !== 'Identifier') return node;
    const bound = binding(node);
    if (!bound || bound.scope.written.has(node.name!)) return node;
    return resolve(bound.value, seen);
  };
  const property = (node: Node | undefined): string | undefined => {
    if (node?.type !== 'MemberExpression') return;
    const name = node.computed ? literal(node.property, resolve) : node.property?.name;
    return typeof name === 'string' ? name : undefined;
  };
  const callable = (node: Node | undefined): boolean => {
    const value = resolve(node);
    if (value?.type === 'PromiseResolver') return value.callee?.name === 'Promise' && !binding(value.callee);
    if (value?.type === 'CallExpression' && helpers.get(resolve(value.callee)!) === 'functionCallback')
      return true;
    return !!value && /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(value.type);
  };
  const nonScript = (node: Node | undefined): boolean => {
    const value = resolve(node);
    // These constructors and literal DOM tag names cannot produce HTMLScriptElement instances.
    // Unknown receivers remain candidates, so a dependency cannot hide a script behind a variable.
    if (value?.type === 'NewExpression' && value.callee?.name === 'Image' && !binding(value.callee))
      return true;
    if (value?.type === 'ObjectExpression') return true;
    if (
      value?.type === 'CallExpression' &&
      ['createElement', 'createElementNS'].includes(property(value.callee) ?? '')
    ) {
      const receiver = resolve(value.callee?.object);
      const nativeDocument =
        (receiver?.type === 'Identifier' && receiver.name === 'document' && !binding(receiver)) ||
        (property(receiver) === 'document' &&
          ['window', 'globalThis', 'self'].includes(receiver?.object?.name ?? '') &&
          !binding(receiver!.object!));
      const tag = literal(value.arguments?.[property(value.callee) === 'createElementNS' ? 1 : 0]);
      return !!nativeDocument && typeof tag === 'string' && tag.toLowerCase() !== 'script';
    }
    return false;
  };
  const trusted = (node: Node | undefined, kind: 'html' | 'url'): boolean => {
    node = resolve(node);
    if (node?.type !== 'CallExpression') return false;
    const name = helpers.get(resolve(node.callee)!);
    return kind === 'html'
      ? name === 'trustedHTML' || name === 'trustedDocument' || name === 'runtimeHTML'
      : name === 'trustedScriptURL';
  };
  const sinks: Sink[] = [];
  const check = (node: Node, sink: string, values: (Node | undefined)[], kind?: 'html' | 'url') => {
    if (kind && values.length && values.every((value) => trusted(value, kind))) return;
    sinks.push({ sink, snippet: source.slice(node.start, node.end).replace(/\s+/g, ' ').slice(0, 200) });
  };
  walk(tree, (node) => {
    // DOMPurify's parsing capability stays private.  A new consumer must use the policy helpers,
    // rather than invoking the library with an untyped parser or a default policy.
    const imported =
      (node.source as Node)?.value ??
      (node.type === 'CallExpression' && node.callee?.name === 'require'
        ? node.arguments?.[0]?.value
        : undefined);
    if (
      !policyOwner &&
      typeof imported === 'string' &&
      /(?:^|\/node_modules\/)dompurify(?:\/|$)/.test(imported)
    )
      check(node, 'private sanitizer import', []);
    if (node.type === 'AssignmentExpression') {
      const name = property(node.left);
      if (name && ['innerHTML', 'outerHTML', 'srcdoc'].includes(name))
        check(node, name, [node.right], node.operator === '=' ? 'html' : undefined);
      if (name === 'src' && !nonScript(node.left?.object))
        check(node, 'possible script.src', [node.right], 'url');
      if (name === 'text' && !nonScript(node.left?.object)) check(node, 'possible script.text', [node.right]);
    }
    const callee = node.callee;
    const name = property(resolve(callee)) ?? resolve(callee)?.name ?? property(callee) ?? callee?.name;
    const args = node.arguments ?? [];
    const invocation = property(resolve(callee));
    if (node.type === 'CallExpression' && ['call', 'apply'].includes(invocation ?? '')) {
      const target = resolve(resolve(callee)?.object);
      const operation = property(target) ?? target?.name;
      // Borrowed browser operations need an explicit direct boundary.  Do not infer trust from
      // an argument array or a caller-supplied receiver.
      if (
        [
          'eval',
          'Function',
          'importScripts',
          'setTimeout',
          'setInterval',
          'write',
          'writeln',
          'parseFromString',
          'createContextualFragment',
          'insertAdjacentHTML',
          'setAttribute',
        ].includes(operation ?? '')
      )
        check(node, `${operation}.${invocation}`, args);
    }
    if (node.type === 'NewExpression' && ['Worker', 'SharedWorker'].includes(name ?? ''))
      check(node, `new ${name}`, [args[0]], 'url');
    if (['CallExpression', 'NewExpression'].includes(node.type) && name === 'Function')
      check(node, 'Function', args);
    if (node.type !== 'CallExpression') return;
    if (helpers.get(resolve(callee)!) === 'installTrustedTypesBoundaries' && !policyOwner)
      check(node, 'policy boundary registration', args);
    if (['innerHTML', 'outerHTML', 'srcdoc'].includes(name ?? '')) return;
    if (['parseFromString', 'createContextualFragment'].includes(name ?? ''))
      check(node, name!, [args[0]], 'html');
    if (name === 'insertAdjacentHTML') check(node, name, [args[1]], 'html');
    if (['write', 'writeln'].includes(name ?? '')) check(node, `possible document.${name}`, args, 'html');
    if (name === 'setAttribute') {
      const attributeValue = literal(args[0], resolve);
      const attribute = String(attributeValue).toLowerCase();
      const value = args[1];
      const expression = (node: Node | undefined) => (node ? source.slice(node.start, node.end) : undefined);
      if (
        value?.type === 'CallExpression' &&
        value.arguments?.length === 3 &&
        ['trustedAttribute', 'runtimeAttribute'].includes(helpers.get(resolve(value.callee)!) ?? '') &&
        expression(value.arguments[0]) === expression(callee?.object) &&
        expression(value.arguments[1]) === expression(args[0])
      )
        return;
      if (attributeValue === undefined) check(node, 'dynamic setAttribute', [args[1]]);
      if (['src', 'text'].includes(attribute) && !nonScript(callee?.object))
        check(
          node,
          `possible script.setAttribute(${attribute})`,
          [args[1]],
          attribute === 'src' ? 'url' : undefined,
        );
      if (['srcdoc', 'innerhtml', 'outerhtml'].includes(attribute))
        check(node, `setAttribute(${attribute})`, [args[1]], 'html');
    }
    if (name === 'importScripts') check(node, name, args, 'url');
    if (name === 'eval') check(node, name, args);
    if (['setTimeout', 'setInterval'].includes(name ?? '')) {
      if (!callable(args[0])) check(node, `possible string ${name}`, [args[0]]);
    }
  });
  // A review locks the complete construction, not just a sink-shaped statement.  Any source
  // change invalidates it, and every other module and sink still fails closed.
  const canonical = source.replaceAll(securityDirectory, '<security>/');
  const digest = createHash('sha256').update(canonical).digest('hex');
  return sinks.filter(
    ({ sink }) =>
      !safeConstructions.some(
        (review) => id.endsWith(review.module) && digest === review.sha256 && review.sinks.includes(sink),
      ),
  );
}

/** Bundle membership is determined by the bundler, including lazy chunks and virtual modules. */
export function trustedTypesGuard(inspectedScripts = new Set<string>()): Plugin {
  const modules = new Map<string, string>();
  let output = '';
  let worker = false;
  let written = false;
  return {
    name: 'trusted-types-guard',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      output = resolvePath(config.root, config.build.outDir);
      worker = config.isWorker;
    },
    moduleParsed(module) {
      modules.set(module.id, module.code ?? '');
    },
    generateBundle(_options, bundle) {
      const shipped = new Set<string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk')
          for (const [id, rendered] of Object.entries(chunk.modules)) {
            shipped.add(id);
            // Bundler runtime helpers have no input module.  Inspect their emitted JavaScript.
            if (!modules.has(id) && rendered.code != null) modules.set(id, rendered.code);
          }
      }
      const failures: string[] = [];
      for (const id of shipped) {
        const source = modules.get(id) ?? this.getModuleInfo(id)?.code;
        if (source == null) this.error(`Cannot inspect shipped JavaScript module: ${id}`);
        if (!source) continue;
        for (const { sink, snippet } of unadaptedSinks(source, id, (input) => this.parse(input)))
          failures.push(`${id}\n  ${sink}: ${snippet}`);
      }
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset' || !browserScript(file.fileName) || inspectedScripts.has(file.fileName))
          continue;
        const source = typeof file.source === 'string' ? file.source : Buffer.from(file.source).toString();
        for (const { sink, snippet } of unadaptedSinks(source, file.fileName, (input) => this.parse(input)))
          failures.push(`${file.fileName}\n  ${sink}: ${snippet}`);
      }
      if (failures.length) this.error(`Unadapted Trusted Types sinks:\n${failures.join('\n')}`);
      for (const file of Object.values(bundle))
        if (browserScript(file.fileName)) inspectedScripts.add(file.fileName);
    },
    writeBundle() {
      written = true;
    },
    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        if (worker || !written) return;
        // Public scripts and the assembled service worker bypass the module graph.  Check their
        // written code too, after the other output plugins finish.  PDF renderer CJS assets run
        // only on the server and are never loaded into a browser document.
        for (const file of readdirSync(output, { recursive: true, withFileTypes: true })) {
          if (!file.isFile()) continue;
          const path = resolvePath(file.parentPath, file.name);
          const relative = path.slice(output.length + 1);
          if (!browserScript(relative) || inspectedScripts.has(relative)) continue;
          for (const { sink, snippet } of unadaptedSinks(readFileSync(path, 'utf8'), path, (input) =>
            this.parse(input),
          ))
            this.error(`Unadapted Trusted Types sink in ${path}\n  ${sink}: ${snippet}`);
        }
      },
    },
  };
}
