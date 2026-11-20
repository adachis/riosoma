import type { DecisionInput, QuestionKind, ScopeKind } from './types.js';

const conventionScopes: ScopeKind[] = ['format', 'sender', 'table'];
const valueScopes: ScopeKind[] = ['valueFromSender', 'valueFromAnyone', 'format', 'sender', 'table'];
const inputs: DecisionInput[] = ['text', 'field', 'heading', 'sender', 'format'];
const standard = (
  id: string,
  category: QuestionKind['class'],
  answerType: QuestionKind['answerType'] = 'choices',
  businessOnly = false,
  allowedScopes = category === 'value' ? valueScopes : conventionScopes,
): QuestionKind => ({
  id,
  class: category,
  messageId: `ingest.questions.${id}`,
  answerType,
  businessOnly,
  allowUnknown: category !== 'file',
  allowedScopes: [...allowedScopes],
  defaultScope: allowedScopes[0] ?? null,
  inputs: [...inputs],
});

export const STANDARD_QUESTIONS: readonly QuestionKind[] = [
  standard('numericDateOrder', 'convention'),
  standard('missingDateDay', 'convention', 'number'),
  standard('missingDateYear', 'convention', 'number', true),
  standard('missingReportingPeriod', 'convention', 'month', true),
  standard('twoDigitYear', 'convention', 'choices', true),
  standard('decimalPoint', 'convention'),
  standard('figureScale', 'convention'),
  standard('missingUnit', 'convention', 'text', true),
  standard('identifierAndName', 'convention'),
  standard('totalRows', 'convention'),
  standard('unrecognizedFormat', 'convention', 'mapping'),
  standard('unfamiliarListValue', 'value'),
  standard('unknownColumn', 'value', 'mapping', false, ['format', 'sender', 'table']),
  standard('possibleSameName', 'value'),
  standard('repeatedRowKey', 'value'),
  standard('fileTableDisagreement', 'value'),
  standard('blankRequiredValue', 'value', 'text', true),
  standard('outsideAllowedRange', 'value'),
  standard('passwordProtected', 'file', 'text', false, []),
  standard('attachmentLink', 'file', 'choices', false, []),
  standard('unopenableFileType', 'file', 'choices', false, []),
];

/** Table declarations name sibling inputs explicitly and can only request business knowledge. */
export function tableQuestionKind(
  id: string,
  messageId: string,
  answerType: QuestionKind['answerType'],
  siblings: string[] = [],
): QuestionKind {
  return {
    ...standard(id, 'value', answerType, true),
    messageId,
    inputs: [...inputs, ...siblings.map((field): DecisionInput => `sibling:${field}`)],
  };
}
