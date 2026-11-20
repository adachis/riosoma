import { BlockList, isIP } from 'node:net';
import { CustomDomainHost } from '@riosoma/contracts';

/** How many custom domains one organization may have added at once, unless the operator says otherwise */
export const DEFAULT_CUSTOM_DOMAIN_LIMIT = 50;

function addresses(value: string): BlockList {
  const list = new BlockList();
  for (const entry of value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const [address = '', prefix, extra] = entry.split('/');
    const family = isIP(address);
    if (!family || extra !== undefined) throw new Error('invalid proxy address');
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(address, type);
    else {
      if (!/^\d{1,3}$/.test(prefix)) throw new Error('invalid proxy network');
      list.addSubnet(address, Number(prefix), type);
    }
  }
  return list;
}

export function validAddresses(value: string): boolean {
  try {
    addresses(value);
    return true;
  } catch {
    return false;
  }
}

export function addressAllowed(address: string | undefined, value: string): boolean {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/, '');
  const family = isIP(normalized);
  return Boolean(family && addresses(value).check(normalized, family === 4 ? 'ipv4' : 'ipv6'));
}

export function validTarget(value: string): boolean {
  return Boolean(isIP(value)) || CustomDomainHost.safeParse(value).success;
}
