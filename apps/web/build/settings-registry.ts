import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import type { Plugin } from 'vite';

const MODULE = 'virtual:settings-registry';
const RESOLVED = `\0${MODULE}`;
const ROOT = join(import.meta.dirname, '../src');

function literal(node: ts.Node, declarations = new Map<string, ts.Expression>()): unknown {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
    return literal(node.expression, declarations);
  if (ts.isIdentifier(node) && declarations.has(node.text))
    return literal(declarations.get(node.text)!, declarations);
  if (ts.isPropertyAccessExpression(node))
    return (literal(node.expression, declarations) as Record<string, unknown>)[node.name.text];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((item) => literal(item, declarations));
  if (ts.isCallExpression(node) && node.expression.getText() === 'msg' && node.arguments[0])
    return literal(node.arguments[0], declarations);
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(
      node.properties.map((property) => {
        if (!ts.isPropertyAssignment(property))
          throw new Error('Settings metadata must use literal properties');
        return [
          property.name.getText().replace(/^['"]|['"]$/g, ''),
          literal(property.initializer, declarations),
        ];
      }),
    );
  }
  throw new Error(`Settings metadata must be literal: ${node.getText()}`);
}

export interface RegistryRow {
  area: string;
  section: string;
  page: string;
  id: string;
  label: { id: string; message?: string };
  pageLabel: { id: string; message?: string };
  roles: string[];
  keywords?: { id: string; message?: string };
  help?: { id: string; message?: string };
}

/** Reading the controls' declarations makes missing metadata fail the gate. */
export function readSettingsScreen(source: string, filename: string): RegistryRow[] {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const pages = new Map<string, Record<string, unknown>>();
  const rows: RegistryRow[] = [];
  const declarations = new Map<string, ts.Expression>();
  tree.forEachChild((node) => {
    if (ts.isVariableStatement(node))
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer)
          declarations.set(declaration.name.text, declaration.initializer);
      }
  });
  const visitPages = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(tree) === 'defineSettingsPage'
    ) {
      pages.set(
        node.name.getText(tree),
        literal(node.initializer.arguments[0]!, declarations) as Record<string, unknown>,
      );
    }
    ts.forEachChild(node, visitPages);
  };
  visitPages(tree);
  if (!pages.size) return [];
  const visitItems = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'defineSettingItems') {
      const page = pages.get(node.arguments[0]!.getText(tree));
      if (!page) throw new Error(`${filename}: setting items need a declared page`);
      const items = literal(node.arguments[1]!, declarations) as Record<string, Record<string, unknown>>;
      for (const [id, item] of Object.entries(items))
        rows.push({ ...page, pageLabel: page.label, ...item, id } as unknown as RegistryRow);
    }
    ts.forEachChild(node, visitItems);
  };
  visitItems(tree);
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === 'Setting') {
      const attributes: Record<string, unknown> = {};
      for (const attribute of node.openingElement.attributes.properties) {
        if (!ts.isJsxAttribute(attribute) || !attribute.initializer) continue;
        const value = ts.isJsxExpression(attribute.initializer)
          ? attribute.initializer.expression!
          : attribute.initializer;
        attributes[attribute.name.getText(tree)] =
          attribute.name.getText(tree) === 'page'
            ? pages.get(value.getText(tree))
            : ts.isPropertyAccessExpression(value) && pages.has(value.expression.getText(tree))
              ? pages.get(value.expression.getText(tree))![value.name.text]
              : literal(value, declarations);
      }
      const page = attributes.page as Record<string, unknown> | undefined;
      if (!page || !attributes.id || !attributes.label)
        throw new Error(`${filename}: a setting needs its page, id, and label message`);
      if (attributes.id !== 'overview') {
        const controls = new Set([
          'TextField',
          'TextArea',
          'NumberField',
          'Select',
          'ComboBox',
          'RadioGroup',
          'AriaRadioGroup',
          'PasswordField',
        ]);
        let label: string | undefined;
        const findLabel = (child: ts.Node) => {
          if (label) return;
          if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
            const opening = ts.isJsxElement(child) ? child.openingElement : child;
            const tag = opening.tagName.getText(tree);
            if (['Setting', 'SettingItem'].includes(tag)) return;
            if (controls.has(tag)) {
              const attribute = opening.attributes.properties
                .filter(ts.isJsxAttribute)
                .find((item) => item.name.getText(tree) === 'label');
              const expression =
                attribute?.initializer && ts.isJsxExpression(attribute.initializer)
                  ? attribute.initializer.expression
                  : undefined;
              if (
                expression &&
                ts.isCallExpression(expression) &&
                expression.expression.getText(tree) === 't' &&
                expression.arguments[0] &&
                ts.isObjectLiteralExpression(expression.arguments[0])
              ) {
                const id = expression.arguments[0].properties.find(
                  (item) => ts.isPropertyAssignment(item) && item.name.getText(tree) === 'id',
                );
                if (id && ts.isPropertyAssignment(id) && ts.isStringLiteral(id.initializer))
                  label = id.initializer.text;
              }
              return;
            }
          }
          ts.forEachChild(child, findLabel);
        };
        for (const child of node.children) findLabel(child);
        if (label && label !== (attributes.label as { id: string }).id)
          throw new Error(`${filename}: ${String(attributes.id)} label differs from its rendered control`);
      }
      rows.push({ ...page, pageLabel: page.label, ...attributes, page: page.page } as unknown as RegistryRow);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return rows;
}

