import { detectType } from '../../data/files/detect.js';
import { guardedEntries, guardedMember, isZip } from './archive.js';
import { ExtractionFailure, outcome, type Extractor } from './types.js';

const extractor: Extractor = {
  priority: -100,
  claims: isZip,
  async extract(bytes, context) {
    if (context.archiveDepth >= 1) throw new ExtractionFailure('archive-depth');
    const parts = [];
    for (const entry of guardedEntries(bytes).values()) {
      const member = guardedMember(bytes, entry);
      if (entry.name.endsWith('/')) continue;
      parts.push({
        name: entry.name,
        bytes: member,
        mediaType: detectType(member),
        archiveDepth: context.archiveDepth + 1,
        emailDepth: context.emailDepth,
      });
    }
    if (!parts.length) return outcome('empty', context.sniffedType);
    return { kind: 'archive', name: context.name, parts, warnings: [] };
  },
};
export default extractor;
