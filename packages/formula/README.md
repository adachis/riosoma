# Formula engine

`@riosoma/formula` is the browser-safe parser, resolver, checker, and evaluator.
`@riosoma/formula/sql` is the server entry point for the PostgreSQL compiler. The
root entry point never imports database runtime code. Only existing workspace
packages are dependencies; the test suite uses `@riosoma/testkit`.

## API and value contract

```ts
import { parse, resolve, check, evaluate } from '@riosoma/formula';
import { compileSql } from '@riosoma/formula/sql';

const parsed = parse('{Price} * 2');
if ('ast' in parsed) {
  const resolved = resolve(parsed.ast, fields, currentFormulaFieldId);
  if ('ast' in resolved) {
    const checked = check(resolved.ast);
    if ('type' in checked) {
      const value = evaluate(resolved.ast, record, context);
      const expression = compileSql(resolved.ast, fields, sqlContext);
    }
  }
}
```

- `parse(source)` returns `{ ast }` or `{ error }`. Error spans are zero-based,
  end-exclusive UTF-16 offsets into the original source. EOF has a zero-length
  span. Errors contain a `messageKey` and optional interpolation `params`.
- `resolve(ast, fields, selfId?)` returns a new AST with stable field IDs and type
  metadata. Supply the current formula field ID to reject direct self references.
  It accepts a field array or map. Name matching is case-insensitive; ambiguous
  names are errors. Resolving an already resolved tree uses IDs, even after a
  rename. `references(ast)` deduplicates IDs in first-use order. The caller detects
  longer cycles. `describe(ast, fields)` prints a reparsable formula with current
  names and explicit parentheses.
- `check(ast, fieldTypes?)` returns `{ type }` or a positioned error. The optional
  map supplies current types or field descriptors. Types are `number`, `text`,
  `boolean`, `date`, `datetime`, `blank`, or `{ array: elementType }`. `blank` fits
  any argument. Boolean values can participate in arithmetic as 1 and 0. IF and
  SWITCH branches must have the same nonblank type. Date arguments also accept
  text that can be parsed as a date. `FUNCTIONS` exposes every arity and signature.
- A field descriptor's optional `valueType` says what a computed field holds when
  its type alone can't, such as `{ array: 'number' }` for a lookup of prices.  It
  wins over the type's own.
- A lookup reference (a field of type `lookup` holding `{ array: item }`) reads as
  its one item where its list wouldn't fit and one item would: an argument that
  takes a number, text, or date, either side of arithmetic, and a comparison or
  SWITCH match against a single value.  There the checker types it as its item, and
  `check` lists such lookups by field ID, in the order they appear, as `oneValue`.
  At run time the list reads as its item when it holds exactly one, as blank when
  it's empty, and as the error `formula.list.several` when it holds more than one.
  An item of another type than the checker gave, which a lookup holds only briefly
  after its target changes type, reads as blank, or for text as its text.  Wherever
  a list already fits, such as COUNT, CONCATENATE, `&`, IF, or the array
  functions, a lookup stays a list, so no formula that checked before changes its
  meaning.  A lookup with no value at all reads as an empty list.  A link reads the
  same way, as its list of names, so `{Client} = "Forrester"` compares the one
  linked record's name.  A multiple select never reads as one value.
  `singleReads(ast, fieldTypes?)` returns the references read this way.
- ASTs are immutable. Resolve and check once, then reuse the AST. The evaluator
  caches prepared functions in a WeakMap, never record values or a clock result.
- Records contain `values: CellValues`, `id`, `createdAt`, and `updatedAt`.
  Context contains an explicit `now`, an IANA `timeZone`, and optional `choices`
  and `people` maps from IDs to current names. Unknown choice/person IDs yield
  blanks.  Multiple selects preserve order and become arrays of choice names, an
  empty one an empty array.
- A link field's value in a record is its linked records' names, in link order,
  which the caller looks up: each linked record's primary field as the app shows
  it, even when that name is empty.  Formulas never see linked record IDs.  A
  record linked to nothing holds an empty array.  `RECORD_ID()` still gives the
  record's own ID.
- Results are numbers, text, booleans, ISO day/instant strings, arrays, `null`, or
  `{ error: '#ERROR!', messageKey, params? }`. The error marker is a protocol value;
  callers translate the reason key for display. Dates remain typed internally.
  No system clock, network, database, or record mutation is used by evaluation.
- Blank means null, empty text, or an empty array. Arithmetic converts null to 0;
  concatenation converts it to empty text. Comparisons involving a blank return
  false, except equality of two blank values. False and numeric zero remain
  distinct from blank. IF, SWITCH, AND, OR, `&&`, and `||` evaluate only the needed
  branches. Strict functions propagate the first error; ISERROR consumes it.
