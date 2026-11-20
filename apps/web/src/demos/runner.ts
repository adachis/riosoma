import type { DemoScript, DemoStep } from '@riosoma/contracts';
import type { Narration, Playback } from '../audio/director';
import { findAnchor, findItem, Journal, pressable, refusal, typable, type Pacing } from './actions';

/**
 * Plays a demo script in the real interface.  Each step finds its control, points at it, says its
 * line, and does its one action, and the demo moves on when both are done, at the narration's
 * pace.  It can be paused, stepped back and forward, and stopped, and however it ends, the page
 * and every database go back to exactly how they were.
 */

export type DemoOutcome =
  /** Every step played */
  | 'finished'
  /** The person stopped it */
  | 'stopped'
  /** The first step's control isn't on this page */
  | 'where'
  /** A step's control is above the person's level */
  | 'level'
  /** A step's control isn't there, most likely for lack of access */
  | 'access'
  /** A step would have touched something that saves or leaves */
  | 'refused';

export interface DemoState {
  status: 'playing' | 'paused' | 'ended';
  index: number;
  total: number;
  /** The current step's narration */
  caption: string;
  /** What the current step points at */
  target: Element | null;
  outcome?: DemoOutcome;
}

export interface RunnerDeps {
  document: Document;
  /** Plays narration one line at a time, the app's audio director */
  narrate(line: Narration): Playback;
  stopNarration(): void;
  sandbox: { begin(): void; reset(): void; end(): void };
  /** A message's text in the reader's language */
  say(id: string): string;
  lang: string;
  /** Recorded clips are looked for here, as `<base>/<locale>/<clip>.mp3` */
  clipBase?: string;
  reducedMotion(): boolean;
  /** Whether the demo's help module is above the person's level */
  aboveLevel: boolean;
  setTimeout?(callback: () => void, ms: number): unknown;
  clearTimeout?(timer: unknown): void;
  timing?: Partial<Timing>;
}

export interface Timing {
  /** How long to look for a control that a previous step is still opening */
  find: number;
  /** A beat between pointing at a control and acting on it, so eyes can find it first */
  beat: number;
  /** The pause between steps */
  gap: number;
}

const TIMING: Timing = { find: 2500, beat: 350, gap: 600 };

export class DemoRunner {
  private state: DemoState;
  private listeners = new Set<() => void>();
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly journal: Journal;
  private narration: Playback | null = null;
  private done = new Set<number>();
  private timers = new Set<unknown>();
  private ended = false;
  private readonly timing: Timing;

  constructor(
    private readonly script: DemoScript,
    private readonly deps: RunnerDeps,
  ) {
    this.journal = new Journal(deps.document);
    this.timing = { ...TIMING, ...deps.timing };
    this.state = { status: 'playing', index: 0, total: script.steps.length, caption: '', target: null };
  }

  getState = (): DemoState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** True while the demo presses keys itself, such as Escape to close a menu it opened */
  get dispatching(): boolean {
    return this.journal.dispatching;
  }

