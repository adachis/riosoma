import {
  AppError,
  isComputedType,
  PUBLIC_QUESTION_TYPES,
  visibleFormQuestions,
  type FieldType,
  type FormQuestion,
} from '@riosoma/contracts';
import type { StoredField } from '../types.js';
import { badViewSetting } from '../view-settings.js';
import { scopeOf, view, type CommandContext } from './context.js';

/** Whether a form shared by link may ask about a field of this type. */
export function isPublicQuestionType(type: FieldType): type is (typeof PUBLIC_QUESTION_TYPES)[number] {
  return (PUBLIC_QUESTION_TYPES as readonly FieldType[]).includes(type);
}

export async function formQuestions(
  c: CommandContext,
  viewId: string,
  tableId: string,
  fields: readonly StoredField[],
  records: readonly { values: Record<string, unknown> }[],
): Promise<FormQuestion[]> {
  const loaded = await view(c, viewId);
  if (loaded.view.type !== 'form' || loaded.view.tableId !== tableId) badViewSetting('formViewId');
  // Through its public link a form asks only what anyone may answer.  Its other questions stay
  // private there, so they're neither accepted nor required.  Links that follow matching values
  // can't be answered anywhere, so a question on one is left out the same way.
  // A question on a field the person may not change, such as a locked or restricted one, is left
  // out the same way.  Through a public link that means every locked or restricted field.
  const scope = await scopeOf(c, tableId);
  const askable = (field: StoredField) =>
    !(field.type === 'link' && field.options.match) &&
    (c.publicForm ? isPublicQuestionType(field.type) : !isComputedType(field.type)) &&
    scope.canEditField(tableId, field);
  const writable = new Set(fields.filter(askable).map((field) => field.id));
  const questions = loaded.view.config.form.questions.filter((question) => writable.has(question.fieldId));
  const allowed = new Set(questions.map((question) => question.fieldId));
  // The payment service adds its own result values, which no question asks for.
  const service = c.managedWrite?.fieldIds ?? new Set<string>();
  for (const record of records) {
    for (const fieldId of Object.keys(record.values)) {
      if (!allowed.has(fieldId) && !service.has(fieldId))
        throw new AppError('validation_failed', 'data.form.unknownField', { params: { fieldId } });
    }
  }
  return questions;
}

export function requireFormAnswers(
  questions: readonly FormQuestion[],
  records: readonly { values: Record<string, unknown> }[],
  submitted: readonly { values: Record<string, unknown> }[] = records,
): void {
  for (const [index, record] of records.entries()) {
    const visible = new Set(
      visibleFormQuestions(questions, record.values).map((question) => question.fieldId),
    );
    for (const question of questions) {
      if (!visible.has(question.fieldId)) {
        if (Object.hasOwn(submitted[index]!.values, question.fieldId))
          throw new AppError('validation_failed', 'data.form.unknownField', {
            params: { fieldId: question.fieldId },
          });
        // A hidden question cannot acquire a field default either.
        delete record.values[question.fieldId];
        continue;
      }
      const value = record.values[question.fieldId];
      if (
        question.required &&
        (value === undefined ||
          value === null ||
          (typeof value === 'string' && value.trim() === '') ||
          (Array.isArray(value) && !value.length))
      )
        throw new AppError('validation_failed', 'data.form.required', {
          params: { fieldId: question.fieldId },
        });
    }
  }
}
