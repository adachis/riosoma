import type { SourceConnection, SourceSecrets } from '@riosoma/contracts';
import { isHost, parseConnectionString, refusedOption, type HostGuard } from '@riosoma/connectors';
import { systemResolve, type Resolve } from '../automations/outbound.js';
import type { RuntimeConfig } from '../config.js';
import { refuse } from './files.js';
import { bare } from '../webhooks/url.js';
import { hostGuard, refusedHost } from './hosts.js';

/**
 * MongoDB sources on this server.  The connector runs in the connector service, under a network
 * that holds every host the driver looks up, and every address a connection string or a replica
 * set names outright, to the private-network rule webhooks, file sources, and API sources follow.
 * A host is private when any address it resolves to is, and only the operator's setting lets a
 * source reach one.  The server checks a source's addresses before it's saved or tried.
 */

type Config = Pick<RuntimeConfig, 'production' | 'automationsAllowPrivateHosts'>;

/** The network a MongoDB source reaches its servers through, which the connector service builds too. */
export function mongoNetwork(config: Config, resolve: Resolve = systemResolve): HostGuard {
  return hostGuard(config, resolve);
}

/**
 * Refuses a MongoDB source before it's saved or tried when its connection string doesn't read as
 * one, sets an option that would take the driver somewhere other than the servers it names, can't
 * go through its tunnel, or names a private address the rule forbids.  Names that resolve somewhere
 * private are caught again when the driver looks them up.  Behind a tunnel, the bastion is the host
 * the rule applies to, since the servers are the bastion's to reach.
 */
export function checkMongoSource(connection: SourceConnection, secrets: SourceSecrets, config: Config): void {
  if (connection.kind !== 'mongodb') return;
  let hosts: string[] = [];
  if (connection.address === 'uri') {
    // A missing string is the secrets check's to report.
    if (!secrets.connectionString) return;
    if (refusedOption(secrets.connectionString) !== null)
      refuse('connectionString', 'sources.mongodb.option');
    const address = parseConnectionString(secrets.connectionString);
    if (!address) refuse('connectionString', 'sources.mongodb.connectionString');
    if (connection.ssh && (address.srv || address.hosts.length !== 1))
      refuse('connectionString', 'sources.mongodb.tunnel');
    hosts = address.hosts.map((entry) => entry.host);
  } else if (connection.host) {
    // The host becomes part of an address the driver reads, so it can't carry anything else.
    if (!isHost(bare(connection.host))) refuse('host', 'sources.remote.host');
    hosts = [connection.host];
  }
  if (connection.ssh) {
    if (refusedHost(connection.ssh.host, config)) refuse('sshHost', 'sources.mongodb.blocked');
    return;
  }
  const field = connection.address === 'uri' ? 'connectionString' : 'host';
  if (hosts.some((host) => refusedHost(host, config))) refuse(field, 'sources.mongodb.blocked');
}
