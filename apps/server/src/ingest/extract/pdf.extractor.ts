import type { TextQuality } from '@riosoma/ingest';
import { type Extractor } from './types.js';

/** Short layers, missing glyph mappings, and unexpected characters all lower confidence. */
export function textQuality(text: string): TextQuality {
  const characters = [...text.replace(/\s/g, '')];
  if (!characters.length) return 'none';
  const expected =
    /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Devanagari}\p{Script=Thai}\p{Script=Bengali}\p{Script=Common}\p{Script=Inherited}]/u;
  const outside = characters.filter(
    (char) => !expected.test(char) || /[\p{Cc}\p{Co}\p{Cn}\uFFFD]/u.test(char),
  ).length;
  return characters.length < 20 || outside / characters.length > 0.1 || /\(cid:\s*\d+\)/i.test(text)
    ? 'garbled'
    : 'clean';
}

const extractor: Extractor = {
  priority: 100,
  claims: (bytes) => bytes.subarray(0, 5).toString() === '%PDF-',
  async extract(bytes, context) {
    const { extractPdfPages } = await import('../../data/library-text-parser.js');
    const pages = (await extractPdfPages(bytes)).map((text, index) => ({
      number: index + 1,
      text,
      textQuality: textQuality(text),
    }));
    return {
      kind: 'pdf',
      name: context.name,
      pages,
      warnings: pages.every((page) => page.textQuality === 'none') ? ['ingest.extract.empty'] : [],
    };
  },
};
export default extractor;
