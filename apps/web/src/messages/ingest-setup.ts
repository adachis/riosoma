import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

export const INGEST_SETUP_MESSAGES: Record<string, MessageDescriptor> = {
  'ingest.drafts.finishing': msg({
    id: 'ingest.drafts.finishing',
    message:
      'The previous reading is finishing.  Start this file again after its spending has been recorded.',
  }),
  'ingest.drafts.input': msg({
    id: 'ingest.drafts.input',
    message: 'This input file is reserved for an example draft.',
  }),
  'ingest.drafts.kept': msg({
    id: 'ingest.drafts.kept',
    message: 'Discard the draft before removing its input file.',
  }),
  'ingest.drafts.needsOwn': msg({
    id: 'ingest.drafts.needsOwn',
    message:
      'The table needs to see one finished pair from you before it guesses at others.  Add a confirmed example you prepared for this format first.',
  }),
  'ingest.drafts.sameFile': msg({
    id: 'ingest.drafts.sameFile',
    message: 'This file already belongs to an example or an active draft.  Use a different input file.',
  }),
  'ingest.drafts.state': msg({
    id: 'ingest.drafts.state',
    message: 'This command is unavailable in the current draft state.',
  }),
  'ingest.drafts.none': msg({
    id: 'ingest.drafts.none',
    message: 'None of these.  Type the value from the file.',
  }),
  'ingest.drafts.mismatch': msg({
    id: 'ingest.drafts.mismatch',
    message: 'Look at this place in the file again, and correct the row or supply the value again.',
  }),
  'ingest.drafts.checksRequired': msg({
    id: 'ingest.drafts.checksRequired',
    message:
      'Supply every spot check value, and resolve every row needing correction before confirming this draft.',
  }),
  'ingest.drafts.matchesDraft': msg({
    id: 'ingest.drafts.matchesDraft',
    message: 'These rows match the draft.  Complete its spot checks before confirming the example.',
  }),
  'ingest.drafts.outputChanged': msg({
    id: 'ingest.drafts.outputChanged',
    message: 'The output format changed.  Start the draft again with the current output format.',
  }),
  'ingest.drafts.inputUnavailable': msg({
    id: 'ingest.drafts.inputUnavailable',
    message: 'The original input file is unavailable.  Upload it again to restart the draft.',
  }),
  'ingest.drafts.invalidReading': msg({
    id: 'ingest.drafts.invalidReading',
    message: 'The file could not be read into a complete draft.  Start the draft again.',
  }),
  'ingest.layout.invalidData': msg({
    id: 'ingest.layout.invalidData',
    message: 'Use valid layout reading rules.',
  }),
  'ingest.setup.state': msg({
    id: 'ingest.setup.state',
    message: "This command is unavailable in the table's current ingest state.",
  }),
  'ingest.setup.disabled': msg({
    id: 'ingest.setup.disabled',
    message: 'Turn on AI and ingest for the organization before starting setup.',
  }),
  'ingest.setup.senderUsed': msg({
    id: 'ingest.setup.senderUsed',
    message:
      'This sender is referenced by {count} files.  Remove those references before removing the sender.',
  }),
  'ingest.setup.personMustGoLive': msg({
    id: 'ingest.setup.personMustGoLive',
    message: 'A person must press the button to take this table live.',
  }),
  'ingest.setup.sheetRows': msg({
    id: 'ingest.setup.sheetRows',
    message: 'This sheet exceeds the spreadsheet import row limit.',
  }),
  'ingest.setup.emptySheet': msg({
    id: 'ingest.setup.emptySheet',
    message: 'Offer a sheet with column headings and expected rows.',
  }),
  'ingest.setup.sheetColumns': msg({
    id: 'ingest.setup.sheetColumns',
    message: 'Use one unique output field key for each sheet column.',
  }),
  'ingest.setup.choiceValues': msg({
    id: 'ingest.setup.choiceValues',
    message: 'Allowed values must be unique choices for a choice field.',
  }),
  'ingest.setup.pairBlocked': msg({
    id: 'ingest.setup.pairBlocked',
    message: 'This example has blocking findings.  Resolve every finding before confirming it.',
  }),
  'ingest.setup.confirmPair': msg({
    id: 'ingest.setup.confirmPair',
    message: 'Review these findings, and confirm the example with a second call.',
  }),
  'ingest.setup.signatureOverlap': msg({
    id: 'ingest.setup.signatureOverlap',
    message: 'This signature makes an example match another format.  Narrow the signature before saving it.',
  }),
  'ingest.setup.toolkitVersion': msg({
    id: 'ingest.setup.toolkitVersion',
    message: 'Use the installed reader toolkit version.',
  }),
  'ingest.setup.notReady': msg({
    id: 'ingest.setup.notReady',
    message: 'Complete every readiness gate before taking the table live.',
  }),
  'ingest.setup.confirmRedo': msg({
    id: 'ingest.setup.confirmRedo',
    message: 'Confirm that you want to erase this setup.',
  }),
  'ingest.ready.noFields': msg({ id: 'ingest.ready.noFields', message: 'Choose the output fields.' }),
  'ingest.ready.fieldType': msg({
    id: 'ingest.ready.fieldType',
    message: 'Output field {field} needs a type and a data field mark.',
  }),
  'ingest.ready.fieldRequired': msg({
    id: 'ingest.ready.fieldRequired',
    message: 'Decide whether output field {field} is required.',
  }),
  'ingest.ready.fieldMeaning': msg({
    id: 'ingest.ready.fieldMeaning',
    message: 'Describe output field {field} in a sentence that explains its meaning.',
  }),
  'ingest.ready.fieldChoices': msg({
    id: 'ingest.ready.fieldChoices',
    message: 'Choose the allowed values for output field {field}.',
  }),
  'ingest.ready.unlistedField': msg({
    id: 'ingest.ready.unlistedField',
    message: 'Include marked data field {field} in the output format.',
  }),
  'ingest.ready.rowMeaning': msg({
    id: 'ingest.ready.rowMeaning',
    message: 'Describe what one output row means in a sentence.',
  }),
  'ingest.ready.identity': msg({
    id: 'ingest.ready.identity',
    message: 'Choose identity keys, or explicitly decide that rows have no identity.',
  }),
  'ingest.ready.valueSource': msg({
    id: 'ingest.ready.valueSource',
    message: 'Resolve question {questionId} about where required field {field} gets its value.',
  }),
  'ingest.ready.examples': msg({
    id: 'ingest.ready.examples',
    message: 'Format {format} has {count} complete examples from different files.  It needs {needed}.',
  }),
  'ingest.ready.ownExample': msg({
    id: 'ingest.ready.ownExample',
    message: 'Format {format} needs an example whose expected rows did not come from a draft.',
  }),
  'ingest.ready.incompleteExample': msg({
    id: 'ingest.ready.incompleteExample',
    message: 'Example {exampleId} for format {format} is incomplete.',
  }),
  'ingest.ready.rules': msg({
    id: 'ingest.ready.rules',
    message:
      'Save reading rules for format {format} that reproduce every example exactly.  Currently {count} examples pass.',
  }),
  'ingest.ready.signature': msg({
    id: 'ingest.ready.signature',
    message: 'Save a signature for format {format}, and check it against its examples.',
  }),
  'ingest.ready.original': msg({
    id: 'ingest.ready.original',
    message: 'The original for example {exampleId} in format {format} is unavailable.',
  }),
  'ingest.ready.noFormat': msg({
    id: 'ingest.ready.noFormat',
    message: 'Add a format with three confirmed examples from different files.',
  }),
  'ingest.names.needsReview': msg({ id: 'ingest.names.needsReview', message: 'Needs review' }),
  'ingest.names.reviewNote': msg({ id: 'ingest.names.reviewNote', message: 'Review note' }),
  'ingest.names.readByAi': msg({ id: 'ingest.names.readByAi', message: 'Read by AI' }),
  'ingest.names.source': msg({ id: 'ingest.names.source', message: 'Source' }),
  'ingest.names.received': msg({ id: 'ingest.names.received', message: 'Received' }),
  'ingest.names.reviewView': msg({ id: 'ingest.names.reviewView', message: 'Needs review' }),
};
