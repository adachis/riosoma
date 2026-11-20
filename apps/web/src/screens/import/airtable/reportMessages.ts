import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { RollupFunction } from '@riosoma/contracts';

/**
 * What each line of an Airtable import's report says.  The server sends a key and its parameters,
 * and a test keeps this list in step with every key the server can send.
 */
export const REPORT_MESSAGES: Readonly<Record<string, MessageDescriptor>> = {
  'import.airtable.report.exact': msg({
    id: 'import.airtable.report.exact',
    message: 'Came across as it was.',
  }),
  'import.airtable.report.records': msg({
    id: 'import.airtable.report.records',
    message: '{count, plural, one {# record came across.} other {# records came across.}}',
  }),
  'import.airtable.report.renamed': msg({
    id: 'import.airtable.report.renamed',
    message: 'Renamed from “{from}”, since names here have to be different.',
  }),
  'import.airtable.report.primaryText': msg({
    id: 'import.airtable.report.primaryText',
    message: 'Holds text here, since a field of its type can’t name records.',
  }),
  'import.airtable.report.primaryLines': msg({
    id: 'import.airtable.report.primaryLines',
    message: 'Holds a single line here, since it names each record.  Line breaks became spaces.',
  }),
  'import.airtable.report.richText': msg({
    id: 'import.airtable.report.richText',
    message: 'Holds plain text here, since it names each record.  Its formatting was left out.',
  }),
  'import.airtable.report.currencyUnknown': msg({
    id: 'import.airtable.report.currencyUnknown',
    message: 'A number here, since Riosoma can’t tell which currency “{symbol}” is.',
  }),
  'import.airtable.report.checkboxIcon': msg({
    id: 'import.airtable.report.checkboxIcon',
    message: 'Shows a check mark here instead of its own icon.',
  }),
  'import.airtable.report.timeFixed': msg({
    id: 'import.airtable.report.timeFixed',
    message: 'A date field holding the times from Airtable.  New records don’t fill it in.',
  }),
  'import.airtable.report.tooManyChoices': msg({
    id: 'import.airtable.report.tooManyChoices',
    message: 'Text here, since it had more than {max} options.',
  }),
  'import.airtable.report.syncSource': msg({
    id: 'import.airtable.report.syncSource',
    message: 'A single select naming each record’s source.  Syncing stays in Airtable.',
  }),
  'import.airtable.report.peopleFixed': msg({
    id: 'import.airtable.report.peopleFixed',
    message: 'Holds who it was in Airtable.  New records don’t fill it in.',
  }),
  'import.airtable.report.peopleText': msg({
    id: 'import.airtable.report.peopleText',
    message:
      '{count, plural, =0 {Kept as email addresses.} one {Kept as email addresses, since # person in it isn’t a member here.} other {Kept as email addresses, since # people in it aren’t members here.}}',
  }),
  'import.airtable.report.linkMissing': msg({
    id: 'import.airtable.report.linkMissing',
    message: 'Left out, since it links to a table that didn’t come across.',
  }),
  'import.airtable.report.linkRefused': msg({
    id: 'import.airtable.report.linkRefused',
    message: 'Left out, since the link couldn’t be made here.',
  }),
  'import.airtable.report.linkBothWays': msg({
    id: 'import.airtable.report.linkBothWays',
    message: 'Links here show on both tables, so {table} got a field named “{field}”.',
  }),
  'import.airtable.report.linksDropped': msg({
    id: 'import.airtable.report.linksDropped',
    message:
      '{count, plural, one {# link pointed to a record that didn’t come across.} other {# links pointed to records that didn’t come across.}}',
  }),
  'import.airtable.report.linkSeveral': msg({
    id: 'import.airtable.report.linkSeveral',
    message: 'Allows several records here, since some records linked to more than one.',
  }),
  'import.airtable.report.barcode': msg({
    id: 'import.airtable.report.barcode',
    message: 'Holds each barcode’s text.  The barcode type was left out.',
  }),
  'import.airtable.report.button': msg({
    id: 'import.airtable.report.button',
    message: 'A URL field holding each button’s link.  Buttons that ran scripts have none.',
  }),
  'import.airtable.report.generatedText': msg({
    id: 'import.airtable.report.generatedText',
    message: 'Holds the text Airtable generated.  It won’t update here.',
  }),
  'import.airtable.report.typeUnsupported': msg({
    id: 'import.airtable.report.typeUnsupported',
    message: 'Left out, since Riosoma has no field like this ({type}).',
  }),
  'import.airtable.report.tooManyFields': msg({
    id: 'import.airtable.report.tooManyFields',
    message: 'Left out, since a table here holds at most {max} fields.',
  }),
  'import.airtable.report.autoNumberFixed': msg({
    id: 'import.airtable.report.autoNumberFixed',
    message: 'Kept as numbers, since Airtable’s had gaps.  New records aren’t numbered.',
  }),
  'import.airtable.report.formulaTranslated': msg({
    id: 'import.airtable.report.formulaTranslated',
    message: 'The formula works here, with the same results.',
  }),
  'import.airtable.report.formulaDiffers': msg({
    id: 'import.airtable.report.formulaDiffers',
    message:
      'The formula works here, but {count} of the {checked} records checked came out differently, like “{here}” instead of “{airtable}”.',
  }),
  'import.airtable.report.formulaText': msg({
    id: 'import.airtable.report.formulaText',
    message: 'Kept as text, since the formula doesn’t work here.',
  }),
  'import.airtable.report.formulaFunctions': msg({
    id: 'import.airtable.report.formulaFunctions',
    message: 'Kept as text, since Riosoma doesn’t have {functions}.',
  }),
  'import.airtable.report.formulaFields': msg({
    id: 'import.airtable.report.formulaFields',
    message: 'Kept as text, since it reads fields that didn’t come across.',
  }),
  'import.airtable.report.formulaBroken': msg({
    id: 'import.airtable.report.formulaBroken',
    message: 'Kept as text, since the formula had an error in Airtable.',
  }),
  'import.airtable.report.formulaUnread': msg({
    id: 'import.airtable.report.formulaUnread',
    message: 'Kept as text, since Riosoma couldn’t read the formula.',
  }),
  'import.airtable.report.relationText': msg({
    id: 'import.airtable.report.relationText',
    message: 'Kept as text, since what it reads didn’t come across.',
  }),
  'import.airtable.report.countFixed': msg({
    id: 'import.airtable.report.countFixed',
    message: 'Kept as numbers, since the count couldn’t be set up here.',
  }),
  'import.airtable.report.rollupMatched': msg({
    id: 'import.airtable.report.rollupMatched',
    message: 'Airtable doesn’t share rollup formulas, so this one uses {fn}, which gives the same values.',
  }),
  'import.airtable.report.rollupGuessed': msg({
    id: 'import.airtable.report.rollupGuessed',
    message:
      'Airtable doesn’t share rollup formulas, and there were no values to compare, so this one uses {fn}.  Check that it’s right.',
  }),
  'import.airtable.report.rollupUnknown': msg({
    id: 'import.airtable.report.rollupUnknown',
    message: 'Kept as text, since none of Riosoma’s rollups gives the same values.',
  }),
  'import.airtable.report.valuesDropped': msg({
    id: 'import.airtable.report.valuesDropped',
    message:
      '{count, plural, one {# value didn’t fit and was left empty, like “{example}”.} other {# values didn’t fit and were left empty, like “{example}”.}}',
  }),
  'import.airtable.report.filesTooLarge': msg({
    id: 'import.airtable.report.filesTooLarge',
    message:
      '{count, plural, one {# file was larger than {megabytes} MB and was left out.} other {# files were larger than {megabytes} MB and were left out.}}',
  }),
  'import.airtable.report.filesBlocked': msg({
    id: 'import.airtable.report.filesBlocked',
    message:
      '{count, plural, one {# file came from an address Riosoma won’t fetch from, and was left out.} other {# files came from addresses Riosoma won’t fetch from, and were left out.}}',
  }),
  'import.airtable.report.filesFailed': msg({
    id: 'import.airtable.report.filesFailed',
    message:
      '{count, plural, one {# file couldn’t be downloaded and was left out.} other {# files couldn’t be downloaded and were left out.}}',
  }),
  'import.airtable.report.filesBudget': msg({
    id: 'import.airtable.report.filesBudget',
    message:
      '{count, plural, one {# file was left out once the import had brought {gigabytes} GB of files.} other {# files were left out once the import had brought {gigabytes} GB of files.}}',
  }),
  'import.airtable.report.viewUnsupported': msg({
    id: 'import.airtable.report.viewUnsupported',
    message: 'Left out, since Riosoma has no view like this ({type}).',
  }),
  'import.airtable.report.viewFields': msg({
    id: 'import.airtable.report.viewFields',
    message: 'Shows the first few fields, since Airtable shares which fields a view shows only for grids.',
  }),
  'import.airtable.report.viewStack': msg({
    id: 'import.airtable.report.viewStack',
    message: 'Stacks by {field}, since Airtable doesn’t share a kanban’s stacks.',
  }),
  'import.airtable.report.viewNoStack': msg({
    id: 'import.airtable.report.viewNoStack',
    message:
      'Needs a field to stack by, since Airtable doesn’t share a kanban’s stacks and no field here fits.',
  }),
  'import.airtable.report.viewCover': msg({
    id: 'import.airtable.report.viewCover',
    message: 'Uses {field} for card covers, since Airtable doesn’t share them.',
  }),
  'import.airtable.report.viewDates': msg({
    id: 'import.airtable.report.viewDates',
    message: 'Uses {field} for dates, since Airtable doesn’t share which field a view uses.',
  }),
  'import.airtable.report.viewNoDates': msg({
    id: 'import.airtable.report.viewNoDates',
    message: 'Needs a date field, since Airtable doesn’t share which one a view uses and none here fits.',
  }),
  'import.airtable.report.viewQuestions': msg({
    id: 'import.airtable.report.viewQuestions',
    message: 'Asks about every field it can, since Airtable doesn’t share a form’s questions.',
  }),
  'import.airtable.report.viewFilter': msg({
    id: 'import.airtable.report.viewFilter',
    message:
      'Its filter was worked out from the records it shows, since Airtable doesn’t share filters.  Check it.',
  }),
  'import.airtable.report.viewFilterUnknown': msg({
    id: 'import.airtable.report.viewFilterUnknown',
    message:
      'Its filter was left out, since Airtable doesn’t share filters and no single condition picks the records it shows.',
  }),
  'import.airtable.report.viewSort': msg({
    id: 'import.airtable.report.viewSort',
    message: 'Its sort was worked out from the order of its records, since Airtable doesn’t share sorts.',
  }),
  'import.airtable.report.viewSortUnknown': msg({
    id: 'import.airtable.report.viewSortUnknown',
    message:
      'Its sort was left out, since Airtable doesn’t share sorts and no field here puts its records in order.',
  }),
  'import.airtable.report.viewTooLarge': msg({
    id: 'import.airtable.report.viewTooLarge',
    message:
      'Its filter and sort were left out, since working them out means reading every view, and the table has more than {max} records.',
  }),
  'import.airtable.report.viewAdded': msg({
    id: 'import.airtable.report.viewAdded',
    message: 'Got a grid view named {view}, since every table here needs one.',
  }),
  'import.airtable.report.viewPlain': msg({
    id: 'import.airtable.report.viewPlain',
    message: 'Came across without its settings, since they didn’t fit here.',
  }),
  'import.airtable.report.viewRefused': msg({
    id: 'import.airtable.report.viewRefused',
    message: 'Left out, since it couldn’t be made here.',
  }),
  'import.airtable.report.viewSettings': msg({
    id: 'import.airtable.report.viewSettings',
    message:
      'Views’ grouping, colors, column widths, and row heights were left out, since Airtable doesn’t share them.',
  }),
  'import.airtable.report.notShared': msg({
    id: 'import.airtable.report.notShared',
    message: 'Record comments, revision history, automations, interfaces, and extensions stay in Airtable.',
  }),
};

