import { connect, createServer, type AddressInfo } from 'node:net';

/** How long a candidate port gets to answer before it counts as something other than a refusal. */
const PROBE_MS = 250;

/**
 * Ports a test run cannot be given, since only a privileged process may bind one, and none of the
 * ones an HTTP client refuses to dial before it even tries, so every kind of client is refused by
 * the network rather than by its own rules.  Each is checked before it is handed out, so a host
 * that does run something on one of them moves the test to the next.
 */
const CANDIDATES = [2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 24, 26, 28, 30, 32];

/**
 * A loopback port that refuses connections, for a test that needs an endpoint nobody answers on.
 *
 * Taking a free port and giving it back is a race the rest of the suite can lose: the operating
 * system hands that number to the next listener that asks for one, which with several test files
 * running at once is somebody else's stand-in, and it then receives bytes meant for the endpoint
 * this test wanted gone.  A port from the list above stays refused for as long as the test needs.
 */
export async function refusedPort(): Promise<number> {
  for (const port of CANDIDATES) if (await refuses(port)) return port;
  throw new Error('No loopback port refuses connections');
}

/** Whether a connection to this loopback port is refused at once, rather than answered or held. */
async function refuses(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const settle = (refused: boolean) => {
      clearTimeout(giveUp);
      socket.removeAllListeners();
      socket.destroy();
      resolve(refused);
    };
    // A port that accepts a connection and then says nothing would otherwise hold the probe open.
    const giveUp = setTimeout(() => settle(false), PROBE_MS);
    socket.once('connect', () => settle(false));
    socket.once('error', (error: NodeJS.ErrnoException) => settle(error.code === 'ECONNREFUSED'));
  });
}

/** A server that starts listening when given Node's listen options, as a Fastify app does */
export interface Listener {
  listen(options: { host: string; port: number }): Promise<unknown>;
}

/** A loopback port that stays bound from the moment it's chosen until a server takes it over */
export interface HeldPort {
  readonly port: number;
  /** Starts `server` listening on the held socket, which is the server's from then on. */
  serve(server: Listener): Promise<void>;
  /** Lets the port go.  Once a server has taken it over, closing that server lets it go instead. */
  release(): Promise<void>;
}

/**
 * A loopback port for a server that has to know its own address before it starts.
 *
 * Binding port 0, reading the number, and closing again leaves a gap before the server binds
 * that number, and anything on the machine can take the port in the gap: another test file's
 * listener, the local end of an outgoing connection, or a job of another CI runner on the same
 * host.  Here the socket that was given the port is the one the server listens on, so nothing
 * can come between.
 */
export async function holdPort(host = '127.0.0.1'): Promise<HeldPort> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, host, () => {
      probe.off('error', reject);
      resolve();
    });
  });
  const { port } = probe.address() as AddressInfo;
  let taken = false;
  return {
    port,
    async serve(server) {
      taken = true;
      // Node listens on a bound handle passed as `handle`, which is how a socket that's already
      // bound changes hands, and then ignores the host and port.
      const handle = (probe as unknown as { _handle: object })._handle;
      await server.listen({ host, port, handle } as { host: string; port: number });
    },
    async release() {
      if (!taken) await new Promise<void>((resolve) => probe.close(() => resolve()));
    },
  };
}
