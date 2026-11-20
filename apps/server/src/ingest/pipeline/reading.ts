import {
  STANDARD_QUESTIONS,
  applyCleaners,
  canonical,
  createQuestion,
  date,
  number,
  boolean,
  duration,
  instant,
  normalizeMarker,
  interpretLayout,
  type DecisionItem,
  type DecisionQuestion,
  type ExtractedSource,
  type QuestionKind,
  type QuestionResponse,
  type RowLocation,
  type IngestRow,
  type SourceSheet,
  type Cell,
} from '@riosoma/ingest';
import { IngestValueSource, type IngestFile, type TableMeta } from '@riosoma/contracts';
import { runReader, type LookupTables, type ReaderFacts } from '../readers/index.js';
import type { StoredIngestFormat } from '../tables/store.js';
import type { PipelineFunctions, PipelineReading, ReadingDoubt } from './types.js';

export const kind = (id: string) => STANDARD_QUESTIONS.find((item) => item.id === id)!;
export function fileQuestion(
  file: IngestFile,
  id: string,
  key: string,
  choices: string[] = [],
): DecisionQuestion {
  const definition: QuestionKind =
    key === 'formatTie'
      ? {
          ...kind('unrecognizedFormat'),
          id: 'formatTie',
          messageId: 'ingest.pipeline.formatTie',
          answerType: 'choices',
          allowUnknown: false,
          businessOnly: true,
          allowedScopes: [],
          defaultScope: null,
        }
      : kind(id);
  return createQuestion(definition, {
    key: `${file.id}:${key}`,
    values: [],
    evidence: [{ file: file.id, examples: [] }],
    target: { type: 'file', file: file.id },
    exits: ['skipFile'],
    form:
      definition.answerType === 'text'
        ? { type: 'text' }
        : definition.answerType === 'mapping'
          ? { type: 'mapping', columns: [] }
          : {
              type: 'choices',
              choices: choices.map((choice) => ({
                id: choice,
                messageId: ['keepTable', 'takeFile'].includes(choice)
                  ? `ingest.pipeline.${choice}`
                  : 'ingest.pipeline.chooseFormat',
              })),
            },
  });
}
export function findingQuestion(file: IngestFile, messageId: string): DecisionQuestion {
  const question = fileQuestion(file, 'unopenableFileType', messageId);
  return createQuestion({ ...kind('unopenableFileType'), messageId }, question);
}
export const sameLocation = (a: RowLocation, b: RowLocation) => canonical(a) === canonical(b);

/** Generic invalid values ask for an exact replacement instead of choosing a convention. */
export function valueDoubt(
  file: IngestFile,
  format: StoredIngestFormat,
  field: string,
  at: RowLocation,
  raw: string,
  type: 'text' | 'number' | 'date',
  standardId = 'blankRequiredValue',
): ReadingDoubt {
  const definition: QuestionKind = { ...kind(standardId), answerType: type, allowUnknown: true };
  const item: DecisionItem = {
    kind: definition,
    value: raw,
    format: format.id,
    inputs: {
      text: { type: 'text', value: raw },
      field: { type: 'text', value: field },
      format: { type: 'text', value: format.id },
    },
  };
  return {
    item,
    question: createQuestion(
      definition,
      {
        key: `${file.id}:${field}:${canonical(at)}`,
        values: [{ type: 'text', value: raw }],
        form: { type },
        evidence: [{ file: file.id, ...at, column: field, examples: [raw] }],
        target: { type: 'field', file: file.id, rows: [at], field },
        exits: ['removeRow', 'skipFile'],
      },
      { value: raw, format: format.id },
    ),
  };
}

