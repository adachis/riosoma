/** Reject string timers before the browser can interpret them as executable code. */
export function functionCallback<T extends (...args: never[]) => unknown>(callback: T): T {
  if (typeof callback !== 'function') throw new TypeError('Timer callbacks must be functions');
  return callback;
}
