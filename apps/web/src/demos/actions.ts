import type { DemoStep } from '@riosoma/contracts';
import { anchorInfo, preloadAnchor } from './anchors';

/**
 * What a demo does to the page, and how it puts the page back.  Demos press, focus, and type the
 * way a person would, through the same events, and a journal remembers what each action changed
 * so that stopping restores it: typed values, opened menus and dialogs, and scroll positions.
 */

/** Where the demo's own controls live, which the page's lookups skip. */
export const LAYER = '[data-demo-layer]';

export function restoreDemoFocus(target: HTMLElement | null): () => void {
  if (!target) return () => undefined;
  let frame: number | null = null;
  let observer: MutationObserver | null = null;
  let canceled = false;
  function ready() {
    if (canceled || !target?.isConnected) {
      observer?.disconnect();
      return;
    }
    // The runner can finish before the next render enables its start button.  A focus call
    // while that button is disabled is ignored, so wait for its actual enabled state.
    if (target.matches(':disabled, [aria-disabled="true"]')) {
      observer ??= new MutationObserver(ready);
      observer.observe(target, { attributes: true, attributeFilter: ['disabled', 'aria-disabled'] });
      return;
    }
    observer?.disconnect();
    frame = requestAnimationFrame(() => {
      // Overlay focus scopes restore their own triggers on the first frame after teardown.
      frame = requestAnimationFrame(() => {
        if (canceled || !target.isConnected) return;
        if (target.matches(':disabled, [aria-disabled="true"]')) ready();
        else target.focus();
      });
    });
  }
  ready();
  return () => {
    canceled = true;
    if (frame !== null) cancelAnimationFrame(frame);
    observer?.disconnect();
  };
}

const OVERLAYS =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="complementary"], aside';
const PRESSABLE = 'button, [role="button"], a[href], [aria-haspopup], [role="menuitem"], [role="option"]';
const TYPABLE = 'input:not([type="hidden"]), textarea, [contenteditable="true"]';

function visible(element: Element): boolean {
  // A dialog makes the page behind it inert, but a demo can still point there.
  if (!element.isConnected || element.closest('[hidden]') || element.closest(LAYER)) return false;
  const check = (element as Element & { checkVisibility?: () => boolean }).checkVisibility;
  return typeof check === 'function' ? check.call(element) : true;
}

/** The first visible control with the anchor. */
export function findAnchor(root: ParentNode, id: string): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>(`[data-anchor="${CSS.escape(id)}"]`))
    if (visible(element)) return element;
  return null;
}

/** An item in the menu or list an anchor opened, by its key. */
export function findItem(root: Document, anchor: Element, key: string): HTMLElement | null {
  const selector = `[data-key="${CSS.escape(key)}"]`;
  const trigger = pressable(anchor);
  const controlled = trigger?.getAttribute('aria-controls');
  const owner = controlled ? root.getElementById(controlled) : null;
  const inOwner = owner?.querySelector<HTMLElement>(selector);
  if (inOwner && visible(inOwner)) return inOwner;
  const lists = [...root.querySelectorAll('[role="menu"], [role="listbox"]')].filter(visible).reverse();
  for (const list of lists) {
    const item = list.querySelector<HTMLElement>(selector);
    if (item && visible(item)) return item;
  }
  return null;
}

function matches(element: Element, selector: string): boolean {
  return element.matches(selector);
}

/** The control a press lands on: the anchor itself, or the first pressable control inside it. */
export function pressable(anchor: Element): HTMLElement | null {
  if (matches(anchor, PRESSABLE)) return anchor as HTMLElement;
  return anchor.querySelector<HTMLElement>(PRESSABLE);
}

/** The field typing lands in: the anchor itself, or the first field inside it. */
export function typable(anchor: Element): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
  if (matches(anchor, TYPABLE)) return anchor as HTMLElement;
  return anchor.querySelector<HTMLElement>(TYPABLE);
}

export type Refusal = 'persists' | 'external' | 'outside';

/**
 * Whether a step's action may touch this element.  The anchor's own marks come first, then the
 * page's: anything marked as saving or leaving, a form's submit button, a link to another site,
 * and a file picker are all off limits, and a choice has to be inside a menu, list, or popover.
 */
