import { expect, type Locator } from '@playwright/test';

export async function expectVideoFrames(video: Locator, message: string): Promise<void> {
  const frames = await video.evaluateHandle((node) => {
    const movie = node as HTMLVideoElement;
    if (typeof movie.requestVideoFrameCallback !== 'function')
      throw new Error('This browser lacks requestVideoFrameCallback');
    let first: VideoFrameCallbackMetadata | undefined;
    const state = {
      callbacks: 0,
      advancing: false,
      error: movie.error ? { code: movie.error.code, message: movie.error.message } : null,
    };
    const onError = () => {
      first = undefined;
      state.advancing = false;
      state.error = movie.error ? { code: movie.error.code, message: movie.error.message } : null;
    };
    const onData = () => {
      first = undefined;
      state.advancing = false;
      state.error = movie.error ? { code: movie.error.code, message: movie.error.message } : null;
      movie.cancelVideoFrameCallback(callback);
      callback = movie.requestVideoFrameCallback(frame);
    };
    movie.addEventListener('loadeddata', onData);
    movie.addEventListener('error', onError);
    const frame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      state.callbacks++;
      if (first)
        state.advancing =
          metadata.mediaTime > first.mediaTime || metadata.presentedFrames > first.presentedFrames;
      else first = metadata;
      if (!state.advancing) callback = movie.requestVideoFrameCallback(frame);
    };
    let callback = movie.requestVideoFrameCallback(frame);
    return {
      state,
      stop() {
        movie.cancelVideoFrameCallback(callback);
        movie.removeEventListener('error', onError);
        movie.removeEventListener('loadeddata', onData);
      },
    };
  });
  try {
    await expect
      .poll(() => frames.evaluate(({ state }) => state), { intervals: [50], message })
      .toMatchObject({ advancing: true, error: null });
  } finally {
    await frames.evaluate(({ stop }) => stop());
    await frames.dispose();
  }
}