  private set(patch: Partial<DemoState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const set =
        this.deps.setTimeout ?? ((callback, delay) => globalThis.setTimeout(() => callback(), delay));
      const timer = set(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      this.timers.add(timer);
    });
  }

  private pacing(generation: number, instant = false): Pacing {
    const reduced = this.deps.reducedMotion();
    return {
      instant: instant || reduced,
      keepPace: () => generation === this.generation,
      wait: (ms) => this.wait(ms),
    };
  }

  /** Runs a change of step after anything already under way, and cancels what was waiting. */
  private transition(body: (generation: number) => Promise<void>): Promise<void> {
    const generation = ++this.generation;
    this.stopLine();
    const next = this.queue.then(() => (this.ended ? undefined : body(generation)));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private stopLine(): void {
    this.narration?.stop();
    this.narration = null;
    this.deps.stopNarration();
  }

  start(): Promise<void> {
    this.deps.sandbox.begin();
    return this.transition((generation) => this.enter(0, generation));
  }

  pause(): void {
    if (this.state.status !== 'playing') return;
    this.generation++;
    this.stopLine();
    this.set({ status: 'paused' });
  }

  resume(): void {
    if (this.state.status !== 'paused') return;
    this.set({ status: 'playing' });
    const index = this.state.index;
    void this.transition(async (generation) => {
      // Paused before the step found its control, it starts the step over.  Otherwise it says the
      // line again and carries on.
      if (!this.state.target) await this.enter(index, generation);
      else void this.advanceAfter(this.line(index), index, generation);
    });
  }

  next(): Promise<void> {
    const index = this.state.index + 1;
    return this.transition((generation) =>
      index < this.script.steps.length ? this.enter(index, generation) : this.finish('finished'),
    );
  }

  back(): Promise<void> {
    const index = Math.max(0, this.state.index - 1);
    return this.transition(async (generation) => {
      await this.rewind(generation);
      if (!this.ended) await this.enter(index, generation);
    });
  }

  stop(): Promise<void> {
    return this.transition(() => this.finish('stopped'));
  }

  /** Looks for a step's control for a moment, since the step before may still be opening it. */
  private async find(step: DemoStep, generation: number): Promise<HTMLElement | null> {
    const { document } = this.deps;
    for (let waited = 0; ; waited += 100) {
      const anchor = findAnchor(document, step.anchor);
      const found = anchor && step.item ? findItem(document, anchor, step.item) : anchor;
      if (found || waited >= this.timing.find || generation !== this.generation) return found;
      await this.wait(100);
    }
  }

  private missing(index: number): DemoOutcome {
    if (this.deps.aboveLevel) return 'level';
    const { where } = this.script;
    const place = where === 'table' ? 'database.views' : where === 'database' ? 'database.tables' : null;
    if (index === 0 && place && !findAnchor(this.deps.document, place)) return 'where';
    return 'access';
  }

  /** Does a step's action.  Returns false when the demo had to stop instead. */
  private async act(
    index: number,
    element: HTMLElement,
    generation: number,
    instant: boolean,
  ): Promise<boolean> {
    const step = this.script.steps[index]!;
    if (this.done.has(index) || !step.do) {
      this.done.add(index);
      return true;
    }
    const target =
      step.do === 'type' || step.do === 'focus'
        ? (typable(element) ?? element)
        : step.do === 'open' || (step.do === 'choose' && !step.item)
          ? (pressable(element) ?? element)
          : element;
    if (refusal(step, target)) {
      await this.finish('refused');
      return false;
    }
    const pacing = this.pacing(generation, instant);
    this.done.add(index);
    const keepFocus = this.deps.document.activeElement?.closest('[data-demo-layer]') as HTMLElement | null;
    const returnFocus = keepFocus ? (this.deps.document.activeElement as HTMLElement) : null;
    switch (step.do) {
      case 'open':
        await this.journal.open(element, pacing);
        break;
      case 'choose':
        this.journal.choose(target);
        break;
      case 'focus':
        this.journal.focus(target);
        break;
      case 'type':
        await this.journal.type(target, this.deps.say(step.text!), pacing);
        break;
      case 'scroll':
        this.journal.scroll(element, pacing.instant);
        break;
      case 'wait':
        break;
    }
    // Someone following along with the keyboard keeps their place in the demo's controls, unless
    // the step was about moving focus.  Dialog autofocus can wait for CSS transitions to end.
    if (returnFocus?.isConnected && step.do !== 'focus') {
      const view = this.deps.document.defaultView;
      if (view) {
        await new Promise<void>((resolve) =>
          view.requestAnimationFrame(() => view.requestAnimationFrame(() => resolve())),
        );
        // Poll so an animation paused offscreen does not hold the demo's controls indefinitely.
        while (
          generation === this.generation &&
          this.deps.document
            .getAnimations?.()
            .some(
              (animation) =>
                animation.playState === 'running' &&
                Number.isFinite(animation.effect?.getComputedTiming().endTime),
            )
        )
          await new Promise<void>((resolve) => view.requestAnimationFrame(() => resolve()));
        // Transition completion can schedule autofocus on the following paint.
        await new Promise<void>((resolve) =>
          view.requestAnimationFrame(() => view.requestAnimationFrame(() => resolve())),
        );
      }
      if (
        !this.ended &&
        returnFocus.isConnected &&
        !this.deps.document.activeElement?.closest('[data-demo-layer]')
      )
        returnFocus.focus({ preventScroll: true });
    }
    return true;
  }

  /** Shows a step: finds its control, points at it, says its line, and does its action. */
  private async enter(index: number, generation: number): Promise<void> {
    const step = this.script.steps[index]!;
    this.set({ index, caption: this.deps.say(step.say), target: null });
    if (!(await this.catchUp(index, generation))) return;
    const element = await this.find(step, generation);
    if (generation !== this.generation || this.ended) return;
    if (!element) {
      await this.finish(this.missing(index));
      return;
    }
    await this.journal.closeAround(element, this.pacing(generation, true));
    this.journal.reveal(element, this.deps.reducedMotion());
    this.set({ target: element });
    const spoken = this.state.status === 'playing' ? this.line(index) : null;
    if (step.do && !this.done.has(index)) await this.wait(this.deps.reducedMotion() ? 0 : this.timing.beat);
    const acted = await this.act(index, element, generation, false);
    if (!acted) return;
    // A choice closes its list, so the outline moves back to the control the list belongs to.
    if (step.item && step.do === 'choose') this.set({ target: findAnchor(this.deps.document, step.anchor) });
    else if (!element.isConnected) this.set({ target: findAnchor(this.deps.document, step.anchor) });
    if (spoken) void this.advanceAfter(spoken, index, generation);
  }

  private line(index: number): Playback {
    const step = this.script.steps[index]!;
    const base = this.deps.clipBase ?? '/narration';
    const playback = this.deps.narrate({
      text: this.deps.say(step.say),
      lang: this.deps.lang,
      ...(step.audio ? { clip: `${base}/${this.deps.lang}/${step.audio}.mp3` } : {}),
    });
    this.narration = playback;
    return playback;
  }

  private async advanceAfter(spoken: Playback, index: number, generation: number): Promise<void> {
    const result = await spoken.done;
    if (result !== 'ended' || generation !== this.generation || this.state.status !== 'playing') return;
    const step = this.script.steps[index]!;
    await this.wait(step.do === 'wait' ? (step.ms ?? this.timing.gap) : this.timing.gap);
    if (generation !== this.generation || this.state.status !== 'playing' || this.ended) return;
    void this.next();
  }

  /**
   * Goes back to how the page was before the demo began: puts everything back and starts a fresh
   * sandbox.  Entering a step then does the earlier steps' actions again, quickly.
   */
  private async rewind(generation: number): Promise<void> {
    await this.journal.restore(this.pacing(generation, true));
    this.deps.sandbox.reset();
    this.done.clear();
  }

  /**
   * Does, at once, any earlier step's action that hasn't been done, as after stepping back, or
   * after moving on while a step was still finding its control.  Returns false when it had to stop.
   */
  private async catchUp(index: number, generation: number): Promise<boolean> {
    for (let earlier = 0; earlier < index; earlier++) {
      const step = this.script.steps[earlier]!;
      if (this.done.has(earlier) || !step.do || step.do === 'wait' || step.do === 'scroll') continue;
      const element = await this.find(step, generation);
      if (this.ended || generation !== this.generation) return false;
      if (!element) {
        await this.finish(this.missing(earlier));
        return false;
      }
      await this.journal.closeAround(element, this.pacing(generation, true));
      if (!(await this.act(earlier, element, generation, true))) return false;
    }
    return true;
  }

  /** Ends the demo, however it ended, and puts everything back. */
  private async finish(outcome: DemoOutcome): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.generation++;
    this.stopLine();
    this.set({ target: null });
    try {
      await this.journal.restore(this.pacing(this.generation, true));
    } finally {
      this.deps.sandbox.end();
      const clear = this.deps.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer as number));
      for (const timer of this.timers) clear(timer);
      this.timers.clear();
      this.set({ status: 'ended', outcome, target: null });
    }
  }
}
