import type { ChildProcess } from 'node:child_process';

export async function waitForVersionServerShutdown(shutdown: Promise<void>, server?: ChildProcess) {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      shutdown,
      new Promise<void>((_, reject) => {
        deadline = setTimeout(() => {
          if (server && (server.exitCode !== null || server.signalCode !== null)) {
            // Descendants can keep output pipes open after the server has finished writing files.
            server.stdout?.destroy();
            server.stderr?.destroy();
            return;
          }
          server?.kill('SIGKILL');
          reject(new Error('Version test server did not exit within 10 seconds'));
        }, 10_000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
