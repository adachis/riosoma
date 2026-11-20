import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { toast, toastQueue } from '@riosoma/ui';
import type { Preferences, SessionInfo } from '@riosoma/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeRioReactions, type RioReaction } from '../rio/reactions';
import { CelebrationLayer, editingBox } from './CelebrationLayer';
import type { AnimationClock } from './confetti';
import { CelebrationEngine, memoryStore } from './engine';
import { KONAMI } from './surprises';

const signedIn = vi.hoisted(() => ({ preferences: {} as Preferences }));
vi.mock('../../session', () => ({
  useSession: () => ({ user: { id: 'user-one' }, preferences: signedIn.preferences }) as SessionInfo,
}));

let reducedMotion = false;
const reactions: RioReaction[] = [];
let stopListening: () => void = () => undefined;

/** Frames run only when the test asks, and the end-of-celebration timer is a real (fake) timer. */
function manualClock() {
  const frames = new Map<number, () => void>();
  let next = 0;
  let time = 0;
  const clock: AnimationClock = {
    now: () => time,
    frame: (callback) => {
      frames.set(++next, callback);
      return next;
    },
    cancelFrame: (handle) => void frames.delete(handle),
    later: (callback, ms) => setTimeout(callback, ms),
    cancelLater: (handle) => clearTimeout(handle),
  };
  return {
    clock,
    frame() {
      time += 16;
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    },
  };
}

function setup(preferences: Preferences = {}) {
  signedIn.preferences = preferences;
  const engine = new CelebrationEngine({ store: memoryStore(), random: () => 0 });
  const player = { play: vi.fn(() => true), stop: vi.fn() };
  const { clock, frame } = manualClock();
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  const view = render(
    <I18nProvider i18n={i18n}>
      <CelebrationLayer engine={engine} player={player} clock={clock} />
    </I18nProvider>,
  );
  const overlay = view.container.querySelector<HTMLElement>('.rio-celebrations')!;
  const person = { userId: 'user-one', level: 'on' as const };
  return {
    engine,
    player,
    frame,
    overlay,
    canvas: () => overlay.querySelector<HTMLCanvasElement>('canvas'),
    celebrate(name: 'importClean' | 'kanbanDone', extra: { cause?: 'you' | 'others' } = {}) {
      act(() => void engine.celebrate(name, { ...person, key: `key-${Math.random()}`, ...extra }));
    },
    large() {
      act(() => {
        engine.observe('records100', { ...person, key: 'table-one', reached: false });
        engine.observe('records100', { ...person, key: 'table-one', reached: true });
      });
    },
  };
}

const toastTitles = () => toastQueue.visibleToasts.map((item) => item.content.title);

beforeEach(() => {
  vi.useFakeTimers();
  reducedMotion = false;
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('reduced-motion') && reducedMotion,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
  reactions.length = 0;
  stopListening = subscribeRioReactions((reaction) => reactions.push(reaction));
});

