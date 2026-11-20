/**
 * Feed sources: RSS 2.0, RSS 1.0, Atom 1.0, and JSON Feed at a web address.  The server registers
 * the connector with its own guarded network, the one file and API sources use.
 */
export {
  createFeedConnector,
  FEED_CONNECTOR_KEYS,
  FEED_SOURCE_COLUMNS,
  feedValue,
  type FeedConnectorOptions,
} from './connector.js';
export { decodeEntities, htmlText, htmlToDoc, htmlToMarkdown } from './html.js';
export { feedDate, parseFeed, type FeedItem, type ParsedFeed } from './parse.js';
