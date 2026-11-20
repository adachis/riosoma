import ExcelJS from 'exceljs';
import { zipEntries, entryBytes } from '../../imports/zip.js';
import { guardFormula } from '../text.js';
import { AppError } from '@riosoma/contracts';
import { PDFCheckBox, PDFDropdown, PDFTextField } from 'pdf-lib';
import { hasXfa, readDocument, removeActiveContent } from '../../../signatures/pdf.js';
import { wordWriter } from './load.js';

const invalid = () => new AppError('validation_failed', 'automations.document.invalid');
export const TEMPLATE_LIMIT = 10 * 1024 * 1024;

/** Only named placeholders are filled, leaving a template's layout and other cells intact. */
export async function fillDocumentTemplate(
  bytes: Buffer,
  format: 'docx' | 'pdf' | 'xlsx',
  values: Record<string, string>,
): Promise<Buffer> {
  if (bytes.length > TEMPLATE_LIMIT) throw invalid();
  try {
    if (format !== 'pdf') {
      const entries = zipEntries(bytes);
      let total = 0;
      for (const entry of entries.values()) {
        if (entry.size > 16 * 1024 * 1024 || total + entry.size > 64 * 1024 * 1024) throw invalid();
        // Check actual inflation too because the directory sizes come from the upload.
        const inflated = entryBytes(bytes, entry, Math.min(16 * 1024 * 1024, 64 * 1024 * 1024 - total));
        if (inflated.length !== entry.size) throw invalid();
        total += inflated.length;
      }
    }
    let result: Buffer;
    if (format === 'docx') {
      result = await (await wordWriter()).patchTemplate(bytes, values);
    } else if (format === 'pdf') {
      const document = await readDocument(bytes);
      if (hasXfa(document)) throw invalid();
      const form = document.getForm();
      for (const [name, value] of Object.entries(values)) {
        const field = form.getField(name);
        if (field instanceof PDFTextField) field.setText(value);
        else if (field instanceof PDFCheckBox) {
          if (!['true', 'false', ''].includes(value)) throw invalid();
          if (value === 'true') field.check();
          else field.uncheck();
        } else if (field instanceof PDFDropdown) field.select(value);
        else throw invalid();
      }
      form.flatten();
      removeActiveContent(document);
      result = Buffer.from(await document.save());
    } else {
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(bytes as unknown as ExcelJS.Buffer);
      let cells = 0;
      book.eachSheet((sheet) =>
        sheet.eachRow((row) =>
          row.eachCell((cell) => {
            if (++cells > 100000) throw invalid();
            const value = cell.value;
            const replace = (text: string) =>
              text.replace(/\{\{([^{}]+)\}\}/g, (_token, name: string) => {
                if (!Object.hasOwn(values, name.trim())) throw invalid();
                return values[name.trim()]!;
              });
            if (typeof value === 'string' && value.includes('{{')) cell.value = guardFormula(replace(value));
            else if (value && typeof value === 'object' && 'richText' in value) {
              const text = value.richText.map((part) => part.text).join('');
              if (text.includes('{{')) cell.value = guardFormula(replace(text));
            }
          }),
        ),
      );
      result = Buffer.from(await book.xlsx.writeBuffer());
    }
    if (result.length > TEMPLATE_LIMIT) throw invalid();
    return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid();
  }
}