- Numeric failures (including nonfinite results) produce keyed errors. Text
  indexing and LEN use UTF-16 positions. Text and array indexes start at 1.
  String escapes include quotes, backslash, newline, tab, carriage return, and
  four-digit Unicode escapes. Field names escape closing braces with `\}`.

## Function semantics

The compatibility target is the [Airtable function reference](https://support.airtable.com/articles/7330071120-airtable-formula-field-functions-reference).
Each row describes the implemented behavior. Optional arguments appear in brackets.

| Function | Signature and semantics |
| --- | --- |
| ABS | `ABS(n)`: absolute value; blank becomes zero. |
| ROUND | `ROUND(n, precision)`: decimal rounding, ties toward positive infinity, including negative numbers. Negative precision rounds left of the decimal. |
| ROUNDUP | `ROUNDUP(n, precision)`: rounds away from zero. |
| ROUNDDOWN | `ROUNDDOWN(n, precision)`: truncates toward zero. |
| CEILING | `CEILING(n, [step=1])`: next multiple at or above n; step must be positive. |
| FLOOR | `FLOOR(n, [step=1])`: next multiple at or below n; step must be positive. |
| INT | `INT(n)`: integer floor, including negative numbers. |
| MOD | `MOD(n, divisor)`: remainder with the dividend's sign; a zero divisor is an error. |
| POWER | `POWER(base, exponent)`: exponentiation; nonreal/nonfinite results are errors. |
| SQRT | `SQRT(n)`: square root; negative input is an error. |
| EXP | `EXP(n)`: exponential; overflow is an error. |
| LOG | `LOG(n, [base=10])`: logarithm; input/base must be positive and base cannot be one. |
| LOG10 | `LOG10(n)`: base-ten logarithm. |
| MAX | `MAX(n, …)`: largest numeric argument, flattening lists and ignoring blanks.  All blank returns zero. |
| MIN | `MIN(n, …)`: smallest numeric argument, flattening lists and ignoring blanks.  All blank returns zero. |
| SUM | `SUM(n, …)`: sum of numeric arguments in order, flattening lists in place and ignoring blanks and booleans. |
| AVERAGE | `AVERAGE(n, …)`: mean of numeric arguments, flattening lists and ignoring blanks.  No numeric inputs is an error. |
| COUNT | `COUNT(value, …)`: count numeric elements; arrays are flattened and booleans are not numbers. |
| COUNTA | `COUNTA(value, …)`: count nonblank elements, including false and zero. |
| COUNTALL | `COUNTALL(value, …)`: count elements including blanks; arrays are flattened. |
| VALUE | `VALUE(text)`: parse a signed decimal/exponent after removing whitespace, grouping commas, and common currency symbols; invalid or empty input is an error. |
| EVEN | `EVEN(n)`: round away from zero to an even integer; zero stays zero. |
| ODD | `ODD(n)`: round away from zero to an odd integer; zero becomes one. |
| CONCATENATE | `CONCATENATE(value, …)`: join values; blank becomes empty text, booleans become 1/0, and arrays join with comma-space. |
| LEN | `LEN(text)`: UTF-16 length; blank has length zero. |
| LEFT | `LEFT(text, count)`: take the first count characters; negative count is an error. |
| RIGHT | `RIGHT(text, count)`: take the last count characters; zero returns empty text. |
| MID | `MID(text, start, count)`: take count characters from the one-based start. |
| FIND | `FIND(needle, text, [start])`: case-sensitive one-based position; zero if absent. |
| SEARCH | `SEARCH(needle, text, [start])`: case-insensitive position; blank if absent. |
| SUBSTITUTE | `SUBSTITUTE(text, old, replacement, [occurrence])`: replace all literal occurrences or only the specified one-based occurrence. Empty old text leaves input unchanged. |
| REPLACE | `REPLACE(text, start, count, replacement)`: replace a character range. |
| LOWER | `LOWER(text)`: Unicode lowercase. |
| UPPER | `UPPER(text)`: Unicode uppercase, including expanding characters. |
| TRIM | `TRIM(text)`: remove surrounding Unicode whitespace; preserve internal spaces. |
| REPT | `REPT(text, count)`: repeat a nonnegative truncated count; bounds cap count and output at one million. |
| T | `T(value)`: preserve text; other values become blank. Errors still propagate. |
| ENCODE_URL_COMPONENT | `ENCODE_URL_COMPONENT(text)`: percent-encode UTF-8 except letters, digits, hyphen, underscore, period, and tilde. |
| REGEX_MATCH | `REGEX_MATCH(text, pattern)`: whether a match exists; invalid patterns are errors. |
| REGEX_EXTRACT | `REGEX_EXTRACT(text, pattern)`: first complete match; no match is an error. |
| REGEX_REPLACE | `REGEX_REPLACE(text, pattern, replacement)`: replace all matches; numbered capture substitutions are supported. |
| IF | `IF(condition, yes, [no=BLANK()])`: evaluate only the selected branch. |
| SWITCH | `SWITCH(value, pattern, result, …, [default])`: first matching pattern wins; only its result is evaluated; no match/default is blank. |
| AND | `AND(value, …)`: stop at the first false value or error. |
| OR | `OR(value, …)`: stop at the first true value or error. |
| NOT | `NOT(value)`: invert truthiness. |
| XOR | `XOR(value, …)`: true for an odd number of true arguments. |
| TRUE | `TRUE()` or `TRUE`: boolean true. |
| FALSE | `FALSE()` or `FALSE`: boolean false. |
| BLANK | `BLANK()`: null. |
| ERROR | `ERROR([detail])`: explicit keyed error; supplied detail is a parameter, never a reason string. |
| ISERROR | `ISERROR(expression)`: true for an error value, false otherwise. |
| TODAY | `TODAY()`: day containing context.now in context.timeZone. |
| NOW | `NOW()`: context.now as a UTC ISO instant. |
| DATEADD | `DATEADD(date, amount, unit)`: always returns an instant; day/week additions use calendar days, month/quarter/year additions clamp month ends, smaller units use elapsed time. |
| DATETIME_DIFF | `DATETIME_DIFF(a, b, [unit=seconds])`: a minus b, truncated to whole units; days/weeks use wall time and month units use clamped calendar anchors. |
| DATETIME_FORMAT | `DATETIME_FORMAT(date, [format=YYYY-MM-DD])`: text using calendar/time tokens and context time zone or SET_TIMEZONE override. |
| DATETIME_PARSE | `DATETIME_PARSE(text, [format], [locale=en])`: parse explicit calendar components into an instant; reject impossible dates. Unzoned input uses context.timeZone. Blank stays blank. |
| YEAR | `YEAR(date)`: local calendar year. |
| MONTH | `MONTH(date)`: local month, 1–12. |
| DAY | `DAY(date)`: local day of month, 1–31. |
| HOUR | `HOUR(date)`: local hour, 0–23. |
| MINUTE | `MINUTE(date)`: local minute, 0–59. |
| SECOND | `SECOND(date)`: local whole second, 0–59. |
| WEEKDAY | `WEEKDAY(date, [start=Sunday])`: zero-based weekday; start may be Sunday or Monday. |
| WEEKNUM | `WEEKNUM(date, [start=Sunday])`: week containing January 1 is week one; start may be Sunday or Monday. |
| WORKDAY | `WORKDAY(date, count, [holidays])`: move a truncated number of working days, excluding the starting day, weekends, and comma-separated ISO holidays; returns a day. |
| WORKDAY_DIFF | `WORKDAY_DIFF(start, end, [holidays])`: inclusive count of business days; reverse ranges produce a negative count. |
| IS_BEFORE | `IS_BEFORE(a, b)`: compare instants; a day represents local midnight. Blank returns false. |
| IS_AFTER | `IS_AFTER(a, b)`: inverse temporal comparison; blank returns false. |
| IS_SAME | `IS_SAME(a, b, [unit=second])`: same local calendar bucket at the supplied precision. Blank returns false. |
| SET_TIMEZONE | `SET_TIMEZONE(date, zone)`: preserve the instant while attaching an IANA zone for downstream date functions; invalid zones are errors. |
| DATESTR | `DATESTR(date)`: local `YYYY-MM-DD` text. |
| TIMESTR | `TIMESTR(date)`: local `HH:mm:ss` text. |
| RECORD_ID | `RECORD_ID()`: record.id. |
| CREATED_TIME | `CREATED_TIME()`: record.createdAt as an instant. |
| LAST_MODIFIED_TIME | `LAST_MODIFIED_TIME([field, …])`: record.updatedAt without arguments; otherwise the latest requested `record.fieldUpdatedAt` entry. Missing per-field metadata is an explicit error. |
| ARRAYJOIN | `ARRAYJOIN(array, [separator=", "])`: join stringified elements. Blank input becomes empty text. |
| ARRAYUNIQUE | `ARRAYUNIQUE(array)`: retain the first occurrence of each structurally equal element. |
| ARRAYCOMPACT | `ARRAYCOMPACT(array)`: discard blanks; retain false, zero, and whitespace-only strings. |
| ARRAYFLATTEN | `ARRAYFLATTEN(array)`: recursively remove nesting while preserving element order. |
| ARRAYSLICE | `ARRAYSLICE(array, start, [end])`: one-based inclusive bounds; negative bounds count back from the end. Blank input becomes an empty array. |

Date units accept singular/plural names and `ms`, `s`, `m`, `h`, `d`, `w`, `M`,
`Q`, and `y`. Case distinguishes minute `m` from month `M`. Unrecognized units are
errors. Date extraction/formatting returns blank for blank input. Day values never
shift simply because the viewer's zone changes. Calendar operations retain local
wall time across daylight saving changes. An ambiguous repeated wall time chooses
the earlier instant; a nonexistent wall time moves forward across the gap.

Formatting includes year, month names, ordinals, day/year/week numbers, ISO week
years, 12/24-hour time, fractional seconds, offsets, Unix timestamps, bracketed
literals, and `L`/`LT` presets. Parsing supports explicit numeric calendar/time
components, localized month names, AM/PM, offsets, Unix timestamps, and those
presets composed of these components. Without a format, input must be ISO or an
American slash date. It does not depend on host-specific `Date.parse` heuristics.
See [format tokens](https://support.airtable.com/articles/2278160967-formatting-dates-with-datetime-format-in-airtable).

Regex functions use a prioritized finite-state matcher with captures, greedy and
lazy repetition, scoped `i`/`m`/`s`/`U` flags, ASCII/POSIX and Unicode character
classes, quoted literals, and numbered/named replacements. Matching processes
states once per character instead of backtracking over the input. Lookaround and
backreferences are rejected. The `\C` escape consumes one UTF-8 byte; captures
that split a character decode with replacement characters. Pattern length, nesting, counted repetition, and
compiled state count are bounded; invalid patterns produce keyed errors. See
[regular expression semantics](https://support.airtable.com/articles/9064687080-using-regex-functions-in-airtable).

## SQL result and fallback

`compileSql(ast, fields, context)` takes the evaluation context plus a
`columnRef(field)` callback returning a trusted `Sql` fragment (or null), an
optional `errorRef(field)` callback returning a field's own error value as JSONB,
and an optional `systemRef('id' | 'createdAt' | 'updatedAt')` callback.  This keeps
physical column naming, table aliases, and system columns in the caller.  No server
package is imported.  Callbacks must return raw typed columns, not
display-formatted text.  A lookup's column is a JSONB array of its items: JSON
numbers, strings, and booleans, with dates as ISO text.  Return null for a lookup
whose items are objects, such as date ranges, which only JavaScript writes as text.
A link's column is a JSONB array of its linked records' names, the same names the
caller hands `evaluate`.  Choice columns hold choice IDs, a single select's as text
and a multiple select's as `text[]`, which compile to their names through the
context's `choices`.

The returned scalar expression has PostgreSQL type JSONB. Successful values decode
through the database driver to exactly the evaluator's external values; errors
retain their reason keys. SQL NULL represents blank. The caller can extract/cast a
successful scalar using the checked formula type for sorting or filtering. All
formula literals, names, time zones, timestamps, and error values are parameters.
Construction uses only the database SQL builders.

Supported compilation includes arithmetic, comparisons, blank rules, lazy logic,
IF/SWITCH, ABS/INT, numeric aggregates/counts, text concatenation, numbers joined
with text (written exactly as JavaScript's `String()` writes them), LEN, TRIM, T,
LOWER/UPPER, FIND/SEARCH, three-argument SUBSTITUTE, REPT, ROUND with a constant
precision, ARRAYJOIN of lookups, links, and multiple selects, record functions
without field arguments, TODAY/NOW, date component extraction, DATESTR/TIMESTR,
WEEKDAY/WEEKNUM with fixed week starts, temporal comparisons, fixed-unit
elapsed/day/week DATETIME_DIFF, IS_SAME except weeks, and DATEADD with bounded
constant offsets in UTC.

LOWER, UPPER, and SEARCH give JavaScript's `toLowerCase` and `toUpperCase`, not the
database collation's.  ASCII text uses PostgreSQL's `lower` and `upper` under the
`"C"` collation, which change ASCII letters only.  Other text goes through tables
read from the running JavaScript engine the first time they're needed: `translate`
for characters that map to one character, `replace` for ones that map to several,
like `ß` to `SS`, and, for lowercase, a pattern that writes a capital sigma at the
end of a word as `ς`, as JavaScript's Final_Sigma rule does.  FIND and SEARCH count
UTF-16 positions, from a start held to the text, with zero (FIND) or blank
(SEARCH) when nothing is found.  ROUND multiplies by JavaScript's own
`10 ** precision`, which is why the precision has to be constant, checks for
overflow the way arithmetic does, and breaks ties toward positive infinity, as
`Math.round` does.

Lookups, links, and multiple selects compile too.  Lookups and links read as one
value with the same blank and `formula.list.several` rules, and all three are
flattened by SUM, AVERAGE, MAX, MIN, COUNT, COUNTA, COUNTALL, CONCATENATE, and
`&`.  SUM and AVERAGE add a list's numbers one at a time in order, as JavaScript
does, checking each step for overflow first, since PostgreSQL fails a whole query
on an overflowing sum.  A looked-up number too
large for a double reads as blank and one too small as zero, as the server reads
them.  A lookup's truthiness is whether it holds anything.

The compiler returns null for an expression containing unsupported behavior,
including regex, locale formatting/parsing, array operations other than ARRAYJOIN,
a list as the result of the formula or of IF or SWITCH, lists compared with each
other, lists other than lookups, links, and multiple selects, ROUND with a precision
that isn't constant, text ordering, field-specific modification timestamps, dynamic
calendar offsets, or calendar arithmetic in non-UTC zones.  These cases remain
available through JavaScript.  Returning null is also required when the caller
cannot provide a column or required system column.

## Verification

`pnpm install --silent && pnpm turbo run build lint typecheck test --filter=@riosoma/formula...`

Vitest starts a real isolated PostgreSQL database through `@riosoma/testkit`.
The seeded differential generator produces 2,000 distinct, well-typed formulas
with nesting through depth four and 20 independently generated records per
formula. It exercises all five scalar types, blanks, Unicode, errors, and lazy
branches.  Further generated and fixed cases cover number-like fields joined with
text, error values handed in by fields, and lookups of every item type read as
one value and totaled, over lists of none, one, and several items, including sums
that overflow partway.  Case conversion covers every character that has a case or
that the sigma rule reads, and a capital sigma beside each of them.  FIND and SEARCH
run over characters outside the Basic Multilingual Plane and starts inside them, and
ROUND over ties, both ends of the number line, and precisions at and past its limits.
Links and choices read by name, with names holding commas,
quotes, and nothing at all, records linked to nothing, choices that no longer
exist, and names a linked table's primary field formula writes.  Failures print
the formula, record, and time zone.  Fixed tests cover every declared function at
least three times, strict error propagation, parser positions and precedence,
renames, types, time zones, and injection boundaries.
A separate timed test evaluates a formula exceeding 20 nodes 100,000 times within
one second. PostgreSQL tests are required; no database-dependent tests are skipped.

## Cross-record formulas

Structured references have `tableName` and, after resolution, `tableId` alongside
`fieldId`.  Supply descriptors with `tableId` and `tableName`, and pass the current
table ID as the fourth argument of `resolve`.  `describe` can emit IDs for storage
or current names for display.  Quoted table names and escaped closing brackets
are supported.

`XLOOKUP`, `SUMIFS`, `COUNTIFS`, `AVERAGEIFS`, `MAXIFS`, and `MINIFS` read structured
ranges.  Ranges within one call must belong to one table.  Criteria support Excel
comparisons, case-insensitive wildcards with tilde escaping, and expressions over
the current record.  `XLOOKUP` supports modes 0, -1, 1, and 2, and searches first
or last with 1 or -1.  The default missing result is blank.

`RANK(value, order?, partition?)` uses descending competition ranks by default,
ascending for order 1, and no rank for a blank.  `PREVIOUS`, `NEXT`, `RUNNINGSUM`,
and `RUNNINGCOUNT` accept an expression, optional order field, and optional
partition field.  `RUNNINGCOUNT()` counts records, while its expression form
counts nonblank values.  Ordering ties use creation time and then record ID.

JavaScript receives complete permission-filtered tables in `context.tables`, and
the current table in `context.records`.  Missing sources return a keyed error.
`readsRecords` lets page caches retain server results until a complete source is
available.  `evaluateRelation` applies linked filters, sorting, limits, and rollup
functions to readable records supplied in link order.

The SQL context supplies `recordSource(tableId?)`, returning a relation, an
access predicate, and the context for that relation.  Conditional totals and
lookups compile as correlated subqueries.  Order functions compute windows over
the source before selecting the current record, so a view cannot change their
meaning.  Access predicates must include record rules and exclude deleted rows.
The server follows all referenced fields when applying field permissions and
refuses circular dependencies across tables.
