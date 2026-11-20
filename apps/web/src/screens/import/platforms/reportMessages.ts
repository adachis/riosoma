import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

/**
 * What each line of a NocoDB, Baserow, Grist, Teable, or SeaTable import's report says.  The server
 * sends a key and its parameters, the tool's name fills `{product}`, and a test keeps this list in
 * step with every key the server can send.
 */
export const PLATFORM_REPORT_MESSAGES: Readonly<Record<string, MessageDescriptor>> = {
  'import.platform.report.taskDependenciesPremium': msg({
    id: 'import.platform.report.taskDependenciesPremium',
    message:
      'Some dependency links were left out because the API requires a higher Asana plan.  Accessible tasks and dependency pages were imported.',
  }),
  'import.platform.report.taskLinksDeferred': msg({
    id: 'import.platform.report.taskLinksDeferred',
    message:
      'Task link fields are created for referenced tables during the import.  Empty relations do not create fields.',
  }),
  'import.platform.report.taskLinkCapacity': msg({
    id: 'import.platform.report.taskLinkCapacity',
    message:
      'This selection could exceed the limit of {max} fields per table, including inverse link fields.  Source fields take priority, and links beyond the limit are reported as omissions.',
  }),
  'import.platform.report.taskExtraFields': msg({
    id: 'import.platform.report.taskExtraFields',
    message:
      'Retains all custom field API values as structured data, including fields found only on subtasks or other project memberships.  Fields defined on selected lists or projects also get their own columns.',
  }),
  'import.platform.report.taskNumberFormat': msg({
    id: 'import.platform.report.taskNumberFormat',
    message: 'Keeps the numeric value.  The source number formatting remains in {product}.',
  }),
  'import.platform.report.taskChoiceText': msg({
    id: 'import.platform.report.taskChoiceText',
    message: 'Keeps the choice names as text.  Source choice behavior remains in {product}.',
  }),
  'import.platform.report.taskUnavailable': msg({
    id: 'import.platform.report.taskUnavailable',
    message: 'A task was deleted or became inaccessible after it was listed and could not be imported.',
  }),
  'import.platform.report.taskLinksOutside': msg({
    id: 'import.platform.report.taskLinksOutside',
    message:
      '{count, plural, one {# task reference could not become a link outside the selected tables.} other {# task references could not become links outside the selected tables.}}',
  }),
  'import.platform.report.taskDate': msg({
    id: 'import.platform.report.taskDate',
    message:
      'Dates retain the API timestamps in UTC.  Date-only values may display differently from the source time zone.',
  }),
  'import.platform.report.taskPeople': msg({
    id: 'import.platform.report.taskPeople',
    message:
      'People retain the names and email addresses the API exposes.  Teams and people without a matching member remain text.',
  }),
  'import.platform.report.taskStructured': msg({
    id: 'import.platform.report.taskStructured',
    message:
      'The API value remains structured data.  Source formatting and references to projects, goals, or portfolios remain snapshots.',
  }),
  'import.platform.report.taskSnapshot': msg({
    id: 'import.platform.report.taskSnapshot',
    message: 'Keeps the API values.  Calculations, progress tracking, and voting remain in {product}.',
  }),
  'import.platform.report.taskUnknown': msg({
    id: 'import.platform.report.taskUnknown',
    message: 'Keeps the API value as structured data for this field type ({type}).',
  }),
  'import.platform.report.taskHierarchy': msg({
    id: 'import.platform.report.taskHierarchy',
    message:
      'Subtasks become records in their selected parent list or project, with parent links.  Nested subtasks are included.',
  }),
  'import.platform.report.taskScope': msg({
    id: 'import.platform.report.taskScope',
    message:
      'Task links connect records in the selected tables.  References to tasks outside the selection, deleted tasks, and inaccessible tasks cannot become links.',
  }),
  'import.platform.report.taskMultiHome': msg({
    id: 'import.platform.report.taskMultiHome',
    message:
      'A task in several selected lists or projects becomes a separate record in each table.  Links connect its selected occurrences.  Later edits are independent.',
  }),
  'import.platform.report.taskViews': msg({
    id: 'import.platform.report.taskViews',
    message:
      'Keeps exposed grouping where the fields match.  Source filters, sorting, and layout settings remain in {product}.',
  }),
  'import.platform.report.taskTags': msg({
    id: 'import.platform.report.taskTags',
    message: 'Tags retain their names as text.  Tag colors and membership behavior remain in {product}.',
  }),

  'import.platform.report.selectText': msg({
    id: 'import.platform.report.selectText',
    message: 'Kept dropdown values as text because some values cannot be represented as select choices.',
  }),
  'import.platform.report.selectExpanded': msg({
    id: 'import.platform.report.selectExpanded',
    message: 'Added choices for values found in the sheet that were outside the dropdown options.',
  }),
  'import.platform.report.datetimeText': msg({
    id: 'import.platform.report.datetimeText',
    message:
      'Kept project dates and times as text because some values have no time zone or cannot be converted.',
  }),
  'import.platform.report.cellLinksFixed': msg({
    id: 'import.platform.report.cellLinksFixed',
    message: 'Kept the linked cell values.  Incoming and outgoing cell links stay in Smartsheet.',
  }),
  'import.platform.report.crossSheetFixed': msg({
    id: 'import.platform.report.crossSheetFixed',
    message:
      'Kept values from cross-sheet references.  Their connections to other sheets stay in Smartsheet.',
  }),
  'import.platform.report.autoNumberMask': msg({
    id: 'import.platform.report.autoNumberMask',
    message:
      'Kept the formatted auto-numbers as text.  Their prefix, suffix, and padding stay in Smartsheet, and new records are not numbered.',
  }),
  'import.platform.report.textNumber': msg({
    id: 'import.platform.report.textNumber',
    message: 'Text and numbers can share this column in Smartsheet.  Its values are preserved as text here.',
  }),
  'import.platform.report.symbolSelect': msg({
    id: 'import.platform.report.symbolSelect',
    message: 'Symbols become select choices by name and color.  Their drawings stay in Smartsheet.',
  }),
  'import.platform.report.durationCalendar': msg({
    id: 'import.platform.report.durationCalendar',
    message:
      'Durations become seconds using the sheet’s workday and workweek.  Working calendars and automatic scheduling stay in Smartsheet.',
  }),
  'import.platform.report.durationText': msg({
    id: 'import.platform.report.durationText',
    message: 'Kept durations as text because some values use a format Riosoma cannot convert.',
  }),
  'import.platform.report.predecessorSchedule': msg({
    id: 'import.platform.report.predecessorSchedule',
    message:
      'Predecessors become links to records in this table.  Dependency types and lag are kept in a companion text field.  Automatic scheduling stays in Smartsheet.',
  }),
  'import.platform.report.unknownColumn': msg({
    id: 'import.platform.report.unknownColumn',
    message: 'Kept values as text because Riosoma has no matching column type ({type}).',
  }),
  'import.platform.report.projectViews': msg({
    id: 'import.platform.report.projectViews',
    message: 'Kept a grid view and shared filters.  Gantt, card, and calendar settings stay in Smartsheet.',
  }),
  'import.platform.report.sheetAttachments': msg({
    id: 'import.platform.report.sheetAttachments',
    message:
      'Sheet, comment, and proof attachments are kept in a separate table with their source IDs.  External attachment links cannot be downloaded as files.',
  }),
  'import.platform.report.checkboxBlank': msg({
    id: 'import.platform.report.checkboxBlank',
    message: 'Untouched checkboxes become unchecked here.',
  }),
  'import.platform.report.exact': msg({
    id: 'import.platform.report.exact',
    message: 'Came across as it was.',
  }),
  'import.platform.report.records': msg({
    id: 'import.platform.report.records',
    message: '{count, plural, one {# record came across.} other {# records came across.}}',
  }),
  'import.platform.report.renamed': msg({
    id: 'import.platform.report.renamed',
    message: 'Renamed from “{from}”, since names here have to be different.',
  }),
  'import.platform.report.primaryText': msg({
    id: 'import.platform.report.primaryText',
    message: 'Holds text here, since it names each record and a field of its type can’t.',
  }),
  'import.platform.report.tooManyFields': msg({
    id: 'import.platform.report.tooManyFields',
    message: 'Left out, since a table here holds at most {max} fields.',
  }),
  'import.platform.report.typeUnsupported': msg({
    id: 'import.platform.report.typeUnsupported',
    message: 'Left out, since Riosoma has no field like this ({type}).',
  }),
  'import.platform.report.currencyUnknown': msg({
    id: 'import.platform.report.currencyUnknown',
    message: 'A number here, since Riosoma can’t tell which currency “{symbol}” is.',
  }),
  'import.platform.report.numberAffixes': msg({
    id: 'import.platform.report.numberAffixes',
    message: 'A number here.  The text {product} showed around it, “{prefix}” and “{suffix}”, was left out.',
  }),
  'import.platform.report.ratingMax': msg({
    id: 'import.platform.report.ratingMax',
    message: 'Rates up to {max} here, the most a rating can.',
  }),
  'import.platform.report.ratingIcon': msg({
    id: 'import.platform.report.ratingIcon',
    message: 'Rates with stars here, since Riosoma has no icon like {product}’s “{icon}”.',
  }),
  'import.platform.report.numberShowAs': msg({
    id: 'import.platform.report.numberShowAs',
    message: 'Shows plain numbers here.  The bar or ring {product} drew in each cell was left out.',
  }),
  'import.platform.report.checkboxIcon': msg({
    id: 'import.platform.report.checkboxIcon',
    message: 'Shows a check mark here instead of its own look.',
  }),
  'import.platform.report.timeFixed': msg({
    id: 'import.platform.report.timeFixed',
    message: 'A date field holding the times from {product}.  New records don’t fill it in.',
  }),
  'import.platform.report.timeText': msg({
    id: 'import.platform.report.timeText',
    message: 'Holds each time of day as text, since Riosoma has no field for a time without a date.',
  }),
  'import.platform.report.durationDays': msg({
    id: 'import.platform.report.durationDays',
    message: 'Shows hours here, since durations here don’t count days.',
  }),
  'import.platform.report.peopleFixed': msg({
    id: 'import.platform.report.peopleFixed',
    message: 'Holds who it was in {product}.  New records don’t fill it in.',
  }),
  'import.platform.report.peopleText': msg({
    id: 'import.platform.report.peopleText',
    message:
      '{count, plural, =0 {Kept as names and email addresses.} one {Kept as names and email addresses, since # person in it isn’t a member here.} other {Kept as names and email addresses, since # people in it aren’t members here.}}',
  }),
  'import.platform.report.aiGenerated': msg({
    id: 'import.platform.report.aiGenerated',
    message: 'Holds the values {product} wrote.  The generation that filled them stays in {product}.',
  }),
  'import.platform.report.departmentText': msg({
    id: 'import.platform.report.departmentText',
    message:
      'Holds each department as the ID {product} gave it, since the names it shows them by stay there.',
  }),
  'import.platform.report.placeText': msg({
    id: 'import.platform.report.placeText',
    message: 'Holds the place’s text, since it names a country or region rather than a point on a map.',
  }),
  'import.platform.report.placeDetails': msg({
    id: 'import.platform.report.placeDetails',
    message: 'Keeps the place’s name, address, and provider IDs together in the location label.',
  }),
  'import.platform.report.signatureLeft': msg({
    id: 'import.platform.report.signatureLeft',
    message: 'Left out, since a signature drawn in {product} can’t be signed again here.',
  }),
  'import.platform.report.autoNumberText': msg({
    id: 'import.platform.report.autoNumberText',
    message:
      'Holds each number as text, since {product} writes “{prefix}” in front of it.  New records aren’t numbered.',
  }),
  'import.platform.report.autoNumberDateText': msg({
    id: 'import.platform.report.autoNumberDateText',
    message: 'Holds each number as text, since {product} adds a date prefix.  New records aren’t numbered.',
  }),
  'import.platform.report.codeText': msg({
    id: 'import.platform.report.codeText',
    message: 'Holds each code’s text.  Drawing it as a barcode or QR code was left out.',
  }),
  'import.platform.report.uuidText': msg({
    id: 'import.platform.report.uuidText',
    message: 'Holds each record’s ID from {product} as text.  New records don’t get one.',
  }),
  'import.platform.report.anyText': msg({
    id: 'import.platform.report.anyText',
    message: 'Holds its values as text, since the column could hold anything.',
  }),
  'import.platform.report.password': msg({
    id: 'import.platform.report.password',
    message: 'Left out, since {product} never shares passwords.',
  }),
  'import.platform.report.button': msg({
    id: 'import.platform.report.button',
    message: 'Left out, since buttons stay in {product}.',
  }),
  'import.platform.report.triggerFormula': msg({
    id: 'import.platform.report.triggerFormula',
    message: 'Holds its values.  The formula that filled them in stays in {product}.',
  }),
  'import.platform.report.summaryTable': msg({
    id: 'import.platform.report.summaryTable',
    message: 'A summary table in {product}.  Its values came across, and they won’t update here.',
  }),
  'import.platform.report.linkLabels': msg({
    id: 'import.platform.report.linkLabels',
    message: 'Holds each link’s address.  The text shown for it was left out.',
  }),
  'import.platform.report.linkMissing': msg({
    id: 'import.platform.report.linkMissing',
    message: 'Left out, since it links to a table that didn’t come across.',
  }),
  'import.platform.report.linkTargetText': msg({
    id: 'import.platform.report.linkTargetText',
    message: 'Kept as source IDs or displayed text, since the linked table is unavailable.',
  }),
  'import.platform.report.rangePlain': msg({
    id: 'import.platform.report.rangePlain',
    message: 'The dates became a date range.  Scheduling and week rules stay in {product}.',
  }),
  'import.platform.report.linkRefused': msg({
    id: 'import.platform.report.linkRefused',
    message: 'Left out, since the link couldn’t be made here.',
  }),
  'import.platform.report.linkBothWays': msg({
    id: 'import.platform.report.linkBothWays',
    message: 'Links here show on both tables, so {table} got a field named “{field}”.',
  }),
  'import.platform.report.linksDropped': msg({
    id: 'import.platform.report.linksDropped',
    message:
      '{count, plural, one {# link pointed to a record that didn’t come across.} other {# links pointed to records that didn’t come across.}}',
  }),
  'import.platform.report.linksLimited': msg({
    id: 'import.platform.report.linksLimited',
    message:
      '{count, plural, one {# link was left out because a cell can hold at most {limit} links.} other {# links were left out because a cell can hold at most {limit} links.}}',
  }),
  'import.platform.report.filesLimited': msg({
    id: 'import.platform.report.filesLimited',
    message:
      '{count, plural, one {# file was left out because a cell can hold at most {limit} files.} other {# files were left out because a cell can hold at most {limit} files.}}',
  }),
  'import.platform.report.linksUnread': msg({
    id: 'import.platform.report.linksUnread',
    message: 'Its links were left out, since {product} didn’t say which records they were.',
  }),
  'import.platform.report.linkSeveral': msg({
    id: 'import.platform.report.linkSeveral',
    message: 'Allows several records here, since some records linked to more than one.',
  }),
  'import.platform.report.formulaLinks': msg({
    id: 'import.platform.report.formulaLinks',
    message: 'Holds the links its formula picked.  The formula stays in {product}.',
  }),
  'import.platform.report.formulaTranslated': msg({
    id: 'import.platform.report.formulaTranslated',
    message: 'The formula works here, with the same results.',
  }),
  'import.platform.report.formulaRelation': msg({
    id: 'import.platform.report.formulaRelation',
    message:
      'Became {type, select, rollup {a rollup} count {a count} other {a lookup}} here, which gives the same results as the formula.',
  }),
  'import.platform.report.formulaDiffers': msg({
    id: 'import.platform.report.formulaDiffers',
    message:
      'Works here, but {count} of the {checked} records checked came out differently, like “{here}” instead of “{theirs}”.',
  }),
  'import.platform.report.formulaText': msg({
    id: 'import.platform.report.formulaText',
    message: 'Kept its values, since the formula doesn’t work here.',
  }),
  'import.platform.report.formulaFunctions': msg({
    id: 'import.platform.report.formulaFunctions',
    message: 'Kept its values, since Riosoma doesn’t have {functions}.',
  }),
  'import.platform.report.formulaFields': msg({
    id: 'import.platform.report.formulaFields',
    message: 'Kept its values, since it reads fields that didn’t come across.',
  }),
  'import.platform.report.formulaBroken': msg({
    id: 'import.platform.report.formulaBroken',
    message: 'Kept its values, since the formula had an error in {product}.',
  }),
  'import.platform.report.formulaUnread': msg({
    id: 'import.platform.report.formulaUnread',
    message: 'Kept its values, since Riosoma couldn’t translate the formula.',
  }),
  'import.platform.report.relationText': msg({
    id: 'import.platform.report.relationText',
    message: 'Kept its values, since what it reads didn’t come across.',
  }),
  'import.platform.report.conditionalRead': msg({
    id: 'import.platform.report.conditionalRead',
    message: 'Reads every record it links to here, since the filter {product} put on it stays there.',
  }),
  'import.platform.report.linkFormulaKept': msg({
    id: 'import.platform.report.linkFormulaKept',
    message:
      'Kept its values, since Riosoma has no field that picks one linked record the way {product}’s {kind} does.',
  }),
  'import.platform.report.countFixed': msg({
    id: 'import.platform.report.countFixed',
    message: 'Kept as numbers, since the count couldn’t be set up here.',
  }),
  'import.platform.report.rollupUnknown': msg({
    id: 'import.platform.report.rollupUnknown',
    message: 'Kept its values, since Riosoma has no rollup like {product}’s “{fn}”.',
  }),
  'import.platform.report.autoNumberFixed': msg({
    id: 'import.platform.report.autoNumberFixed',
    message: 'Kept as numbers, since {product}’s had gaps.  New records aren’t numbered.',
  }),
  'import.platform.report.valuesDropped': msg({
    id: 'import.platform.report.valuesDropped',
    message:
      '{count, plural, one {# value didn’t fit and was left empty, like “{example}”.} other {# values didn’t fit and were left empty, like “{example}”.}}',
  }),
  'import.platform.report.filesTooLarge': msg({
    id: 'import.platform.report.filesTooLarge',
    message:
      '{count, plural, one {# file was larger than {megabytes} MB and was left out.} other {# files were larger than {megabytes} MB and were left out.}}',
  }),
  'import.platform.report.filesBlocked': msg({
    id: 'import.platform.report.filesBlocked',
    message:
      '{count, plural, one {# file came from an address Riosoma won’t fetch from, and was left out.} other {# files came from addresses Riosoma won’t fetch from, and were left out.}}',
  }),
  'import.platform.report.filesFailed': msg({
    id: 'import.platform.report.filesFailed',
    message:
      '{count, plural, one {# file couldn’t be downloaded and was left out.} other {# files couldn’t be downloaded and were left out.}}',
  }),
  'import.platform.report.filesBudget': msg({
    id: 'import.platform.report.filesBudget',
    message:
      '{count, plural, one {# file was left out once the import had brought {gigabytes} GB of files.} other {# files were left out once the import had brought {gigabytes} GB of files.}}',
  }),
  'import.platform.report.viewUnsupported': msg({
    id: 'import.platform.report.viewUnsupported',
    message: 'Left out, since Riosoma has no view like this ({type}).',
  }),
  'import.platform.report.viewAdded': msg({
    id: 'import.platform.report.viewAdded',
    message: 'Got a grid view named {view}, since every table here needs one.',
  }),
  'import.platform.report.viewsNeedSignIn': msg({
    id: 'import.platform.report.viewsNeedSignIn',
    message:
      'Views were left out, since {product} shares them only with people who sign in.  Import again with your email address and password to bring them too.',
  }),
  'import.platform.report.viewFilterPartial': msg({
    id: 'import.platform.report.viewFilterPartial',
    message:
      '{count, plural, one {# of its filter’s conditions has no match here and was left out.} other {# of its filter’s conditions have no match here and were left out.}}',
  }),
  'import.platform.report.viewFilterDropped': msg({
    id: 'import.platform.report.viewFilterDropped',
    message: 'Its filter was left out, since none of its conditions has a match here.',
  }),
  'import.platform.report.viewSortPartial': msg({
    id: 'import.platform.report.viewSortPartial',
    message:
      '{count, plural, one {# of its sorts was left out, since its field didn’t come across.} other {# of its sorts were left out, since their fields didn’t come across.}}',
  }),
  'import.platform.report.viewGroup': msg({
    id: 'import.platform.report.viewGroup',
    message: 'Stacks by {field}, since the field it stacked by didn’t come across.',
  }),
  'import.platform.report.viewNoGroup': msg({
    id: 'import.platform.report.viewNoGroup',
    message: 'Needs a field to stack by, since none here fits.',
  }),
  'import.platform.report.viewGroupDropped': msg({
    id: 'import.platform.report.viewGroupDropped',
    message: 'Its grouping was left out, since views like this here don’t group.',
  }),
  'import.platform.report.viewColors': msg({
    id: 'import.platform.report.viewColors',
    message: 'Its colors were left out.  Conditional colors can color records here.',
  }),
  'import.platform.report.viewNoCover': msg({
    id: 'import.platform.report.viewNoCover',
    message: 'Shows cards without covers, since the field it used didn’t come across.',
  }),
  'import.platform.report.viewDates': msg({
    id: 'import.platform.report.viewDates',
    message: 'Uses {field} for dates, since the field it used didn’t come across.',
  }),
  'import.platform.report.viewNoDates': msg({
    id: 'import.platform.report.viewNoDates',
    message: 'Needs a date field, since none here fits.',
  }),
  'import.platform.report.viewNoPlace': msg({
    id: 'import.platform.report.viewNoPlace',
    message: 'Needs a location field, since none here fits.',
  }),
  'import.platform.report.viewLinked': msg({
    id: 'import.platform.report.viewLinked',
    message: 'Shows every record, since following another widget’s selection stays in {product}.',
  }),
  'import.platform.report.viewCardList': msg({
    id: 'import.platform.report.viewCardList',
    message: 'Shows every record’s card, where {product} showed one at a time.',
  }),
  'import.platform.report.viewPlain': msg({
    id: 'import.platform.report.viewPlain',
    message: 'Came across without its settings, since they didn’t fit here.',
  }),
  'import.platform.report.viewRefused': msg({
    id: 'import.platform.report.viewRefused',
    message: 'Left out, since it couldn’t be made here.',
  }),
  'import.platform.report.notShared': msg({
    id: 'import.platform.report.notShared',
    message:
      'Comments, revision history, automations, webhooks, row colors, and sharing settings stay in {product}.',
  }),
  'import.platform.report.richTextPlain': msg({
    id: 'import.platform.report.richTextPlain',
    message: 'Text came across without its inline formatting and mentions.',
  }),
  'import.platform.report.dateRangeText': msg({
    id: 'import.platform.report.dateRangeText',
    message: 'Dates and ranges came across as text to preserve both endpoints and time zones.',
  }),
  'import.platform.report.statusGroups': msg({
    id: 'import.platform.report.statusGroups',
    message: 'Status options became a single-select field.  The groups of status options stay in Notion.',
  }),
  'import.platform.report.uniqueIdFixed': msg({
    id: 'import.platform.report.uniqueIdFixed',
    message: 'Unique IDs came across as text.  New records do not continue the source’s numbering.',
  }),
  'import.platform.report.valueSnapshot': msg({
    id: 'import.platform.report.valueSnapshot',
    message: 'The values came across as text.  The source’s behavior stays in {product}.',
  }),
  'import.platform.report.pageBody': msg({
    id: 'import.platform.report.pageBody',
    message:
      'Page body content is separate from table data.  It came across in a long text field, with nested text and media references.  Page layout and interactive blocks stay in Notion.',
  }),
  'import.platform.report.archivedExcluded': msg({
    id: 'import.platform.report.archivedExcluded',
    message: 'Archived and deleted tables and records were left out.',
  }),
  'import.platform.report.relatedIncluded': msg({
    id: 'import.platform.report.relatedIncluded',
    message: 'Accessible related tables were included so links and computed fields can work.',
  }),
  'import.platform.report.linkLabel': msg({
    id: 'import.platform.report.linkLabel',
    message: 'The web address came across.  Its display label stays in monday.com.',
  }),
  'import.platform.report.linkSeveralBoards': msg({
    id: 'import.platform.report.linkSeveralBoards',
    message:
      'Connections to several boards have a separate link field for each accessible target table, and their original display values remain as text.',
  }),
  'import.platform.report.dependencyLinks': msg({
    id: 'import.platform.report.dependencyLinks',
    message: 'Dependencies became links.  Scheduling behavior and dependency types stay in monday.com.',
  }),
  'import.platform.report.trackingFixed': msg({
    id: 'import.platform.report.trackingFixed',
    message: 'Tracked time became a duration.  Timer history and running timers stay in monday.com.',
  }),
  'import.platform.report.apiValueUnavailable': msg({
    id: 'import.platform.report.apiValueUnavailable',
    message: 'Left out because {product} does not expose these calculated values through its API.',
  }),
  'import.platform.report.subitemsTable': msg({
    id: 'import.platform.report.subitemsTable',
    message: 'Subitems became a linked child table, with links to their parent items.',
  }),
  'import.platform.report.tooManyChoices': msg({
    id: 'import.platform.report.tooManyChoices',
    message: 'Select values came across as text because this field has more than {max} choices.',
  }),
};

/** A line the web app doesn't know yet still reads as something. */
export const PLATFORM_UNKNOWN_LINE = msg({
  id: 'import.platform.report.unknown',
  message: 'Came across with a change.',
});
