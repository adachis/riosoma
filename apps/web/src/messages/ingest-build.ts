import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

export const INGEST_BUILD_MESSAGES: Record<string, MessageDescriptor> = {
  'ingest.build.examples': msg({
    id: 'ingest.build.examples',
    message: 'There are {have} complete examples from different files.  This build needs {need}.',
  }),
  'ingest.build.oneMore': msg({
    id: 'ingest.build.oneMore',
    message: 'The builder has seen every example.  Add one more example for a blind test.',
  }),
  'ingest.build.busy': msg({
    id: 'ingest.build.busy',
    message: 'A build is already running for this format.',
  }),
  'ingest.build.owner': msg({
    id: 'ingest.build.owner',
    message: 'Only the person who started this build can cancel it.',
  }),
  'ingest.build.finished': msg({ id: 'ingest.build.finished', message: 'This build has ended.' }),
  'ingest.build.invalidTool': msg({
    id: 'ingest.build.invalidTool',
    message: 'Use one of the four build tools with valid arguments.',
  }),
  'ingest.build.invalidRules': msg({
    id: 'ingest.build.invalidRules',
    message: 'Use valid reading rules and a signature.',
  }),
  'ingest.build.bindingsRequired': msg({
    id: 'ingest.build.bindingsRequired',
    message: 'Give every reader output field an executable value source.',
  }),
  'ingest.build.layoutFirst': msg({
    id: 'ingest.build.layoutFirst',
    message: 'Test a layout before writing a reader.',
  }),
  'ingest.build.testRequired': msg({
    id: 'ingest.build.testRequired',
    message: 'Test the draft before replacing it.',
  }),
  'ingest.build.writeRequired': msg({
    id: 'ingest.build.writeRequired',
    message: 'Write a draft before testing it.',
  }),
  'ingest.build.unresolved': msg({
    id: 'ingest.build.unresolved',
    message: 'Resolve the difference for this field before building again.',
  }),
  'ingest.build.valueSource': msg({
    id: 'ingest.build.valueSource',
    message: 'Where does this required field get its value?',
  }),
  'ingest.build.valuePresent': msg({
    id: 'ingest.build.valuePresent',
    message: 'A build file supplies this value.  Inspect the file before asking where the value comes from.',
  }),
  'ingest.build.choice': msg({
    id: 'ingest.build.choice',
    message: '{field}: {difference}.  Choose {choice}.',
  }),
  'ingest.build.attempts': msg({
    id: 'ingest.build.attempts',
    message:
      'Six attempts left a specific difference unresolved.  Answer the question before building again.',
  }),
  'ingest.build.blindFailed': msg({
    id: 'ingest.build.blindFailed',
    message: 'The rules failed on the blind example.  Add one more example before building again.',
  }),
  'ingest.build.ceiling': msg({
    id: 'ingest.build.ceiling',
    message: 'This build reached its spending ceiling.',
  }),
  'ingest.build.aiOff': msg({
    id: 'ingest.build.aiOff',
    message: 'AI is turned off.  Turn it on before building again.',
  }),
  'ingest.build.ingestOff': msg({
    id: 'ingest.build.ingestOff',
    message: 'AI ingest is turned off.  Turn it on before building again.',
  }),
  'ingest.build.budgetSpent': msg({
    id: 'ingest.build.budgetSpent',
    message: 'The monthly AI budget is spent.  Build again when budget is available.',
  }),
  'ingest.build.providerDown': msg({
    id: 'ingest.build.providerDown',
    message: 'The power model is unavailable.  Build again when it is available.',
  }),
  'ingest.build.keyRefused': msg({
    id: 'ingest.build.keyRefused',
    message: 'The provider refused the API key.  Update the key before building or studying again.',
  }),
  'ingest.build.classification': msg({
    id: 'ingest.build.classification',
    message: 'The table classification or your access prevents sending examples to this model.',
  }),
  'ingest.build.noProgress': msg({
    id: 'ingest.build.noProgress',
    message: 'The build ended without tested rules.',
  }),
  'ingest.build.stale': msg({
    id: 'ingest.build.stale',
    message: 'The format or its examples changed during the build.  Start a new build.',
  }),
  'ingest.build.original': msg({
    id: 'ingest.build.original',
    message: 'An example original is unavailable.  Add a complete example, and build again.',
  }),
  'ingest.build.fixed': msg({ id: 'ingest.build.fixed', message: 'It is always this value.' }),
  'ingest.build.lookup': msg({ id: 'ingest.build.lookup', message: 'It comes from a list.' }),
  'ingest.build.email': msg({ id: 'ingest.build.email', message: 'It is in the email.' }),
  'ingest.build.person': msg({ id: 'ingest.build.person', message: 'A person knows it.' }),
  'ingest.build.correctRules': msg({
    id: 'ingest.build.correctRules',
    message: 'Correct the reading rule for this field.',
  }),
  'ingest.build.correctExample': msg({
    id: 'ingest.build.correctExample',
    message: 'Correct the expected value for this field.',
  }),
};