export function refusal(step: DemoStep, element: Element): Refusal | null {
  if (!step.do || step.do === 'scroll' || step.do === 'wait') return null;
  const info = anchorInfo(step.anchor);
  if (step.item) {
    if (info?.items !== 'local') return 'persists';
  } else {
    if (info?.persists) return 'persists';
    if (info?.external) return 'external';
  }
  const marked = element.closest('[data-persists], [data-external]');
  if (marked) return marked.hasAttribute('data-external') ? 'external' : 'persists';
  if (element.matches('button[type="submit"], input[type="submit"], input[type="image"]')) return 'persists';
  if (element.matches('input[type="file"]')) return 'external';
  const link = element.closest('a[href]');
  if (link) {
    if (link.getAttribute('target') === '_blank' || link.hasAttribute('download')) return 'external';
    try {
      if (new URL(link.getAttribute('href')!, location.href).origin !== location.origin) return 'external';
    } catch {
      return 'external';
    }
  }
  if (step.do === 'choose' && !element.closest('[role="menu"], [role="listbox"], [role="dialog"]'))
    return 'outside';
  return null;
}

interface OpenedOverlay {
  trigger: HTMLElement;
  /** What it opened, once that's known */
  container: Element | null;
  /** What was already open before it, so what it opened can be found later if it came late */
  before: Set<Element>;
}

export interface Pacing {
  /** Types everything at once and scrolls without animating */
  instant: boolean;
  /** Called between typed characters.  Returns false to finish the rest at once. */
  keepPace(): boolean;
  wait(ms: number): Promise<void>;
}

/** Sets a field's value the way typing does, so the page's own handlers see the change. */
export function setFieldValue(field: HTMLElement, value: string): void {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    const prototype =
      field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(field, value);
    else field.value = value;
  } else field.textContent = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

function fieldValue(field: HTMLElement): string {
  return field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
    ? field.value
    : (field.textContent ?? '');
}

function overlays(root: Document): Set<Element> {
  return new Set(
    [...root.querySelectorAll(OVERLAYS)].filter(
      (element) => !element.closest(LAYER) && !element.querySelector('.rio-feature-loading'),
    ),
  );
}

/** The outermost of the elements, leaving out any inside another. */
function outermost(elements: readonly Element[]): Element | null {
  return (
    elements.find((element) => !elements.some((other) => other !== element && other.contains(element))) ??
    null
  );
}

/**
 * Everything the demo did that the page wouldn't undo by itself, and how to put it back.  The
 * sandbox takes care of changes to databases.
 */
export class Journal {
  private opened: OpenedOverlay[] = [];
  private values: Array<{ field: HTMLElement; value: string }> = [];
  private scrolls = new Map<Element | 'window', { top: number; left: number }>();
  /** Set while the journal dispatches keys of its own, so the demo's Escape doesn't stop itself */
  dispatching = false;

  constructor(private readonly root: Document) {}

  /** Remembers where everything that scrolls around an element is, before the demo scrolls it. */
  rememberScroll(element: Element): void {
    const view = this.root.defaultView;
    if (view && !this.scrolls.has('window'))
      this.scrolls.set('window', { top: view.scrollY, left: view.scrollX });
    for (let node = element.parentElement; node; node = node.parentElement) {
      if (this.scrolls.has(node)) continue;
      if (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)
        this.scrolls.set(node, { top: node.scrollTop, left: node.scrollLeft });
    }
  }

