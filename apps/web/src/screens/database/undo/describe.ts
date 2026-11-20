import { msg, plural } from '@lingui/core/macro';
import type { ActionSummary } from '../../../data/types';
import type { Translate } from '../../../grid/cells/describe';

/**
 * An action in the undo history as a person would put it: "Changed 3 cells in Tasks", "Deleted
 * the Status field", "Added 12 records to Tasks".  Names are the ones things had at the time.
 */
export function describeAction(summary: ActionSummary, t: Translate): string {
  const { count, name, to } = summary;
  const table = summary.table ?? '';
  switch (summary.kind) {
    case 'database.create':
      return t(msg({ id: 'undo.action.databaseCreated', message: `Created the ${name} database` }));
    case 'namedFunction.create':
      return t(msg({ id: 'undo.action.namedFunctionAdded', message: `Added the ${name} function` }));
    case 'namedFunction.update':
      return t(msg({ id: 'undo.action.namedFunctionChanged', message: `Changed the ${name} function` }));
    case 'namedFunction.delete':
      return t(msg({ id: 'undo.action.namedFunctionDeleted', message: `Deleted the ${name} function` }));
    case 'database.navigation':
      return t(msg({ id: 'undo.action.navigation', message: `Arranged the sidebar in ${name}` }));
    case 'record.generateDocument':
      return t(msg({ id: 'undo.action.document', message: `Generated a document in ${name}` }));
    case 'automation.notify':
      return t(msg({ id: 'undo.action.notification', message: `Sent notifications for ${name}` }));
    case 'automation.calendarEvent':
      return t(msg({ id: 'undo.action.calendarEvent', message: `Changed a calendar event for ${name}` }));
    case 'button.run':
      return t(msg({ id: 'undo.action.buttonRun', message: `Ran ${name}` }));
    case 'record.update':
    case 'record.attachFromUrl':
      return t(
        msg({
          id: 'undo.action.cells',
          message: plural(count, { one: `Changed # cell in ${name}`, other: `Changed # cells in ${name}` }),
        }),
      );
    case 'record.duplicate':
      return t(
        msg({
          id: 'undo.action.recordsDuplicated',
          message: plural(count, {
            one: `Duplicated # record in ${name}`,
            other: `Duplicated # records in ${name}`,
          }),
        }),
      );
    case 'field.duplicate':
      return t(msg({ id: 'undo.action.fieldDuplicated', message: `Duplicated the ${name} field` }));
    case 'table.duplicate':
      return t(msg({ id: 'undo.action.tableDuplicated', message: `Duplicated the ${name} table` }));
    case 'record.create':
      return t(
        msg({
          id: 'undo.action.recordsAdded',
          message: plural(count, { one: `Added # record to ${name}`, other: `Added # records to ${name}` }),
        }),
      );
    case 'record.setLock':
      return t(msg({ id: 'undo.action.recordLocks', message: `Changed record locks in ${name}` }));
    case 'record.trash':
      return t(
        msg({
          id: 'undo.action.recordsDeleted',
          message: plural(count, {
            one: `Deleted # record from ${name}`,
            other: `Deleted # records from ${name}`,
          }),
        }),
      );
    case 'record.restore':
      return t(
        msg({
          id: 'undo.action.recordsRestored',
          message: plural(count, {
            one: `Restored # record in ${name}`,
            other: `Restored # records in ${name}`,
          }),
        }),
      );
    case 'record.merge':
      return t(
        msg({
          id: 'undo.action.recordsMerged',
          message: plural(count, { one: `Merged # record in ${name}`, other: `Merged # records in ${name}` }),
        }),
      );
    case 'record.move':
      return t(
        msg({
          id: 'undo.action.recordsMoved',
          message: plural(count, {
            one: `Moved # record in the ${name} view`,
            other: `Moved # records in the ${name} view`,
          }),
        }),
      );
    case 'record.clearOverrides':
      return t(
        msg({
          id: 'undo.action.sourceValues',
          message: plural(count, {
            one: `Used the source value in # cell in ${name}`,
            other: `Used the source values in # cells in ${name}`,
          }),
        }),
      );
    case 'field.create':
      return t(msg({ id: 'undo.action.fieldAdded', message: `Added the ${name} field to ${table}` }));
    case 'field.update':
      return to !== undefined
        ? t(msg({ id: 'undo.action.fieldRenamed', message: `Renamed the ${name} field to ${to}` }))
        : t(msg({ id: 'undo.action.fieldChanged', message: `Changed the ${name} field` }));
    case 'field.convert':
      return t(msg({ id: 'undo.action.fieldConverted', message: `Changed the type of the ${name} field` }));
    case 'field.trash':
      return t(msg({ id: 'undo.action.fieldDeleted', message: `Deleted the ${name} field` }));
    case 'field.restore':
      return t(msg({ id: 'undo.action.fieldRestored', message: `Restored the ${name} field` }));
    case 'field.setPrimary':
      return t(msg({ id: 'undo.action.fieldPrimary', message: `Made ${name} the primary field` }));
    case 'table.create':
      return t(msg({ id: 'undo.action.tableAdded', message: `Added the ${name} table` }));
    case 'table.update':
      return to !== undefined
        ? t(msg({ id: 'undo.action.tableRenamed', message: `Renamed the ${name} table to ${to}` }))
        : t(msg({ id: 'undo.action.tableChanged', message: `Changed the ${name} table` }));
    case 'table.move':
      return t(msg({ id: 'undo.action.tableMoved', message: `Moved the ${name} table` }));
    case 'table.trash':
      return t(msg({ id: 'undo.action.tableDeleted', message: `Deleted the ${name} table` }));
    case 'table.restore':
      return t(msg({ id: 'undo.action.tableRestored', message: `Restored the ${name} table` }));
    case 'table.updateSource':
      return t(msg({ id: 'undo.action.tableSync', message: `Changed how ${name} syncs` }));
    case 'view.create':
      return t(msg({ id: 'undo.action.viewAdded', message: `Added the ${name} view to ${table}` }));
    case 'view.update':
      return to !== undefined
        ? t(msg({ id: 'undo.action.viewRenamed', message: `Renamed the ${name} view to ${to}` }))
        : t(msg({ id: 'undo.action.viewChanged', message: `Changed the ${name} view` }));
    case 'view.move':
      return t(msg({ id: 'undo.action.viewMoved', message: `Moved the ${name} view` }));
    case 'view.trash':
      return t(msg({ id: 'undo.action.viewDeleted', message: `Deleted the ${name} view` }));
    case 'view.restore':
      return t(msg({ id: 'undo.action.viewRestored', message: `Restored the ${name} view` }));
    case 'database.update':
      return to !== undefined
        ? t(msg({ id: 'undo.action.databaseRenamed', message: `Renamed the database to ${to}` }))
        : summary.theme
          ? t(msg({ id: 'undo.action.databaseTheme', message: 'Changed the database’s theme' }))
          : t(msg({ id: 'undo.action.databaseChanged', message: 'Changed the database' }));
    case 'database.trash':
      return t(msg({ id: 'undo.action.databaseDeleted', message: 'Deleted the database' }));
    case 'database.restore':
      return t(msg({ id: 'undo.action.databaseRestored', message: 'Restored the database' }));
    case 'dashboard.create':
      return t(msg({ id: 'undo.action.dashboardAdded', message: `Added the ${name} dashboard` }));
    case 'dashboard.update':
      return to !== undefined
        ? t(msg({ id: 'undo.action.dashboardRenamed', message: `Renamed the ${name} dashboard to ${to}` }))
        : t(msg({ id: 'undo.action.dashboardChanged', message: `Changed the ${name} dashboard` }));
    case 'dashboard.move':
      return t(msg({ id: 'undo.action.dashboardMoved', message: `Moved the ${name} dashboard` }));
    case 'dashboard.trash':
      return t(msg({ id: 'undo.action.dashboardDeleted', message: `Deleted the ${name} dashboard` }));
    case 'dashboard.restore':
      return t(msg({ id: 'undo.action.dashboardRestored', message: `Restored the ${name} dashboard` }));
    case 'interface.create':
      return t(msg({ id: 'undo.action.interfaceAdded', message: `Added the ${name} interface` }));
    case 'interface.update':
      return to !== undefined
        ? t(msg({ id: 'undo.action.interfaceRenamed', message: `Renamed the ${name} interface to ${to}` }))
        : t(msg({ id: 'undo.action.interfaceChanged', message: `Changed the ${name} interface` }));
    case 'interface.move':
      return t(msg({ id: 'undo.action.interfaceMoved', message: `Moved the ${name} interface` }));
    case 'interface.trash':
      return t(msg({ id: 'undo.action.interfaceDeleted', message: `Deleted the ${name} interface` }));
    case 'interface.restore':
      return t(msg({ id: 'undo.action.interfaceRestored', message: `Restored the ${name} interface` }));
    case 'automation.cancelRun':
      return t(
        msg({
          id: 'undo.action.automationRunCanceled',
          message: `Changed a waiting run of the ${name} automation`,
        }),
      );
    case 'automation.create':
      return t(msg({ id: 'undo.action.automationAdded', message: `Added the ${name} automation` }));
    case 'automation.update':
      return to !== undefined
        ? t(msg({ id: 'undo.action.automationRenamed', message: `Renamed the ${name} automation to ${to}` }))
        : t(msg({ id: 'undo.action.automationChanged', message: `Changed the ${name} automation` }));
    case 'automation.publish':
      return t(msg({ id: 'undo.action.automationPublished', message: `Published the ${name} automation` }));
    case 'automation.discardDraft':
      return t(
        msg({
          id: 'undo.action.automationDraftDiscarded',
          message: `Discarded the ${name} automation’s draft`,
        }),
      );
    case 'automation.restoreVersion':
      return t(
        msg({
          id: 'undo.action.automationVersionRestored',
          message: `Restored an earlier version of the ${name} automation`,
        }),
      );
    case 'automation.move':
      return t(msg({ id: 'undo.action.automationMoved', message: `Moved the ${name} automation` }));
    case 'automation.trash':
      return t(msg({ id: 'undo.action.automationDeleted', message: `Deleted the ${name} automation` }));
    case 'automation.restore':
      return t(msg({ id: 'undo.action.automationRestored', message: `Restored the ${name} automation` }));
    case 'script.create':
      return t(msg({ id: 'undo.action.scriptAdded', message: `Added the ${name} script` }));
    case 'script.update':
      return to !== undefined
        ? t(msg({ id: 'undo.action.scriptRenamed', message: `Renamed the ${name} script to ${to}` }))
        : t(msg({ id: 'undo.action.scriptChanged', message: `Changed the ${name} script` }));
    case 'script.move':
      return t(msg({ id: 'undo.action.scriptMoved', message: `Moved the ${name} script` }));
    case 'script.trash':
      return t(msg({ id: 'undo.action.scriptDeleted', message: `Deleted the ${name} script` }));
    case 'script.restore':
      return t(msg({ id: 'undo.action.scriptRestored', message: `Restored the ${name} script` }));
    // Everything one run of a script wrote, which undoes at once.
    case 'script.run':
      return t(msg({ id: 'undo.action.scriptRun', message: `Ran the ${name} script` }));
    // Syncs and comments never undo, so they never reach the history.
    case 'table.sync':
    case 'comment.create':
    case 'comment.update':
    case 'comment.delete':
      return t(msg({ id: 'undo.action.other', message: 'Made a change' }));
  }
}
