import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type ExcelJS from 'exceljs';
import { sparklineValues, type Sparkline, type RowData } from '@riosoma/contracts';
import type { StoredField } from '../types.js';

// Portable equivalents of the base theme's accent and legibility-tier choice tokens.
const TOKEN_RGB: Record<Sparkline['color'], string> = {
  accent: '2F6B4F',
  blue: '3B82F6',
  green: '2F9E44',
  red: 'E5484D',
  purple: '9B59D0',
  gray: '7C7C7C',
};
const xml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function letter(index: number): string {
  let result = '';
  while (index > 0) {
    index--;
    result = String.fromCharCode(65 + (index % 26)) + result;
    index = Math.floor(index / 26);
  }
  return result;
}

interface ExtensionSheet extends ExcelJS.Worksheet {
  _writeCloseWorksheet(): void;
  _write(text: string): void;
}

/**
 * The streaming writer has no sparkline API. Append the documented worksheet extension at its
 * closing boundary, with source cells on a hidden sheet. Group entries spool to disk so exports
 * keep only a page of records and a fixed-size XML buffer in memory.
 */
export class ExcelSparklines {
  private readonly directory: string;
  private readonly groups: Array<{
    setting: Sparkline;
    field: StoredField;
    column: number;
    file: number;
    count: number;
  }>;
  private readonly data: ExcelJS.Worksheet;
  private nextRow = 1;
  constructor(
    workbook: ExcelJS.stream.xlsx.WorkbookWriter,
    fields: readonly StoredField[],
    settings: readonly Sparkline[],
  ) {
    this.directory = mkdtempSync(join(tmpdir(), 'rio-sparklines-'));
    let name = '_sparkline_data';
    for (let suffix = 2; workbook.getWorksheet(name); suffix++) name = `_sparkline_data_${suffix}`;
    this.data = workbook.addWorksheet(name, { state: 'veryHidden' });
    this.groups = settings.flatMap((setting, index) => {
      const column = fields.findIndex((field) => field.id === setting.fieldId);
      if (column < 0) return [];
      return [
        {
          setting,
          field: fields[column]!,
          column: column + 1,
          file: openSync(join(this.directory, String(index)), 'w+'),
          count: 0,
        },
      ];
    });
  }
  row(row: RowData, destination: number): void {
    for (const group of this.groups) {
      const values = sparklineValues(row, group.field, group.setting);
      // Beyond spreadsheet source-range limits, the visible cell retains its original values.
      if (!values.length || values.length > 16_384 || this.nextRow > 1_048_576) continue;
      const source = this.nextRow++;
      this.data.getRow(source).values = values;
      this.data.getRow(source).commit();
      const formula = xml(`'${this.data.name}'!A${source}:${letter(values.length)}${source}`);
      writeSync(
        group.file,
        `<x14:sparkline><xm:f>${formula}</xm:f><xm:sqref>${letter(group.column)}${destination}</xm:sqref></x14:sparkline>`,
      );
      group.count++;
    }
  }
  finish(worksheet: ExcelJS.Worksheet): void {
    this.data.commit();
    const sheet = worksheet as ExtensionSheet;
    const close = sheet._writeCloseWorksheet.bind(sheet);
    sheet._writeCloseWorksheet = () => {
      if (this.groups.some((group) => group.count)) {
        sheet._write(
          '<extLst><ext uri="{05C60535-1F16-4FD2-B633-F4F36F0B64E0}"><x14:sparklineGroups xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">',
        );
        const buffer = Buffer.alloc(64 * 1024);
        for (const group of this.groups) {
          if (!group.count) continue;
          const { setting } = group;
          const axis = setting.sharedAxis ? 'group' : 'individual';
          sheet._write(
            `<x14:sparklineGroup type="${setting.type === 'winLoss' ? 'stacked' : setting.type}" first="${Number(setting.first)}" last="${Number(setting.last)}" low="${Number(setting.min)}" high="${Number(setting.max)}" negative="1" displayHidden="1" minAxisType="${axis}" maxAxisType="${axis}"><x14:colorSeries rgb="FF${TOKEN_RGB[setting.color]}"/><x14:colorNegative rgb="FF${TOKEN_RGB.red}"/><x14:colorFirst rgb="FF1D1D1B"/><x14:colorLast rgb="FF1D1D1B"/><x14:colorHigh rgb="FF1D1D1B"/><x14:colorLow rgb="FF1D1D1B"/><x14:sparklines>`,
          );
          let position = 0;
          for (;;) {
            const count = readSync(group.file, buffer, 0, buffer.length, position);
            if (!count) break;
            sheet._write(buffer.toString('utf8', 0, count));
            position += count;
          }
          sheet._write('</x14:sparklines></x14:sparklineGroup>');
        }
        sheet._write('</x14:sparklineGroups></ext></extLst>');
      }
      close();
    };
  }
  dispose(): void {
    for (const group of this.groups) closeSync(group.file);
    rmSync(this.directory, { recursive: true, force: true });
  }
}
