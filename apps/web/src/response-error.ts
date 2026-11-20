import { ERROR_CODES, type ErrorBody } from '@riosoma/contracts';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const parameter = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));

/** Background failures need their metadata without loading feature schema code. */
export function parseError(data: unknown): ErrorBody['error'] | null {
  if (!record(data) || !record(data.error)) return null;
  const error = data.error;
  const code = ERROR_CODES.find((candidate) => candidate === error.code);
  if (!code || typeof error.messageKey !== 'string' || typeof error.userFault !== 'boolean') return null;
  const result: ErrorBody['error'] = { code, messageKey: error.messageKey, userFault: error.userFault };
  if (error.reference !== undefined) {
    if (typeof error.reference !== 'string') return null;
    result.reference = error.reference;
  }
  if (error.params !== undefined) {
    if (!record(error.params)) return null;
    const params = Object.entries(error.params);
    if (params.some(([, value]) => !parameter(value))) return null;
    result.params = Object.fromEntries(params) as NonNullable<ErrorBody['error']['params']>;
  }
  if (error.fields !== undefined) {
    if (!record(error.fields) || Object.values(error.fields).some((value) => typeof value !== 'string'))
      return null;
    result.fields = Object.fromEntries(Object.entries(error.fields)) as Record<string, string>;
  }
  if (error.issues !== undefined) {
    if (!Array.isArray(error.issues)) return null;
    const issues: NonNullable<ErrorBody['error']['issues']> = [];
    for (const issue of error.issues) {
      if (
        !record(issue) ||
        typeof issue.recordId !== 'string' ||
        typeof issue.fieldId !== 'string' ||
        typeof issue.messageKey !== 'string' ||
        (issue.message !== undefined && typeof issue.message !== 'string')
      )
        return null;
      issues.push({
        recordId: issue.recordId,
        fieldId: issue.fieldId,
        messageKey: issue.messageKey,
        ...(issue.message === undefined ? {} : { message: issue.message }),
      });
    }
    result.issues = issues;
  }
  if (error.conflicts !== undefined) {
    if (!Array.isArray(error.conflicts)) return null;
    const conflicts: NonNullable<ErrorBody['error']['conflicts']> = [];
    for (const item of error.conflicts) {
      if (
        !record(item) ||
        ['tableId', 'recordId', 'fieldId', 'updatedAt', 'proposal'].some(
          (key) => typeof item[key] !== 'string',
        ) ||
        ['base', 'ours', 'theirs', 'updatedBy', 'name'].some(
          (key) => item[key] !== null && typeof item[key] !== 'string',
        )
      )
        return null;
      conflicts.push(item as unknown as NonNullable<ErrorBody['error']['conflicts']>[number]);
    }
    result.conflicts = conflicts;
  }
  return result;
}