export async function readFormat(
  source: ExtractedSource,
  format: StoredIngestFormat,
  table: TableMeta,
  file: IngestFile,
  functions: PipelineFunctions,
  lookups: LookupTables,
  facts: ReaderFacts,
): Promise<PipelineReading | null> {
  if (format.reading === 'ai') return functions.readWithAi?.(source, format, table, file.checks) ?? null;
  if (format.reading === 'reader') {
    const result = await runReader(
      source,
      format.rules.code,
      lookups,
      { ...format.rules.facts, ...facts },
      { bindings: format.rules.bindings, anonymousSheets: format.rules.anonymousSheets },
    );
    if (result.status === 'failed')
      return {
        rows: [],
        failure: { messageId: result.messageKey },
        checks: { failure: { code: result.code, line: result.line } },
      };
    const failed = result.checks.find((check) => canonical(check.expected) !== canonical(check.actual));
    for (const [key, entry] of Object.entries(format.valueSources ?? {})) {
      const parsed = IngestValueSource.safeParse(entry);
      if (!parsed.success) continue;
      const binding = parsed.data;
      for (const row of result.rows) {
        if (binding.kind === 'fixed') row.values[key] = binding.value;
        if (binding.kind === 'emailSubject') row.values[key] = source.email?.subject ?? null;
        if (binding.kind === 'fact') row.values[key] = facts[binding.key] ?? row.values[key] ?? null;
      }
    }
    return {
      rows: result.rows,
      notes: result.notes.map((note) => ({ messageId: 'ingest.pipeline.readerNote', params: { note } })),
      checks: { reader: result.checks },
      ...(failed
        ? { failure: { messageId: 'ingest.pipeline.totalFailed', params: { check: failed.name } } }
        : {}),
    };
  }
  const result = interpretLayout(source, format.rules);
  const notes: IngestFile['notes'] = result.notes.map((note) => ({
    messageId: note.key,
    ...('field' in note
      ? {
          params: {
            field: note.field,
            ...('actual' in note ? { preferred: note.preferred, actual: note.actual } : {}),
          },
        }
      : {}),
  }));
  if (!result.ok)
    return {
      rows: [],
      notes,
      checks: { layout: result.checks, failure: result.failure },
      failure: {
        messageId: result.failure.key,
        ...('field' in result.failure
          ? { params: { field: result.failure.field, sheet: result.failure.sheet } }
          : {}),
      },
    };
  const failed = result.checks.find((check) => check.status !== 'passed');
  if (failed)
    return {
      rows: result.rows,
      notes,
      checks: { layout: result.checks },
      failure: {
        messageId: failed.reason ?? 'ingest.pipeline.totalFailed',
        params: { field: failed.field, check: failed.label },
      },
    };
  const doubts: ReadingDoubt[] = result.notes.flatMap((note) => {
    if (note.key !== 'ingest.layout.uncertain') return [];
    const row = result.rows.find((item) => sameLocation(item.at, note.at));
    if (!row) return [];
    const specs = format.rules.columns[note.field]?.cleaners ?? [];
    const type = specs.some((spec) => spec.kind === 'date')
      ? 'date'
      : specs.some((spec) => spec.kind === 'number')
        ? 'number'
        : 'text';
    const raw = row.raw[note.field] ?? String(row.values[note.field] ?? '');
    const doubt = valueDoubt(file, format, note.field, note.at, raw, type);
    // An ambiguous date convention is answerable for every later value with the same rule.
    const convention =
      type === 'date' && note.issue.input === 'formats'
        ? { id: 'numericDateOrder', choices: ['monthFirst', 'dayFirst'] }
        : type === 'number' && note.issue.input === 'decimalMark'
          ? { id: 'decimalPoint', choices: ['dot', 'comma'] }
          : null;
    if (convention) {
      const definition = kind(convention.id);
      doubt.item.kind = definition;
      doubt.question = createQuestion(
        definition,
        {
          ...doubt.question,
          form: {
            type: 'choices',
            choices: convention.choices.map((id) => ({ id, messageId: `ingest.pipeline.${id}` })),
          },
        },
        { value: raw, format: format.id },
      );
    }
    return [doubt];
  });
  for (const [key, value] of Object.entries(format.valueSources ?? {})) {
    const parsed = IngestValueSource.safeParse(value);
    if (!parsed.success) continue;
    const binding = parsed.data;
    const rows: IngestRow[] = result.rows;
    for (const row of rows) {
      if (binding.kind === 'fixed') row.values[key] = binding.value;
      if (binding.kind === 'emailSubject') row.values[key] = source.email?.subject ?? null;
      if (binding.kind === 'fact') row.values[key] = facts[binding.key] ?? row.values[key] ?? null;
      if (binding.kind === 'lookup' || binding.kind === 'column') {
        const sheet: SourceSheet | undefined = source.sheets?.find((sheet) => sheet.name === row.at.sheet);
        const header: Cell[] | undefined = sheet?.rows
          .slice(0, format.rules.header.searchRows)
          .find((cells) =>
            cells.some((cell) =>
              binding.aliases.some(
                (alias) => normalizeMarker(alias) === normalizeMarker(String(cell.v ?? '')),
              ),
            ),
          );
        const index =
          header?.findIndex((cell) =>
            binding.aliases.some((alias) => normalizeMarker(alias) === normalizeMarker(String(cell.v ?? ''))),
          ) ?? -1;
        const text = sheet?.rows[(row.at.row ?? 1) - 1]?.[index]?.v;
        if (binding.kind === 'lookup') row.values[key] = binding.entries[String(text ?? '')] ?? null;
        else if (index >= 0 && !format.rules.columns[key]) {
          row.values[key] = text ?? null;
          row.raw[key] = String(text ?? '');
        }
      }
    }
  }
  return { rows: result.rows, notes, checks: { layout: result.checks }, doubts };
}

export function answeredValue(
  doubt: ReadingDoubt,
  response: Extract<QuestionResponse, { type: 'answer' }>,
): unknown {
  const answer = response.answer;
  if (doubt.item.kind.id === 'numericDateOrder' && answer.type === 'choice')
    return date(doubt.item.value, { formats: [answer.value === 'monthFirst' ? 'MM/DD/YYYY' : 'DD/MM/YYYY'] })
      .value;
  if (doubt.item.kind.id === 'decimalPoint' && answer.type === 'choice') {
    const value = number(doubt.item.value, { decimalMark: answer.value === 'comma' ? ',' : '.' }).value;
    return value === null ? null : Number(value);
  }
  return answer.type === 'number' ? answer.value : answer.value;
}

export function cleanValue(input: unknown, type: string) {
  if (input !== null && input !== undefined && !['string', 'number', 'boolean'].includes(typeof input))
    return null;
  if (['number', 'currency', 'percent', 'rating'].includes(type))
    return number(input as string | number | null);
  if (type === 'date') return date(input as string | number | null);
  if (type === 'instant') return instant(input as string | number | null);
  if (type === 'checkbox') return boolean(input as string | number | null);
  if (type === 'duration') return duration(input as string | number | null, { unit: 'seconds' });
  return applyCleaners(input as string | number | null, []);
}
