import { decodeText, textGrid } from './text.js';
import { outcome, type Extractor } from './types.js';

const extractor: Extractor = {
  priority: -200,
  claims: (bytes) => decodeText(bytes) !== undefined,
  async extract(bytes, context) {
    const text = decodeText(bytes)!;
    if (!text.trim()) return outcome('empty', context.sniffedType);
    return {
      kind: 'text',
      name: context.name,
      sheets: [{ name: context.name, hidden: false, rows: textGrid(text) }],
      pages: [{ number: 1, text, textQuality: 'clean' }],
      warnings: [],
    };
  },
};
export default extractor;
