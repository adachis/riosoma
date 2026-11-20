import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

export const INGEST_PIPELINE_MESSAGES: Record<string, MessageDescriptor> = {
  'ingest.pipeline.dot': msg({ id: 'ingest.pipeline.dot', message: 'Use a decimal point' }),
  'ingest.pipeline.comma': msg({ id: 'ingest.pipeline.comma', message: 'Use a decimal comma' }),
  'ingest.pipeline.inactive': msg({
    id: 'ingest.pipeline.inactive',
    message: 'Incoming files require a live or paused table.',
  }),
  'ingest.pipeline.seenBefore': msg({
    id: 'ingest.pipeline.seenBefore',
    message: 'This table has seen these file contents before.  A person must choose to read them again.',
  }),
  'ingest.pipeline.leaseLost': msg({
    id: 'ingest.pipeline.leaseLost',
    message: 'Another run now owns this file.  This run stopped writing.',
  }),
  'ingest.pipeline.paused': msg({
    id: 'ingest.pipeline.paused',
    message: 'This table is paused.  Its incoming files will wait.',
  }),
  'ingest.pipeline.originalExpired': msg({
    id: 'ingest.pipeline.originalExpired',
    message: 'The original file has expired and cannot be read again.',
  }),
  'ingest.pipeline.originalUnavailable': msg({
    id: 'ingest.pipeline.originalUnavailable',
    message: 'The original file is unavailable.  No rows were read.',
  }),
  'ingest.pipeline.failed': msg({
    id: 'ingest.pipeline.failed',
    message: 'Reading this file stopped unexpectedly.  Retry it to continue.',
  }),
  'ingest.pipeline.hourlyLimit': msg({
    id: 'ingest.pipeline.hourlyLimit',
    message: 'This table has reached its limit of 60 files per hour.  This file will wait.',
  }),
  'ingest.pipeline.partDepth': msg({
    id: 'ingest.pipeline.partDepth',
    message: 'Nested archives and email attachments require a person to open them.',
  }),
  'ingest.pipeline.partLimit': msg({
    id: 'ingest.pipeline.partLimit',
    message: 'This file has more than 25 parts.  A person must split it before reading.',
  }),
  'ingest.pipeline.partsQueued': msg({
    id: 'ingest.pipeline.partsQueued',
    message: 'Queued {count} parts as separate files.  The envelope remains with the original.',
  }),
  'ingest.pipeline.formatTie': msg({
    id: 'ingest.pipeline.formatTie',
    message: 'More than one format matches this file.  Choose the format to use.',
  }),
  'ingest.pipeline.chooseFormat': msg({ id: 'ingest.pipeline.chooseFormat', message: 'Use this format' }),
  'ingest.pipeline.readFailed': msg({
    id: 'ingest.pipeline.readFailed',
    message: 'The format could not read this file.  Check its reading rules before continuing.',
  }),
  'ingest.pipeline.readerUnavailable': msg({
    id: 'ingest.pipeline.readerUnavailable',
    message: 'This format needs a reading service that is unavailable.',
  }),
  'ingest.pipeline.questionsOpen': msg({
    id: 'ingest.pipeline.questionsOpen',
    message: 'This file needs answers before all of its rows can be settled.',
  }),
  'ingest.pipeline.writeStopped': msg({
    id: 'ingest.pipeline.writeStopped',
    message: 'The table could not accept the incoming rows.',
  }),
  'ingest.pipeline.probation': msg({
    id: 'ingest.pipeline.probation',
    message: 'This file was read with a format on probation.',
  }),
  'ingest.pipeline.tryLater': msg({
    id: 'ingest.pipeline.tryLater',
    message: 'A service or budget is unavailable.  This file will wait and try again.',
  }),
  'ingest.pipeline.totalFailed': msg({
    id: 'ingest.pipeline.totalFailed',
    message: 'The stated total for {check} did not match the rows.  No rows were written.',
  }),
  'ingest.pipeline.readerNote': msg({ id: 'ingest.pipeline.readerNote', message: 'Reading note: {note}' }),
  'ingest.pipeline.monthFirst': msg({ id: 'ingest.pipeline.monthFirst', message: 'Month first' }),
  'ingest.pipeline.dayFirst': msg({ id: 'ingest.pipeline.dayFirst', message: 'Day first' }),
  'ingest.pipeline.keepTable': msg({ id: 'ingest.pipeline.keepTable', message: 'Keep the table values' }),
  'ingest.pipeline.takeFile': msg({ id: 'ingest.pipeline.takeFile', message: 'Take the file values' }),
  'ingest.layout.drift': msg({
    id: 'ingest.layout.drift',
    message: 'Column {field} used the later alias {actual} instead of {preferred}.',
  }),
  'ingest.layout.skipped': msg({
    id: 'ingest.layout.skipped',
    message: 'Skipped a row according to the saved layout.',
  }),
  'ingest.layout.uncertain': msg({
    id: 'ingest.layout.uncertain',
    message: 'The reading for {field} needs an answer.',
  }),
  'ingest.check.totalMissing': msg({
    id: 'ingest.check.totalMissing',
    message: 'The file did not provide the expected total.',
  }),
  'ingest.check.totalAmbiguous': msg({
    id: 'ingest.check.totalAmbiguous',
    message: 'The file provided an ambiguous total.',
  }),
  'ingest.check.uncertainValue': msg({
    id: 'ingest.check.uncertainValue',
    message: 'An uncertain value prevented checking the stated total.',
  }),
  'ingest.pipeline.lookupLimit': msg({
    id: 'ingest.pipeline.lookupLimit',
    message: 'The lookup list exceeds its reading limit.  A person must narrow it before reading.',
  }),
  'ingest.pipeline.rowsRemoved': msg({
    id: 'ingest.pipeline.rowsRemoved',
    message: 'A person chose to omit {count} incoming rows.',
  }),
  'ingest.pipeline.columnMissing': msg({
    id: 'ingest.pipeline.columnMissing',
    message: 'The reader did not return the required column {field}.  No rows were written.',
  }),
};
