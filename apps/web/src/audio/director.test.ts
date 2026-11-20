import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioDirector, readingTime, type ClipPlayer, type SpeechEngine } from './director';

interface Spoken {
  text: string;
  lang: string;
  end(): void;
  fail(): void;
}

function fakeSpeech() {
  const said: Spoken[] = [];
  const cancel = vi.fn<() => void>();
  const engine = {
    speak: (text: string, lang: string, events: { end(): void; fail(): void }) => {
      said.push({ text, lang, ...events });
    },
    cancel,
  } satisfies SpeechEngine;
  return { engine, said };
}

function fakeClips() {
  const played: Array<{ url: string; end(): void; fail(): void; stop: ReturnType<typeof vi.fn> }> = [];
  const player: ClipPlayer = {
    play: (url, events) => {
      const stop = vi.fn();
      played.push({ url, ...events, stop });
      return { stop };
    },
  };
  return { player, played };
}

const clock = {
  now: () => Date.now(),
  setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
  clearTimeout: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the audio director', () => {
  it('plays one thing at a time: starting a line stops the one before it', async () => {
    const speech = fakeSpeech();
    const director = new AudioDirector({ speech: speech.engine, clips: null, clock });
    const first = director.narrate({ text: 'Your tables are listed here.', lang: 'en-US' });
    expect(speech.said.map((line) => line.text)).toEqual(['Your tables are listed here.']);
    const second = director.narrate({ text: 'Add a field with the plus.', lang: 'en-US' });
    expect(await first.done).toBe('stopped');
    expect(speech.engine.cancel).toHaveBeenCalledTimes(1);
    expect(director.playing()).toBe(true);
    speech.said[1]!.end();
    expect(await second.done).toBe('ended');
    expect(director.playing()).toBe(false);
  });

  it('speaks in the reader’s language', () => {
    const speech = fakeSpeech();
    const director = new AudioDirector({ speech: speech.engine, clips: null, clock });
    director.narrate({ text: 'Bonjour', lang: 'fr' });
    expect(speech.said[0]).toMatchObject({ text: 'Bonjour', lang: 'fr' });
  });

  it('plays a recorded clip instead of speech when the file exists, and speaks when it doesn’t', async () => {
    const speech = fakeSpeech();
    const clips = fakeClips();
    const director = new AudioDirector({ speech: speech.engine, clips: clips.player, clock });
    const recorded = director.narrate({
      text: 'A line',
      lang: 'en-US',
      clip: '/narration/en-US/fields/add.mp3',
    });
    expect(clips.played.map((clip) => clip.url)).toEqual(['/narration/en-US/fields/add.mp3']);
    expect(speech.said).toEqual([]);
    clips.played[0]!.end();
    expect(await recorded.done).toBe('ended');

    const missing = director.narrate({
      text: 'Another line',
      lang: 'en-US',
      clip: '/narration/en-US/none.mp3',
    });
    clips.played[1]!.fail();
    expect(speech.said.map((line) => line.text)).toEqual(['Another line']);
    speech.said[0]!.end();
    expect(await missing.done).toBe('ended');
  });

  it('stops a clip when anything else starts', async () => {
    const clips = fakeClips();
    const director = new AudioDirector({ speech: null, clips: clips.player, clock });
    const clip = director.narrate({ text: 'A line', lang: 'en-US', clip: '/narration/en-US/a.mp3' });
    director.narrate({ text: 'The next line', lang: 'en-US' });
    expect(clips.played[0]!.stop).toHaveBeenCalled();
    expect(await clip.done).toBe('stopped');
  });

  it('pauses a video that’s playing when narration starts, and stops narration when a video starts', async () => {
    const speech = fakeSpeech();
    const director = new AudioDirector({ speech: speech.engine, clips: null, clock });
    const video = document.createElement('video');
    let paused = true;
    Object.defineProperty(video, 'paused', { get: () => paused });
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => {
      paused = true;
      video.dispatchEvent(new Event('pause'));
    });
    const release = director.adopt(video);

    const line = director.narrate({ text: 'A line', lang: 'en-US' });
    paused = false;
    video.dispatchEvent(new Event('play'));
    expect(await line.done).toBe('stopped');
    expect(speech.engine.cancel).toHaveBeenCalled();
    expect(director.playing()).toBe(true);

    director.narrate({ text: 'Another line', lang: 'en-US' });
    expect(pause).toHaveBeenCalledTimes(1);
    release();
  });

  it('keeps a muted line on screen for as long as it takes to read, without a sound', async () => {
    const speech = fakeSpeech();
    const director = new AudioDirector({ speech: speech.engine, clips: null, clock });
    director.setMuted(true);
    const text = 'Filter shows only the records that match.';
    const line = director.narrate({ text, lang: 'en-US' });
    expect(speech.said).toEqual([]);
    let result: string | undefined;
    void line.done.then((value) => (result = value));
    await vi.advanceTimersByTimeAsync(readingTime(text) - 10);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);
    expect(result).toBe('ended');
  });

  it('goes quiet mid-line when muted, but keeps the line’s time', async () => {
    const speech = fakeSpeech();
    const director = new AudioDirector({ speech: speech.engine, clips: null, clock });
    const listener = vi.fn();
    director.subscribe(listener);
    const text = 'Sort puts records in the order you choose.';
    const line = director.narrate({ text, lang: 'en-US' });
    await vi.advanceTimersByTimeAsync(500);
    director.setMuted(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(speech.engine.cancel).toHaveBeenCalledTimes(1);
    // The silenced voice's own end no longer counts.
    speech.said[0]!.end();
    let result: string | undefined;
    void line.done.then((value) => (result = value));
    await vi.advanceTimersByTimeAsync(readingTime(text) - 600);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(result).toBe('ended');
  });

  it('falls back to reading time when speech fails or never says it finished', async () => {
    const speech = fakeSpeech();
    const director = new AudioDirector({ speech: speech.engine, clips: null, clock });
    const text = 'A short line.';
    const failed = director.narrate({ text, lang: 'en-US' });
    speech.said[0]!.fail();
    await vi.advanceTimersByTimeAsync(readingTime(text));
    expect(await failed.done).toBe('ended');

    const silent = director.narrate({ text, lang: 'en-US' });
    await vi.advanceTimersByTimeAsync(readingTime(text) + 5_000);
    expect(await silent.done).toBe('ended');
  });
});
