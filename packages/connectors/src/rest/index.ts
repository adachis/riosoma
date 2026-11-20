/**
 * API sources: endpoints of a web API that answers in JSON.  The server registers the connector
 * with its own guarded network, the one file sources use.
 */
export {
  createRestConnector,
  endpointUrl,
  firstUrl,
  isRestConnector,
  REST_KEYS,
  type RestConnector,
  type RestConnectorOptions,
} from './connector.js';
export { nextLink, pace, retryAfterMs } from './http.js';
export {
  cellsOf,
  isRecordObject,
  KeyScan,
  listPaths,
  parseJson,
  Sampler,
  valueAt,
  type RestColumn,
} from './records.js';
