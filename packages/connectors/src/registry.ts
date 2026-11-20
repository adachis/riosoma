import type { CellValue, SourceKind } from '@riosoma/contracts';
import { ConnectorError, type Connector } from './types.js';

export * from './types.js';

const registry = new Map<SourceKind, Connector>();

/** Makes a connector available.  Each kind's module registers itself; tests may register fakes. */
export function registerConnector(connector: Connector): void {
  registry.set(connector.kind, connector);
}

export function connectorFor(kind: SourceKind): Connector {
  const connector = registry.get(kind);
  if (!connector) throw new ConnectorError('sources.kindUnavailable', undefined, { kind });
  return connector;
}

export function availableKinds(): SourceKind[] {
  return [...registry.keys()];
}

/**
 * A row's key: its key columns' values as a JSON array.  Numbers and text that look alike stay
 * distinct (`[1]` and `["1"]`), and the form never depends on the driver, so a record keeps its
 * key when a source moves from one system to another with the same data.
 */
export function sourceKey(values: readonly CellValue[]): string {
  return JSON.stringify(values.map((value) => (value === undefined ? null : value)));
}
