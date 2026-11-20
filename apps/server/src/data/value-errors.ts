import { AppError } from '@riosoma/contracts';

/** Positions count from zero in the submitted records, including records that passed validation. */
export function cellError(
  error: AppError | string,
  field: { id: string; name: string },
  recordId: string,
  recordIndex: number,
): AppError {
  const original = typeof error === 'string' ? new AppError('validation_failed', error) : error;
  return new AppError(original.code, original.messageKey, {
    params: { ...original.params, fieldId: field.id, field: field.name, recordId, recordIndex },
    ...(original.fields ? { fields: original.fields } : {}),
    ...(original.conflicts ? { conflicts: original.conflicts } : {}),
    cause: original,
  });
}

/** Filtering unchanged rows or splitting a batch must not change the reported request position. */
export function recordError(
  error: unknown,
  position: (recordId: string, fieldId: string) => number | undefined,
): unknown {
  if (
    !(error instanceof AppError) ||
    typeof error.params?.recordId !== 'string' ||
    typeof error.params.fieldId !== 'string'
  )
    return error;
  const index = position(error.params.recordId, error.params.fieldId);
  if (index === undefined || index < 0) return error;
  return new AppError(error.code, error.messageKey, {
    params: { ...error.params, recordIndex: index },
    ...(error.fields ? { fields: error.fields } : {}),
    ...(error.conflicts ? { conflicts: error.conflicts } : {}),
    cause: error,
  });
}
