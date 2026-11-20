function quote(text: string): string {
  return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '<br>');
}

export function writeClipboard(cells: readonly (readonly string[])[]): { text: string; html: string } {
  return {
    // A terminator preserves an intentional final empty row when the clipboard is read again.
    text: cells.map((row) => `${row.map(quote).join('\t')}\r\n`).join(''),
    html: `<table>${cells.map((row) => `<tr>${row.map((cell) => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}</table>`,
  };
}
