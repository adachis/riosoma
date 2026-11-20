import { registerConnector } from '@riosoma/connectors';
import { createDriverConnectors } from './index.js';

// The tests reach the driver connectors through the registry, as the connector service does through
// its own set.  The server registers connectors that call the service instead.
for (const connector of createDriverConnectors()) registerConnector(connector);
