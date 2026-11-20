import { describe, expect, it } from 'vitest';
import { providerFor, type ProviderConfig } from '../index.js';
import { wait } from './retry.js';

const key = process.env.RIOSOMA_TEST_AI_FAL_KEY?.trim();
describe.skipIf(!key)('the media queue, live', () => {
  it('generates one small synthetic image and retrieves its result', async () => {
    const config: ProviderConfig = { apiKey: key, baseUrl: process.env.RIOSOMA_TEST_AI_FAL_URL };
    const queue = providerFor('fal').queue!;
    const signal = AbortSignal.timeout(120_000);
    const job = await queue.submit(
      config,
      process.env.RIOSOMA_TEST_AI_FAL_MODEL ?? 'fal-ai/flux-2/klein/4b',
      {
        prompt: 'A single black square on a white background.',
        image_size: { width: 512, height: 512 },
        num_images: 1,
      },
      signal,
    );
    let completed = false;
    try {
      while (!completed) {
        completed = (await queue.status(config, job, signal)) === 'completed';
        if (!completed) await wait(1000, signal);
      }
      const result = await queue.result(config, job, signal);
      expect(Array.isArray(result.images)).toBe(true);
      expect(result.images).toHaveLength(1);
    } finally {
      if (!completed) await queue.cancel(config, job, AbortSignal.timeout(10_000));
    }
  }, 140_000);
});
