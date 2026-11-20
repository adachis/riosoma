import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

export const INGEST_DECISION_MESSAGES: Record<string, MessageDescriptor> = {
  'ingest.decisions.invalidRule': msg({
    id: 'ingest.decisions.invalidRule',
    message: 'This rule uses an unsupported condition, input, scope, or answer.',
  }),
  'ingest.decisions.ruleLimit': msg({
    id: 'ingest.decisions.ruleLimit',
    message: 'This rule exceeds the size limits.  Use a smaller rule.',
  }),
  'ingest.decisions.invalidQuestion': msg({
    id: 'ingest.decisions.invalidQuestion',
    message: 'This question could not be verified.  Read the file again.',
  }),
  'ingest.decisions.staleAnswer': msg({
    id: 'ingest.decisions.staleAnswer',
    message: 'This question changed while you were answering it.  Review the current question.',
  }),
  'ingest.decisions.invalidAnswer': msg({
    id: 'ingest.decisions.invalidAnswer',
    message: 'Choose an offered answer or enter a valid value.',
  }),
  'ingest.decisions.answerForbidden': msg({
    id: 'ingest.decisions.answerForbidden',
    message: 'You need permission to edit this table’s records to answer its questions.',
  }),
  'ingest.decisions.ruleForbidden': msg({
    id: 'ingest.decisions.ruleForbidden',
    message: 'You need permission to edit this table’s schema to remember or turn off a rule.',
  }),
  'ingest.decisions.ruleConflict': msg({
    id: 'ingest.decisions.ruleConflict',
    message: 'Rules at the same scope give different answers.  Choose which answer applies.',
  }),
  'ingest.decisions.chooseRuleAnswer': msg({
    id: 'ingest.decisions.chooseRuleAnswer',
    message: 'Use this rule’s answer',
  }),
  'ingest.decisions.businessKnowledgeRequired': msg({
    id: 'ingest.decisions.businessKnowledgeRequired',
    message: 'A person who knows the business must supply this value.',
  }),
  'ingest.decisions.unresolved': msg({
    id: 'ingest.decisions.unresolved',
    message:
      'This item is still unresolved after the allowed attempt.  Review the evidence and rules that were tried.',
  }),
  'ingest.questions.numericDateOrder': msg({
    id: 'ingest.questions.numericDateOrder',
    message: 'Which order does this file use for numeric dates?',
  }),
  'ingest.questions.missingDateDay': msg({
    id: 'ingest.questions.missingDateDay',
    message: 'Which day belongs to this date?',
  }),
  'ingest.questions.missingDateYear': msg({
    id: 'ingest.questions.missingDateYear',
    message: 'Which year belongs to this date?',
  }),
  'ingest.questions.missingReportingPeriod': msg({
    id: 'ingest.questions.missingReportingPeriod',
    message: 'Which reporting period does this file cover?',
  }),
  'ingest.questions.twoDigitYear': msg({
    id: 'ingest.questions.twoDigitYear',
    message: 'How should this two-digit year be read?',
  }),
  'ingest.questions.decimalPoint': msg({
    id: 'ingest.questions.decimalPoint',
    message: 'Which mark is the decimal point?',
  }),
  'ingest.questions.figureScale': msg({
    id: 'ingest.questions.figureScale',
    message: 'Are these figures stated as units, thousands, or millions?',
  }),
  'ingest.questions.missingUnit': msg({
    id: 'ingest.questions.missingUnit',
    message: 'Which unit do these figures use?',
  }),
  'ingest.questions.identifierAndName': msg({
    id: 'ingest.questions.identifierAndName',
    message: 'How should this identifier be separated from the name?',
  }),
  'ingest.questions.totalRows': msg({
    id: 'ingest.questions.totalRows',
    message: 'How should total and subtotal rows be handled?',
  }),
  'ingest.questions.unrecognizedFormat': msg({
    id: 'ingest.questions.unrecognizedFormat',
    message: 'Which table fields match this file’s columns?',
  }),
  'ingest.questions.unfamiliarListValue': msg({
    id: 'ingest.questions.unfamiliarListValue',
    message: 'Which known list value matches this name?',
  }),
  'ingest.questions.unknownColumn': msg({
    id: 'ingest.questions.unknownColumn',
    message: 'Which field matches this unknown column?',
  }),
  'ingest.questions.possibleSameName': msg({
    id: 'ingest.questions.possibleSameName',
    message: 'Do these names refer to the same thing?',
  }),
  'ingest.questions.repeatedRowKey': msg({
    id: 'ingest.questions.repeatedRowKey',
    message: 'How should rows with this repeated key be handled?',
  }),
  'ingest.questions.fileTableDisagreement': msg({
    id: 'ingest.questions.fileTableDisagreement',
    message: 'Which value applies when the file and table disagree?',
  }),
  'ingest.questions.blankRequiredValue': msg({
    id: 'ingest.questions.blankRequiredValue',
    message: 'What belongs in this required field?',
  }),
  'ingest.questions.outsideAllowedRange': msg({
    id: 'ingest.questions.outsideAllowedRange',
    message: 'How should this value outside the allowed range be handled?',
  }),
  'ingest.questions.passwordProtected': msg({
    id: 'ingest.questions.passwordProtected',
    message: 'What is the password for this file?',
  }),
  'ingest.questions.attachmentLink': msg({
    id: 'ingest.questions.attachmentLink',
    message: 'How should this link be handled in place of an attachment?',
  }),
  'ingest.questions.unopenableFileType': msg({
    id: 'ingest.questions.unopenableFileType',
    message: 'How should this file type be handled when it cannot be opened?',
  }),
};
