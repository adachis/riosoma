import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Preferences } from '@riosoma/contracts';
import { createSoundPlayer, maySound, playSound, SOUND_NAMES, type SoundPlayer } from './sounds';

/** An audio parameter that records what is scheduled on it and checks the values make sense. */
class FakeParam {
  value = 0;
  events: Array<[string, number, number]> = [];
  private record(kind: string, value: number, time: number) {
    if (!Number.isFinite(value) || !Number.isFinite(time) || time < 0) throw new RangeError(kind);
    this.events.push([kind, value, time]);
    return this;
  }
  setValueAtTime(value: number, time: number) {
    this.value = value;
    return this.record('set', value, time);
  }
  linearRampToValueAtTime(value: number, time: number) {
    return this.record('linear', value, time);
  }
  exponentialRampToValueAtTime(value: number, time: number) {
    // The Web Audio API refuses exponential ramps to zero, so the stub does too.
    if (value <= 0) throw new RangeError('exponential ramp to zero');
    return this.record('exponential', value, time);
  }
  cancelScheduledValues(time: number) {
    return this.record('cancel', 0, time);
  }
}

class FakeNode {
  outputs: unknown[] = [];
  constructor(readonly context: FakeContext) {}
  connect(destination: unknown) {
    if (!(destination instanceof FakeNode) && destination !== this.context.destination)
      throw new TypeError('Not an audio node');
    this.outputs.push(destination);
    return destination;
  }
  disconnect() {
    this.outputs = [];
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeOscillator extends FakeNode {
  type = 'sine';
  frequency = new FakeParam();
  started?: number;
  stopped?: number;
  start(time: number) {
    if (this.started !== undefined) throw new Error('Started twice');
    this.started = time;
  }
  stop(time: number) {
    if (this.started === undefined) throw new Error('Stopped before it started');
    this.stopped = Math.min(this.stopped ?? Infinity, time);
  }
}

class FakeContext {
  state: 'suspended' | 'running' = 'suspended';
  currentTime = 12;
  destination = { kind: 'destination' };
  gains: FakeGain[] = [];
  oscillators: FakeOscillator[] = [];
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  createGain() {
    const gain = new FakeGain(this);
    this.gains.push(gain);
    return gain;
  }
  createOscillator() {
    const oscillator = new FakeOscillator(this);
    this.oscillators.push(oscillator);
    return oscillator;
  }
}

function fakePlayer() {
  const context = new FakeContext();
  const factory = vi.fn(() => context as unknown as AudioContext);
  return { context, factory, player: createSoundPlayer(factory) };
}

function spyPlayer(): SoundPlayer & { play: ReturnType<typeof vi.fn> } {
  return { play: vi.fn(() => true), stop: vi.fn() };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the sound set', () => {
  it.each(SOUND_NAMES)('builds the %s sound’s audio graph without errors', (name) => {
    const { context, player } = fakePlayer();
    expect(player.play(name, 'normal')).toBe(true);
    const [master, ...envelopes] = context.gains;
    expect(master!.outputs).toEqual([context.destination]);
    expect(context.oscillators.length).toBeGreaterThan(0);
    expect(envelopes).toHaveLength(context.oscillators.length);
    context.oscillators.forEach((oscillator, index) => {
      expect(oscillator.outputs).toEqual([envelopes[index]]);
      expect(envelopes[index]!.outputs).toEqual([master]);
      expect(oscillator.started).toBeGreaterThanOrEqual(context.currentTime);
      expect(oscillator.stopped).toBeGreaterThan(oscillator.started!);
      // Every sound is short.
      expect(oscillator.stopped! - context.currentTime).toBeLessThan(1);
    });
  });

  it('plays a tick, two notes, a rising figure, and a low tone', () => {
    const pitches = SOUND_NAMES.map((name) => {
      const { context, player } = fakePlayer();
      player.play(name, 'normal');
      return context.oscillators.map((oscillator) => oscillator.frequency.events[0]![1]);
    });
    const [tick, chime, rise, low] = pitches;
    expect(tick).toHaveLength(1);
    expect(chime).toHaveLength(2);
    expect(rise!.length).toBeGreaterThanOrEqual(3);
    expect([...rise!].sort((a, b) => a - b)).toEqual(rise);
    expect(low![0]).toBeLessThan(300);
  });

  it('plays Quiet softer than Normal', () => {
    const quiet = fakePlayer();
    const normal = fakePlayer();
    quiet.player.play('chime', 'quiet');
    normal.player.play('chime', 'normal');
    expect(quiet.context.gains[0]!.gain.value).toBeLessThan(normal.context.gains[0]!.gain.value);
  });

  it('opens its audio context on the first sound, never before, and wakes it', () => {
    const { context, factory, player } = fakePlayer();
    expect(factory).not.toHaveBeenCalled();
    player.play('tick', 'quiet');
    player.play('tick', 'quiet');
    expect(factory).toHaveBeenCalledOnce();
    expect(context.resume).toHaveBeenCalled();
  });

  it('stops the sound that’s playing before starting another', () => {
    const { context, player } = fakePlayer();
    player.play('rise', 'normal');
    const first = [...context.oscillators];
    context.currentTime += 0.05;
    player.play('low', 'normal');
    for (const oscillator of first)
      expect(oscillator.stopped).toBeLessThanOrEqual(context.currentTime + 0.05);
    expect(context.gains[0]!.gain.events.at(-1)).toEqual(['linear', 0, context.currentTime + 0.02]);
  });

  it('stays silent where the browser has no Web Audio', () => {
    expect(createSoundPlayer(() => null).play('chime', 'normal')).toBe(false);
    expect(
      createSoundPlayer(() => {
        throw new Error('Not allowed');
      }).play('chime', 'normal'),
    ).toBe(false);
  });
});

describe('when sounds play', () => {
  it('stays silent by default', () => {
    const player = spyPlayer();
    expect(playSound('chime', undefined, player)).toBe(false);
    expect(playSound('tick', {}, player)).toBe(false);
    expect(player.play).not.toHaveBeenCalled();
  });

  it('plays at the level the person chose', () => {
    const player = spyPlayer();
    expect(playSound('rise', { soundLevel: 'quiet' }, player)).toBe(true);
    expect(playSound('low', { soundLevel: 'normal' }, player)).toBe(true);
    expect(player.play.mock.calls).toEqual([
      ['rise', 'quiet'],
      ['low', 'normal'],
    ]);
  });

  it('stays silent while the tab is hidden', () => {
    const player = spyPlayer();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    expect(playSound('chime', { soundLevel: 'normal' }, player)).toBe(false);
    expect(player.play).not.toHaveBeenCalled();
  });

  it('stays silent at reduced motion unless the person turned sounds on themselves', () => {
    expect(maySound({ level: 'quiet', chosen: false, reducedMotion: true, hidden: false })).toBe(false);
    expect(maySound({ level: 'quiet', chosen: true, reducedMotion: true, hidden: false })).toBe(true);
    expect(maySound({ level: 'off', chosen: true, reducedMotion: false, hidden: false })).toBe(false);
    const player = spyPlayer();
    const preferences: Preferences = { soundLevel: 'normal', motion: 'reduce' };
    expect(playSound('chime', preferences, player)).toBe(true);
  });
});
