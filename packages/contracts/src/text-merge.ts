import { z } from 'zod';

export const TextConflict = z.object({
  tableId: z.string(),
  recordId: z.string(),
  fieldId: z.string(),
  base: z.string().nullable(),
  ours: z.string().nullable(),
  theirs: z.string().nullable(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string(),
  name: z.string().nullable(),
  /** A complete editable proposal, with only overlapping spans marked. */
  proposal: z.string(),
});
export type TextConflict = z.infer<typeof TextConflict>;

export const TextMergeNotice = TextConflict.omit({
  base: true,
  ours: true,
  theirs: true,
  proposal: true,
}).extend({
  value: z.string().nullable(),
});
export type TextMergeNotice = z.infer<typeof TextMergeNotice>;

interface Edit {
  start: number;
  end: number;
  tokens: string[];
}

const words = new Intl.Segmenter('en', { granularity: 'word' });
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

function tokenize(text: string, mode: 'words' | 'lines'): string[] {
  if (mode === 'lines') return text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  return [...words.segment(text)].flatMap((part) =>
    part.isWordLike ? [part.segment] : [...graphemes.segment(part.segment)].map((item) => item.segment),
  );
}

/** Shortest insert/delete diff, bounded so unrelated million-character inputs cannot exhaust memory. */
function edits(base: string[], next: string[]): Edit[] {
  let prefix = 0;
  while (prefix < base.length && prefix < next.length && base[prefix] === next[prefix]) prefix++;
  let end = base.length;
  let nextEnd = next.length;
  while (end > prefix && nextEnd > prefix && base[end - 1] === next[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  const a = base.slice(prefix, end);
  const b = next.slice(prefix, nextEnd);
  if (!a.length || !b.length)
    return end === prefix && nextEnd === prefix ? [] : [{ start: prefix, end, tokens: b }];
  const trace: Map<number, number>[] = [];
  let frontier = new Map<number, number>([[1, 0]]);
  let work = 0;
  for (let distance = 0; distance <= a.length + b.length; distance++) {
    trace.push(frontier);
    const current = new Map<number, number>();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (++work > 500_000) {
        // A conservative replacement can report a conflict, but can never discard an edit.
        return [{ start: prefix, end, tokens: b }];
      }
      const left = frontier.get(diagonal - 1) ?? -1;
      const right = frontier.get(diagonal + 1) ?? -1;
      let x = diagonal === -distance || (diagonal !== distance && left < right) ? right : left + 1;
      let y = x - diagonal;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x++;
        y++;
      }
      current.set(diagonal, x);
      if (x < a.length || y < b.length) continue;
      const operations: Array<'same' | 'add' | 'remove'> = [];
      for (let d = distance; d >= 0; d--) {
        const previous = trace[d]!;
        const k = x - y;
        const priorK =
          k === -d || (k !== d && (previous.get(k - 1) ?? -1) < (previous.get(k + 1) ?? -1)) ? k + 1 : k - 1;
        const priorX = d === 0 ? 0 : previous.get(priorK)!;
        const priorY = d === 0 ? 0 : priorX - priorK;
        while (x > priorX && y > priorY) {
          operations.push('same');
          x--;
          y--;
        }
        if (d > 0) {
          if (x === priorX) {
            operations.push('add');
            y--;
          } else {
            operations.push('remove');
            x--;
          }
        }
      }
      operations.reverse();
      const result: Edit[] = [];
      let old = prefix;
      let added = prefix;
      let edit: Edit | undefined;
      for (const operation of operations) {
        if (operation === 'same') {
          edit = undefined;
          old++;
          added++;
          continue;
        }
        if (!edit) {
          edit = { start: old, end: old, tokens: [] };
          result.push(edit);
        }
        if (operation === 'remove') edit.end = ++old;
        else edit.tokens.push(next[added++]!);
      }
      return result;
    }
    frontier = current;
  }
  return [];
}

function overlap(a: Edit, b: Edit): boolean {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end) return b.start > a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

function render(base: string[], changes: Edit[], start: number, end: number): string {
  const parts: string[] = [];
  let cursor = start;
  for (const edit of changes) {
    parts.push(base.slice(cursor, edit.start).join(''), edit.tokens.join(''));
    cursor = edit.end;
  }
  parts.push(base.slice(cursor, end).join(''));
  return parts.join('');
}

export type TextMerge = { clean: true; text: string } | { clean: false; proposal: string };

/** Three-way merge retains exact tokens, including Markdown punctuation and Unicode graphemes. */
export function mergeText(
  baseText: string,
  theirsText: string,
  oursText: string,
  mode: 'words' | 'lines' = 'words',
): TextMerge {
  if (oursText === theirsText || baseText === theirsText) return { clean: true, text: oursText };
  if (baseText === oursText) return { clean: true, text: theirsText };
  const base = tokenize(baseText, mode);
  const ours = edits(base, tokenize(oursText, mode));
  const theirs = edits(base, tokenize(theirsText, mode));
  const changes = [
    ...ours.map((edit) => ({ edit, side: 'ours' as const })),
    ...theirs.map((edit) => ({ edit, side: 'theirs' as const })),
  ].sort((a, b) => a.edit.start - b.edit.start || a.edit.end - b.edit.end);
  const parts: string[] = [];
  let cursor = 0;
  let clean = true;
  while (changes.length) {
    const group = [changes.shift()!];
    for (let index = 0; index < changes.length;) {
      if (group.some((item) => overlap(item.edit, changes[index]!.edit))) {
        group.push(changes.splice(index, 1)[0]!);
        index = 0;
      } else index++;
    }
    const start = Math.min(...group.map((item) => item.edit.start));
    const end = Math.max(...group.map((item) => item.edit.end));
    parts.push(base.slice(cursor, start).join(''));
    const own = group
      .filter((item) => item.side === 'ours')
      .map((item) => item.edit)
      .sort((a, b) => a.start - b.start);
    const other = group
      .filter((item) => item.side === 'theirs')
      .map((item) => item.edit)
      .sort((a, b) => a.start - b.start);
    const mine = render(base, own, start, end);
    const theirs = render(base, other, start, end);
    if (!own.length) parts.push(theirs);
    else if (!other.length || mine === theirs) parts.push(mine);
    else {
      clean = false;
      parts.push(`<<<<<<<\n${mine}\n=======\n${theirs}\n>>>>>>>`);
    }
    cursor = end;
  }
  parts.push(base.slice(cursor).join(''));
  return clean ? { clean: true, text: parts.join('') } : { clean: false, proposal: parts.join('') };
}