export function settingsSources(root = ROOT): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? settingsSources(path)
      : /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') && !entry.name.endsWith('.d.ts')
        ? [path]
        : [];
  });
}

export function settingsPages(): string[] {
  const filename = join(ROOT, 'screens/settings/SettingsScreen.tsx');
  const tree = ts.createSourceFile(
    filename,
    readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let pages: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(tree) === 'SECTION_COMPONENTS' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    )
      pages = node.initializer.properties.map((property) =>
        property.name!.getText(tree).replace(/^['"]|['"]$/g, ''),
      );
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return pages;
}

function settingsComponents(): Set<string> {
  const filename = join(ROOT, 'screens/settings/SettingsScreen.tsx');
  const tree = ts.createSourceFile(
    filename,
    readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(tree) === 'default' &&
      ts.isPropertyAccessExpression(node.initializer)
    )
      names.add(node.initializer.name.text);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return names;
}

type Component = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
interface ComponentModule {
  tree: ts.SourceFile;
  functions: Map<string, Component>;
  imports: Map<string, { path: string; name: string }>;
  exports: Map<string, string | { path: string; name: string }>;
  exportAll: string[];
}

/** Follow the screen tree across local imports so extracting a child cannot bypass the gate. */
export function unregisteredSettings(
  source: string,
  filename: string,
  readSource: (file: string) => string | undefined = (file) =>
    existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8') : undefined,
): string[] {
  const modules = new Map<string, ComponentModule>();
  const parse = (file: string, text: string): ComponentModule => {
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const module: ComponentModule = {
      tree,
      functions: new Map(),
      imports: new Map(),
      exports: new Map(),
      exportAll: [],
    };
    modules.set(file, module);
    tree.forEachChild((node) => {
      const exported =
        ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      const defaultExport =
        ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
      if (ts.isFunctionDeclaration(node)) {
        const name = node.name?.text ?? 'default';
        module.functions.set(name, node);
        if (exported) module.exports.set(defaultExport ? 'default' : name, name);
      }
      if (ts.isVariableStatement(node))
        for (const declaration of node.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
          const initializer = declaration.initializer;
          const component = ts.isCallExpression(initializer) ? initializer.arguments[0] : initializer;
          if (component && (ts.isArrowFunction(component) || ts.isFunctionExpression(component))) {
            module.functions.set(declaration.name.text, component);
            if (exported) module.exports.set(declaration.name.text, declaration.name.text);
          }
        }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const path = node.moduleSpecifier.text;
        const clause = node.importClause;
        if (!path.startsWith('.') || !clause || clause.isTypeOnly) return;
        if (clause.name) module.imports.set(clause.name.text, { path, name: 'default' });
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
          for (const binding of bindings.elements)
            if (!binding.isTypeOnly)
              module.imports.set(binding.name.text, {
                path,
                name: binding.propertyName?.text ?? binding.name.text,
              });
        if (bindings && ts.isNamespaceImport(bindings))
          module.imports.set(bindings.name.text, { path, name: '*' });
      }
      if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
        const path =
          node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
            ? node.moduleSpecifier.text
            : undefined;
        if (path && !path.startsWith('.')) return;
        if (node.exportClause && ts.isNamedExports(node.exportClause))
          for (const binding of node.exportClause.elements) {
            const name = binding.propertyName?.text ?? binding.name.text;
            module.exports.set(binding.name.text, path ? { path, name } : name);
          }
        else if (path) module.exportAll.push(path);
      }
      if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression))
        module.exports.set('default', node.expression.text);
      if (ts.isExportAssignment(node) && ts.isArrowFunction(node.expression)) {
        module.functions.set('default', node.expression);
        module.exports.set('default', 'default');
      }
    });
    return module;
  };
  const load = (module: ComponentModule, path: string): ComponentModule | undefined => {
    const base = resolve(dirname(module.tree.fileName), path);
    for (const file of [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
      if (modules.has(file)) return modules.get(file);
      const text = readSource(file);
      if (text !== undefined) return parse(file, text);
    }
  };
  const findComponent = (
    module: ComponentModule,
    name: string,
    exported = false,
    resolving = new Set<string>(),
  ): { module: ComponentModule; component: Component; name: string } | undefined => {
    const key = `${module.tree.fileName}:${name}:${exported}`;
    if (resolving.has(key)) return;
    resolving.add(key);
    if (!exported) {
      const component = module.functions.get(name);
      if (component) return { module, component, name };
      const [namespace, member] = name.split('.');
      const imported = module.imports.get(namespace!);
      if (imported) {
        const child = load(module, imported.path);
        if (child)
          return findComponent(child, imported.name === '*' ? member! : imported.name, true, resolving);
      }
    }
    const definition = module.exports.get(name);
    if (typeof definition === 'string') return findComponent(module, definition, false, resolving);
    if (definition) {
      const child = load(module, definition.path);
      if (child) return findComponent(child, definition.name, true, resolving);
    }
    for (const path of module.exportAll) {
      const child = load(module, path);
      const found = child && findComponent(child, name, true, resolving);
      if (found) return found;
    }
  };
  const entry = parse(filename, source);
  const { tree, functions } = entry;
  const roots = new Set<string>();
  const screens = settingsComponents();
  for (const name of entry.exports.keys()) if (screens.has(name)) roots.add(name);
  const discover = (node: ts.Node) => {
    if (
      ts.isJsxElement(node) &&
      ['Setting', 'SettingItem'].includes(node.openingElement.tagName.getText(tree))
    ) {
      let parent: ts.Node | undefined = node;
      while (parent && ![...functions.values()].includes(parent as Component)) parent = parent.parent;
      for (const [name, component] of functions) if (parent === component) roots.add(name);
    }
    ts.forEachChild(node, discover);
  };
  discover(tree);
  const controls = new Set([
    'TextField',
    'TextArea',
    'NumberField',
    'Select',
    'ComboBox',
    'Switch',
    'Checkbox',
    'CheckboxGroup',
    'RadioGroup',
    'AriaRadioGroup',
    'Slider',
    'PasswordField',
    'input',
    'select',
    'textarea',
  ]);
  const problems = new Set<string>();
  const visited = new Set<string>();
  const visitFunction = (module: ComponentModule, name: string, inherited = false) => {
    const found = findComponent(module, name);
    if (!found) return;
    const { module: childModule, component } = found;
    const tree = childModule.tree;
    const key = `${tree.fileName}:${found.name}:${inherited}`;
    if (visited.has(key)) return;
    visited.add(key);
    const visit = (node: ts.Node, registered = inherited) => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const tag = opening.tagName.getText(tree);
        if (['Modal', 'Dialog', 'ConfirmDialog'].includes(tag)) return;
        const attributes = opening.attributes.properties.filter(ts.isJsxAttribute);
        if (tag === 'SettingItem') registered = true;
        if (tag === 'Setting') {
          const id = attributes.find((attribute) => attribute.name.getText(tree) === 'id')?.initializer;
          const value = id && ts.isJsxExpression(id) ? id.expression : id;
          if (!value || !ts.isStringLiteral(value) || value.text !== 'overview') registered = true;
        }
        const readOnly = attributes.some(
          (attribute) =>
            ['isReadOnly', 'readOnly'].includes(attribute.name.getText(tree)) &&
            (!attribute.initializer || attribute.initializer.getText(tree) === '{true}'),
        );
        if (controls.has(tag) && !registered && !readOnly) {
          const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
          problems.add(`${tree.fileName}:${line}: ${tag} renders without a registered setting`);
        }
        visitFunction(childModule, tag, registered);
      }
      ts.forEachChild(node, (child) => visit(child, registered));
    };
    visit(component);
  };
  for (const root of roots) visitFunction(entry, root);
  return [...problems];
}

