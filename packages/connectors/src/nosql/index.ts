import { NOSQL_KINDS } from '@riosoma/contracts';
import { registerConnector } from '../registry.js';
import { createNoSqlConnector } from './connector.js';
for (const kind of NOSQL_KINDS) registerConnector(createNoSqlConnector(kind));
export { createNoSqlConnector } from './connector.js';
export { endpoint as noSqlEndpoint, type NoSqlOptions } from './http.js';
export type { DocumentRequest } from './connector.js';
