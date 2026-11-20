import { detectType } from '../../data/files/detect.js';
import type { Extractor } from './types.js';
import { ExtractionFailure } from './types.js';

const extractor: Extractor = {
  priority: 100,
  claims: (bytes) => {
    const type = detectType(bytes);
    return type.startsWith('image/') && type !== 'image/svg+xml';
  },
  async extract(bytes, context) {
    const { default: sharp } = await import('sharp');
    const metadata = await sharp(bytes, { limitInputPixels: 100000000 }).metadata();
    if (!metadata.width || !metadata.height) throw new ExtractionFailure('invalid');
    return {
      kind: 'image',
      name: context.name,
      images: [{ index: 1, width: metadata.width, height: metadata.pageHeight ?? metadata.height }],
      warnings: [],
    };
  },
};
export default extractor;
