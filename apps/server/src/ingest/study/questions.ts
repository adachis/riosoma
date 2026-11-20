import {
  createQuestion,
  normalizeMarker,
  cellText,
  findHeaderRow,
  type ExtractedSource,
  type DecisionQuestion,
  type QuestionKind,
  decide,
} from '@riosoma/ingest';
import type { IngestFile, IngestTableSettings } from '@riosoma/contracts';
import { kind } from '../pipeline/reading.js';
import type { Draft } from '../build/runner.js';
import type { IngestWorker } from '../pipeline/worker.js';
import type { IngestClaim } from '../pipeline/types.js';

export function studyQuestion(
  file: IngestFile,
  id: string,
  key: string,
  form: DecisionQuestion['form'],
  target: DecisionQuestion['target'] = { type: 'file', file: file.id },
  evidence: DecisionQuestion['evidence'] = [],
) {
  const definition: QuestionKind = {
    ...kind('unknownColumn'),
    id,
    messageId: `ingest.study.${id}`,
    answerType: form.type,
    allowUnknown: true,
    businessOnly: true,
    allowedScopes: [],
    defaultScope: null,
  };
  return createQuestion(definition, {
    key: `${file.id}:${key}`,
    values: [],
    form,
    target,
    evidence,
    exits: ['skipFile'],
  });
}
export function choices(ids: string[]): DecisionQuestion['form'] {
  return { type: 'choices', choices: ids.map((id) => ({ id, messageId: `ingest.study.${id}` })) };
}
export interface Heading {
  heading: string;
  examples: string[];
  sheet: string;
  index: number;
  headerRow: number;
}
export function headings(source: ExtractedSource, draft: Draft): Heading[] {
  return (source.sheets ?? []).flatMap((sheet) => {
    const aliases =
      draft.reading === 'reader'
        ? [
            ...draft.signature.headerGroups.flat(),
            ...Object.values(draft.rules.bindings ?? {}).flatMap((binding) =>
              binding.kind === 'column' || binding.kind === 'lookup' ? binding.aliases : [],
            ),
          ]
        : [];
    const row =
      draft.reading === 'layout'
        ? findHeaderRow(sheet.rows, draft.rules.header.markers, draft.rules.header.searchRows)
        : sheet.rows
            .slice(0, 200)
            .findIndex((line) =>
              line.some((cell) =>
                aliases.some((alias) => normalizeMarker(alias) === normalizeMarker(cellText(cell))),
              ),
            );
    if (row === null || row < 0) return [];
    return sheet.rows[row]!.flatMap((cell, index) => {
      const heading = cellText(cell).trim();
      return heading
        ? [
            {
              heading,
              examples: sheet.rows.slice(row + 1, row + 4).map((line) => cellText(line[index])),
              sheet: sheet.name,
              index,
              headerRow: row,
            },
          ]
        : [];
    });
  });
}

export function headingValue(
  source: ExtractedSource,
  at: { sheet?: string; row?: number },
  heading: Heading,
) {
  const sheet =
    source.sheets?.find((entry) => entry.name === at.sheet) ??
    source.sheets?.find((_entry, index) => at.sheet === `sheet-${index + 1}`);
  return sheet?.rows[(at.row ?? 0) - 1]?.[heading.index]?.v ?? null;
}
export function columnQuestion(
  file: IngestFile,
  heading: Heading,
  settings: IngestTableSettings,
  formatId?: string,
) {
  const form: DecisionQuestion['form'] = {
    type: 'choices',
    choices: [
      ...settings.fields.map((field) => ({
        id: field.key,
        messageId: 'ingest.study.outputField',
        params: { field: field.key },
      })),
      ...['leaveOut', 'ownField'].map((id) => ({ id, messageId: `ingest.study.${id}` })),
    ],
  };
  const q = studyQuestion(
    file,
    'column',
    `column:${normalizeMarker(heading.heading)}${formatId ? `:${formatId}` : ''}`,
    form,
    { type: 'file', file: file.id },
    [
      {
        file: file.id,
        sheet: heading.sheet,
        row: heading.headerRow + 1,
        column: heading.heading,
        examples: heading.examples,
      },
    ],
  );
  return createQuestion(
    {
      ...kind('unknownColumn'),
      id: 'column',
      messageId: q.messageId,
      answerType: 'choices',
      allowUnknown: true,
    },
    q,
    formatId ? { format: formatId } : {},
  );
}

export async function columnDecision(worker: IngestWorker, claim: IngestClaim, question: DecisionQuestion) {
  const definition: QuestionKind = { ...kind('unknownColumn'), id: 'column', answerType: 'choices' };
  const heading = question.evidence[0]?.column ?? '';
  const sender = claim.file.senderId
    ? await worker.store.tables.readSender(claim.file, claim.file.senderId)
    : null;
  const item = {
    kind: definition,
    value: heading,
    format: question.scopeContext.format,
    ...(sender ? { sender: { id: sender.id, kind: sender.kind, value: sender.value } } : {}),
    inputs: {
      heading: { type: 'text' as const, value: heading },
      text: { type: 'text' as const, value: heading },
    },
  };
  return decide({
    item,
    rules: await worker.store.decisions.findRules(claim.file, item),
    question,
    target: question.target,
    key: question.key,
    attempt: 'exhausted',
  });
}
