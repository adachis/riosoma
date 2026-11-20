import { checkCellValue, type CellValue, type FieldMeta, type RowData } from '@riosoma/contracts';
import type { CustomEditorRequest } from '../../../../../packages/grid-core/src/types';
import type { DatabaseSession } from '../../data';
import type { FormatContext } from '../format';
import type { AnyRouter } from '@tanstack/react-router';

export interface EditorContext {
  router?: AnyRouter;
  field: FieldMeta;
  session?: DatabaseSession;
  format: FormatContext;
  canEditOptions: boolean;
  apply(value: CellValue): void;
  addOption(name: string): string;
}

export interface EditorProps {
  request: CustomEditorRequest<RowData>;
  context: EditorContext;
  portalContainer?: HTMLElement;
}

export function applyValue(context: EditorContext, value: CellValue, field = context.field): boolean {
  const checked = checkCellValue(field, value);
  if (!checked.ok) return false;
  context.apply(checked.value);
  return true;
}
