/**
 * The one place the app plays spoken or recorded sound for help, demos, and videos.  It plays one
 * thing at a time: starting anything stops whatever was playing, and a video that starts on its
 * own stops the rest too.
 *
 * Narration is spoken by the browser in the reader's language for now.  A step can name a
 * recorded clip, and when that file exists the director plays it instead of speaking.  Muted,
 * narration still takes the time it would take to read, so captions keep their pace.
 */

export type PlayResult = 'ended' | 'stopped';

export interface Playback {
  /** Settles when the sound ends, or when something stops it */
  readonly done: Promise<PlayResult>;
  stop(): void;
}

export interface Narration {
  text: string;
  /** A BCP 47 tag, such as `en-US` */
  lang: string;
  /** A recorded clip's address, played instead of speech when it loads */
  clip?: string;
}

/** Whatever speaks, the browser's own speech synthesis in the app. */
export interface SpeechEngine {
  speak(text: string, lang: string, events: { end(): void; fail(): void }): void;
  cancel(): void;
}

/** Whatever plays a recorded clip, an audio element in the app. */
export interface ClipPlayer {
  play(url: string, events: { end(): void; fail(): void }): { stop(): void };
}

export interface DirectorClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface DirectorDeps {
  speech?: SpeechEngine | null;
  clips?: ClipPlayer | null;
  clock?: DirectorClock;
}

/** How long a line takes to read, so muted narration keeps a human pace. */
export function readingTime(text: string): number {
  return Math.max(2200, 900 + text.length * 55);
}

/** Speech that never reports its end (it happens with some voices) is let go after this long. */
const SPEECH_GRACE_MS = 4000;

interface Current {
  stop(): void;
  /** The media element playing, when it's a video or clip on the page */
  element?: HTMLMediaElement;
  /** Turns sound off without ending the narration's time */
  silence?(): void;
}

export class AudioDirector {
  private current: Current | null = null;
  private muteState = false;
  private listeners = new Set<() => void>();
  private readonly speech: SpeechEngine | null;
  private readonly clips: ClipPlayer | null;
  private readonly clock: DirectorClock;

  constructor(deps: DirectorDeps = {}) {
    this.speech = deps.speech === undefined ? browserSpeech() : deps.speech;
    this.clips = deps.clips === undefined ? browserClips() : deps.clips;
    this.clock = deps.clock ?? {
      now: () => Date.now(),
      setTimeout: (callback, delay) => globalThis.setTimeout(() => callback(), delay),
      clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
    };
  }

  get muted(): boolean {
    return this.muteState;
  }

