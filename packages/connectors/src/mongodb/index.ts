/**
 * MongoDB sources: what the server checks in a source's addresses before it's saved, and how a
 * document becomes a record.  The connector itself, which needs the MongoDB driver, runs in the
 * connector service.
 */
export { asksForTls, isHost, parseConnectionString, refusedOption, type MongoAddress } from './address.js';
export { documentRecord, plainDecimal } from './documents.js';
