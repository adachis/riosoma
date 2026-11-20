import {
  privateHostAllowed as privateHostAllowedUnder,
  privateNetworkGuard,
  refusedHost as refusedHostUnder,
  type HostGuard,
} from '@riosoma/connectors';
import { systemResolve, type Resolve } from '../automations/outbound.js';
import type { RuntimeConfig } from '../config.js';

/**
 * The private-network rule for sources whose drivers connect to a host by name, like MongoDB and
 * the analytics engines, which is the rule webhooks, file sources, and API sources follow.  A host
 * is private when any address it resolves to is, and only the operator's setting lets a source
 * reach one.  The rule itself lives with the connectors, so the connector service holds the
 * sources it runs to exactly the same one.
 */

type Config = Pick<RuntimeConfig, 'production' | 'automationsAllowPrivateHosts'>;

/** Whether the rule lets a source reach this host on a private network. */
export function privateHostAllowed(host: string, config: Config): boolean {
  return privateHostAllowedUnder(host, config);
}

/**
 * Where a source's host names resolve: every address a name resolves to must pass the rule, and
 * the driver connects only to the addresses handed back.
 */
export function hostGuard(config: Config, resolve: Resolve = systemResolve): HostGuard {
  return privateNetworkGuard(config, resolve);
}

/** Whether a host the settings name outright is one the rule refuses before anything connects. */
export function refusedHost(host: string, config: Config): boolean {
  return refusedHostUnder(host, config);
}
