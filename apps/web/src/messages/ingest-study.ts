import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

export const INGEST_STUDY_MESSAGES: Record<string, MessageDescriptor> = {
  'ingest.study.fileDateOrder': msg({
    id: 'ingest.study.fileDateOrder',
    message: 'The file proves the date order.',
  }),
  'ingest.study.useRows': msg({ id: 'ingest.study.useRows', message: 'Use these rows' }),
  'ingest.study.fieldRequest': msg({
    id: 'ingest.study.fieldRequest',
    message: 'The requested field could not be created.',
  }),
  'ingest.study.nearFormat': msg({ id: 'ingest.study.nearFormat', message: 'Is this one of these formats?' }),
  'ingest.study.none': msg({ id: 'ingest.study.none', message: 'None of these' }),
  'ingest.study.column': msg({ id: 'ingest.study.column', message: 'Which field does this column supply?' }),
  'ingest.study.outputField': msg({ id: 'ingest.study.outputField', message: 'Use {field}' }),
  'ingest.study.leaveOut': msg({ id: 'ingest.study.leaveOut', message: 'Leave it out' }),
  'ingest.study.ownField': msg({ id: 'ingest.study.ownField', message: 'Make it its own field' }),
  'ingest.study.valueSource': msg({
    id: 'ingest.study.valueSource',
    message: 'Where does this value come from?',
  }),
  'ingest.study.fixed': msg({ id: 'ingest.study.fixed', message: 'It is always this value' }),
  'ingest.study.lookup': msg({ id: 'ingest.study.lookup', message: 'It comes from a list' }),
  'ingest.study.email': msg({ id: 'ingest.study.email', message: 'It is in the email' }),
  'ingest.study.person': msg({ id: 'ingest.study.person', message: 'A person knows it' }),
  'ingest.study.sourceValue': msg({
    id: 'ingest.study.sourceValue',
    message: 'What value should this field use?',
  }),
  'ingest.study.keepRules': msg({ id: 'ingest.study.keepRules', message: 'Keep these reading rules?' }),
  'ingest.study.file': msg({ id: 'ingest.study.file', message: 'Only this file' }),
  'ingest.study.layout': msg({ id: 'ingest.study.layout', message: 'Files laid out like this one' }),
  'ingest.study.sender': msg({ id: 'ingest.study.sender', message: 'Every unknown file from this sender' }),
  'ingest.study.assumed': msg({ id: 'ingest.study.assumed', message: 'Assumed from the available evidence' }),
  'ingest.study.fileHeading': msg({
    id: 'ingest.study.fileHeading',
    message: 'The file supplies this heading',
  }),
  'ingest.study.approval': msg({
    id: 'ingest.study.approval',
    message: 'Reading rules are waiting for a person who can edit the schema.',
  }),
  'ingest.study.noApproval': msg({
    id: 'ingest.study.noApproval',
    message: 'This file has no reading rules waiting for approval.',
  }),
  'ingest.study.draftQuestion': msg({
    id: 'ingest.study.draftQuestion',
    message: 'The draft needs a reading decision.',
  }),
  'ingest.study.correctRules': msg({ id: 'ingest.study.correctRules', message: 'Correct the reading rules' }),
  'ingest.study.correctExample': msg({ id: 'ingest.study.correctExample', message: 'Review this file' }),
  'ingest.study.failing': msg({
    id: 'ingest.study.failing',
    message: 'This format failed an example.  Check the specific finding before reading its next file.',
  }),
};
