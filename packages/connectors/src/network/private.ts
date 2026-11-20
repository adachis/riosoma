import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { FileNetworkError } from '../files/network.js';
import type { HostGuard } from '../warehouses/http.js';

/**
 * The private-network rule, shared by the server and the connector service.  An address is
 * private when it isn't on the public internet, and a host is private when any address it resolves
 * to is.  Only the operator's setting, or a local name while developing, lets a source reach one.
 */

/** What the rule depends on: whether this is production, and whether the operator allows private hosts. */
export interface PrivateNetworkPolicy {
  production: boolean;
  automationsAllowPrivateHosts?: boolean;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolve = (hostname: string) => Promise<ResolvedAddress[]>;

/** Every address a name resolves to, in the order the system gives them. */
export const lookupAll: Resolve = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));

type Range = [prefix: number[], bits: number];

// Addresses that aren't on the public internet: loopback, private, link-local (where cloud
// metadata services answer), shared, documentation, benchmarking, multicast, and reserved.
const V4_RANGES: Range[] = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];
const V6_RANGES: Range[] = [
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 128],
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 128],
  [[0x01, 0, 0, 0, 0, 0, 0, 0], 64],
  [[0x20, 0x01, 0, 0], 32],
  [[0x20, 0x01, 0x0d, 0xb8], 32],
  [[0xfc], 7],
  [[0xfe, 0x80], 10],
  [[0xfe, 0xc0], 10],
  [[0xff], 8],
];

function inRange(bytes: readonly number[], [prefix, bits]: Range): boolean {
  for (let bit = 0; bit < bits; bit += 8) {
    const mask = bits - bit >= 8 ? 0xff : (0xff << (8 - (bits - bit))) & 0xff;
    if (((bytes[bit / 8] ?? 0) & mask) !== ((prefix[bit / 8] ?? 0) & mask)) return false;
  }
  return true;
}

function v4Bytes(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.map(Number);
}

function v6Bytes(input: string): number[] | null {
  let address = input.replace(/%.*$/, '');
  let tail: number[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted) {
    const v4 = v4Bytes(dotted[1]!);
    if (!v4) return null;
    tail = v4;
    address = `${address.slice(0, dotted.index)}0:0`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const words = (text: string) => (text ? text.split(':') : []);
  const head = words(halves[0]!);
  const rest = halves.length === 2 ? words(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 2 && missing < 1) || (halves.length === 1 && missing !== 0)) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (all.some((word) => !/^[0-9a-fA-F]{1,4}$/.test(word))) return null;
  const bytes = all.flatMap((word) => {
    const value = parseInt(word, 16);
    return [value >> 8, value & 0xff];
  });
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** Whether an address is on the public internet. */
export function isPublicAddress(address: string): boolean {
  const v4 = v4Bytes(address);
  if (v4) return !V4_RANGES.some((range) => inRange(v4, range));
  const v6 = v6Bytes(address);
  if (!v6) return false;
  const zeros = (from: number, to: number) => v6.slice(from, to).every((byte) => byte === 0);
  // IPv4 carried inside IPv6 answers for the IPv4 address: mapped, compatible, NAT64, and 6to4.
  // That holds for an all-zero IPv4 address too, which a machine delivers to itself.
  if (zeros(0, 10) && ((v6[10] === 0xff && v6[11] === 0xff) || (v6[10] === 0 && v6[11] === 0)))
    return isPublicAddress(v6.slice(12, 16).join('.'));
  if (inRange(v6, [[0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96]))
    return isPublicAddress(v6.slice(12, 16).join('.'));
  if (inRange(v6, [[0x20, 0x02], 16])) return isPublicAddress(v6.slice(2, 6).join('.'));
  return !V6_RANGES.some((range) => inRange(v6, range));
}

/** A host without the brackets around an IPv6 address. */
export function bare(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, '$1');
}

export function isLocalhost(hostname: string): boolean {
  const host = bare(hostname).toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1';
}

/** Whether a call to this address may reach a private network. */
export function allowsPrivate(url: string, policy: PrivateNetworkPolicy): boolean {
  if (policy.automationsAllowPrivateHosts) return true;
  if (policy.production) return false;
  try {
    return isLocalhost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * A host as the rule compares it: without the brackets around an IPv6 address, and without the dot
 * that ends a full name, which points to the same place with or without it.
 */
function named(host: string): string {
  const name = bare(host);
  return isIP(name) ? name : name.replace(/\.$/, '');
}

/** Whether the rule lets a source reach this host on a private network. */
export function privateHostAllowed(host: string, policy: PrivateNetworkPolicy): boolean {
  const name = named(host);
  return allowsPrivate(`http://${isIP(name) === 6 ? `[${name}]` : name}/`, policy);
}

/**
 * Where a source's host names resolve: every address a name resolves to must pass the rule, and
 * the driver connects only to the addresses handed back.
 */
export function privateNetworkGuard(policy: PrivateNetworkPolicy, resolve: Resolve = lookupAll): HostGuard {
  return {
    async lookup(hostname) {
      const host = bare(hostname);
      const literal = isIP(host);
      let found;
      if (literal) found = [{ address: host, family: literal === 6 ? (6 as const) : (4 as const) }];
      else {
        try {
          found = await resolve(host);
        } catch {
          throw new FileNetworkError('resolve', `${host} didn’t resolve`);
        }
      }
      if (!found.length) throw new FileNetworkError('resolve', `${host} has no address`);
      if (!privateHostAllowed(host, policy) && found.some((entry) => !isPublicAddress(entry.address)))
        throw new FileNetworkError('blocked', `${host} is on a private network`);
      return found;
    },
    allowsAddress: (address) => privateHostAllowed(address, policy) || isPublicAddress(bare(address)),
  };
}

/** Whether a host the settings name outright is one the rule refuses before anything connects. */
export function refusedHost(host: string, policy: PrivateNetworkPolicy): boolean {
  const name = named(host);
  if (privateHostAllowed(name, policy)) return false;
  return isLocalhost(name) || (isIP(name) !== 0 && !isPublicAddress(name));
}
