export { translateFormula, type Translation } from '../core/formulas.js';

/**
 * Airtable's API gives a formula with its fields named by ID in braces, like
 * `IF({fld…} > 3, "Big", "")`, which is also how Riosoma stores formulas, since the two share a
 * language.  Translating a formula swaps each Airtable field ID for the field's ID here, as long as
 * every function it calls exists here and every field it reads came across.  Whether the result
 * also type-checks is up to the server when the field is made.
 */

/** The longest formula text a report line shows */
const SHOWN = 2_000;

/** A formula as people read it, with field names in place of IDs, for the report. */
export function displayFormula(formula: string, names: (reference: string) => string | undefined): string {
  const shown = formula.replace(/\{(fld[A-Za-z0-9]{14})\}/g, (whole, id: string) => {
    const name = names(id);
    return name === undefined ? whole : `{${name.replaceAll('\\', '\\\\').replaceAll('}', '\\}')}}`;
  });
  return shown.length > SHOWN ? `${shown.slice(0, SHOWN - 1)}…` : shown;
}
