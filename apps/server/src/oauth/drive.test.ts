import type { DriveEntry, DriveListing } from '@riosoma/contracts';
import { describe, expect, it } from 'vitest';
import { gatherListing, LISTING_ENTRIES, LISTING_MS } from './drive.js';

const entry = (name: string, kind: 'file' | 'folder' = 'file'): DriveEntry => ({
  id: `id:${name}`,
  name,
  kind,
  size: kind === 'file' ? 1 : null,
  modifiedAt: null,
  thumbnail: false,
});

/** A drive that answers from a list of pages, each naming the next by its index. */
function pages(...answers: DriveEntry[][]) {
  const asked: string[] = [];
  const answer = (index: number): DriveListing => ({
    entries: answers[index]!,
    cursor: index + 1 < answers.length ? String(index + 1) : null,
  });
  return {
    asked,
    first: async () => {
      asked.push('first');
      return answer(0);
    },
    next: async (cursor: string) => {
      asked.push(cursor);
      return answer(Number(cursor));
    },
  };
}

describe('gathering a listing', () => {
  it('reads past short and empty pages until the folder is whole', async () => {
    const drive = pages([entry('b.txt')], [], [entry('a.txt')], [entry('Notes', 'folder')]);
    const listing = await gatherListing(drive.first, drive.next, { sort: true });
    expect(drive.asked).toEqual(['first', '1', '2', '3']);
    expect(listing.cursor).toBeNull();
    expect(listing.entries.map((found) => found.name)).toEqual(['Notes', 'a.txt', 'b.txt']);
  });

  it('puts folders first and orders names as people read them', async () => {
    const drive = pages([
      entry('File 10'),
      entry('file 9'),
      entry('Zeta', 'folder'),
      entry('alpha', 'folder'),
    ]);
    const listing = await gatherListing(drive.first, drive.next, { sort: true });
    expect(listing.entries.map((found) => found.name)).toEqual(['alpha', 'Zeta', 'file 9', 'File 10']);
  });

  it("keeps a search in the drive's own order", async () => {
    const drive = pages([entry('b.txt'), entry('Folder', 'folder')], [entry('a.txt')]);
    const listing = await gatherListing(drive.first, drive.next, { sort: false });
    expect(listing.entries.map((found) => found.name)).toEqual(['b.txt', 'Folder', 'a.txt']);
  });

  it('answers with what it has and a cursor once it holds enough entries', async () => {
    const big = Array.from({ length: LISTING_ENTRIES / 2 }, (_, index) => entry(`file ${index}`));
    const drive = pages(big, big, big);
    const listing = await gatherListing(drive.first, drive.next, { sort: true });
    expect(drive.asked).toEqual(['first', '1']);
    expect(listing.entries).toHaveLength(LISTING_ENTRIES);
    expect(listing.cursor).toBe('2');
  });

  it('answers with what it has and a cursor once it has taken long enough', async () => {
    let clock = 0;
    const drive = pages([entry('a')], [entry('b')], [entry('c')]);
    const slow = async (cursor: string) => {
      clock += LISTING_MS;
      return drive.next(cursor);
    };
    const listing = await gatherListing(drive.first, slow, { sort: true, now: () => clock });
    expect(drive.asked).toEqual(['first', '1']);
    expect(listing.entries.map((found) => found.name)).toEqual(['a', 'b']);
    expect(listing.cursor).toBe('2');
  });
});
