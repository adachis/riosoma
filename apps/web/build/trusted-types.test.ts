// @vitest-environment node
import { parseSync } from '@babel/core';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { functionCallback } from '../src/security/function-callback';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import { unadaptedSinks, trustedTypesGuard } from './trusted-types-guard';
import { adaptTrustedTypes, trustedTypesDependencies } from './trusted-types';

const require = createRequire(import.meta.url);
const parse = (source: string) =>
  parseSync(source, { sourceType: 'module', configFile: false, babelrc: false });

describe('dependency Trusted Types adapter', () => {
  for (const name of [
    '@react-aria/live-announcer',
    '@tiptap/core',
    'prosemirror-view',
    'maplibre-gl/dist/maplibre-gl.mjs',
    'echarts/lib/component/tooltip/TooltipHTMLContent.js',
    'zrender/lib/canvas/Painter.js',
  ]) {
    it(`adapts the installed ${name} sinks`, () => {
      const id =
        name === '@react-aria/live-announcer'
          ? createRequire(
              createRequire(require.resolve('react-aria-components')).resolve('react-aria/package.json'),
            ).resolve('./dist/private/live-announcer/LiveAnnouncer.mjs')
          : require.resolve(name);
      const source = readFileSync(id, 'utf8');
      const adapted = adaptTrustedTypes(source, id, parse);
      expect(adapted?.code).toContain(
        name === '@react-aria/live-announcer' || name === 'zrender/lib/canvas/Painter.js'
          ? '.replaceChildren()'
          : '__rioHTML(',
      );
      expect(adapted?.code).not.toContain('createPolicy("ProseMirrorClipboard"');
      expect(() => parse(adapted!.code)).not.toThrow();
    });
  }
  it('adapts minified workers and all HTML parser argument positions', () => {
    const adapted = adaptTrustedTypes(
      'a.innerHTML=x,b.outerHTML=y;c.insertAdjacentHTML("beforeend",z);d.parseFromString(h,"text/html");r.createContextualFragment(f);new Worker(u);new SharedWorker(v);',
      '/node_modules/maplibre-gl/test.mjs',
      parse,
    )!.code;
    expect(adapted).toContain('a.innerHTML=__rioHTML(x)');
    expect(adapted).toContain('b.outerHTML=__rioHTML(y)');
    expect(adapted).toContain('insertAdjacentHTML("beforeend",__rioHTML(z))');
    expect(adapted).toContain('parseFromString(__rioHTML(h),"text/html")');
    expect(adapted).toContain('createContextualFragment(__rioHTML(f))');
    expect(adapted).toContain('new Worker(__rioScriptURL(u))');
    expect(adapted).toContain('new SharedWorker(__rioScriptURL(v))');
  });
  it('leaves unrelated modules untouched', () => {
    expect(adaptTrustedTypes('element.innerHTML = value;', '/app.ts', parse)).toBeUndefined();
  });
});

