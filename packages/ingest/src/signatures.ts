import { cellText, normalizeMarker, splitLines } from './tables.js';
import type { ExtractedSource, SourceKind } from './source.js';

export interface Signature {
  id: string;
  kind: SourceKind;
  headerGroups: readonly (readonly string[])[];
  markers: readonly string[];
  markerRows?: number;
}
export interface SignatureMatch {
  signature: Signature;
  score: number;
}
export type SignatureResult =
  | { status: 'none'; matches: [] }
  | { status: 'matched'; match: SignatureMatch; matches: SignatureMatch[] }
  | { status: 'tie'; tied: SignatureMatch[]; matches: SignatureMatch[] };

/** A complete header match belongs to one sheet, rather than unrelated headings across tabs. */
export function matchSignature(source: ExtractedSource, signature: Signature): SignatureMatch | null {
  if (
    source.kind !== signature.kind ||
    !signature.id ||
    signature.headerGroups.some((group) => !group.length || group.some((alias) => !normalizeMarker(alias))) ||
    signature.markers.some((marker) => !normalizeMarker(marker))
  )
    return null;
  const sheets = source.sheets ?? [];
  const headerMatch =
    !signature.headerGroups.length ||
    sheets.some((sheet) => {
      const headers = new Set(
        sheet.rows.slice(0, 60).flatMap((row) => row.map((item) => normalizeMarker(cellText(item)))),
      );
      return signature.headerGroups.every((group) =>
        group.some((alias) => headers.has(normalizeMarker(alias))),
      );
    });
  if (!headerMatch) return null;
  const limit = Math.min(60, Math.max(1, signature.markerRows ?? 10));
  const sheetMarkers = sheets.flatMap((sheet) =>
    sheet.rows.slice(0, limit).flatMap((row) => [...row.map(cellText), row.map(cellText).join(' ')]),
  );
  const firstPage = source.pages?.[0];
  const markers = [
    ...sheetMarkers,
    ...(firstPage?.textQuality === 'clean' ? [firstPage.text] : []),
    ...(source.email ? [splitLines(source.email.bodyText).slice(0, limit).join('\n')] : []),
  ].map(normalizeMarker);
  if (!signature.markers.every((marker) => markers.some((text) => text.includes(normalizeMarker(marker)))))
    return null;
  // An alias group adds one constraint, regardless of how many equivalent spellings it accepts.
  const groups = new Set(
    signature.headerGroups.map((group) => JSON.stringify([...new Set(group.map(normalizeMarker))].sort())),
  );
  const groupScore = [...groups].reduce(
    (sum, group) => sum + 100 + 100 - Math.min((JSON.parse(group) as string[]).length, 100),
    0,
  );
  const markerScore = [...new Set(signature.markers.map(normalizeMarker))].reduce(
    (sum, marker) => sum + 100 + Math.min(marker.length, 99),
    0,
  );
  return { signature, score: 1 + groupScore + markerScore };
}
export function matchSignatures(source: ExtractedSource, signatures: readonly Signature[]): SignatureResult {
  const matches = signatures
    .flatMap((signature) => {
      const match = matchSignature(source, signature);
      return match ? [match] : [];
    })
    .sort((a, b) => b.score - a.score);
  if (!matches.length) return { status: 'none', matches: [] };
  const tied = matches.filter((match) => match.score === matches[0]!.score);
  return tied.length > 1
    ? { status: 'tie', tied, matches }
    : { status: 'matched', match: matches[0]!, matches };
}
export interface SignatureExample {
  id: string;
  signatureId: string;
  source: ExtractedSource;
}

/** A majority of heading groups on one sheet is evidence for a changed known format. */
export function nearSignatures(source: ExtractedSource, signatures: readonly Signature[]): SignatureMatch[] {
  return signatures
    .flatMap((signature) => {
      if (
        source.kind !== signature.kind ||
        !signature.headerGroups.length ||
        matchSignature(source, signature)
      )
        return [];
      const present = Math.max(
        0,
        ...(source.sheets ?? []).map((sheet) => {
          const headings = new Set(
            sheet.rows.slice(0, 60).flatMap((row) => row.map((cell) => normalizeMarker(cellText(cell)))),
          );
          return signature.headerGroups.filter((group) =>
            group.some((alias) => headings.has(normalizeMarker(alias))),
          ).length;
        }),
      );
      return present > signature.headerGroups.length / 2
        ? [{ signature, score: present / signature.headerGroups.length }]
        : [];
    })
    .sort((left, right) => right.score - left.score || left.signature.id.localeCompare(right.signature.id));
}
export function findSignatureMismatches(
  signatures: readonly Signature[],
  examples: readonly SignatureExample[],
): { exampleId: string; ownSignatureId: string; matchedSignatureId: string; score: number }[] {
  return examples.flatMap((example) =>
    signatures.flatMap((signature) => {
      if (signature.id === example.signatureId) return [];
      const match = matchSignature(example.source, signature);
      return match
        ? [
            {
              exampleId: example.id,
              ownSignatureId: example.signatureId,
              matchedSignatureId: signature.id,
              score: match.score,
            },
          ]
        : [];
    }),
  );
}
