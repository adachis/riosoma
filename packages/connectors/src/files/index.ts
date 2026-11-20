/**
 * File sources: one file at a web address, or files in an S3-compatible bucket.  The server
 * registers them with its own guarded network and workbook reader, since both belong to it.
 */
export {
  createFileConnector,
  createFileConnectors,
  DEFAULT_MAX_BYTES,
  FILE_KEYS,
  nodeSockets,
  type FileConnectorOptions,
  type Sockets,
} from './connector.js';
export { cellValue, type CellReading, type FileCell } from './cells.js';
export { remoteFileAddress } from './remote.js';
export type { SpreadsheetEvent, SpreadsheetReader } from './engine.js';
export {
  FileNetworkError,
  NO_NETWORK,
  type CheckedAddress,
  type FileNetwork,
  type FileNetworkProblem,
  type FileRequest,
  type FileResponse,
} from './network.js';
