import type { Connector, ConnectorContext, ContractTransport } from '@riosoma/connectors';
import type { SourceSelect } from '@riosoma/contracts';

/**
 * A connector set up against its driver's fixture, with what the shared contract needs to run it:
 * its context, the object it reads, that object's key, how many rows it holds, and the boundary
 * that sees every request.  The connector's own tests run it directly, and the connector service's
 * contract test runs it in the service, through the server's connector.
 */
export interface ContractFixture {
  connector: Connector;
  context: ConnectorContext;
  select: Extract<SourceSelect, { kind: 'object' }>;
  keyColumns: string[];
  count: number;
  boundary: ContractTransport;
  timeoutCall?: (ctx: ConnectorContext) => Promise<unknown>;
}
