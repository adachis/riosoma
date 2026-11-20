import { msg } from '@lingui/core/macro';

export const VALIDATION_MESSAGES = {
  'data.records.locksChanged': msg({ id: 'data.records.locksChanged', message: 'Changed record locks.' }),
  'data.validation.failed': msg({
    id: 'data.validation.failed',
    message: 'Some values do not meet the field rules.',
  }),
  'data.validation.required': msg({ id: 'data.validation.required', message: 'Enter a value.' }),
  'data.validation.min': msg({ id: 'data.validation.min', message: 'The value is below the minimum.' }),
  'data.validation.max': msg({ id: 'data.validation.max', message: 'The value is above the maximum.' }),
  'data.validation.minLength': msg({ id: 'data.validation.minLength', message: 'The text is too short.' }),
  'data.validation.maxLength': msg({ id: 'data.validation.maxLength', message: 'The text is too long.' }),
  'data.validation.pattern': msg({
    id: 'data.validation.pattern',
    message: 'The value does not match the pattern.',
  }),
  'data.validation.patternLength': msg({
    id: 'data.validation.patternLength',
    message: 'Patterns accept at most 10,000 characters.',
  }),
  'data.validation.patternSyntax': msg({
    id: 'data.validation.patternSyntax',
    message: 'Use a simple pattern without backreferences, lookaround, or nested quantifiers.',
  }),
  'data.validation.dateBound': msg({
    id: 'data.validation.dateBound',
    message: 'Enter an ISO date or timestamp.',
  }),
  'data.validation.bounds': msg({
    id: 'data.validation.bounds',
    message: 'The minimum must not exceed the maximum.',
  }),
  'data.validation.unique': msg({
    id: 'data.validation.unique',
    message: 'Another record already has this value.',
  }),
  'data.validation.duplicates': msg({
    id: 'data.validation.duplicates',
    message: 'Resolve existing duplicates before requiring unique values.',
  }),
  'data.validation.uniqueSource': msg({
    id: 'data.validation.uniqueSource',
    message: 'Source fields cannot require unique values.',
  }),
  'data.validation.uniquePrepare': msg({
    id: 'data.validation.uniquePrepare',
    message: 'Save the unique field rule again to finish building its index.',
  }),
  'data.validation.uniqueConvert': msg({
    id: 'data.validation.uniqueConvert',
    message: 'Turn off uniqueness before changing the field type, then turn it on again.',
  }),
  'data.locks.recordLocked': msg({
    id: 'data.locks.recordLocked',
    message: 'This record is locked.  {reason}',
  }),
  'data.locks.unlockDenied': msg({
    id: 'data.locks.unlockDenied',
    message: 'Your role cannot unlock this record.',
  }),
  'data.locks.viewLocked': msg({
    id: 'data.locks.viewLocked',
    message: 'Unlock this view before changing its configuration.',
  }),
  'data.locks.condition': msg({
    id: 'data.locks.condition',
    message: 'Choose a complete condition using available fields.',
  }),
};
