/** Object identity keeps the process grant outside serialized commands and archives. */
export const ingestCapability: unique symbol = Symbol('ingest');
export type IngestCapability = typeof ingestCapability;
