import { describe, expect, it, vi } from 'vitest';
import { particlesFor } from './confetti-particles';
import {
  animate,
  burst,
  CELEBRATION_MS,
  draw,
  opacity,
  sparkles,
  step,
  type AnimationClock,
  type Particle,
} from './confetti';

/** A repeatable stand-in for Math.random. */
function seeded(seed = 7) {
  let value = seed;
  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}

/** A clock whose frames and time move only when the test says so. */
function manualClock() {
  let time = 0;
  let next = 0;
  const frames = new Map<number, () => void>();
  const timers: Array<{ at: number; run: () => void; done: boolean }> = [];
  const clock: AnimationClock = {
    now: () => time,
    frame: (callback) => {
      frames.set(++next, callback);
      return next;
    },
    cancelFrame: (handle) => void frames.delete(handle),
    later: (run, ms) => {
      const timer = { at: time + ms, run, done: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    cancelLater: (handle) => {
      (handle as unknown as { done: boolean }).done = true;
    },
  };
  return {
    clock,
    /** Moves time on, running a frame each step unless frames are paused, as on a hidden tab */
    run(ms: number, stepMs = 16, paused = false) {
      for (let spent = 0; spent < ms; spent += stepMs) {
        time += stepMs;
        for (const timer of timers)
          if (!timer.done && timer.at <= time) {
            timer.done = true;
            timer.run();
          }
        if (paused) continue;
        const pending = [...frames.values()];
        frames.clear();
        for (const frame of pending) frame();
      }
    },
  };
}

const viewport = { width: 1200, height: 800 };
const colors = ['rgb(1, 2, 3)', 'rgb(4, 5, 6)'];
const lastMoment = (particles: readonly Particle[]) =>
  Math.max(...particles.map((particle) => particle.delay + particle.life));

describe('confetti', () => {
  it.each(['small', 'medium', 'large'] as const)(
    'gives a %s celebration particles that are all gone within 1.5 seconds',
    (size) => {
      const particles = particlesFor(size, null, viewport, colors, seeded());
      expect(particles.length).toBeGreaterThan(0);
      expect(lastMoment(particles) * 1000).toBeLessThanOrEqual(CELEBRATION_MS);
      expect(CELEBRATION_MS).toBeLessThan(1500);
    },
  );

  it('makes each size bigger than the last', () => {
    const counts = (['small', 'medium', 'large'] as const).map(
      (size) => particlesFor(size, null, viewport, colors, seeded()).length,
    );
    expect(counts[0]).toBeLessThan(counts[1]!);
    expect(counts[1]).toBeLessThan(counts[2]!);
  });

  it('bursts from the element that caused it, in the theme’s colors', () => {
    const anchor = { left: 100, top: 200, width: 80, height: 20 };
    const particles = particlesFor('medium', anchor, viewport, colors, seeded());
    for (const particle of particles) {
      expect(particle.x).toBe(140);
      expect(particle.y).toBe(210);
      expect(colors).toContain(particle.color);
    }
  });

  it('sparkles just outside the element, never on it', () => {
    const box = { left: 300, top: 300, width: 120, height: 32 };
    const particles = sparkles(box, colors, { random: seeded() });
    expect(particles).toHaveLength(8);
    for (const particle of particles) {
      const inside =
        particle.x > box.left &&
        particle.x < box.left + box.width &&
        particle.y > box.top &&
        particle.y < box.top + box.height;
      expect(inside).toBe(false);
      expect(particle.vx).toBe(0);
      expect(particle.vy).toBe(0);
    }
  });

  it('throws confetti up, lets it fall, and fades it out before it ends', () => {
    const [particle] = burst({
      x: 0,
      y: 0,
      count: 1,
      colors,
      direction: 0,
      spread: 0,
      speed: [600, 600],
      life: [1, 1],
      random: () => 0.5,
    });
    step([particle!], 0.1);
    expect(particle!.y).toBeLessThan(0);
    expect(opacity(particle!)).toBe(1);
    for (let index = 0; index < 8; index++) step([particle!], 0.1);
    expect(opacity(particle!)).toBeGreaterThan(0);
    expect(opacity(particle!)).toBeLessThan(1);
    expect(step([particle!], 0.2)).toBe(0);
    expect(opacity(particle!)).toBe(0);
  });

  it('ends when the last particle is gone', () => {
    const { clock, run } = manualClock();
    const onDone = vi.fn();
    const render = vi.fn();
    const particles = particlesFor('medium', null, viewport, colors, seeded());
    const end = lastMoment(particles) * 1000;
    animate({ particles, render, onDone, clock });
    run(end - 64);
    expect(onDone).not.toHaveBeenCalled();
    run(96);
    expect(onDone).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalled();
  });

  it('ends on time even when the tab hides and frames stop coming', () => {
    const { clock, run } = manualClock();
    const onDone = vi.fn();
    animate({
      particles: particlesFor('large', null, viewport, colors, seeded()),
      render: () => undefined,
      onDone,
      clock,
    });
    run(CELEBRATION_MS + 100, 16, true);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('can be stopped early, and only ends once', () => {
    const { clock, run } = manualClock();
    const onDone = vi.fn();
    const stop = animate({
      particles: particlesFor('small', null, viewport, colors, seeded()),
      render: () => undefined,
      onDone,
      clock,
    });
    stop();
    run(CELEBRATION_MS + 100);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('cuts every box it is told to keep clear out of what it draws', () => {
    const calls: string[] = [];
    const context = new Proxy(
      {},
      {
        get: (_target, name: string) => {
          if (name === 'globalAlpha' || name === 'fillStyle') return undefined;
          return (...args: unknown[]) => calls.push(`${name}(${args.join(',')})`);
        },
        set: () => true,
      },
    ) as CanvasRenderingContext2D;
    const particles = particlesFor('medium', null, viewport, colors, seeded());
    step(particles, 0.1);
    draw(context, particles, [{ left: 10, top: 20, width: 30, height: 40 }], { ...viewport, scale: 2 });
    expect(calls[0]).toBe('setTransform(2,0,0,2,0,0)');
    const clip = calls.indexOf('clip(evenodd)');
    expect(calls.slice(0, clip)).toEqual(expect.arrayContaining(['rect(0,0,1200,800)', 'rect(10,20,30,40)']));
    expect(calls.slice(clip).some((call) => call.startsWith('fillRect') || call.startsWith('fill('))).toBe(
      true,
    );
  });
});
