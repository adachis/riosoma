/** What a file reader holds, seen two ways. */
export interface MemoryUse {
  /** V8 heap the reader and its host have grown by. */
  heapBytes: number;
  /** External storage the reader and its host have reserved, such as buffers, whether or not it is resident. */
  externalBytes: number;
  /** Resident growth of the reader's process since the reader was ready, which includes native allocations. */
  residentBytes: number;
}

/**
 * Holds each view to the budget on its own.  A buffer counts in both once its pages are touched, so adding
 * the views together would count it twice, while an untouched reservation shows only in the first view and
 * a native allocation only in the second.
 */
export function overBudget(use: MemoryUse, budgetBytes: number): boolean {
  return Math.max(use.heapBytes + use.externalBytes, use.residentBytes) > budgetBytes;
}
