/**
 * Browser steps in CI must run inside the loopback-only network namespace that
 * `tools/ci/loopback-only.sh` creates.  Interface changes on the host fail Chromium's in-flight
 * requests, even to 127.0.0.1, with net::ERR_NETWORK_CHANGED, and a namespace of its own keeps
 * those changes out.  This guard stops a new, unwrapped browser step from slipping in.
 */

/** Browsers count a machine with only loopback as offline, so the namespace adds this interface. */
const ONLINE_INTERFACE = 'rio-online';

export function checkLoopbackOnly({
  env,
  platform,
  interfaces,
}: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** The key list of `os.networkInterfaces()`. */
  interfaces: string[];
}): { warning?: string } {
  if (!env.CI || platform !== 'linux') return {};
  const mode = env.RIOSOMA_LOOPBACK_ONLY;
  if (mode === undefined)
    throw new Error(
      'Browser steps in CI must run through tools/ci/loopback-only.sh.  ' +
        "Host network interface changes fail Chromium's in-flight requests, even to 127.0.0.1, with net::ERR_NETWORK_CHANGED.",
    );
  if (mode === '1') {
    const outside = interfaces.filter((name) => name !== 'lo' && name !== ONLINE_INTERFACE);
    if (outside.length)
      throw new Error(
        `RIOSOMA_LOOPBACK_ONLY=1, but interfaces other than lo and ${ONLINE_INTERFACE} are visible: ${outside.join(', ')}.  ` +
          'The step is not in the loopback-only network namespace that tools/ci/loopback-only.sh creates.',
      );
    if (!interfaces.includes(ONLINE_INTERFACE))
      throw new Error(
        `RIOSOMA_LOOPBACK_ONLY=1, but the ${ONLINE_INTERFACE} interface is missing, so browsers would report themselves offline ` +
          'and the app would hold its writes.',
      );
    return {};
  }
  if (mode === 'unavailable')
    return {
      warning:
        'The loopback-only network namespace is unavailable on this runner, so the browser step runs on the host network.  ' +
        "Host interface changes can fail Chromium's loopback requests with net::ERR_NETWORK_CHANGED.",
    };
  throw new Error(
    `RIOSOMA_LOOPBACK_ONLY has an unexpected value: ${JSON.stringify(mode)}.  Expected 1 or unavailable.`,
  );
}
