export const ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  /** Something that worked once and has stopped, such as a link whose person is suspended */
  'gone',
  'conflict',
  'rate_limited',
  'payload_too_large',
  'unavailable',
  'setup_required',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
