export const AI_READER_COPY: Record<string, string> = {
  'ingest.modelCallFailed': /*i18n*/ {
    id: 'ingest.modelCallFailed',
    message: 'The model call failed.',
  }.message,
  'ingest.aiReader.keyRefused': /*i18n*/ {
    id: 'ingest.aiReader.keyRefused',
    message: 'The provider refused the API key.  Update the key before retrying this held file.',
  }.message,
  'ingest.aiReader.aiOff': /*i18n*/ {
    id: 'ingest.aiReader.aiOff',
    message: 'AI is turned off.  This file was held without writing rows.',
  }.message,
  'ingest.aiReader.ingestOff': /*i18n*/ {
    id: 'ingest.aiReader.ingestOff',
    message: 'AI reading for incoming files is turned off.  This file was held without writing rows.',
  }.message,
  'ingest.aiReader.classification': /*i18n*/ {
    id: 'ingest.aiReader.classification',
    message: 'The classification or access rules prevent sending this file to the selected model.',
  }.message,
  'ingest.aiReader.unsupported': /*i18n*/ {
    id: 'ingest.aiReader.unsupported',
    message: 'This kind of file is not read by AI yet.  Use sheets, delimited text, or email body tables.',
  }.message,
  'ingest.aiReader.tooLarge': /*i18n*/ {
    id: 'ingest.aiReader.tooLarge',
    message: 'This file is too large for AI reading.  Use a layout or a reader.',
  }.message,
  'ingest.aiReader.fileLimit': /*i18n*/ {
    id: 'ingest.aiReader.fileLimit',
    message: 'The per-file spending ceiling stopped this reading after ${spent}.  No rows were written.',
  }.message,
  'ingest.aiReader.unpriced': /*i18n*/ {
    id: 'ingest.aiReader.unpriced',
    message: 'The selected model has no known price.  Its per-file spending ceiling cannot be enforced.',
  }.message,
  'ingest.aiReader.dynamicChoices': /*i18n*/ {
    id: 'ingest.aiReader.dynamicChoices',
    message: 'This format uses choices from existing records.  Use a layout or a reader.',
  }.message,
  'ingest.aiReader.providerUnavailable': /*i18n*/ {
    id: 'ingest.aiReader.providerUnavailable',
    message: 'The reading provider is unavailable.  This file will wait and try again.',
  }.message,
  'ingest.aiReader.monthlyBudget': /*i18n*/ {
    id: 'ingest.aiReader.monthlyBudget',
    message: 'The monthly AI budget is spent.  This file will wait and try again.',
  }.message,
  'ingest.aiReader.hiddenSheet': /*i18n*/ {
    id: 'ingest.aiReader.hiddenSheet',
    message: 'Hidden sheet {sheet} was skipped.',
  }.message,
  'ingest.aiReader.unreadRow': /*i18n*/ {
    id: 'ingest.aiReader.unreadRow',
    message: 'Sheet {sheet}, row {start}, could not be read within the output limit.',
  }.message,
  'ingest.aiReader.refusedChunk': /*i18n*/ {
    id: 'ingest.aiReader.refusedChunk',
    message: 'The model declined sheet {sheet}, rows {start} through {end}.  Those rows could not be read.',
  }.message,
  'ingest.aiReader.invalidChunk': /*i18n*/ {
    id: 'ingest.aiReader.invalidChunk',
    message:
      'Sheet {sheet}, rows {start} through {end}, returned invalid output.  Those rows could not be read.',
  }.message,
  'ingest.aiReader.countMismatch': /*i18n*/ {
    id: 'ingest.aiReader.countMismatch',
    message: 'Sheet {sheet}, rows {start} through {end}, stated {stated} rows but returned {received}.',
  }.message,
  'ingest.aiReader.placeOutside': /*i18n*/ {
    id: 'ingest.aiReader.placeOutside',
    message: 'A returned row at row {row} is outside its chunk in sheet {sheet}.',
  }.message,
  'ingest.aiReader.duplicatePlace': /*i18n*/ {
    id: 'ingest.aiReader.duplicatePlace',
    message: 'Sheet {sheet}, row {row}, was returned more than once.',
  }.message,
  'ingest.aiReader.valueUnsupported': /*i18n*/ {
    id: 'ingest.aiReader.valueUnsupported',
    message: 'The value for {field} at sheet {sheet}, row {row}, is not supported by its source text.',
  }.message,
  'ingest.aiReader.sourceUnsupported': /*i18n*/ {
    id: 'ingest.aiReader.sourceUnsupported',
    message: 'The source text for {field} at sheet {sheet}, row {row}, is absent from the chunk.',
  }.message,
  'ingest.aiReader.choiceOutside': /*i18n*/ {
    id: 'ingest.aiReader.choiceOutside',
    message:
      'The choice for {field} at sheet {sheet}, row {row}, is outside the allowed values.  It was kept for review.',
  }.message,
  'ingest.aiReader.emptyChunk': /*i18n*/ {
    id: 'ingest.aiReader.emptyChunk',
    message: 'Sheet {sheet}, rows {start} through {end}, returned no rows: {reason}.',
  }.message,
  'ingest.aiReader.missingEmptyReason': /*i18n*/ {
    id: 'ingest.aiReader.missingEmptyReason',
    message: 'Sheet {sheet}, rows {start} through {end}, returned no rows without explaining why.',
  }.message,
  'ingest.aiReader.fieldDoubted': /*i18n*/ {
    id: 'ingest.aiReader.fieldDoubted',
    message: 'The reading model is unsure of {field}.  Review the value against the original.',
  }.message,
  'ingest.aiReader.flagged': /*i18n*/ {
    id: 'ingest.aiReader.flagged',
    message: 'This file has reading findings that need review.',
  }.message,
};