/** Rollup functions by name, the way the field editor names them. */
export const ROLLUP_NAMES: Readonly<Record<RollupFunction, MessageDescriptor>> = {
  sum: msg({ id: 'field.rollup.fn.sum', message: 'Sum' }),
  average: msg({ id: 'field.rollup.fn.average', message: 'Average' }),
  min: msg({ id: 'field.rollup.fn.min', message: 'Minimum' }),
  max: msg({ id: 'field.rollup.fn.max', message: 'Maximum' }),
  count: msg({ id: 'field.rollup.fn.count', message: 'Count of values' }),
  countAll: msg({ id: 'field.rollup.fn.countAll', message: 'Count of all' }),
  countUnique: msg({ id: 'field.rollup.fn.countUnique', message: 'Count of unique values' }),
  and: msg({ id: 'field.rollup.fn.and', message: 'All true' }),
  or: msg({ id: 'field.rollup.fn.or', message: 'Any true' }),
  concatenate: msg({ id: 'field.rollup.fn.concatenate', message: 'Joined text' }),
  arrayUnique: msg({ id: 'field.rollup.fn.arrayUnique', message: 'Unique values' }),
  earliest: msg({ id: 'field.rollup.fn.earliest', message: 'Earliest' }),
  latest: msg({ id: 'field.rollup.fn.latest', message: 'Latest' }),
};

/** What came across, in numbers. */
export const SUMMARY = msg({
  id: 'import.airtable.report.summary',
  message:
    '{tables, plural, one {# table} other {# tables}}, {records, plural, one {# record} other {# records}}, {views, plural, one {# view} other {# views}}, and {files, plural, one {# file} other {# files}} came across.',
});

/** A line the web app doesn't know yet still reads as something. */
export const UNKNOWN_LINE = msg({
  id: 'import.airtable.report.unknown',
  message: 'Came across with a change.',
});
