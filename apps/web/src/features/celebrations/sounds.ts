import type { Preferences } from '@riosoma/contracts';
import { reducedMotion, soundChosen, soundLevel, type SoundLevel } from './settings';

/**
 * A handful of small sounds, made with the Web Audio API as they play, so there are no audio files
 * to load or license.
 */
export type SoundName = 'tick' | 'chime' | 'rise' | 'low';

export const SOUND_NAMES: readonly SoundName[] = ['tick', 'chime', 'rise', 'low'];

interface Note {
  /** Hertz */
  frequency: number;
  /** Seconds after the sound starts */
  at: number;
  /** Seconds until it has faded out */
  length: number;
  wave: OscillatorType;
  /** The note's loudness before the level's own, from 0 to 1 */
  peak: number;
  /** Hertz the pitch slides to by the end, for a note that bends */
  bend?: number;
}

const NOTES: Record<SoundName, readonly Note[]> = {
  // A soft, short tick, like a pencil mark.
  tick: [{ frequency: 1760, at: 0, length: 0.05, wave: 'triangle', peak: 0.5 }],
  // Two notes a fifth apart, the second a little later and a little softer.
  chime: [
    { frequency: 1046.5, at: 0, length: 0.45, wave: 'sine', peak: 0.7 },
    { frequency: 1568, at: 0.12, length: 0.55, wave: 'sine', peak: 0.55 },
  ],
  // Up a major arpeggio, landing on the octave.
  rise: [
    { frequency: 523.25, at: 0, length: 0.2, wave: 'triangle', peak: 0.5 },
    { frequency: 659.25, at: 0.07, length: 0.2, wave: 'triangle', peak: 0.5 },
    { frequency: 783.99, at: 0.14, length: 0.22, wave: 'triangle', peak: 0.55 },
    { frequency: 1046.5, at: 0.21, length: 0.5, wave: 'sine', peak: 0.65 },
  ],
  // One low tone that sags a little, for when something went wrong.
  low: [{ frequency: 196, at: 0, length: 0.34, wave: 'sine', peak: 0.9, bend: 174.6 }],
};

/** How loud each level plays everything */
const LEVEL_GAIN: Record<Exclude<SoundLevel, 'off'>, number> = { quiet: 0.05, normal: 0.14 };

/** When sounds may play at all. */
export interface SoundPolicy {
  level: SoundLevel;
  /** The person picked the level themselves */
  chosen: boolean;
  reducedMotion: boolean;
  hidden: boolean;
}

/**
 * Nothing plays while sounds are off or the tab is hidden, and a system that asks for reduced
 * motion stays quiet unless the person turned sounds on themselves.
 */
export function maySound(policy: SoundPolicy): boolean {
  if (policy.level === 'off' || policy.hidden) return false;
  return !policy.reducedMotion || policy.chosen;
}

export interface SoundPlayer {
  /** Plays a sound at a level, stopping any sound still playing.  Says whether it started. */
  play(name: SoundName, level: Exclude<SoundLevel, 'off'>): boolean;
  stop(): void;
}

type ContextFactory = () => AudioContext | null;

function browserContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Context =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Context ? new Context() : null;
}

/**
 * Builds each sound as a small graph: every note is an oscillator through its own envelope, and
 * the notes meet in one gain for the level.  A new sound fades the one before it out first, so two
 * never play over each other.  The context opens on the first sound, never before.
 */
export function createSoundPlayer(createContext: ContextFactory = browserContext): SoundPlayer {
  let context: AudioContext | null = null;
  let current: { gain: GainNode; oscillators: OscillatorNode[] } | null = null;

  function release(at: number) {
    if (!current) return;
    const { gain, oscillators } = current;
    current = null;
    try {
      gain.gain.cancelScheduledValues(at);
      gain.gain.setValueAtTime(gain.gain.value, at);
      gain.gain.linearRampToValueAtTime(0, at + 0.02);
      for (const oscillator of oscillators) oscillator.stop(at + 0.03);
    } catch {
      // A sound that already ended has nothing left to stop.
    }
  }

  return {
    play(name, level) {
      try {
        context ??= createContext();
      } catch {
        return false;
      }
      if (!context) return false;
      try {
        if (context.state === 'suspended') void context.resume().catch(() => undefined);
        const start = context.currentTime;
        release(start);
        const master = context.createGain();
        master.gain.setValueAtTime(LEVEL_GAIN[level], start);
        master.connect(context.destination);
        const oscillators = NOTES[name].map((note) => {
          const at = start + note.at;
          const end = at + note.length;
          const oscillator = context!.createOscillator();
          oscillator.type = note.wave;
          oscillator.frequency.setValueAtTime(note.frequency, at);
          if (note.bend) oscillator.frequency.exponentialRampToValueAtTime(note.bend, end);
          const envelope = context!.createGain();
          envelope.gain.setValueAtTime(0, at);
          envelope.gain.linearRampToValueAtTime(note.peak, at + 0.008);
          envelope.gain.exponentialRampToValueAtTime(0.0001, end);
          oscillator.connect(envelope);
          envelope.connect(master);
          oscillator.start(at);
          oscillator.stop(end + 0.02);
          return oscillator;
        });
        current = { gain: master, oscillators };
        return true;
      } catch {
        return false;
      }
    },
    stop() {
      if (context) release(context.currentTime);
    },
  };
}

/** The app's one player, so a new sound anywhere stops the last one. */
export const sounds = createSoundPlayer();

/** Plays a sound if the person's settings and the page allow it, and says whether it did. */
export function playSound(
  name: SoundName,
  preferences: Preferences | undefined,
  player: SoundPlayer = sounds,
): boolean {
  const level = soundLevel(preferences);
  const allowed = maySound({
    level,
    chosen: soundChosen(preferences),
    reducedMotion: reducedMotion(preferences),
    hidden: typeof document !== 'undefined' && document.hidden,
  });
  return allowed && level !== 'off' ? player.play(name, level) : false;
}
