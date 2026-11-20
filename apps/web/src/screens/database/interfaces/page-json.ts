import { InterfacePage, type InterfacePage as Page } from '@riosoma/contracts';

export type PageJsonResult = { page: Page; path?: never } | { page?: never; path: string };

/** Preserve page identity and block links so JSON and visual edits obey the same rules */
export function parsePageJson(text: string, originalId: string, pages: readonly Page[]): PageJsonResult {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return { path: '$' };
  }
  const result = InterfacePage.safeParse(input);
  if (!result.success) return { path: result.error.issues[0]?.path.join('.') || '$' };
  const page = result.data;
  if (page.id !== originalId) return { path: 'id' };
  const ids = new Set(
    pages.filter((item) => item.id !== originalId).flatMap((item) => item.blocks.map((block) => block.id)),
  );
  for (const [index, block] of page.blocks.entries()) {
    if (ids.has(block.id)) return { path: `blocks.${index}.id` };
    ids.add(block.id);
    if (block.kind === 'record') {
      const source = page.blocks.find((item) => item.id === block.recordsBlockId);
      if (block.recordsBlockId === null ? block.fieldIds.length > 0 : source?.kind !== 'records')
        return { path: `blocks.${index}.recordsBlockId` };
    }
    if (
      block.kind === 'filter' &&
      block.blockIds.some((id) => {
        const source = page.blocks.find((item) => item.id === id);
        return source?.kind !== 'records' || source.source.tableId !== block.tableId;
      })
    )
      return { path: `blocks.${index}.blockIds` };
  }
  return { page };
}
