import { riosomaFormula, type Written } from '../fields.js';

/** Only references to the current row can be expressed as fields in a record formula. */
export function smartsheetFormula(source: string): Written {
  const unsupported: Written = { expression: null, problem: 'syntax', functions: [] };
  const text = source.trim().replace(/^=/, '');
  let expression = '';
  for (let at = 0; at < text.length;) {
    const char = text[at]!;
    if (char === '"') {
      let end = at + 1;
      for (; end < text.length; end++) {
        if (text[end] === '\\') {
          end++;
          continue;
        }
        if (text[end] === '"') break;
      }
      if (end === text.length) return unsupported;
      expression += text.slice(at, end + 1);
      at = end + 1;
      continue;
    }
    const reference = /^(?:\[([^\]]+)\]|([A-Za-z_][\w]*))@row\b/i.exec(text.slice(at));
    if (reference) {
      const name = reference[1] ?? reference[2]!;
      expression += `{${name.replace(/\\/g, '\\\\').replace(/}/g, '\\}')}}`;
      at += reference[0].length;
      continue;
    }
    // Braces name cross-sheet ranges.  Brackets and @ elsewhere name cells or whole columns.
    if ('{}[]@:'.includes(char)) return unsupported;
    expression += char;
    at++;
  }
  return riosomaFormula(expression, { AVG: 'AVERAGE' });
}
