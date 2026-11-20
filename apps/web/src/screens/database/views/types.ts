import type { AttachmentMeta, FieldMeta, GridConfigPatch, TableMeta, ViewMeta } from '@riosoma/contracts';
import type { DatabaseSession } from '../../../data/types';
import type { FormatContext } from '../../../grid/format';
import type { ViewColors } from '../colors/paint';

/** What every view type receives from the database screen. */
export interface ViewComponentProps {
  session: DatabaseSession;
  table: TableMeta;
  /** The view with its current configuration, including edits not yet saved */
  view: ViewMeta;
  /** Every field of the table, in the table's order */
  fields: readonly FieldMeta[];
  format: FormatContext;
  canEdit: boolean;
  calendarDay?: string | null;
  onCalendarDay?(day: string): void;
  dependencySource?: string | null;
  onDependencySource?(recordId: string | null): void;
  /** Saves part of the view's configuration; each key given replaces that key */
  onConfig(patch: GridConfigPatch): void;
  /** Opens a record in the record card */
  onExpand(recordId: string): void;
  /**
   * Details of a file in an attachment cell, for covers.  Undefined until the file's details have
   * loaded, or while the app has no attachment support; draw a neutral placeholder then.
   */
  attachment?(id: string): AttachmentMeta | undefined;
  /** The view's conditional colors, for views that draw them */
  colors?: ViewColors;
  /**
   * A page anyone with a link can read, where nothing can change: views leave out the controls
   * that would change something, rather than showing them turned off
   */
  readOnly?: boolean;
}
