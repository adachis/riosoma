import { z } from 'zod';
import { ERROR_CODES, type ErrorCode } from './error-values.js';
import { TextConflict } from './text-merge.js';
export { ERROR_CODES, type ErrorCode } from './error-values.js';

/**
 * Every failure crosses the API boundary in this one shape.  People never see machine output:
 * the client renders `messageKey` (an i18n key) with `params`, and `reference` lets an admin find
 * the matching log entry when the fault is the system's rather than the person's.
 */
export const ErrorBody = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    messageKey: z.string(),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    /** True when the person can fix it; false when it's the system's fault. */
    userFault: z.boolean(),
    /** Present for system faults, so the log entry can be found. */
    reference: z.string().optional(),
    issues: z
      .array(
        z.object({
          recordId: z.string(),
          fieldId: z.string(),
          messageKey: z.string(),
          message: z.string().optional(),
        }),
      )
      .optional(),
    /** Field-level problems for forms. */
    fields: z.record(z.string(), z.string()).optional(),
    conflicts: z.array(TextConflict).optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  gone: 410,
  conflict: 409,
  rate_limited: 429,
  payload_too_large: 413,
  unavailable: 503,
  setup_required: 409,
  internal: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly messageKey: string;
  readonly params: Record<string, string | number | boolean> | undefined;
  readonly fields: Record<string, string> | undefined;
  readonly issues: ErrorBody['error']['issues'];
  readonly conflicts: ErrorBody['error']['conflicts'];

  constructor(
    code: ErrorCode,
    messageKey: string,
    options: {
      params?: Record<string, string | number | boolean>;
      fields?: Record<string, string>;
      issues?: ErrorBody['error']['issues'];
      conflicts?: ErrorBody['error']['conflicts'];
      cause?: unknown;
    } = {},
  ) {
    super(messageKey, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.messageKey = messageKey;
    this.params = options.params;
    this.fields = options.fields;
    this.issues = options.issues;
    this.conflicts = options.conflicts;
  }

  get status(): number {
    return STATUS[this.code];
  }

  get userFault(): boolean {
    return this.code !== 'internal' && this.code !== 'unavailable';
  }

  toBody(reference?: string): ErrorBody {
    return {
      error: {
        code: this.code,
        messageKey: this.messageKey,
        ...(this.params ? { params: this.params } : {}),
        userFault: this.userFault,
        ...(reference && !this.userFault ? { reference } : {}),
        ...(this.issues ? { issues: this.issues } : {}),
        ...(this.fields ? { fields: this.fields } : {}),
        ...(this.conflicts ? { conflicts: this.conflicts } : {}),
      },
    };
  }
}

export function statusFor(code: ErrorCode): number {
  return STATUS[code];
}
