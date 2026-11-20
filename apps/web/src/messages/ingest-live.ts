import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

export const INGEST_LIVE_MESSAGES: Record<string, MessageDescriptor> = {
  'ingest.live.notInMode': msg({
    id: 'ingest.live.notInMode',
    message: 'This table is not in Chaotic Data Ingest Mode.',
  }),
  'ingest.live.inSetup': msg({
    id: 'ingest.live.inSetup',
    message: 'Finish setup and take this table live before sending files.',
  }),
  'ingest.live.editRequired': msg({
    id: 'ingest.live.editRequired',
    message: 'You need permission to edit records to send files or change incoming files.',
  }),
  'ingest.live.uploadRequired': msg({
    id: 'ingest.live.uploadRequired',
    message: 'Send one file as a streamed upload.',
  }),
  'ingest.live.alreadyAnswered': msg({
    id: 'ingest.live.alreadyAnswered',
    message: 'This question has already been answered.',
  }),
  'ingest.live.retryUnavailable': msg({
    id: 'ingest.live.retryUnavailable',
    message: 'Only failed answer requests can be retried.',
  }),
  'ingest.live.scope.valueFromSender': msg({
    id: 'ingest.live.scope.valueFromSender',
    message: 'This value from this sender: {value}, {sender}',
  }),
  'ingest.live.scope.valueFromAnyone': msg({
    id: 'ingest.live.scope.valueFromAnyone',
    message: 'This value from any sender: {value}',
  }),
  'ingest.live.scope.format': msg({
    id: 'ingest.live.scope.format',
    message: 'Files in this format: {format}',
  }),
  'ingest.live.scope.sender': msg({
    id: 'ingest.live.scope.sender',
    message: 'Files from this sender: {sender}',
  }),
  'ingest.live.scope.table': msg({
    id: 'ingest.live.scope.table',
    message: 'All incoming files for this table',
  }),
  'ingest.live.scope.withheld': msg({
    id: 'ingest.live.scope.withheld',
    message: 'Rule scope details are withheld by your table access.',
  }),
};