  /** Mutes or unmutes narration.  Narration already under way goes quiet but keeps its time. */
  setMuted(muted: boolean): void {
    if (muted === this.muteState) return;
    this.muteState = muted;
    if (muted) this.current?.silence?.();
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Whether anything is playing. */
  playing(): boolean {
    return this.current !== null;
  }

  /** Stops whatever is playing. */
  stop(): void {
    const current = this.current;
    this.current = null;
    current?.stop();
  }

  /**
   * Speaks a line of narration, or plays its recorded clip when the clip loads, after stopping
   * whatever was playing.  The playback settles when the line has been said, or read, when muted.
   */
  narrate(line: Narration): Playback {
    this.stop();
    let settle!: (result: PlayResult) => void;
    const done = new Promise<PlayResult>((resolve) => {
      settle = resolve;
    });
    let finished = false;
    let timer: unknown;
    let sound: { stop(): void } | null = null;
    const started = this.clock.now();
    const budget = readingTime(line.text);
    const remaining = () => budget - (this.clock.now() - started);
    const finish = (result: PlayResult) => {
      if (finished) return;
      finished = true;
      this.clock.clearTimeout(timer);
      if (this.current === entry) this.current = null;
      settle(result);
    };
    // Muted, missing speech, and failed speech all fall back to the time the line takes to read.
    const wait = (ms: number) => {
      sound = null;
      this.clock.clearTimeout(timer);
      timer = this.clock.setTimeout(() => finish('ended'), Math.max(0, ms));
    };
    const speak = () => {
      if (finished) return;
      if (this.muteState || !this.speech) {
        wait(remaining());
        return;
      }
      const speech = this.speech;
      let active = true;
      sound = {
        stop: () => {
          active = false;
          speech.cancel();
        },
      };
      this.clock.clearTimeout(timer);
      timer = this.clock.setTimeout(() => finish('ended'), budget + SPEECH_GRACE_MS);
      speech.speak(line.text, line.lang, {
        end: () => {
          if (active) finish('ended');
        },
        fail: () => {
          if (!active || finished) return;
          active = false;
          wait(remaining());
        },
      });
    };
    const entry: Current = {
      stop: () => {
        const playing = sound;
        sound = null;
        playing?.stop();
        finish('stopped');
      },
      silence: () => {
        const playing = sound;
        if (!playing || finished) return;
        playing.stop();
        wait(remaining());
      },
    };
    this.current = entry;
    if (line.clip && this.clips && !this.muteState) {
      sound = this.clips.play(line.clip, {
        end: () => finish('ended'),
        // No recording yet, or one that won't play: the browser says the line instead.
        fail: () => speak(),
      });
    } else speak();
    return { done, stop: () => (this.current === entry ? this.stop() : entry.stop()) };
  }

  /**
   * Lets a video or audio element on the page take part: when it starts, everything else stops,
   * and when anything else starts, it pauses.  Returns how to let it go.
   */
  adopt(element: HTMLMediaElement): () => void {
    const onPlay = () => {
      if (this.current?.element === element) return;
      this.stop();
      this.current = {
        element,
        stop: () => {
          if (!element.paused) element.pause();
        },
      };
    };
    const onEnd = () => {
      if (this.current?.element === element) this.current = null;
    };
    element.addEventListener('play', onPlay);
    element.addEventListener('pause', onEnd);
    element.addEventListener('ended', onEnd);
    return () => {
      element.removeEventListener('play', onPlay);
      element.removeEventListener('pause', onEnd);
      element.removeEventListener('ended', onEnd);
      onEnd();
    };
  }
}

/** The browser's voice for a language: an exact match, then one for the same language anywhere. */
function voiceFor(voices: readonly SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | undefined {
  const wanted = lang.toLowerCase();
  const base = wanted.split('-')[0]!;
  return (
    voices.find((voice) => voice.lang.toLowerCase() === wanted && voice.localService) ??
    voices.find((voice) => voice.lang.toLowerCase() === wanted) ??
    voices.find((voice) => voice.lang.toLowerCase().split(/[-_]/)[0] === base)
  );
}

/** A browser driven by automation, such as a test suite, never makes a sound. */
function automated(): boolean {
  return typeof navigator !== 'undefined' && navigator.webdriver === true;
}

function browserSpeech(): SpeechEngine | null {
  if (typeof window === 'undefined' || automated()) return null;
  const synth = window.speechSynthesis;
  const Utterance = window.SpeechSynthesisUtterance;
  if (!synth || typeof Utterance !== 'function') return null;
  return {
    speak(text, lang, events) {
      const utterance = new Utterance(text);
      utterance.lang = lang;
      const voice = voiceFor(synth.getVoices(), lang);
      if (voice) utterance.voice = voice;
      utterance.onend = () => events.end();
      utterance.onerror = (event) => {
        // Canceling is how the director stops a line, and isn't a failure.
        if (event.error !== 'canceled' && event.error !== 'interrupted') events.fail();
      };
      synth.speak(utterance);
    },
    cancel() {
      synth.cancel();
    },
  };
}

function browserClips(): ClipPlayer | null {
  if (typeof Audio === 'undefined' || automated()) return null;
  return {
    play(url, events) {
      const audio = new Audio(url);
      audio.addEventListener('ended', () => events.end());
      audio.addEventListener('error', () => events.fail());
      audio.play().catch(() => events.fail());
      return {
        stop() {
          audio.pause();
          audio.removeAttribute('src');
        },
      };
    },
  };
}

/** The app's one director. */
export const director = new AudioDirector();