describe('bundle Trusted Types guard', () => {
  const id = '/node_modules/new-dependency/index.js';

  for (const value of ['payload', "''"]) {
    it(`rejects an unadapted dependency innerHTML assignment of ${value}`, () => {
      expect(unadaptedSinks(`element.innerHTML = ${value}`, id, parse)).toEqual([
        { sink: 'innerHTML', snippet: `element.innerHTML = ${value}` },
      ]);
    });
  }

  it('accepts the live announcer only after adaptation, including its empty clears', () => {
    const id = '/node_modules/@react-aria/live-announcer/dist/LiveAnnouncer.mjs';
    const source = "this.assertiveLog.innerHTML = ''; this.politeLog.innerHTML = message;";
    expect(unadaptedSinks(source, id, parse)).toHaveLength(2);
    const adapted = adaptTrustedTypes(source, id, parse)!.code;
    expect(unadaptedSinks(adapted, id, parse)).toEqual([]);
  });

  for (const source of [
    'element["innerHTML"] = html',
    'element.outerHTML = html',
    'element.insertAdjacentHTML("beforeend", html)',
    'document.write(html)',
    'document.writeln(html)',
    'new DOMParser().parseFromString(html, "text/html")',
    'range.createContextualFragment(html)',
    'frame.srcdoc = html',
    'script.src = url',
    'script.text = code',
    'script.setAttribute("src", url)',
    'script.setAttribute("text", code)',
    'new Worker(url)',
    'new SharedWorker(url)',
    'importScripts(url)',
    'eval(code)',
    'new Function(code)',
    'setTimeout("alert(1)", 1)',
    'setInterval(code, 1)',
  ]) {
    it(`rejects ${source}`, () => {
      expect(unadaptedSinks(source, id, parse)).not.toEqual([]);
    });
  }

  it('does not trust a helper merely because of its name', () => {
    expect(unadaptedSinks('el.innerHTML = trustedHTML(html)', id, parse)).toHaveLength(1);
  });

  it('recognizes policy imports under local aliases', () => {
    expect(
      unadaptedSinks(
        'import { trustedHTML as clean, trustedScriptURL as url } from "../security/trusted-types"; el.innerHTML = clean(html); new Worker(url(worker));',
        fileURLToPath(new URL('../src/feature/example.js', import.meta.url)),
        parse,
      ),
    ).toEqual([]);
  });
});

it('fails the production bundle for a newly imported dependency and accepts its adapted form', async () => {
  const dependency = '/node_modules/@react-aria/live-announcer/fixture.js';
  const bundle = (adapt: boolean) =>
    build({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'guard-fixture',
          enforce: 'pre',
          resolveId(id) {
            if (id === 'guard-entry' || id === dependency) return id;
            if (id.endsWith('/security/trusted-types.ts')) return { id, external: true };
          },
          load(id) {
            if (id === 'guard-entry') return `import(${JSON.stringify(dependency)}).then(m => m.clear());`;
            if (id === dependency) return "export function clear() { document.body.innerHTML = ''; }";
          },
        },
        ...(adapt ? [trustedTypesDependencies()] : []),
        trustedTypesGuard(),
      ],
      build: { write: false, rolldownOptions: { input: 'guard-entry' } },
    });
  await expect(bundle(false)).rejects.toThrow(/live-announcer\/fixture\.js\n\s+innerHTML:.*innerHTML = ''/);
  await expect(bundle(true)).resolves.toBeDefined();
});

it('rejects constructor aliases, mutable callback bindings, and shadowed policy names', () => {
  const id = fileURLToPath(new URL('../src/feature/example.js', import.meta.url));
  expect(unadaptedSinks('const F = Function; new F(code)', id, parse)).toHaveLength(1);
  expect(
    unadaptedSinks('let callback = () => {}; callback = code; setTimeout(callback, 1)', id, parse),
  ).toHaveLength(1);
  expect(
    unadaptedSinks(
      'import { trustedHTML } from "../security/trusted-types"; function unsafe(trustedHTML) { el.innerHTML = trustedHTML(html); }',
      id,
      parse,
    ),
  ).toHaveLength(1);
  expect(
    unadaptedSinks(
      'import { trustedHTML } from "../security/trusted-types"; el.innerHTML += trustedHTML(html);',
      id,
      parse,
    ),
  ).toHaveLength(1);
});

it('proves local function timers and non-script DOM URLs without accepting unknown receivers', () => {
  expect(
    unadaptedSinks(
      'const callback = () => {}; setTimeout(callback, 1); const image = new Image(); image.src = url;',
      '/app.js',
      parse,
    ),
  ).toEqual([]);
  expect(unadaptedSinks('const image = getElement(); image.src = url;', '/app.js', parse)).toHaveLength(1);
});

