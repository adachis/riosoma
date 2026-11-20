import type { ChildProcess } from 'node:child_process';

/** File cleanup must wait for both the process and its output streams to close. */
export async function stopProcess(
  child: ChildProcess,
  closed: Promise<void>,
  name: string,
  waitMs = 10_000,
): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const stopped = Promise.race([
      closed,
      new Promise<void>((_, reject) => {
        deadline = setTimeout(() => {
          const running = child.exitCode === null && child.signalCode === null;
          if (running) child.kill('SIGKILL');
          // Inherited pipes must not keep a failed teardown alive after its deadline.
          child.stdout?.destroy();
          child.stderr?.destroy();
          reject(
            new Error(
              `${name} (PID ${child.pid ?? 'unknown'}) did not ${running ? 'exit' : 'close its output streams'} within ${waitMs / 1000} seconds`,
            ),
          );
        }, waitMs);
      }),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await stopped;
  } finally {
    clearTimeout(deadline);
  }
}