  /** Brings an element into view, when it's out of it. */
  reveal(element: Element, instant: boolean): void {
    const view = this.root.defaultView;
    const rect = element.getBoundingClientRect();
    if (!view || (rect.width === 0 && rect.height === 0)) return;
    const inside =
      rect.top >= 0 && rect.left >= 0 && rect.bottom <= view.innerHeight && rect.right <= view.innerWidth;
    if (inside) return;
    this.rememberScroll(element);
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: instant ? 'auto' : 'smooth' });
  }

  /**
   * Closes what the demo opened, newest first, until it reaches something that holds this element,
   * the way a person closes a menu before moving on.  What's open stacks like the page does: a
   * list opened inside a dialog floats outside it, but the dialog under it stays open.
   */
  async closeAround(element: Element, pacing: Pacing): Promise<void> {
    for (const earlier of [...this.opened].reverse()) {
      const container = this.resolve(earlier);
      if (container?.contains(element) || earlier.trigger.contains(element)) return;
      await this.close(earlier, pacing);
    }
  }

  async open(anchor: HTMLElement, pacing: Pacing): Promise<void> {
    const trigger = pressable(anchor) ?? anchor;
    await preloadAnchor(trigger);
    const before = overlays(this.root);
    trigger.click();
    const record: OpenedOverlay = { trigger, container: null, before };
    for (let tries = 0; tries < 20 && !this.resolve(record); tries++) await pacing.wait(50);
    // Dialog autofocus can wait for an entry animation after the controls appear.
    if (record.container) {
      const animations = new Set<Animation>();
      for (let element: Element | null = record.container; element; element = element.parentElement) {
        for (const animation of element.getAnimations?.() ?? []) {
          if (
            animation.playState === 'running' &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime)
          )
            animations.add(animation);
        }
      }
      await Promise.all([...animations].map((animation) => animation.finished.catch(() => undefined)));
      await pacing.wait(50);
    }
    this.opened.push(record);
  }

  /** What an opened control opened: what its trigger names, or what appeared once it was pressed. */
  private resolve(record: OpenedOverlay): Element | null {
    // Once found, it stays the one, even closed, so something opened later is never taken for it.
    if (record.container) return record.container;
    const controlled = record.trigger.getAttribute('aria-controls');
    const owner = controlled ? this.root.getElementById(controlled) : null;
    // A loading shell can be replaced before its controls take focus; journal the settled surface.
    const found =
      owner && !owner.querySelector('.rio-feature-loading')
        ? owner
        : outermost([...overlays(this.root)].filter((element) => !record.before.has(element)));
    if (found) record.container = found;
    return found;
  }

  async type(field: HTMLElement, text: string, pacing: Pacing): Promise<void> {
    if (!this.values.some((entry) => entry.field === field))
      this.values.push({ field, value: fieldValue(field) });
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      if (field.disabled || field.readOnly) return;
    }
    field.focus({ preventScroll: true });
    if (pacing.instant) {
      setFieldValue(field, text);
      return;
    }
    for (let length = 1; length <= text.length; length++) {
      if (!pacing.keepPace()) {
        setFieldValue(field, text);
        return;
      }
      setFieldValue(field, text.slice(0, length));
      if (length < text.length) await pacing.wait(45);
    }
  }

  choose(element: HTMLElement): void {
    element.click();
  }

  focus(element: HTMLElement): void {
    const target = typable(element) ?? pressable(element) ?? element;
    target.focus({ preventScroll: true });
  }

  scroll(element: Element, instant: boolean): void {
    this.rememberScroll(element);
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: instant ? 'auto' : 'smooth' });
  }

  private isOpen(record: OpenedOverlay): boolean {
    const container = this.resolve(record);
    // An exiting modal still owns focus until its surface unmounts.
    if (container) return container.isConnected;
    return record.trigger.getAttribute('aria-expanded') === 'true';
  }

  private escape(target: Element): void {
    this.dispatching = true;
    try {
      for (const type of ['keydown', 'keyup'])
        target.dispatchEvent(
          new KeyboardEvent(type, { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }),
        );
    } finally {
      this.dispatching = false;
    }
  }

  /**
   * Closes something the demo opened, with Escape, the way a person would.  Where the key has to
   * land differs: a popover listens on itself, and a panel on its own content, while a control
   * inside can keep the key for itself, so each place gets a turn until it closes.  A trigger that
   * still says it's open is pressed again as a last resort.
   */
  private async close(record: OpenedOverlay, pacing?: Pacing): Promise<void> {
    this.opened = this.opened.filter((entry) => entry !== record);
    const pause = () => pacing?.wait(120) ?? new Promise<void>((resolve) => setTimeout(resolve, 120));
    const container = this.resolve(record);
    const { trigger } = record;
    const active = this.root.activeElement;
    const targets = [
      container,
      container && active && container.contains(active) ? active : null,
      container?.firstElementChild ?? null,
      container?.querySelector('button, input, textarea, [tabindex]') ?? null,
      container ? null : trigger,
    ].filter((target, index, all): target is Element => !!target && all.indexOf(target) === index);
    for (const target of targets) {
      if (!this.isOpen(record)) return;
      this.escape(target);
      await pause();
    }
    if (this.isOpen(record) && trigger.getAttribute('aria-expanded') === 'true') {
      trigger.click();
      await pause();
    }
  }

  /** Puts the page back: typed values, then anything opened, newest first, then scroll positions. */
  async restore(pacing: Pacing): Promise<void> {
    for (const { field, value } of this.values.splice(0).reverse())
      if (field.isConnected && fieldValue(field) !== value) setFieldValue(field, value);
    for (const record of [...this.opened].reverse()) await this.close(record, pacing);
    const view = this.root.defaultView;
    for (const [node, { top, left }] of this.scrolls) {
      if (node === 'window') view?.scrollTo({ top, left, behavior: 'auto' });
      else if (node.isConnected) {
        node.scrollTop = top;
        node.scrollLeft = left;
      }
    }
    this.scrolls.clear();
  }
}
