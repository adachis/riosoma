export type ScimErrorType =
  'invalidFilter' | 'invalidValue' | 'invalidPath' | 'uniqueness' | 'noTarget' | 'mutability';

/**
 * A SCIM failure.  The response's `detail` is the message key, unless the error carries a detail of
 * its own for the directory's administrator to read in their provisioning log.
 */
export class ScimError extends Error {
  constructor(
    readonly status: number,
    readonly messageKey: string,
    readonly scimType?: ScimErrorType,
    readonly detail?: string,
  ) {
    super(messageKey);
  }
}

export function invalidValue(): never {
  throw new ScimError(400, 'scim.errors.invalidValue', 'invalidValue');
}

export function invalidPath(): never {
  throw new ScimError(400, 'scim.errors.invalidPath', 'invalidPath');
}

export function invalidFilter(): never {
  throw new ScimError(400, 'scim.errors.invalidFilter', 'invalidFilter');
}

export function noTarget(): never {
  throw new ScimError(400, 'scim.errors.noTarget', 'noTarget');
}

// NUL, and a surrogate without its other half, can't be stored in PostgreSQL text or jsonb.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function storable(text: string): boolean {
  return !text.includes('\u0000') && !LONE_SURROGATE.test(text);
}

/** Directories send booleans as JSON booleans, and Entra also as the strings "True" and "False". */
export function booleanOf(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && /^(?:true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  return undefined;
}
