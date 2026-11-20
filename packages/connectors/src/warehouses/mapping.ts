import type { SourceColumn } from '@riosoma/contracts';
import { column, NUMBER_ALTERNATIVES } from '../values.js';

/**
 * What a warehouse column's own type comes down to.  Each connector reads its system's type names
 * into one of these, and this module turns them into the same suggestions the SQL connectors make,
 * so a column maps to the same field type whichever system it lives in.
 */
export type TypeClass =
  | 'location'
  | 'integer'
  | 'decimal'
  | 'float'
  | 'boolean'
  | 'date'
  /** A date and time, with a zone or without one (which reads as UTC) */
  | 'timestamp'
  /** A clock reading with no day, which no field type holds, so it stays text */
  | 'time'
  | 'text'
  /** Structured values: JSON, variants, arrays, maps, and records, held as JSON text */
  | 'json'
  | 'binary'
  /** Anything else Riosoma can't hold, like geography, intervals, and bit strings */
  | 'unknown';

/** A column as a connector describes it, with the class its values are read by. */
export interface Described {
  column: SourceColumn;
  kind: TypeClass;
  /** Search mappings describe elements, so an array can arrive after scalar sampling */
  arraysAsJson?: boolean;
}

/** Declared lengths past this suggest long text, as they do for the SQL connectors. */
const LONG_TEXT = 1_000;
/** The highest number of decimal places a number field shows. */
const MOST_DECIMALS = 8;
const PLAIN = ['text', 'longText'];
/** A number can also be shown as money or as a percentage, which hold the same values. */
const NUMERIC = [...NUMBER_ALTERNATIVES];
const TEXT_ALTERNATIVES = ['longText', 'email', 'url', 'phone', 'singleSelect'];

export interface ColumnFacts {
  name: string;
  /** The system's own name for the type, like `NUMBER(38,0)` or `ARRAY<STRING>` */
  sourceType: string;
  nullable: boolean;
  kind: TypeClass;
  /** Digits after the point, for decimals.  When unknown, a number field shows values as entered */
  scale?: number | null;
  /** A declared maximum length, for text */
  length?: number | null;
  /** The values an enumerated type allows, in order */
  labels?: readonly string[];
}

/** One column as Riosoma sees it: the suggested field type, its options, and the alternatives. */
export function describeColumn(facts: ColumnFacts): Described {
  const { name, sourceType, nullable, kind } = facts;
  if (facts.labels && facts.labels.length > 0) {
    // An enumeration picks from a fixed list, which is a single select, choices and all.
    const spec = column({ name, type: 'enum', nullable, labels: [...facts.labels] }, 'postgres');
    return { column: { ...spec, sourceType }, kind: 'text' };
  }
  let suggested: SourceColumn['suggested'] = null;
  let alternatives: string[] = [];
  switch (kind) {
    case 'location':
      suggested = { type: 'location', options: {} };
      break;
    case 'integer':
      suggested = { type: 'number', options: { precision: 0 } };
      alternatives = NUMERIC;
      break;
    case 'decimal': {
      const scale = facts.scale;
      suggested = {
        type: 'number',
        options: {
          precision:
            scale === null || scale === undefined ? null : Math.max(0, Math.min(scale, MOST_DECIMALS)),
        },
      };
      alternatives = NUMERIC;
      break;
    }
    case 'float':
      suggested = { type: 'number', options: { precision: null } };
      alternatives = NUMERIC;
      break;
    case 'boolean':
      suggested = { type: 'checkbox', options: {} };
      alternatives = PLAIN;
      break;
    case 'date':
      suggested = { type: 'date', options: {} };
      alternatives = PLAIN;
      break;
    case 'timestamp':
      suggested = { type: 'date', options: { includeTime: true, timeZone: 'UTC' } };
      alternatives = PLAIN;
      break;
    case 'time':
    case 'text': {
      const long = kind === 'text' && (facts.length ?? 0) > LONG_TEXT;
      suggested = { type: long ? 'longText' : 'text', options: {} };
      alternatives = long ? [] : TEXT_ALTERNATIVES;
      break;
    }
    case 'json':
      suggested = { type: 'longText', options: {} };
      break;
    case 'binary':
    case 'unknown':
      break;
  }
  return { column: { name, sourceType, nullable, suggested, alternatives: [...alternatives] }, kind };
}

/** A type name with the digits the source declares, like `NUMBER(38,0)` or `VARCHAR(80)`. */
export function sized(name: string, first?: number | null, second?: number | null): string {
  if (first === null || first === undefined) return name;
  return second === null || second === undefined ? `${name}(${first})` : `${name}(${first},${second})`;
}
