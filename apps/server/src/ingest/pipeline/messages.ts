export const PIPELINE_COPY: Record<string, string> = {
  'ingest.pipeline.inactive': /*i18n*/ {
    id: 'ingest.pipeline.inactive',
    message: 'Incoming files require a live or paused table.',
  }.message,
  'ingest.pipeline.seenBefore': /*i18n*/ {
    id: 'ingest.pipeline.seenBefore',
    message: 'This table has seen these file contents before.  A person must choose to read them again.',
  }.message,
  'ingest.pipeline.leaseLost': /*i18n*/ {
    id: 'ingest.pipeline.leaseLost',
    message: 'Another run now owns this file.  This run stopped writing.',
  }.message,
  'ingest.pipeline.paused': /*i18n*/ {
    id: 'ingest.pipeline.paused',
    message: 'This table is paused.  Its incoming files will wait.',
  }.message,
  'ingest.pipeline.originalExpired': /*i18n*/ {
    id: 'ingest.pipeline.originalExpired',
    message: 'The original file has expired and cannot be read again.',
  }.message,
  'ingest.pipeline.originalUnavailable': /*i18n*/ {
    id: 'ingest.pipeline.originalUnavailable',
    message: 'The original file is unavailable.  No rows were read.',
  }.message,
  'ingest.pipeline.failed': /*i18n*/ {
    id: 'ingest.pipeline.failed',
    message: 'Reading this file stopped unexpectedly.  Retry it to continue.',
  }.message,
  'ingest.pipeline.hourlyLimit': /*i18n*/ {
    id: 'ingest.pipeline.hourlyLimit',
    message: 'This table has reached its limit of 60 files per hour.  This file will wait.',
  }.message,
  'ingest.pipeline.partDepth': /*i18n*/ {
    id: 'ingest.pipeline.partDepth',
    message: 'Nested archives and email attachments require a person to open them.',
  }.message,
  'ingest.pipeline.partLimit': /*i18n*/ {
    id: 'ingest.pipeline.partLimit',
    message: 'This file has more than 25 parts.  A person must split it before reading.',
  }.message,
  'ingest.pipeline.partsQueued': /*i18n*/ {
    id: 'ingest.pipeline.partsQueued',
    message: 'Queued {count} parts as separate files.  The envelope remains with the original.',
  }.message,
  'ingest.pipeline.formatTie': /*i18n*/ {
    id: 'ingest.pipeline.formatTie',
    message: 'More than one format matches this file.  Choose the format to use.',
  }.message,
  'ingest.pipeline.chooseFormat': /*i18n*/ { id: 'ingest.pipeline.chooseFormat', message: 'Use this format' }
    .message,
  'ingest.pipeline.readFailed': /*i18n*/ {
    id: 'ingest.pipeline.readFailed',
    message: 'The format could not read this file.  Check its reading rules before continuing.',
  }.message,
  'ingest.pipeline.readerUnavailable': /*i18n*/ {
    id: 'ingest.pipeline.readerUnavailable',
    message: 'This format needs a reading service that is unavailable.',
  }.message,
  'ingest.pipeline.questionsOpen': /*i18n*/ {
    id: 'ingest.pipeline.questionsOpen',
    message: 'This file needs answers before all of its rows can be settled.',
  }.message,
  'ingest.pipeline.writeStopped': /*i18n*/ {
    id: 'ingest.pipeline.writeStopped',
    message: 'The table could not accept the incoming rows.',
  }.message,
  'ingest.pipeline.probation': /*i18n*/ {
    id: 'ingest.pipeline.probation',
    message: 'This file was read with a format on probation.',
  }.message,
  'ingest.pipeline.tryLater': /*i18n*/ {
    id: 'ingest.pipeline.tryLater',
    message: 'A service or budget is unavailable.  This file will wait and try again.',
  }.message,
  'ingest.pipeline.totalFailed': /*i18n*/ {
    id: 'ingest.pipeline.totalFailed',
    message: 'The stated total for {check} did not match the rows.  No rows were written.',
  }.message,
  'ingest.pipeline.readerNote': /*i18n*/ { id: 'ingest.pipeline.readerNote', message: 'Reading note: {note}' }
    .message,
  'ingest.pipeline.monthFirst': /*i18n*/ { id: 'ingest.pipeline.monthFirst', message: 'Month first' }.message,
  'ingest.pipeline.dayFirst': /*i18n*/ { id: 'ingest.pipeline.dayFirst', message: 'Day first' }.message,
  'ingest.pipeline.keepTable': /*i18n*/ { id: 'ingest.pipeline.keepTable', message: 'Keep the table values' }
    .message,
  'ingest.pipeline.takeFile': /*i18n*/ { id: 'ingest.pipeline.takeFile', message: 'Take the file values' }
    .message,
  'ingest.layout.drift': /*i18n*/ {
    id: 'ingest.layout.drift',
    message: 'Column {field} used the later alias {actual} instead of {preferred}.',
  }.message,
  'ingest.layout.skipped': /*i18n*/ {
    id: 'ingest.layout.skipped',
    message: 'Skipped a row according to the saved layout.',
  }.message,
  'ingest.layout.uncertain': /*i18n*/ {
    id: 'ingest.layout.uncertain',
    message: 'The reading for {field} needs an answer.',
  }.message,
  'ingest.check.totalMissing': /*i18n*/ {
    id: 'ingest.check.totalMissing',
    message: 'The file did not provide the expected total.',
  }.message,
  'ingest.check.totalAmbiguous': /*i18n*/ {
    id: 'ingest.check.totalAmbiguous',
    message: 'The file provided an ambiguous total.',
  }.message,
  'ingest.check.uncertainValue': /*i18n*/ {
    id: 'ingest.check.uncertainValue',
    message: 'An uncertain value prevented checking the stated total.',
  }.message,
  'ingest.pipeline.lookupLimit': /*i18n*/ {
    id: 'ingest.pipeline.lookupLimit',
    message: 'The lookup list exceeds its reading limit.  A person must narrow it before reading.',
  }.message,
  'ingest.pipeline.rowsRemoved': /*i18n*/ {
    id: 'ingest.pipeline.rowsRemoved',
    message: 'A person chose to omit {count} incoming rows.',
  }.message,
  'ingest.pipeline.columnMissing': /*i18n*/ {
    id: 'ingest.pipeline.columnMissing',
    message: 'The reader did not return the required column {field}.  No rows were written.',
  }.message,
  'ingest.write.type': /*i18n*/ {
    id: 'ingest.write.type',
    message: 'Check the value for {field}.  It does not match the field type.',
  }.message,
  'ingest.write.required': /*i18n*/ {
    id: 'ingest.write.required',
    message: 'Required field {field} is empty.',
  }.message,
  'ingest.write.choice': /*i18n*/ {
    id: 'ingest.write.choice',
    message: 'The value for {field} is not an allowed choice.',
  }.message,
  'ingest.write.link': /*i18n*/ {
    id: 'ingest.write.link',
    message: 'The value for {field} does not name an available record in the linked table.',
  }.message,
  'ingest.write.different': /*i18n*/ {
    id: 'ingest.write.different',
    message:
      'This file and the table have different values for the same identity.  Choose which values to keep.',
  }.message,
  'ingest.write.repeatedFileIdentity': /*i18n*/ {
    id: 'ingest.write.repeatedFileIdentity',
    message: 'This file repeats an identity.  Choose one row to take, or keep the table.',
  }.message,
  'ingest.write.repeatedTableIdentity': /*i18n*/ {
    id: 'ingest.write.repeatedTableIdentity',
    message: 'The table repeats an identity.  Choose the record to update, or keep the table.',
  }.message,
  'ingest.write.handEdit': /*i18n*/ {
    id: 'ingest.write.handEdit',
    message: 'This cell was changed by a person and was left alone.',
  }.message,
  'ingest.write.ownerCannotWrite': /*i18n*/ {
    id: 'ingest.write.ownerCannotWrite',
    message:
      'The table owner can no longer write these fields.  Restore their access before writing this file.',
  }.message,
  'ingest.write.inactive': /*i18n*/ {
    id: 'ingest.write.inactive',
    message: 'This table is not accepting incoming file rows.',
  }.message,
  'ingest.write.unavailable': /*i18n*/ {
    id: 'ingest.write.unavailable',
    message: 'The incoming file or its table is unavailable.',
  }.message,
  'ingest.write.removed': /*i18n*/ { id: 'ingest.write.removed', message: 'This file has been removed.' }
    .message,
  'ingest.write.changedRun': /*i18n*/ {
    id: 'ingest.write.changedRun',
    message: 'The rows or the output format changed during this run.  Start a new run.',
  }.message,
  'ingest.write.source.sheet': /*i18n*/ { id: 'ingest.write.source.sheet', message: 'sheet {value}' }.message,
  'ingest.write.source.table': /*i18n*/ { id: 'ingest.write.source.table', message: 'table {value}' }.message,
  'ingest.write.source.page': /*i18n*/ { id: 'ingest.write.source.page', message: 'page {value}' }.message,
  'ingest.write.source.line': /*i18n*/ { id: 'ingest.write.source.line', message: 'line {value}' }.message,
  'ingest.write.source.row': /*i18n*/ { id: 'ingest.write.source.row', message: 'row {value}' }.message,
  'ingest.decisions.invalidRule': /*i18n*/ {
    id: 'ingest.decisions.invalidRule',
    message: 'This rule uses an unsupported condition, input, scope, or answer.',
  }.message,
  'ingest.decisions.ruleLimit': /*i18n*/ {
    id: 'ingest.decisions.ruleLimit',
    message: 'This rule exceeds the size limits.  Use a smaller rule.',
  }.message,
  'ingest.decisions.invalidQuestion': /*i18n*/ {
    id: 'ingest.decisions.invalidQuestion',
    message: 'This question could not be verified.  Read the file again.',
  }.message,
  'ingest.decisions.staleAnswer': /*i18n*/ {
    id: 'ingest.decisions.staleAnswer',
    message: 'This question changed while you were answering it.  Review the current question.',
  }.message,
  'ingest.decisions.invalidAnswer': /*i18n*/ {
    id: 'ingest.decisions.invalidAnswer',
    message: 'Choose an offered answer or enter a valid value.',
  }.message,
  'ingest.decisions.answerForbidden': /*i18n*/ {
    id: 'ingest.decisions.answerForbidden',
    message: 'You need permission to edit this table\u2019s records to answer its questions.',
  }.message,
  'ingest.decisions.ruleForbidden': /*i18n*/ {
    id: 'ingest.decisions.ruleForbidden',
    message: 'You need permission to edit this table\u2019s schema to remember or turn off a rule.',
  }.message,
  'ingest.decisions.ruleConflict': /*i18n*/ {
    id: 'ingest.decisions.ruleConflict',
    message: 'Rules at the same scope give different answers.  Choose which answer applies.',
  }.message,
  'ingest.decisions.chooseRuleAnswer': /*i18n*/ {
    id: 'ingest.decisions.chooseRuleAnswer',
    message: 'Use this rule\u2019s answer',
  }.message,
  'ingest.decisions.businessKnowledgeRequired': /*i18n*/ {
    id: 'ingest.decisions.businessKnowledgeRequired',
    message: 'A person who knows the business must supply this value.',
  }.message,
  'ingest.decisions.unresolved': /*i18n*/ {
    id: 'ingest.decisions.unresolved',
    message:
      'This item is still unresolved after the allowed attempt.  Review the evidence and rules that were tried.',
  }.message,
  'ingest.questions.numericDateOrder': /*i18n*/ {
    id: 'ingest.questions.numericDateOrder',
    message: 'Which order does this file use for numeric dates?',
  }.message,
  'ingest.questions.missingDateDay': /*i18n*/ {
    id: 'ingest.questions.missingDateDay',
    message: 'Which day belongs to this date?',
  }.message,
  'ingest.questions.missingDateYear': /*i18n*/ {
    id: 'ingest.questions.missingDateYear',
    message: 'Which year belongs to this date?',
  }.message,
  'ingest.questions.missingReportingPeriod': /*i18n*/ {
    id: 'ingest.questions.missingReportingPeriod',
    message: 'Which reporting period does this file cover?',
  }.message,
  'ingest.questions.twoDigitYear': /*i18n*/ {
    id: 'ingest.questions.twoDigitYear',
    message: 'How should this two-digit year be read?',
  }.message,
  'ingest.questions.decimalPoint': /*i18n*/ {
    id: 'ingest.questions.decimalPoint',
    message: 'Which mark is the decimal point?',
  }.message,
  'ingest.questions.figureScale': /*i18n*/ {
    id: 'ingest.questions.figureScale',
    message: 'Are these figures stated as units, thousands, or millions?',
  }.message,
  'ingest.questions.missingUnit': /*i18n*/ {
    id: 'ingest.questions.missingUnit',
    message: 'Which unit do these figures use?',
  }.message,
  'ingest.questions.identifierAndName': /*i18n*/ {
    id: 'ingest.questions.identifierAndName',
    message: 'How should this identifier be separated from the name?',
  }.message,
  'ingest.questions.totalRows': /*i18n*/ {
    id: 'ingest.questions.totalRows',
    message: 'How should total and subtotal rows be handled?',
  }.message,
  'ingest.questions.unrecognizedFormat': /*i18n*/ {
    id: 'ingest.questions.unrecognizedFormat',
    message: 'Which table fields match this file\u2019s columns?',
  }.message,
  'ingest.questions.unfamiliarListValue': /*i18n*/ {
    id: 'ingest.questions.unfamiliarListValue',
    message: 'Which known list value matches this name?',
  }.message,
  'ingest.questions.unknownColumn': /*i18n*/ {
    id: 'ingest.questions.unknownColumn',
    message: 'Which field matches this unknown column?',
  }.message,
  'ingest.questions.possibleSameName': /*i18n*/ {
    id: 'ingest.questions.possibleSameName',
    message: 'Do these names refer to the same thing?',
  }.message,
  'ingest.questions.repeatedRowKey': /*i18n*/ {
    id: 'ingest.questions.repeatedRowKey',
    message: 'How should rows with this repeated key be handled?',
  }.message,
  'ingest.questions.fileTableDisagreement': /*i18n*/ {
    id: 'ingest.questions.fileTableDisagreement',
    message: 'Which value applies when the file and table disagree?',
  }.message,
  'ingest.questions.blankRequiredValue': /*i18n*/ {
    id: 'ingest.questions.blankRequiredValue',
    message: 'What belongs in this required field?',
  }.message,
  'ingest.questions.outsideAllowedRange': /*i18n*/ {
    id: 'ingest.questions.outsideAllowedRange',
    message: 'How should this value outside the allowed range be handled?',
  }.message,
  'ingest.questions.passwordProtected': /*i18n*/ {
    id: 'ingest.questions.passwordProtected',
    message: 'What is the password for this file?',
  }.message,
  'ingest.questions.attachmentLink': /*i18n*/ {
    id: 'ingest.questions.attachmentLink',
    message: 'How should this link be handled in place of an attachment?',
  }.message,
  'ingest.questions.unopenableFileType': /*i18n*/ {
    id: 'ingest.questions.unopenableFileType',
    message: 'How should this file type be handled when it cannot be opened?',
  }.message,
  'ingest.pairs.cell': /*i18n*/ {
    id: 'ingest.pairs.cell',
    message: 'This field differs from the expected value.',
  }.message,
  'ingest.pairs.missingRow': /*i18n*/ {
    id: 'ingest.pairs.missingRow',
    message: 'An expected row was not produced.',
  }.message,
  'ingest.pairs.extraRow': /*i18n*/ {
    id: 'ingest.pairs.extraRow',
    message: 'This produced row was not expected.',
  }.message,
  'ingest.pairs.duplicateExpectedIdentity': /*i18n*/ {
    id: 'ingest.pairs.duplicateExpectedIdentity',
    message: 'The expected rows repeat this identity.',
  }.message,
  'ingest.pairs.duplicateActualIdentity': /*i18n*/ {
    id: 'ingest.pairs.duplicateActualIdentity',
    message: 'The produced rows repeat this identity.',
  }.message,
  'ingest.pairs.duplicateFile': /*i18n*/ {
    id: 'ingest.pairs.duplicateFile',
    message: 'This format already has a pair with the same input file.',
  }.message,
  'ingest.pairs.inputAsOutput': /*i18n*/ {
    id: 'ingest.pairs.inputAsOutput',
    message:
      'These rows are the same as the rows in {table} of the file.  Confirm if the file already arrives in finished form, or replace them with the rows the file should become.',
  }.message,
  'ingest.pairs.columns': /*i18n*/ {
    id: 'ingest.pairs.columns',
    message:
      'Check the expected columns.  Unknown fields: {unexpected}.  Missing required fields: {missing}.',
  }.message,
  'ingest.pairs.emptyRequired': /*i18n*/ {
    id: 'ingest.pairs.emptyRequired',
    message: 'Required field {field} is empty in rows {rows}.',
  }.message,
  'ingest.pairs.rowShortfall': /*i18n*/ {
    id: 'ingest.pairs.rowShortfall',
    message:
      'The input table {table} has {inputRows} data rows, but only {expectedRows} rows are expected.  Are the others left out by a rule, or missing?',
  }.message,
  'ingest.pairs.absentValue': /*i18n*/ {
    id: 'ingest.pairs.absentValue',
    message:
      'These expected values for {field} appear nowhere in the file: {values}.  Where do they come from?',
  }.message,
  'ingest.pairs.summary': /*i18n*/ {
    id: 'ingest.pairs.summary',
    message:
      'The expected rows look like totals of {table}.  Should the file produce these totals, or individual rows?',
  }.message,
  'ingest.pairs.cannotRunYet': /*i18n*/ {
    id: 'ingest.pairs.cannotRunYet',
    message: 'This format cannot run yet because its reader is unavailable.',
  }.message,
  'ingest.pairs.originalExpired': /*i18n*/ {
    id: 'ingest.pairs.originalExpired',
    message: 'The original input file has expired.  Offer a new pair.',
  }.message,
  'ingest.pairs.originalUnavailable': /*i18n*/ {
    id: 'ingest.pairs.originalUnavailable',
    message: 'The original input file is unavailable.  Offer a new pair.',
  }.message,
  'ingest.pairs.extractionFailed': /*i18n*/ {
    id: 'ingest.pairs.extractionFailed',
    message: 'The input file could not be extracted.  Check the extraction reason.',
  }.message,
  'ingest.pairs.readFailed': /*i18n*/ {
    id: 'ingest.pairs.readFailed',
    message: 'The format could not read this input file.  Check its rules and the failure reason.',
  }.message,
  'ingest.pairs.saveFailed': /*i18n*/ {
    id: 'ingest.pairs.saveFailed',
    message: 'The pair result could not be saved.  Run the examples again.',
  }.message,
  'ingest.pairs.invalidContext': /*i18n*/ {
    id: 'ingest.pairs.invalidContext',
    message: 'The table, format, and pair must belong to the same incoming file setup.',
  }.message,
  'ingest.pairs.ownSignatureMissing': /*i18n*/ {
    id: 'ingest.pairs.ownSignatureMissing',
    message: 'This example does not match its own format signature.',
  }.message,
  'ingest.pairs.otherSignatureMatched': /*i18n*/ {
    id: 'ingest.pairs.otherSignatureMatched',
    message: 'This example also matches another format signature.  Make the signatures distinct.',
  }.message,
  'ingest.layout.invalid': /*i18n*/ {
    id: 'ingest.layout.invalid',
    message: 'The layout contains invalid rules.',
  }.message,
  'ingest.layout.unsupportedSource': /*i18n*/ {
    id: 'ingest.layout.unsupportedSource',
    message: 'This layout cannot read the extracted file type.',
  }.message,
  'ingest.layout.headerNotFound': /*i18n*/ {
    id: 'ingest.layout.headerNotFound',
    message: 'The layout could not find its header in sheet {sheet}.',
  }.message,
  'ingest.layout.columnMissing': /*i18n*/ {
    id: 'ingest.layout.columnMissing',
    message: 'The layout could not find field {field} in sheet {sheet}.',
  }.message,
  'ingest.layout.columnAmbiguous': /*i18n*/ {
    id: 'ingest.layout.columnAmbiguous',
    message: 'More than one column matches field {field} in sheet {sheet}.',
  }.message,
  'ingest.layout.noRows': /*i18n*/ { id: 'ingest.layout.noRows', message: 'The layout produced no rows.' }
    .message,
};