afterEach(() => {
  stopListening();
  cleanup();
  for (const item of toastQueue.visibleToasts) toastQueue.close(item.key);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the celebration overlay', () => {
  it('never receives pointer events, and hides from assistive technology', () => {
    const { overlay, celebrate, canvas } = setup();
    expect(overlay.style.pointerEvents).toBe('none');
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    celebrate('kanbanDone');
    expect(canvas()).not.toBeNull();
    expect(canvas()!.style.pointerEvents).toBe('none');
    expect(overlay.querySelector('button, a, input, [tabindex]')).toBeNull();
  });

  it('draws only while a celebration runs, and is gone within a second and a half', async () => {
    const { celebrate, canvas, frame } = setup();
    expect(canvas()).toBeNull();
    celebrate('kanbanDone');
    expect(canvas()?.dataset.size).toBe('medium');
    await act(async () => {
      await import('./confetti-animation');
    });
    act(() => {
      frame();
      vi.advanceTimersByTime(1500);
    });
    expect(canvas()).toBeNull();
  });

  it('sparkles for a small one, with a happy blink from Rio and no toast', () => {
    const { celebrate, canvas } = setup();
    celebrate('importClean');
    expect(canvas()?.dataset.size).toBe('small');
    expect(reactions).toEqual([{ kind: 'mood', mood: 'happy', seconds: 1.2 }]);
    expect(toastTitles()).toEqual([]);
  });

  it('bursts for a medium one, with a happy Rio and no toast', () => {
    const { celebrate, canvas } = setup();
    celebrate('kanbanDone');
    expect(canvas()?.dataset.size).toBe('medium');
    expect(reactions).toEqual([{ kind: 'mood', mood: 'happy', seconds: 2 }]);
    expect(toastTitles()).toEqual([]);
  });

  it('fills the screen for a large one, with a line from Rio in a toast', () => {
    const { large, canvas } = setup();
    large();
    expect(canvas()?.dataset.size).toBe('large');
    expect(reactions).toEqual([{ kind: 'mood', mood: 'celebrating', seconds: 3 }]);
    expect(toastTitles()).toEqual(['100 records.  This table is growing roots.']);
  });

  it('shows a quiet toast instead of any animation when the system asks for reduced motion', () => {
    reducedMotion = true;
    const { celebrate, large, canvas } = setup();
    celebrate('kanbanDone');
    large();
    expect(canvas()).toBeNull();
    expect(reactions).toEqual([]);
    expect(toastTitles()).toEqual([
      '100 records.  This table is growing roots.',
      'Every card made it across.  Time to stretch.',
    ]);
  });

  it('shows a quiet toast when the person asked Riosoma for reduced motion', () => {
    const { celebrate, canvas } = setup({ motion: 'reduce' });
    celebrate('importClean');
    expect(canvas()).toBeNull();
    expect(toastTitles()).toEqual(['Every row came in clean.']);
  });

  it('shows only a quiet toast while the tab is hidden', () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const { celebrate, canvas, player } = setup({ soundLevel: 'normal' });
    celebrate('kanbanDone');
    expect(canvas()).toBeNull();
    expect(toastTitles()).toHaveLength(1);
    expect(player.play).not.toHaveBeenCalled();
  });

  it('keeps the field being edited clear of confetti', () => {
    const field = document.createElement('input');
    document.body.append(field);
    vi.spyOn(field, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 50,
      width: 200,
      height: 30,
    } as DOMRect);
    expect(editingBox()).toBeNull();
    field.focus();
    expect(editingBox()).toEqual({ left: 96, top: 46, width: 208, height: 38 });
    field.remove();
  });
});

describe('celebration sounds', () => {
  it('stays silent by default', () => {
    const { celebrate, player } = setup();
    celebrate('importClean');
    act(() => void toast.show({ title: 'Couldn’t save', tone: 'danger' }));
    expect(player.play).not.toHaveBeenCalled();
  });

  it('chimes for a small one and rises for bigger ones, when the person turned sounds on', () => {
    const { celebrate, large, player } = setup({ soundLevel: 'quiet' });
    celebrate('importClean');
    large();
    expect(player.play.mock.calls).toEqual([
      ['chime', 'quiet'],
      ['rise', 'quiet'],
    ]);
  });

  it('stays silent for what someone else set off', () => {
    const { celebrate, player } = setup({ soundLevel: 'normal' });
    celebrate('kanbanDone', { cause: 'others' });
    expect(player.play).not.toHaveBeenCalled();
  });

  it('plays the low tone for an error toast, once', () => {
    const { player } = setup({ soundLevel: 'normal' });
    act(() => void toast.show({ title: 'Saved', tone: 'success' }));
    expect(player.play).not.toHaveBeenCalled();
    act(() => void toast.show({ title: 'Couldn’t save', tone: 'danger' }));
    act(() => void toast.show({ title: 'Saved again', tone: 'success' }));
    expect(player.play.mock.calls).toEqual([['low', 'normal']]);
  });
});

describe('the Konami code', () => {
  function press(codes: readonly string[], target: Element = document.body) {
    for (const code of codes) fireEvent.keyDown(target, { code, key: code });
  }

  it('makes Rio dance', () => {
    setup();
    press(KONAMI);
    expect(reactions).toEqual([{ kind: 'dance' }]);
    press(KONAMI.slice(0, 9));
    expect(reactions).toHaveLength(1);
  });

  it('doesn’t count keys typed into a field', () => {
    setup();
    const field = document.createElement('input');
    document.body.append(field);
    press(KONAMI.slice(0, 5));
    press(KONAMI.slice(5), field);
    expect(reactions).toEqual([]);
    field.remove();
  });

  it('never stops a key from doing what it does', () => {
    setup();
    const events = KONAMI.map(
      (code) => new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }),
    );
    for (const event of events) document.body.dispatchEvent(event);
    expect(events.some((event) => event.defaultPrevented)).toBe(false);
    expect(reactions).toHaveLength(1);
  });

  it('gets a happy blink instead of a dance at reduced motion', () => {
    reducedMotion = true;
    setup();
    press(KONAMI);
    expect(reactions).toEqual([{ kind: 'mood', mood: 'happy', seconds: 1.2 }]);
  });
});
