import type * as Deck from './deck.js';
import type * as Word from './word.js';

/**
 * The Word and PowerPoint writers, loaded the first time someone makes a document rather than every
 * time the server starts.  The Word library looks for a browser's `localStorage` as it loads, which
 * Node answers with a warning printed to the server's output, so while it loads the global reads as
 * missing, and it's put back as it was straight after.
 */

export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PPTX_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

async function withoutStorage<T>(load: () => Promise<T>): Promise<T> {
  const own = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  if (own && !own.configurable) return load();
  Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true });
  try {
    return await load();
  } finally {
    if (own) Object.defineProperty(globalThis, 'localStorage', own);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

let word: Promise<typeof Word> | undefined;
let deck: Promise<typeof Deck> | undefined;

/** A failed load is forgotten, so the next document tries again. */
function remembered<T>(load: () => Promise<T>, forget: () => void): Promise<T> {
  return load().catch((error: unknown) => {
    forget();
    throw error;
  });
}

export function wordWriter(): Promise<typeof Word> {
  word ??= remembered(
    () => withoutStorage(() => import('./word.js')),
    () => (word = undefined),
  );
  return word;
}

export function deckWriter(): Promise<typeof Deck> {
  deck ??= remembered(
    () => import('./deck.js'),
    () => (deck = undefined),
  );
  return deck;
}
