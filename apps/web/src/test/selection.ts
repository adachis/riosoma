/**
 * The DOM emulator answers every selection mutation with a Range of its own and dispatches
 * `selectionchange` from inside that mutation, so a listener that puts the selection back where it
 * was—which is what React Aria's date segments do to keep a caret collapsed—is called again by the
 * event it just caused, and again, until the stack gives out.  A browser queues one event per turn
 * and sends it only when the selection really moved, so the same listener settles after a single
 * pass.  This gives the emulator that behavior: a mutation that leaves the selection where it was
 * stays quiet, and a mutation made while an event is being delivered waits for that delivery.
 */

/** How many times a listener may move the selection before it counts as settled. */
const PASSES = 8;

/** The selection methods that can move it, and so can owe the page a `selectionchange`. */
const MUTATIONS = [
  'addRange',
  'collapse',
  'collapseToEnd',
  'collapseToStart',
  'empty',
  'extend',
  'removeAllRanges',
  'removeRange',
  'selectAllChildren',
  'setBaseAndExtent',
  'setPosition',
] as const;

/** Marks a prototype this has already wrapped, so a second call changes nothing. */
const installed = Symbol.for('riosoma.selectionFidelity');

/** Where a selection is, in the parts a browser compares before it says the selection moved. */
function snapshot(view: Window): unknown[] {
  const selection = view.getSelection();
  if (!selection || selection.rangeCount === 0) return ['none'];
  // The emulator keeps an omitted offset as undefined where a browser reads it as a zero.
  const point = (node: Node | null, offset: number): unknown[] => [node, offset ?? 0];
  return [
    ...point(selection.anchorNode, selection.anchorOffset),
    ...point(selection.focusNode, selection.focusOffset),
    selection.isCollapsed,
    selection.type,
  ];
}

/** Whether a snapshot differs from the one the last delivered event described. */
function moved(previous: unknown[] | null, next: unknown[]): boolean {
  if (previous === null) return true;
  if (previous.length !== next.length) return true;
  return next.some((part, index) => !Object.is(part, previous[index]));
}

export function installSelectionChangeFidelity(view: Window & typeof globalThis = window): void {
  const prototype: object | undefined = view.Selection?.prototype;
  if (!prototype || installed in prototype) return;
  Object.defineProperty(prototype, installed, { value: true });

  const document = view.document;
  const dispatch = document.dispatchEvent.bind(document) as typeof document.dispatchEvent;
  const methods = prototype as unknown as Record<string, unknown>;
  /** A selection method is running, so the event the emulator sends inside it is ours to send. */
  let mutating = false;
  /** An event is being delivered, so a listener's own mutation waits for the delivery to end. */
  let delivering = false;
  let queued = false;
  let delivered: unknown[] | null = null;

  document.dispatchEvent = ((event: Event): boolean =>
    event.type === 'selectionchange' && mutating ? true : dispatch(event)) as typeof document.dispatchEvent;

  const settle = (): void => {
    if (delivering) {
      queued = true;
      return;
    }
    delivering = true;
    try {
      // A listener that keeps moving the selection is left where it landed instead of being heard
      // without end, which is all the emulator's synchronous dispatch could do anyway.
      for (let pass = 0; pass < PASSES; pass += 1) {
        queued = false;
        const next = snapshot(view);
        if (moved(delivered, next)) {
          delivered = next;
          dispatch(new view.Event('selectionchange'));
        }
        if (!queued) break;
      }
      queued = false;
    } finally {
      delivering = false;
    }
  };

  for (const name of MUTATIONS) {
    const method = methods[name];
    if (typeof method !== 'function') continue;
    methods[name] = function (this: Selection, ...args: unknown[]): unknown {
      mutating = true;
      let result: unknown;
      try {
        result = (method as (...values: unknown[]) => unknown).apply(this, args);
      } finally {
        mutating = false;
      }
      settle();
      return result;
    };
  }
}
