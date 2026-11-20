import ExcelJS from 'exceljs';
import type { FastifyReply } from 'fastify';
import type { SqlResult } from '@riosoma/contracts';
import { disposition } from '../files/detect.js';
import { CSV_TYPE } from './csv.js';
import { XLSX_TYPE, columnWidth } from './xlsx.js';
import { BYTE_ORDER_MARK, csvRecord, guardFormula } from './text.js';
import { exportFileName, sheetName } from './filename.js';

const cellText = (value: unknown): string =>
  value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);

/** Query results use the export path's formula protection, file names, and spreadsheet sizing. */
export async function exportQuery(
  reply: FastifyReply,
  result: SqlResult,
  format: 'csv' | 'xlsx',
  title: string,
) {
  const type = format === 'csv' ? CSV_TYPE : XLSX_TYPE;
  reply.header('content-type', type);
  reply.header('content-disposition', disposition(type, exportFileName(title, '', format)));
  reply.header('x-content-type-options', 'nosniff');
  if (format === 'csv')
    return reply.send(
      BYTE_ORDER_MARK +
        csvRecord(result.columns) +
        result.rows.map((row) => csvRecord(row.map(cellText))).join(''),
    );
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(sheetName(title), { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = result.columns.map((name, index) => ({
    width: columnWidth(
      name,
      Math.max(0, ...result.rows.slice(0, 100).map((row) => cellText(row[index]).length)),
    ),
  }));
  sheet.addRow(result.columns.map(guardFormula));
  for (const row of result.rows)
    sheet.addRow(
      row.map((value) =>
        typeof value === 'number' || typeof value === 'boolean' ? value : guardFormula(cellText(value)),
      ),
    );
  return reply.send(Buffer.from(await book.xlsx.writeBuffer()));
}
