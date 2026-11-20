import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

/*
 * Who owns a working folder or a lock that processes sharing storage leave behind: its process ID,
 * and when that process started, so an ID a later process reuses isn't mistaken for the owner.
 */

/** How far two readings of one process's start may differ, since each is rounded */
export const START_TOLERANCE_MS = 5_000;

/**
 * The time in milliseconds since 1970, read from the process's monotonic clock rather than the
 * date, so a test that freezes or moves the date never makes another process's folder or lock look
 * old.
 */
export const clock = () => performance.timeOrigin + performance.now();
/** When this process started, which its working folders and locks record beside its process ID */
export const STARTED = Math.round(performance.timeOrigin);

/** Whether a process with this ID is running, as far as this host can see */
export function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission to signal it is refused only when it exists.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * When each running process started, in milliseconds since 1970, where the system says.  Linux
 * keeps it in `/proc` as clock ticks since boot, 100 to the second.  Elsewhere the process listing
 * shows it to the second, asked for in UTC so a change of clocks never shifts it.  A process whose
 * start can't be read is left out.
 */
export async function processStarts(pids: readonly number[]): Promise<Map<number, number>> {
  const starts = new Map<number, number>();
  if (!pids.length) return starts;
  if (process.platform === 'linux') {
    try {
      const boot = Number(/^btime (\d+)$/m.exec(await readFile('/proc/stat', 'utf8'))?.[1]);
      for (const pid of pids) {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
        // Fields after the command name, which may hold spaces, start with the third, the state.
        const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
        if (stat && Number.isFinite(boot) && Number.isFinite(ticks))
          starts.set(pid, (boot + ticks / 100) * 1000);
      }
    } catch {
      /* Without /proc, no start is known. */
    }
    return starts;
  }
  let listing: string;
  try {
    // Its own environment, holding only the language and time zone the listing is read in.
    listing = (
      await promisify(execFile)('/bin/ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], {
        timeout: 5000,
        env: { LC_ALL: 'C', TZ: 'UTC0' },
      })
    ).stdout;
  } catch (error) {
    // A process that stopped since makes the listing fail, but the others are still listed.
    const stdout = (error as { stdout?: unknown }).stdout;
    listing = typeof stdout === 'string' ? stdout : '';
  }
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\S.*\S)\s*$/.exec(line);
    const at = match ? Date.parse(`${match[2]} GMT`) : NaN;
    if (Number.isFinite(at)) starts.set(Number(match![1]), at);
  }
  return starts;
}
