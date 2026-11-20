import type { ExtractedSource } from '@riosoma/ingest';

export const sheetIdentifier = (index: number) => `sheet-${index + 1}`;

/** Ordinal identifiers keep filenames out of generated rules and remain stable for later files. */
export function anonymousReaderSource(source: ExtractedSource): ExtractedSource {
  return {
    ...source,
    name: '',
    parts: undefined,
    sheets: source.sheets?.map((sheet, index) => ({ ...sheet, name: sheetIdentifier(index) })),
    email: source.email && {
      ...source.email,
      from: '',
      originalFrom: undefined,
      messageId: '',
    },
  };
}
