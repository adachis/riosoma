import { ApiError } from '../api';

export function errorInfo(error: unknown): {
  key: string;
  params?: Record<string, string | number | boolean>;
  fields?: Record<string, string>;
  reference?: string;
} | null {
  if (!error) return null;
  if (error instanceof ApiError) {
    // The shared refusal toast already explains this without an inline error or reference.
    if (error.info.messageKey === 'demo.readOnly') return null;
    return {
      key: error.info.messageKey,
      ...(error.info.params ? { params: error.info.params } : {}),
      ...(error.info.fields ? { fields: error.info.fields } : {}),
      ...(error.info.reference ? { reference: error.info.reference } : {}),
    };
  }
  return { key: 'errors.internal' };
}
