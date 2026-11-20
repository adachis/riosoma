import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

export const INGEST_WRITE_MESSAGES: Record<string, MessageDescriptor> = {
  'ingest.write.type': msg({
    id: 'ingest.write.type',
    message: 'Check the value for {field}.  It does not match the field type.',
  }),
  'ingest.write.required': msg({ id: 'ingest.write.required', message: 'Required field {field} is empty.' }),
  'ingest.write.choice': msg({
    id: 'ingest.write.choice',
    message: 'The value for {field} is not an allowed choice.',
  }),
  'ingest.write.link': msg({
    id: 'ingest.write.link',
    message: 'The value for {field} does not name an available record in the linked table.',
  }),
  'ingest.write.different': msg({
    id: 'ingest.write.different',
    message:
      'This file and the table have different values for the same identity.  Choose which values to keep.',
  }),
  'ingest.write.repeatedFileIdentity': msg({
    id: 'ingest.write.repeatedFileIdentity',
    message: 'This file repeats an identity.  Choose one row to take, or keep the table.',
  }),
  'ingest.write.repeatedTableIdentity': msg({
    id: 'ingest.write.repeatedTableIdentity',
    message: 'The table repeats an identity.  Choose the record to update, or keep the table.',
  }),
  'ingest.write.handEdit': msg({
    id: 'ingest.write.handEdit',
    message: 'This cell was changed by a person and was left alone.',
  }),
  'ingest.write.ownerCannotWrite': msg({
    id: 'ingest.write.ownerCannotWrite',
    message:
      'The table owner can no longer write these fields.  Restore their access before writing this file.',
  }),
  'ingest.write.inactive': msg({
    id: 'ingest.write.inactive',
    message: 'This table is not accepting incoming file rows.',
  }),
  'ingest.write.unavailable': msg({
    id: 'ingest.write.unavailable',
    message: 'The incoming file or its table is unavailable.',
  }),
  'ingest.write.removed': msg({ id: 'ingest.write.removed', message: 'This file has been removed.' }),
  'ingest.write.changedRun': msg({
    id: 'ingest.write.changedRun',
    message: 'The rows or the output format changed during this run.  Start a new run.',
  }),
  'ingest.write.source.sheet': msg({ id: 'ingest.write.source.sheet', message: 'sheet {value}' }),
  'ingest.write.source.table': msg({ id: 'ingest.write.source.table', message: 'table {value}' }),
  'ingest.write.source.page': msg({ id: 'ingest.write.source.page', message: 'page {value}' }),
  'ingest.write.source.line': msg({ id: 'ingest.write.source.line', message: 'line {value}' }),
  'ingest.write.source.row': msg({ id: 'ingest.write.source.row', message: 'row {value}' }),
};
