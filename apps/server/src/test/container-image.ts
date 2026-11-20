type DockerCommand = (args: string[], options?: { timeout: number }) => Promise<unknown>;

type ImagePreparation = { action: 'run' } | { action: 'skip'; reason: string };

/** Registry availability only matters until the base image is available locally. */
export async function prepareContainerImage(image: string, docker: DockerCommand): Promise<ImagePreparation> {
  try {
    await docker(['image', 'inspect', image]);
    return { action: 'run' };
  } catch (error) {
    // Daemon and permission errors are test failures, rather than evidence of a missing image.
    if (!(error as { stderr?: string }).stderr?.includes('No such image')) throw error;
  }

  try {
    await docker(['pull', image], { timeout: 120_000 });
    return { action: 'run' };
  } catch (error) {
    return {
      action: 'skip',
      reason: `Container image ${image} could not be fetched: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
