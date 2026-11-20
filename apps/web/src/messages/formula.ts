import { msg } from '@lingui/core/macro';
import { registerMessages } from './descriptors';
import type { MessageDescriptor } from '@lingui/core';

/** Reasons from the formula engine are translated at the point of display. */
export const FORMULA_MESSAGES: Record<string, MessageDescriptor> = {
  'formula.named.invalid': msg({
    id: 'formula.named.invalid',
    message: 'Use valid, unique function and parameter names. Built-in function names are reserved.',
  }),
  'formula.named.parameter': msg({
    id: 'formula.named.parameter',
    message: 'Pass {name} as a parameter instead of reading a field directly.',
  }),
  'formula.named.circular': msg({
    id: 'formula.named.circular',
    message: 'Named functions cannot call themselves, even through another function.',
  }),
  'formula.type.rangeContext': msg({
    id: 'formula.type.rangeContext',
    message: 'Use this table reference in a lookup or conditional total.',
  }),
  'formula.type.rangeRequired': msg({
    id: 'formula.type.rangeRequired',
    message: 'Use a table and field reference here.',
  }),
  'formula.type.sameTable': msg({ id: 'formula.type.sameTable', message: 'Use fields from the same table.' }),
  'formula.runtime.recordsUnavailable': msg({
    id: 'formula.runtime.recordsUnavailable',
    message: 'The readable records are not available yet.',
  }),
  'formula.syntax.depth': msg({ id: 'formula.syntax.depth', message: 'This formula is nested too deeply.' }),
  'formula.syntax.escape': msg({ id: 'formula.syntax.escape', message: 'Check this escaped character.' }),
  'formula.syntax.number': msg({ id: 'formula.syntax.number', message: 'This number is too large.' }),
  'formula.syntax.unexpected': msg({
    id: 'formula.syntax.unexpected',
    message: 'Check the formula at this position.',
  }),
  'formula.syntax.unterminated': msg({
    id: 'formula.syntax.unterminated',
    message: 'Close this text or field reference.',
  }),
  'formula.field.unknown': msg({ id: 'formula.field.unknown', message: 'There’s no field named {name}.' }),
  'formula.field.ambiguous': msg({
    id: 'formula.field.ambiguous',
    message: 'More than one field is named {name}. Rename one of them.',
  }),
  'formula.field.circular': msg({
    id: 'formula.field.circular',
    message: 'This formula refers back to itself.',
  }),
  'formula.field.unresolved': msg({
    id: 'formula.field.unresolved',
    message: 'Choose an existing field for {name}.',
  }),
  'formula.function.arity': msg({
    id: 'formula.function.arity',
    message: 'Check how many arguments {name} needs.',
  }),
  'formula.function.arguments': msg({
    id: 'formula.function.arguments',
    message:
      'This formula passes the wrong number of arguments. Check the function parameters and update the call.',
  }),
  'formula.function.unavailable': msg({
    id: 'formula.function.unavailable',
    message:
      'This formula calls a function that is unavailable. Update the call or restore the named function.',
  }),
  'formula.function.unknown': msg({
    id: 'formula.function.unknown',
    message: 'There’s no function named {name}.',
  }),
  'formula.type.argument': msg({
    id: 'formula.type.argument',
    message: 'This argument has the wrong value type.',
  }),
  'formula.type.branch': msg({
    id: 'formula.type.branch',
    message: 'The possible results need to have the same value type.',
  }),
  'formula.type.comparison': msg({
    id: 'formula.type.comparison',
    message: 'These values can’t be compared.',
  }),
  'formula.type.fieldRequired': msg({
    id: 'formula.type.fieldRequired',
    message: 'Use a field reference here.',
  }),
  'formula.list.several': msg({
    id: 'formula.list.several',
    message: 'This lookup or link holds more than one value, where the formula needs one.',
  }),
  'formula.runtime.argument': msg({
    id: 'formula.runtime.argument',
    message: 'Check the value passed to this function.',
  }),
  'formula.runtime.date': msg({
    id: 'formula.runtime.date',
    message: 'This value isn’t a valid date or time zone.',
  }),
  'formula.runtime.divisionByZero': msg({
    id: 'formula.runtime.divisionByZero',
    message: 'A number can’t be divided by zero.',
  }),
  'formula.runtime.explicit': msg({
    id: 'formula.runtime.explicit',
    message: 'This formula returned an error.',
  }),
  'formula.runtime.limit': msg({
    id: 'formula.runtime.limit',
    message: 'This calculation exceeds the formula’s limits.',
  }),
  'formula.runtime.modificationUnavailable': msg({
    id: 'formula.runtime.modificationUnavailable',
    message: 'Modification times for individual fields aren’t available.',
  }),
  'formula.runtime.number': msg({
    id: 'formula.runtime.number',
    message: 'This calculation doesn’t produce a finite number.',
  }),
  'formula.runtime.regex': msg({ id: 'formula.runtime.regex', message: 'Check the regular expression.' }),
  'formula.runtime.regexNoMatch': msg({
    id: 'formula.runtime.regexNoMatch',
    message: 'The regular expression didn’t find a match.',
  }),
  'formula.runtime.unit': msg({
    id: 'formula.runtime.unit',
    message: 'Choose a supported date or time unit.',
  }),
  'formula.runtime.weekStart': msg({
    id: 'formula.runtime.weekStart',
    message: 'Choose Sunday or Monday as the start of the week.',
  }),
};

registerMessages(FORMULA_MESSAGES);
