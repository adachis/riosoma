import { extractHtmlText } from '../../data/library-text-parser.js';
import { ExtractionFailure, LIMITS } from './types.js';

/** Tags are scanned with quote awareness so a greater-than sign in an attribute cannot end a tag. */
function* tags(html: string): Generator<{ text: string; name?: string; closing?: boolean }> {
  let at = 0;
  while (at < html.length) {
    const start = html.indexOf('<', at);
    if (start < 0) {
      yield { text: html.slice(at) };
      return;
    }
    if (start > at) yield { text: html.slice(at, start) };
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      at = end < 0 ? html.length : end + 3;
      continue;
    }
    let end = start + 1,
      quote = '';
    for (; end < html.length; end++) {
      const char = html[end]!;
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end === html.length) {
      yield { text: html.slice(start) };
      return;
    }
    const text = html.slice(start, end + 1);
    const match = /^<\s*(\/?)\s*([a-z][\w:-]*)/i.exec(text);
    yield { text, name: match?.[2]?.toLowerCase(), closing: match?.[1] === '/' };
    at = end + 1;
  }
}

export function htmlTables(html: string): string[][][] {
  interface Table {
    rows: string[][];
    row: number;
    column: number;
    cell?: { html: string; colspan: number; rowspan: number };
    occupied: Set<string>;
  }
  const tables: Table[] = [],
    stack: Table[] = [];
  let hidden: string | undefined,
    count = 0;
  const span = (tag: string, name: string) => {
    const value = Number(new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, 'i').exec(tag)?.[1] ?? 1);
    if (value < 1 || value > 1000) throw new ExtractionFailure('size-limit');
    return value;
  };
  const closeCell = (table: Table) => {
    if (!table.cell) return;
    table.row = Math.max(0, table.row);
    table.rows[table.row] ??= [];
    while (table.occupied.has(`${table.row}:${table.column}`)) table.column++;
    const item = table.cell;
    for (let row = table.row; row < table.row + item.rowspan; row++) {
      table.rows[row] ??= [];
      for (let col = table.column; col < table.column + item.colspan; col++) {
        if (++count > LIMITS.cells) throw new ExtractionFailure('size-limit');
        table.rows[row]![col] =
          row === table.row && col === table.column
            ? extractHtmlText(item.html).replace(/\s+/g, ' ').trim()
            : '';
        table.occupied.add(`${row}:${col}`);
      }
    }
    table.column += item.colspan;
    table.cell = undefined;
  };
  for (const token of tags(html)) {
    if (hidden) {
      if (token.closing && token.name === hidden) hidden = undefined;
      continue;
    }
    if (!token.closing && ['script', 'style', 'template', 'noscript'].includes(token.name ?? '')) {
      hidden = token.name;
      continue;
    }
    for (const table of stack) if (table.cell) table.cell.html += token.text;
    if (token.name === 'table') {
      if (token.closing) {
        const table = stack.pop();
        if (table) closeCell(table);
      } else {
        const table: Table = { rows: [], row: -1, column: 0, occupied: new Set() };
        tables.push(table);
        stack.push(table);
        if (tables.length > LIMITS.mimeParts) throw new ExtractionFailure('size-limit');
      }
    } else {
      const table = stack.at(-1);
      if (!table) continue;
      if (token.name === 'tr') {
        closeCell(table);
        if (!token.closing) {
          table.row++;
          table.column = 0;
          table.rows[table.row] ??= [];
        }
      } else if (token.name === 'td' || token.name === 'th') {
        closeCell(table);
        if (!token.closing)
          table.cell = {
            html: '',
            colspan: span(token.text, 'colspan'),
            rowspan: span(token.text, 'rowspan'),
          };
      }
    }
  }
  for (const table of stack) closeCell(table);
  return tables.map((table) => {
    const width = table.rows.reduce((max, row) => Math.max(max, row.length), 0);
    return table.rows.map((row) => Array.from({ length: width }, (_, col) => row[col] ?? ''));
  });
}
