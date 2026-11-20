import { createConnection } from 'node:net';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { ScannerAddress, type FileScannerStatus } from '@riosoma/contracts';
import type { FileScanner } from './scanner.js';

export function clamAvScanner(address: string): FileScanner {
  return {
    async scan(contents) {
      const signature = await scanStream(address, contents);
      return signature ? { state: 'infected', signature } : { state: 'clean' };
    },
  };
}

// The engine cannot scan a whole file beyond this size, regardless of its stream setting.
export const CLAMAV_MAX_FILE_BYTES = 2 ** 31 - 1;
export class ScanTooLarge extends Error {
  constructor() {
    super('files.scanner.tooLarge');
  }
}
export const EICAR = Buffer.from(
  ['X5O!P%@AP[4', '\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(''),
);

function connection(address: string, timeoutMs: number) {
  const url = new URL(ScannerAddress.parse(address));
  const socket =
    url.protocol === 'unix:'
      ? createConnection({ path: decodeURIComponent(url.pathname) })
      : createConnection({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) });
  const deadline = setTimeout(() => socket.destroy(new Error('Scanner timed out')), timeoutMs);
  let response = '';
  const answer = new Promise<string>((resolve, reject) => {
    socket.on('error', reject);
    socket.on('data', (bytes: Buffer) => {
      response += bytes.toString('utf8');
      if (response.length > 8192) return socket.destroy(new Error('Scanner response too long'));
      const end = response.indexOf('\0');
      if (end >= 0) resolve(response.slice(0, end));
    });
    socket.on('close', () => reject(new Error('Scanner disconnected')));
  });
  // Attach a handler before awaiting connect, which can reject on the same socket error.
  void answer.catch(() => undefined);
  return {
    socket,
    answer,
    async write(bytes: Buffer | string) {
      if (socket.destroyed) throw new Error('Scanner disconnected');
      if (!socket.write(bytes)) await once(socket, 'drain');
    },
    close() {
      clearTimeout(deadline);
      socket.destroy();
    },
  };
}

/** Only a complete stream and an explicit OK release bytes. */
export async function scanStream(
  address: string,
  source: Readable,
  timeoutMs = 60_000,
): Promise<string | null> {
  const peer = connection(address, timeoutMs);
  let complete = false;
  const verdict = peer.answer.then((result) => {
    if (/INSTREAM size limit exceeded/i.test(result) || /Heuristics\.Limits\.Exceeded/.test(result))
      throw new ScanTooLarge();
    if (result === 'stream: OK' && complete) return null;
    const infected = /^stream: (.+) FOUND$/.exec(result);
    if (infected) return infected[1]!;
    throw new Error('Scanner did not approve the complete file');
  });
  void verdict.catch(() => undefined);
  const send = async () => {
    await once(peer.socket, 'connect');
    await peer.write('zINSTREAM\0');
    let size = 0;
    for await (const value of source) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
      size += bytes.length;
      if (size > CLAMAV_MAX_FILE_BYTES) throw new ScanTooLarge();
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        const part = bytes.subarray(offset, offset + 64 * 1024);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(part.length);
        await peer.write(length);
        await peer.write(part);
      }
    }
    await peer.write(Buffer.alloc(4));
    complete = true;
    return verdict;
  };
  try {
    // A daemon may reject the limit before the source finishes or the send buffer drains.
    return await Promise.race([send(), verdict]);
  } finally {
    peer.close();
    source.destroy();
  }
}

async function command(address: string, name: string): Promise<string> {
  const peer = connection(address, 3000);
  try {
    await once(peer.socket, 'connect');
    await peer.write(`z${name}\0`);
    return await peer.answer;
  } finally {
    peer.close();
  }
}

export async function scannerStatus(address: string | null, test = false): Promise<FileScannerStatus> {
  const status: FileScannerStatus = {
    address,
    reachable: false,
    tested: false,
    signatureDate: null,
    lastError: null,
  };
  if (!address) return status;
  try {
    if ((await command(address, 'PING')) !== 'PONG') throw new Error('Invalid scanner response');
    status.reachable = true;
    // Older daemons may omit the signature date or not support VERSION.
    try {
      const version = await command(address, 'VERSION');
      const date = /^ClamAV [^/]+\/\d+\/(.+)$/.exec(version)?.[1];
      if (date && Number.isFinite(Date.parse(date))) status.signatureDate = new Date(date).toISOString();
    } catch {
      /* Reachability does not depend on optional version metadata. */
    }
    if (test) {
      const signature = await scanStream(address, Readable.from([EICAR]), 5000);
      status.tested = Boolean(signature && /Eicar|EICAR/i.test(signature));
      if (!status.tested) status.lastError = 'files.scanner.testFailed';
    }
  } catch (error) {
    status.lastError = error instanceof ScanTooLarge ? 'files.scanner.tooLarge' : 'files.scanner.unreachable';
  }
  return status;
}

export async function detectScanner(configured?: string | null): Promise<FileScannerStatus> {
  return detectScanners([...(configured ? [configured] : []), ...DEFAULT_SCANNER_ADDRESSES]);
}

export const DEFAULT_SCANNER_ADDRESSES = [
  'tcp://clamav:3310',
  'unix:///run/clamav/clamd.ctl',
  'unix:///run/clamav/clamd.sock',
  'unix:///var/run/clamav/clamd.sock',
];

export async function detectScanners(addresses: readonly string[]): Promise<FileScannerStatus> {
  let last = await scannerStatus(null);
  for (const address of new Set(addresses)) {
    const status = await scannerStatus(address, true);
    if (status.tested) return status;
    if (status.reachable || address === addresses[0]) last = status;
  }
  return last;
}
