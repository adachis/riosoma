import { expect, it, vi } from 'vitest';
import { prepareContainerImage } from './container-image.js';

const image = 'kong:3.9';
const missingImage = Object.assign(new Error('Image is absent'), { stderr: 'Error: No such image' });

it('runs with the cached image without contacting the registry', async () => {
  const docker = vi.fn().mockResolvedValue({});
  await expect(prepareContainerImage(image, docker)).resolves.toEqual({ action: 'run' });
  expect(docker.mock.calls).toEqual([[['image', 'inspect', image]]]);
});

it('runs when an absent image is fetched within the pull limit', async () => {
  const docker = vi.fn().mockRejectedValueOnce(missingImage).mockResolvedValueOnce({});
  await expect(prepareContainerImage(image, docker)).resolves.toEqual({ action: 'run' });
  expect(docker.mock.calls).toEqual([[['image', 'inspect', image]], [['pull', image], { timeout: 120_000 }]]);
});

it.each([
  ['fails', new Error('Registry refused the pull')],
  ['times out', Object.assign(new Error('Pull exceeded its time limit'), { killed: true })],
])('skips when an absent image pull %s and reports why', async (_outcome, error) => {
  const docker = vi.fn().mockRejectedValueOnce(missingImage).mockRejectedValueOnce(error);
  await expect(prepareContainerImage(image, docker)).resolves.toEqual({
    action: 'skip',
    reason: `Container image ${image} could not be fetched: ${error.message}`,
  });
  expect(docker).toHaveBeenLastCalledWith(['pull', image], { timeout: 120_000 });
});

it('fails when Docker cannot inspect images for a reason other than an absent image', async () => {
  const error = Object.assign(new Error('Cannot connect to Docker'), { stderr: 'Connection refused' });
  const docker = vi.fn().mockRejectedValue(error);
  await expect(prepareContainerImage(image, docker)).rejects.toBe(error);
  expect(docker).toHaveBeenCalledTimes(1);
});
