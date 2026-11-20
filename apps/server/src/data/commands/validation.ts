import type { FormQuestion } from '@riosoma/contracts';
import { writeGuard } from '../permissions/enforce.js';
import type { StoredField } from '../types.js';
import { scopeOf, type CommandContext } from './context.js';

/** Check the resulting record, including fields omitted by an update or a form. */
export async function validateRecords(
  c: CommandContext,
  tableId: string,
  fields: readonly StoredField[],
  rows: ReadonlyArray<{ id: string; values: Record<string, unknown> }>,
  existing: boolean,
  questions: readonly FormQuestion[] = [],
  revalidateCascades = false,
): Promise<void> {
  await writeGuard(c.db, c.schemas, await scopeOf(c, tableId), tableId, fields).requireValid(
    rows,
    existing,
    c.publicForm ? questions.map((question) => question.fieldId) : undefined,
    revalidateCascades,
  );
}
