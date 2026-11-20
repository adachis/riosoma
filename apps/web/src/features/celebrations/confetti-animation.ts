import { CELEBRATION_MS, type Box, type Particle } from './confetti-particles';

/** Moves every particle on by `seconds`, and says how many are still to come or showing. */
export function step(particles: Particle[], seconds: number): number {
  let alive = 0;
  for (const particle of particles) {
    particle.age += seconds;
    const active = particle.age - particle.delay;
    if (active >= particle.life) continue;
    alive++;
    if (active <= 0 || particle.shape === 'sparkle') continue;
    // Air slows confetti quickly, so it floats rather than falls once the throw is spent.
    const drag = Math.exp(-2.2 * seconds);
    particle.vx *= drag;
    particle.vy = particle.vy * drag + particle.gravity * seconds;
    particle.x += particle.vx * seconds;
    particle.y += particle.vy * seconds;
    particle.angle += particle.spin * seconds;
    particle.flip += 9 * seconds;
  }
  return alive;
}

/** How visible a particle is now, from 0 to 1. */
export function opacity(particle: Particle): number {
  const progress = (particle.age - particle.delay) / particle.life;
  if (progress <= 0 || progress >= 1) return 0;
  if (particle.shape === 'sparkle') return Math.sin(progress * Math.PI);
  return progress < 0.7 ? 1 : (1 - progress) / 0.3;
}

function star(context: CanvasRenderingContext2D, radius: number) {
  const waist = radius * 0.28;
  context.beginPath();
  for (let point = 0; point < 8; point++) {
    const length = point % 2 === 0 ? radius : waist;
    const angle = (point * Math.PI) / 4;
    context.lineTo(Math.sin(angle) * length, -Math.cos(angle) * length);
  }
  context.closePath();
  context.fill();
}

/**
 * Draws the particles that are showing, leaving the keep-clear boxes untouched.  Sizes are in CSS
 * pixels, and `scale` is how many canvas pixels make one.
 */
export function draw(
  context: CanvasRenderingContext2D,
  particles: readonly Particle[],
  keepClear: readonly Box[],
  size: { width: number; height: number; scale: number },
): void {
  context.setTransform(size.scale, 0, 0, size.scale, 0, 0);
  context.clearRect(0, 0, size.width, size.height);
  context.save();
  context.beginPath();
  context.rect(0, 0, size.width, size.height);
  for (const box of keepClear) context.rect(box.left, box.top, box.width, box.height);
  // Even-odd filling turns each keep-clear box into a hole in the drawable area.
  context.clip('evenodd');
  for (const particle of particles) {
    const alpha = opacity(particle);
    if (alpha <= 0) continue;
    context.save();
    context.globalAlpha = alpha;
    context.fillStyle = particle.color;
    context.translate(particle.x, particle.y);
    context.rotate(particle.angle);
    if (particle.shape === 'ribbon') {
      context.scale(1, Math.cos(particle.flip));
      context.fillRect(-particle.size / 2, -particle.size / 4, particle.size, particle.size / 2);
    } else if (particle.shape === 'dot') {
      context.beginPath();
      context.arc(0, 0, particle.size, 0, Math.PI * 2);
      context.fill();
    } else {
      star(context, particle.size * (0.4 + 0.6 * alpha));
    }
    context.restore();
  }
  context.restore();
}

export interface AnimationClock {
  now(): number;
  frame(callback: () => void): number;
  cancelFrame(handle: number): void;
  later(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  cancelLater(handle: ReturnType<typeof setTimeout>): void;
}

export const browserClock: AnimationClock = {
  now: () => performance.now(),
  frame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  later: (callback, ms) => setTimeout(() => callback(), ms),
  cancelLater: (handle) => clearTimeout(handle),
};

/**
 * Runs the particles until they are all gone, or until the celebration's time is up, whichever
 * comes first.  A hidden tab pauses animation frames, so the timer is what guarantees the end.
 */
export function animate(options: {
  particles: Particle[];
  render: (particles: readonly Particle[]) => void;
  onDone: () => void;
  clock?: AnimationClock;
}): () => void {
  const clock = options.clock ?? browserClock;
  let last = clock.now();
  let finished = false;
  let handle = 0;
  const finish = () => {
    if (finished) return;
    finished = true;
    clock.cancelFrame(handle);
    clock.cancelLater(deadline);
    options.onDone();
  };
  const deadline = clock.later(finish, CELEBRATION_MS + 50);
  const tick = () => {
    if (finished) return;
    const now = clock.now();
    // A long gap between frames counts as one short step, so nothing leaps across the screen.
    const seconds = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    const alive = step(options.particles, seconds);
    options.render(options.particles);
    if (alive === 0) finish();
    else handle = clock.frame(tick);
  };
  handle = clock.frame(tick);
  return finish;
}

export { particlesFor } from './confetti-particles';
