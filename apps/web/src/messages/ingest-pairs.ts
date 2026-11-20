import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

export const INGEST_PAIR_MESSAGES: Record<string, MessageDescriptor> = {
  'ingest.pairs.cell': msg({
    id: 'ingest.pairs.cell',
    message: 'This field differs from the expected value.',
  }),
  'ingest.pairs.missingRow': msg({
    id: 'ingest.pairs.missingRow',
    message: 'An expected row was not produced.',
  }),
  'ingest.pairs.extraRow': msg({
    id: 'ingest.pairs.extraRow',
    message: 'This produced row was not expected.',
  }),
  'ingest.pairs.duplicateExpectedIdentity': msg({
    id: 'ingest.pairs.duplicateExpectedIdentity',
    message: 'The expected rows repeat this identity.',
  }),
  'ingest.pairs.duplicateActualIdentity': msg({
    id: 'ingest.pairs.duplicateActualIdentity',
    message: 'The produced rows repeat this identity.',
  }),
  'ingest.pairs.duplicateFile': msg({
    id: 'ingest.pairs.duplicateFile',
    message: 'This format already has a pair with the same input file.',
  }),
  'ingest.pairs.inputAsOutput': msg({
    id: 'ingest.pairs.inputAsOutput',
    message:
      'These rows are the same as the rows in {table} of the file.  Confirm if the file already arrives in finished form, or replace them with the rows the file should become.',
  }),
  'ingest.pairs.columns': msg({
    id: 'ingest.pairs.columns',
    message:
      'Check the expected columns.  Unknown fields: {unexpected}.  Missing required fields: {missing}.',
  }),
  'ingest.pairs.emptyRequired': msg({
    id: 'ingest.pairs.emptyRequired',
    message: 'Required field {field} is empty in rows {rows}.',
  }),
  'ingest.pairs.rowShortfall': msg({
    id: 'ingest.pairs.rowShortfall',
    message:
      'The input table {table} has {inputRows} data rows, but only {expectedRows} rows are expected.  Are the others left out by a rule, or missing?',
  }),
  'ingest.pairs.absentValue': msg({
    id: 'ingest.pairs.absentValue',
    message:
      'These expected values for {field} appear nowhere in the file: {values}.  Where do they come from?',
  }),
  'ingest.pairs.summary': msg({
    id: 'ingest.pairs.summary',
    message:
      'The expected rows look like totals of {table}.  Should the file produce these totals, or individual rows?',
  }),
  'ingest.pairs.cannotRunYet': msg({
    id: 'ingest.pairs.cannotRunYet',
    message: 'This format cannot run yet because its reader is unavailable.',
  }),
  'ingest.pairs.originalExpired': msg({
    id: 'ingest.pairs.originalExpired',
    message: 'The original input file has expired.  Offer a new pair.',
  }),
  'ingest.pairs.originalUnavailable': msg({
    id: 'ingest.pairs.originalUnavailable',
    message: 'The original input file is unavailable.  Offer a new pair.',
  }),
  'ingest.pairs.extractionFailed': msg({
    id: 'ingest.pairs.extractionFailed',
    message: 'The input file could not be extracted.  Check the extraction reason.',
  }),
  'ingest.pairs.readFailed': msg({
    id: 'ingest.pairs.readFailed',
    message: 'The format could not read this input file.  Check its rules and the failure reason.',
  }),
  'ingest.pairs.saveFailed': msg({
    id: 'ingest.pairs.saveFailed',
    message: 'The pair result could not be saved.  Run the examples again.',
  }),
  'ingest.pairs.invalidContext': msg({
    id: 'ingest.pairs.invalidContext',
    message: 'The table, format, and pair must belong to the same incoming file setup.',
  }),
  'ingest.pairs.ownSignatureMissing': msg({
    id: 'ingest.pairs.ownSignatureMissing',
    message: 'This example does not match its own format signature.',
  }),
  'ingest.pairs.otherSignatureMatched': msg({
    id: 'ingest.pairs.otherSignatureMatched',
    message: 'This example also matches another format signature.  Make the signatures distinct.',
  }),
  'ingest.layout.invalid': msg({
    id: 'ingest.layout.invalid',
    message: 'The layout contains invalid rules.',
  }),
  'ingest.layout.unsupportedSource': msg({
    id: 'ingest.layout.unsupportedSource',
    message: 'This layout cannot read the extracted file type.',
  }),
  'ingest.layout.headerNotFound': msg({
    id: 'ingest.layout.headerNotFound',
    message: 'The layout could not find its header in sheet {sheet}.',
  }),
  'ingest.layout.columnMissing': msg({
    id: 'ingest.layout.columnMissing',
    message: 'The layout could not find field {field} in sheet {sheet}.',
  }),
  'ingest.layout.columnAmbiguous': msg({
    id: 'ingest.layout.columnAmbiguous',
    message: 'More than one column matches field {field} in sheet {sheet}.',
  }),
  'ingest.layout.noRows': msg({ id: 'ingest.layout.noRows', message: 'The layout produced no rows.' }),
};