export function collectSettings(): RegistryRow[] {
  const rows = settingsSources().flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    const settings = readSettingsScreen(source, file);
    if (settings.length || source.includes('defineSettingsPage(')) {
      const problems = unregisteredSettings(source, file);
      if (problems.length) throw new Error(problems.join('\n'));
    }
    return settings;
  });
  const keys = new Set<string>();
  for (const page of settingsPages()) {
    if (!rows.some((row) => row.page === page))
      throw new Error(`Settings page ${page} has no registered settings`);
  }
  for (const row of rows) {
    const key = `${row.area}/${row.section}/${row.page}/${row.id}`;
    if (keys.has(key)) throw new Error(`Duplicate setting: ${key}`);
    keys.add(key);
  }
  return rows;
}

export function settingsRegistry(languageChoice = true): Plugin {
  return {
    name: 'settings-registry',
    resolveId(id) {
      if (id === MODULE) return RESOLVED;
    },
    load(id) {
      if (id !== RESOLVED) return;
      for (const file of settingsSources()) this.addWatchFile(file);
      const rows = collectSettings().filter(
        (row) => languageChoice || (row.page !== 'language' && row.id !== 'defaultLocale'),
      );
      return `export const settingsRegistry = ${JSON.stringify(rows)};`;
    },
    handleHotUpdate({ file, server, modules }) {
      if (!/\.tsx?$/.test(file)) return;
      const module = server.moduleGraph.getModuleById(RESOLVED);
      if (module) {
        server.moduleGraph.invalidateModule(module);
        return [...modules, module];
      }
    },
  };
}
