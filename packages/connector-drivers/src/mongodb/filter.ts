import { filterProblem } from '@riosoma/contracts';
import { BSON, type Document } from 'mongodb';
import { ConnectorError } from '@riosoma/connectors/internal/types.js';

export const FILTER_KEYS = {
  /** The filter isn't one JSON object */
  json: 'sources.mongodb.filter',
  /** The filter asks the server to run JavaScript */
  javascript: 'sources.mongodb.javascript',
} as const;

/** Whether a value, anywhere inside a filter, is a piece of JavaScript Extended JSON made. */
function holdsCode(value: unknown, depth = 0): boolean {
  if (typeof value !== 'object' || value === null) return false;
  // Deeper than any filter a person writes, so it's refused rather than left unchecked.
  if (depth > 100) return true;
  const type = (value as { _bsontype?: unknown })._bsontype;
  if (type === 'Code') return true;
  if (type !== undefined) return false;
  return Object.values(value).some((inner) => holdsCode(inner, depth + 1));
}

/**
 * A synced table's filter as the query document it runs as.  It's JSON, read as Extended JSON so
 * `{"$oid": "…"}` and `{"$date": "…"}` mean what they mean in MongoDB's own tools, and it only
 * ever runs as a filter: operators that run JavaScript on the server are refused before anything
 * is sent, and so is any piece of code the reading produced.
 */
export function parseFilter(text: string | undefined): Document {
  if (text === undefined || text.trim() === '') return {};
  const problem = filterProblem(text);
  if (problem === 'javascript')
    throw new ConnectorError(FILTER_KEYS.javascript, 'the filter uses $where, $function, or $accumulator');
  if (problem === 'json') throw new ConnectorError(FILTER_KEYS.json, 'the filter isn’t one JSON object');
  let filter: unknown;
  try {
    filter = BSON.EJSON.parse(text, { relaxed: true });
  } catch (error) {
    throw new ConnectorError(
      FILTER_KEYS.json,
      error instanceof Error ? error.message.slice(0, 300) : 'the filter isn’t Extended JSON',
    );
  }
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter))
    throw new ConnectorError(FILTER_KEYS.json, 'the filter isn’t one JSON object');
  if (holdsCode(filter)) throw new ConnectorError(FILTER_KEYS.javascript, 'the filter holds JavaScript');
  return filter as Document;
}
