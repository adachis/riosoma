import { trustedHTML } from '../../security/trusted-types';
export interface ClipboardContents {
  text: string;
  html?: string | null;
}

function cellText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (node.nodeName === 'BR') return '\n';
  if (node.nodeName === 'SCRIPT' || node.nodeName === 'STYLE') return '';
  return Array.from(node.childNodes, cellText).join('');
}

function span(cell: Element, attribute: 'colspan' | 'rowspan'): number {
  const value = Number.parseInt(cell.getAttribute(attribute) ?? '', 10);
  if (!Number.isFinite(value) || value < 0) return 1;
  return attribute === 'colspan' ? Math.max(1, Math.min(1000, value)) : Math.min(65534, value);
}

function readTable(table: HTMLTableElement): string[][] {
  const rows = Array.from(table.querySelectorAll('tr')).filter((row) => row.closest('table') === table);
  const cells: string[][] = rows.map(() => []);
  const groupEnds = new Map<Element | null, number>();
  rows.forEach((row, index) => groupEnds.set(row.parentElement, index + 1));
  let width = 0;
  rows.forEach((row, rowIndex) => {
    const target = cells[rowIndex]!;
    let col = 0;
    for (const cell of Array.from(row.children)) {
      if (cell.tagName !== 'TD' && cell.tagName !== 'TH') continue;
      while (target[col] !== undefined) col += 1;
      const colSpan = span(cell, 'colspan');
      const rowSpan = span(cell, 'rowspan');
      // A zero rowspan covers the rest of its row group, not later table sections.
      const groupEnd = groupEnds.get(row.parentElement)!;
      const rowEnd = rowSpan === 0 ? groupEnd : Math.min(groupEnd, rowIndex + rowSpan);
      for (let r = rowIndex; r < rowEnd; r += 1) {
        for (let c = col; c < col + colSpan; c += 1) cells[r]![c] = '';
      }
      target[col] = cellText(cell);
      col += colSpan;
    }
    width = Math.max(width, target.length);
  });
  return cells.map((row) => Array.from({ length: width }, (_, col) => row[col] ?? ''));
}

function readText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let atStart = true;
  let endedRow = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    endedRow = false;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += character;
    } else if (atStart && character === '"') {
      quoted = true;
      atStart = false;
    } else if (character === '\t') {
      row.push(cell);
      cell = '';
      atStart = true;
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      atStart = true;
      endedRow = true;
    } else {
      cell += character;
      atStart = false;
    }
  }
  if (!endedRow) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Spreadsheet HTML preserves merged cells; plain text is the fallback for other apps. */
export function readClipboard({ text, html }: ClipboardContents): string[][] {
  if (html) {
    const table = new DOMParser().parseFromString(trustedHTML(html), 'text/html').querySelector('table');
    if (table !== null) return readTable(table);
  }
  return readText(text);
}
