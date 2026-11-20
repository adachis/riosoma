import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

export const INGEST_AI_READER_MESSAGES: Record<string, MessageDescriptor> = {
  'ingest.modelCallFailed': msg({
    id: 'ingest.modelCallFailed',
    message: 'The model call failed.',
  }),
  'ingest.aiReader.keyRefused': msg({
    id: 'ingest.aiReader.keyRefused',
    message: 'The provider refused the API key.  Update the key before retrying this held file.',
  }),
  'ingest.aiReader.aiOff': msg({
    id: 'ingest.aiReader.aiOff',
    message: 'AI is turned off.  This file was held without writing rows.',
  }),
  'ingest.aiReader.ingestOff': msg({
    id: 'ingest.aiReader.ingestOff',
    message: 'AI reading for incoming files is turned off.  This file was held without writing rows.',
  }),
  'ingest.aiReader.classification': msg({
    id: 'ingest.aiReader.classification',
    message: 'The classification or access rules prevent sending this file to the selected model.',
  }),
  'ingest.aiReader.unsupported': msg({
    id: 'ingest.aiReader.unsupported',
    message: 'This kind of file is not read by AI yet.  Use sheets, delimited text, or email body tables.',
  }),
  'ingest.aiReader.tooLarge': msg({
    id: 'ingest.aiReader.tooLarge',
    message: 'This file is too large for AI reading.  Use a layout or a reader.',
  }),
  'ingest.aiReader.fileLimit': msg({
    id: 'ingest.aiReader.fileLimit',
    message: 'The per-file spending ceiling stopped this reading after ${spent}.  No rows were written.',
  }),
  'ingest.aiReader.unpriced': msg({
    id: 'ingest.aiReader.unpriced',
    message: 'The selected model has no known price.  Its per-file spending ceiling cannot be enforced.',
  }),
  'ingest.aiReader.dynamicChoices': msg({
    id: 'ingest.aiReader.dynamicChoices',
    message: 'This format uses choices from existing records.  Use a layout or a reader.',
  }),
  'ingest.aiReader.providerUnavailable': msg({
    id: 'ingest.aiReader.providerUnavailable',
    message: 'The reading provider is unavailable.  This file will wait and try again.',
  }),
  'ingest.aiReader.monthlyBudget': msg({
    id: 'ingest.aiReader.monthlyBudget',
    message: 'The monthly AI budget is spent.  This file will wait and try again.',
  }),
  'ingest.aiReader.hiddenSheet': msg({
    id: 'ingest.aiReader.hiddenSheet',
    message: 'Hidden sheet {sheet} was skipped.',
  }),
  'ingest.aiReader.unreadRow': msg({
    id: 'ingest.aiReader.unreadRow',
    message: 'Sheet {sheet}, row {start}, could not be read within the output limit.',
  }),
  'ingest.aiReader.refusedChunk': msg({
    id: 'ingest.aiReader.refusedChunk',
    message: 'The model declined sheet {sheet}, rows {start} through {end}.  Those rows could not be read.',
  }),
  'ingest.aiReader.invalidChunk': msg({
    id: 'ingest.aiReader.invalidChunk',
    message:
      'Sheet {sheet}, rows {start} through {end}, returned invalid output.  Those rows could not be read.',
  }),
  'ingest.aiReader.countMismatch': msg({
    id: 'ingest.aiReader.countMismatch',
    message: 'Sheet {sheet}, rows {start} through {end}, stated {stated} rows but returned {received}.',
  }),
  'ingest.aiReader.placeOutside': msg({
    id: 'ingest.aiReader.placeOutside',
    message: 'A returned row at row {row} is outside its chunk in sheet {sheet}.',
  }),
  'ingest.aiReader.duplicatePlace': msg({
    id: 'ingest.aiReader.duplicatePlace',
    message: 'Sheet {sheet}, row {row}, was returned more than once.',
  }),
  'ingest.aiReader.valueUnsupported': msg({
    id: 'ingest.aiReader.valueUnsupported',
    message: 'The value for {field} at sheet {sheet}, row {row}, is not supported by its source text.',
  }),
  'ingest.aiReader.sourceUnsupported': msg({
    id: 'ingest.aiReader.sourceUnsupported',
    message: 'The source text for {field} at sheet {sheet}, row {row}, is absent from the chunk.',
  }),
  'ingest.aiReader.choiceOutside': msg({
    id: 'ingest.aiReader.choiceOutside',
    message:
      'The choice for {field} at sheet {sheet}, row {row}, is outside the allowed values.  It was kept for review.',
  }),
  'ingest.aiReader.emptyChunk': msg({
    id: 'ingest.aiReader.emptyChunk',
    message: 'Sheet {sheet}, rows {start} through {end}, returned no rows: {reason}.',
  }),
  'ingest.aiReader.missingEmptyReason': msg({
    id: 'ingest.aiReader.missingEmptyReason',
    message: 'Sheet {sheet}, rows {start} through {end}, returned no rows without explaining why.',
  }),
  'ingest.aiReader.fieldDoubted': msg({
    id: 'ingest.aiReader.fieldDoubted',
    message: 'The reading model is unsure of {field}.  Review the value against the original.',
  }),
  'ingest.aiReader.flagged': msg({
    id: 'ingest.aiReader.flagged',
    message: 'This file has reading findings that need review.',
  }),
};
