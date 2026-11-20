import { sql, type Sql } from '@riosoma/db';

/**
 * JavaScript's `toLowerCase` and `toUpperCase` in SQL, so LOWER, UPPER, and SEARCH give the same
 * text in the database as the evaluator does.  PostgreSQL's own `lower` and `upper` follow the
 * database's collation, which can map characters differently or not at all, so they're used only
 * with the "C" collation, which changes ASCII letters and nothing else.  Every other character
 * goes through tables read from this JavaScript engine, so the two can't disagree:
 *
 * - `translate` for the characters that map to one character, like `É` to `é`.
 * - `replace` for the ones that map to several, like `ß` to `SS` and `İ` to `i` and a dot above.
 * - For lowercase, a capital sigma at the end of a word becomes `ς` first, where JavaScript's
 *   Final_Sigma rule puts it: after a cased letter and before none, skipping case-ignorable
 *   characters, like apostrophes and accents, either way.
 *
 * ASCII text, the usual case, takes only the first step.  The tables take a moment to read, so
 * they're read the first time a formula needs them.  When the engine maps characters in a way these
 * steps can't repeat, the tables are null and those formulas stay with JavaScript.
 */

interface Direction {
  /** Characters beyond ASCII that map to one character, and what each maps to, in order */
  from: string;
  to: string;
  /** Characters that map to more than one, and what each maps to */
  many: ReadonlyArray<readonly [string, string]>;
}

interface Tables {
  lower: Direction;
  upper: Direction;
  /** A pattern for each capital sigma that JavaScript lowercases as a final sigma */
  finalSigma: string;
}

const SIGMA = 'Σ';
const FINAL_SIGMA = 'ς';

/** A code point as a PostgreSQL regular expression escape. */
function escape(cp: number): string {
  return cp > 0xffff ? `\\U${cp.toString(16).padStart(8, '0')}` : `\\u${cp.toString(16).padStart(4, '0')}`;
}

/** A bracket expression matching exactly these code points, given in ascending order. */
function bracket(points: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < points.length;) {
    let j = i;
    while (j + 1 < points.length && points[j + 1] === points[j]! + 1) j++;
    parts.push(j === i ? escape(points[i]!) : `${escape(points[i]!)}-${escape(points[j]!)}`);
    i = j + 1;
  }
  return `[${parts.join('')}]`;
}

function read(): Tables | null {
  const lower = { from: '', to: '', many: [] as Array<readonly [string, string]> };
  const upper = { from: '', to: '', many: [] as Array<readonly [string, string]> };
  const cased = /\p{Cased}/u;
  const ignorable = /\p{Case_Ignorable}/u;
  // Letters that stop the Final_Sigma search with a match, and characters it passes over.  A
  // character that is both passes over, as JavaScript's engine treats it.
  const letters: number[] = [];
  const skipped: number[] = [];
  for (let cp = 1; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const char = String.fromCodePoint(cp);
    if (ignorable.test(char)) skipped.push(cp);
    else if (cased.test(char)) letters.push(cp);
    const asciiOnly = cp < 0x80;
    for (const [direction, mapped] of [
      [lower, char.toLowerCase()],
      [upper, char.toUpperCase()],
    ] as const) {
      if (mapped === char) continue;
      // The "C" collation's lower and upper cover ASCII letters, which map only to ASCII letters.
      if (asciiOnly) {
        if (!/^[A-Za-z]$/.test(char) || !/^[A-Za-z]$/.test(mapped)) return null;
        continue;
      }
      if ([...mapped].length === 1) {
        direction.from += char;
        direction.to += mapped;
      } else direction.many.push([char, mapped]);
    }
  }
  // Each step has to leave alone what an earlier one wrote, since the steps run one after another.
  for (const direction of [lower, upper]) {
    const expanding = new Set(direction.many.map(([char]) => char));
    const written = [...direction.to, ...direction.many.flatMap(([, mapped]) => [...mapped])];
    if (written.some((char) => expanding.has(char))) return null;
  }
  // The sigma step writes a final sigma, which the later steps have to leave as it is.
  if (lower.from.includes(FINAL_SIGMA) || !lower.from.includes(SIGMA)) return null;
  return {
    lower,
    upper,
    finalSigma: `(?<=${bracket(letters)}${bracket(skipped)}*)${escape(SIGMA.codePointAt(0)!)}(?!${bracket(skipped)}*${bracket(letters)})`,
  };
}

let tables: Tables | null | undefined;

function loaded(): Tables | null {
  if (tables === undefined) tables = read();
  return tables;
}

/** Text whose ASCII letters `ascii` has mapped, with the rest mapped through the tables. */
function mapped(direction: Direction, ascii: Sql): Sql {
  let result = sql`translate(${ascii}, ${direction.from}::text, ${direction.to}::text)`;
  for (const [char, replacement] of direction.many)
    result = sql`replace(${result}, ${char}::text, ${replacement}::text)`;
  return result;
}

/** `text.toLowerCase()` as SQL, or null when this engine's case tables can't be followed in SQL. */
export function lowerSql(text: Sql): Sql | null {
  const found = loaded();
  if (!found) return null;
  const sigmas = sql`CASE WHEN strpos(${text} COLLATE "C", ${SIGMA}::text) > ${0}
    THEN regexp_replace(${text} COLLATE "C", ${found.finalSigma}::text, ${FINAL_SIGMA}::text, ${'g'}) ELSE ${text} END`;
  return sql`CASE WHEN octet_length(${text}) = char_length(${text}) THEN lower(${text} COLLATE "C")
    ELSE ${mapped(found.lower, sql`lower((${sigmas}) COLLATE "C")`)} END`;
}

/** `text.toUpperCase()` as SQL, or null when this engine's case tables can't be followed in SQL. */
export function upperSql(text: Sql): Sql | null {
  const found = loaded();
  if (!found) return null;
  return sql`CASE WHEN octet_length(${text}) = char_length(${text}) THEN upper(${text} COLLATE "C")
    ELSE ${mapped(found.upper, sql`upper(${text} COLLATE "C")`)} END`;
}

/** For tests: the case tables as the SQL uses them, or null when SQL can't follow them. */
export function caseTables(): Readonly<Tables> | null {
  return loaded();
}
