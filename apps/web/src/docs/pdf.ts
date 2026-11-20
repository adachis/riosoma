import { recoverImport } from '../asset-recovery';
import { setupI18n, type I18n, type Messages } from '@lingui/core';
import type { Content, ContentText, TDocumentDefinitions } from 'pdfmake/interfaces';
import type { Token } from 'marked';
import { i18n } from '../i18n';
import { listModules, loadModule, type DocModule } from './loader';
import { parseTokens, resolveShortcutLabel, type MacroToken } from './tokens';

const catalogs = import.meta.glob<{ messages: Messages }>('../locales/*/messages.po');

async function translator(locale: string): Promise<I18n> {
  if (locale === i18n.locale) return i18n;
  const load = catalogs[`../locales/${locale}/messages.po`] ?? catalogs['../locales/en-US/messages.po']!;
  const catalog = await recoverImport(load);
  return setupI18n({ locale, messages: { [locale]: catalog.messages } });
}

export function pdfContent(tokens: Token[], translate: I18n, titles: ReadonlyMap<string, string>): Content[] {
  function inline(items: Token[] = []): ContentText[] {
    return items.flatMap((token): ContentText[] => {
      switch (token.type) {
        case 'text':
          return token.tokens ? inline(token.tokens) : [{ text: token.text }];
        case 'escape':
          return [{ text: token.text }];
        case 'strong':
          return [{ text: inline(token.tokens), bold: true }];
        case 'em':
          return [{ text: inline(token.tokens), italics: true }];
        case 'codespan':
          return [{ text: token.text, background: '#eeeeee' }];
        case 'link':
          return inline(token.tokens);
        case 'br':
          return [{ text: '\n' }];
        case 'del':
          return [{ text: inline(token.tokens), decoration: 'lineThrough' }];
        case 'docMacro': {
          const macro = token as MacroToken;
          if (macro.kind === 'ui') return [{ text: translate._(macro.value), bold: true }];
          if (macro.kind === 'doc') return [{ text: titles.get(macro.value) ?? macro.value }];
          return [{ text: resolveShortcutLabel(macro.value) }];
        }
        default:
          return [];
      }
    });
  }
  return tokens.flatMap((token): Content[] => {
    switch (token.type) {
      case 'heading':
        return [
          {
            text: inline(token.tokens),
            fontSize: Math.max(12, 20 - token.depth * 2),
            bold: true,
            margin: [0, 12, 0, 6],
          },
        ];
      case 'paragraph':
        return [{ text: inline(token.tokens), margin: [0, 0, 0, 8] }];
      case 'text':
        return [{ text: token.tokens ? inline(token.tokens) : token.text }];
      case 'code':
        return [{ text: token.text, fontSize: 10, preserveLeadingSpaces: true, margin: [12, 4, 0, 10] }];
      case 'blockquote':
        return [
          { stack: pdfContent(token.tokens ?? [], translate, titles), margin: [12, 4, 0, 8], italics: true },
        ];
      case 'list': {
        const items = token.items.map((item: { tokens: Token[] }) => ({
          stack: pdfContent(item.tokens, translate, titles),
        }));
        return token.ordered
          ? [{ ol: items, start: token.start || 1, margin: [0, 0, 0, 8] }]
          : [{ ul: items, margin: [0, 0, 0, 8] }];
      }
      case 'table': {
        const header = token.header.map((cell: { tokens: Token[] }) => ({
          text: inline(cell.tokens),
          bold: true,
        }));
        const rows = token.rows.map((row: Array<{ tokens: Token[] }>) =>
          row.map((cell) => ({ text: inline(cell.tokens) })),
        );
        return [
          {
            table: { headerRows: 1, widths: header.map(() => '*'), body: [header, ...rows] },
            layout: 'lightHorizontalLines',
            margin: [0, 0, 0, 8],
          },
        ];
      }
      case 'hr':
        return [
          { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 516, y2: 0, lineWidth: 0.5 }], margin: [0, 8, 0, 8] },
        ];
      default:
        return [];
    }
  });
}

/** Canvas resolves theme color expressions into the numeric sRGB values both renderers accept. */
function pdfColor(value: string, fallback: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d');
  if (!context) return fallback;
  context.fillStyle = fallback;
  context.fillStyle = value || fallback;
  context.fillRect(0, 0, 1, 1);
  const rgb = context.getImageData(0, 0, 1, 1).data;
  return `#${Array.from(rgb)
    .slice(0, 3)
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`;
}

async function download(
  modules: DocModule[],
  locale: string,
  filename: string,
  titles: ReadonlyMap<string, string>,
) {
  const [pdfmake, fonts, translate, lockup] = await Promise.all([
    recoverImport(() => import('pdfmake/build/pdfmake')),
    recoverImport(() => import('pdfmake/build/vfs_fonts')),
    translator(locale),
    fetch('/brand/riosoma-lockup.svg').then((response) => {
      if (!response.ok) throw new Error();
      return response.text();
    }),
  ]);
  pdfmake.default.addVirtualFileSystem(fonts.default);
  const paint = getComputedStyle(document.documentElement);
  const ink = pdfColor(paint.getPropertyValue('--rio-text').trim(), '#000000');
  const surface = pdfColor(paint.getPropertyValue('--rio-surface').trim(), '#ffffff');
  const mark = lockup
    .replaceAll('var(--rs-leaf,var(--rs-ink,currentColor))', ink)
    .replaceAll('var(--rs-highlight,var(--rs-detail,#fff))', surface)
    .replaceAll('var(--rs-face,var(--rs-detail,#fff))', surface)
    .replaceAll('var(--rs-ink,currentColor)', ink)
    .replaceAll('var(--rs-detail,#fff)', surface);
  const definition: TDocumentDefinitions = {
    info: { title: modules.map((module) => module.meta.title).join('; ') },
    pageSize: 'LETTER',
    pageMargins: [48, 48, 48, 54],
    defaultStyle: { fontSize: 11, lineHeight: 1.25, color: ink },
    background: (_page, size) => ({
      canvas: [{ type: 'rect', x: 0, y: 0, w: size.width, h: size.height, color: surface }],
    }),
    content: modules.map((module) => ({
      section: [
        { svg: mark, width: 120, margin: [0, 0, 0, 16] },
        { text: module.meta.title, fontSize: 22, bold: true, margin: [0, 0, 0, 10] },
        { text: module.meta.summary, margin: [0, 0, 0, 14] },
        ...pdfContent(parseTokens(module.body), translate, titles),
      ],
      footer: (page: number, count: number) => ({
        columns: [
          { text: module.meta.title, width: '*' },
          { text: `${page} / ${count}`, width: 'auto', alignment: 'right' },
        ],
        fontSize: 9,
        margin: [48, 16, 48, 0],
      }),
    })),
  };
  await pdfmake.default.createPdf(definition).download(filename);
}

export async function exportModulePdf(id: string, locale: string): Promise<void> {
  const [module, metadata] = await Promise.all([loadModule(id, locale), listModules(locale)]);
  if (!module) throw new Error(`Unknown help module: ${id}`);
  await download(
    [module],
    locale,
    `riosoma-help-${module.meta.id}.pdf`,
    new Map(metadata.map((meta) => [meta.id, meta.title])),
  );
}

export async function exportAllPdf(locale: string): Promise<void> {
  const metadata = await listModules(locale);
  const modules = await Promise.all(metadata.map((meta) => loadModule(meta.id, locale)));
  await download(
    modules.filter((module): module is DocModule => module !== null),
    locale,
    'riosoma-help.pdf',
    new Map(metadata.map((meta) => [meta.id, meta.title])),
  );
}
