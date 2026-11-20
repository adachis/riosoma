import { afterEach, expect, it, vi } from 'vitest';
import { themes } from '../preferences';
import { firstPaintTheme } from './firstPaintTheme';

vi.mock('../preferences', () => ({ themes: { apply: vi.fn(async () => undefined) } }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('waits for the theme and its text metrics before exposing the first controls', async () => {
  let applied!: () => void;
  let loaded!: () => void;
  vi.mocked(themes.apply).mockImplementationOnce(
    () =>
      new Promise((done) => {
        applied = () => done({ theme: 'nature', scheme: 'grove' });
      }),
  );
  const loading = new Promise<FontFace[]>((done) => {
    loaded = () => done([]);
  });
  const load = vi.fn(() => loading);
  const ready = vi.fn();
  const fonts = { load } as unknown as FontFaceSet;
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => 'sans-serif' }));
  const pending = firstPaintTheme({ theme: 'nature' }, fonts).then(ready);
  expect(load).not.toHaveBeenCalled();
  applied();
  await vi.waitFor(() => expect(load).toHaveBeenCalled());
  expect(ready).not.toHaveBeenCalled();
  loaded();
  await pending;
  expect(ready).toHaveBeenCalledOnce();
});

it('keeps startup available when a theme font cannot load', async () => {
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => 'sans-serif' }));
  const fonts = {
    load: vi.fn(async () => {
      throw new Error('Unavailable font');
    }),
  } as unknown as FontFaceSet;
  await expect(firstPaintTheme({ theme: 'nature' }, fonts)).resolves.toBeUndefined();
});