it('invalidates a construction proof when the dependency source changes', () => {
  const id = require.resolve('parse5');
  const source = readFileSync(id, 'utf8');
  expect(unadaptedSinks(source, id, parse)).toEqual([]);
  const changed = unadaptedSinks(`${source}\ndocument.write(html);`, id, parse);
  expect(changed.some(({ snippet }) => snippet === 'document.write(html)')).toBe(true);
});

it.each(['late.js', 'late.mjs', 'late.cjs'])(
  'rejects sinks in emitted %s outside the module graph',
  async (fileName) => {
    await expect(
      build({
        configFile: false,
        logLevel: 'silent',
        plugins: [
          {
            name: 'asset-fixture',
            resolveId(id) {
              if (id === 'guard-entry') return id;
            },
            load(id) {
              if (id === 'guard-entry') return 'console.log("ready")';
            },
            generateBundle() {
              this.emitFile({ type: 'asset', fileName, source: 'document.write(html)' });
            },
          },
          trustedTypesGuard(),
        ],
        build: { write: false, rolldownOptions: { input: 'guard-entry' } },
      }),
    ).rejects.toThrow(/late\.[mc]?js\n\s+possible document.write: document.write\(html\)/);
  },
);

it('does not infer native DOM or Promise guarantees from shadowed bindings', () => {
  for (const source of [
    'function unsafe(document) { const el = document.createElement("img"); el.src = url; }',
    'function unsafe(Image) { const el = new Image(); el.src = url; }',
    'function unsafe(Promise) { new Promise(resolve => setTimeout(resolve, 1)); }',
    'let callback = () => {}; ({ callback } = object); setTimeout(callback, 1);',
  ])
    expect(unadaptedSinks(source, '/dependency.js', parse), source).not.toEqual([]);
});

it('checks folded property names and indirect eval', () => {
  for (const source of [
    'const property = "innerHTML"; element[property] = html;',
    'element["outer" + "HTML"] = html;',
    'element[`inner${"HTML"}`] = html;',
    '(0, eval)(code)',
    'eval.call(window, code)',
    'Function.apply(null, [code])',
    'const evaluate = globalThis.eval; evaluate(code)',
  ])
    expect(unadaptedSinks(source, '/dependency.js', parse), source).not.toEqual([]);
});

it('renders a PDF with the adapted library while string code generation is disabled', async () => {
  const id = require.resolve('pdfmake/build/pdfmake.js');
  const adapted = adaptTrustedTypes(readFileSync(id, 'utf8'), id, parse)!.code;
  const module = {
    exports: {} as {
      addVirtualFileSystem(fonts: Record<string, string>): void;
      createPdf(definition: { content: string[] }): { getBuffer(): Promise<Uint8Array> };
    },
  };
  runInNewContext(
    'globalThis.self = globalThis; globalThis.global = globalThis;\n' +
      adapted.replace(/^import .*;\n/gm, ''),
    {
      module,
      exports: module.exports,
      __rioCallback: functionCallback,
      setTimeout,
      clearTimeout,
      TextEncoder,
      TextDecoder,
      URL,
      Blob,
    },
    { contextCodeGeneration: { strings: false, wasm: false } },
  );
  module.exports.addVirtualFileSystem(require('pdfmake/build/vfs_fonts'));
  const buffer = await module.exports.createPdf({ content: ['Trusted PDF'] }).getBuffer();
  expect(String.fromCharCode(...buffer.subarray(0, 5))).toBe('%PDF-');
  expect(buffer.length).toBeGreaterThan(1_000);
});

it('keeps the sanitizer parser private to the policy module', () => {
  const source = 'import DOMPurify from "dompurify"; DOMPurify.sanitize(html);';
  expect(unadaptedSinks(source, '/node_modules/new-dependency/index.js', parse)).toHaveLength(1);
  expect(
    unadaptedSinks(
      source,
      fileURLToPath(new URL('../src/security/trusted-types.ts', import.meta.url)),
      parse,
    ),
  ).toEqual([]);
});
