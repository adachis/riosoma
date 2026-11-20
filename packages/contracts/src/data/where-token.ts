export const WHERE_TOKEN_LENGTH = 8_000;
export const WHERE_TOKEN_PATTERN = /^[0-9A-Za-z_-]+$/;

/** The URL-safe token syntax shared by routing and the request schema. */
export function isWhereToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= WHERE_TOKEN_LENGTH &&
    WHERE_TOKEN_PATTERN.test(value)
  );
}
