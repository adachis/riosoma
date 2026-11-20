import { describe, FUNCTIONS, parse, type Ast } from '@riosoma/formula';

/**
 * Formulas in Riosoma's own language, with fields named in braces, like `IF({fld…} > 3, "Big", "")`,
 * which is how Airtable's API gives them and how the other importers write the formulas they
 * translate.  Translating one swaps each field reference for the field's ID here, as long as every
 * function it calls exists here and every field it reads came across.  Whether the result also
 * type-checks is up to the server when the field is made.
 */

export type Translation =
  | { ok: true; expression: string; references: string[] }
  | {
      ok: false;
      /** `invalid` when the formula was already broken where it came from */
      problem: 'invalid' | 'syntax' | 'functions' | 'fields';
      functions: string[];
      references: string[];
    };

export function translateFormula(
  formula: string,
  /** Field IDs here, by the source's field ID or name */
  fieldIds: (reference: string) => string | undefined,
  valid = true,
): Translation {
  const parsed = parse(formula);
  const references = new Set<string>();
  const functions = new Set<string>();
  if (!valid || 'error' in parsed)
    return { ok: false, problem: valid ? 'syntax' : 'invalid', functions: [], references: [] };
  let missing = false;
  const walk = (node: Ast): Ast => {
    switch (node.kind) {
      case 'field': {
        references.add(node.name);
        const id = fieldIds(node.name);
        if (!id) {
          missing = true;
          return node;
        }
        return { ...node, name: id, fieldId: id };
      }
      case 'call':
        if (!FUNCTIONS[node.name]) functions.add(node.name);
        return { ...node, args: node.args.map(walk) };
      case 'unary':
        return { ...node, operand: walk(node.operand) };
      case 'binary':
        return { ...node, left: walk(node.left), right: walk(node.right) };
      default:
        return node;
    }
  };
  const mapped = walk(parsed.ast);
  if (functions.size)
    return { ok: false, problem: 'functions', functions: [...functions].sort(), references: [...references] };
  if (missing) return { ok: false, problem: 'fields', functions: [], references: [...references] };
  const ids = new Set<string>();
  const collect = (node: Ast): void => {
    if (node.kind === 'field' && node.fieldId) ids.add(node.fieldId);
    if (node.kind === 'call') node.args.forEach(collect);
    if (node.kind === 'unary') collect(node.operand);
    if (node.kind === 'binary') {
      collect(node.left);
      collect(node.right);
    }
  };
  collect(mapped);
  // Printed with IDs in place of names: the form a formula field keeps.
  const expression = describe(
    mapped,
    [...ids].map((id) => ({ id, name: id, type: 'text' as const })),
  );
  return { ok: true, expression, references: [...references] };
}
