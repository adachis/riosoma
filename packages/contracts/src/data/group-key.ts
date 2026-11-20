export const PIVOT_ROW_MAX = 3;
export const GROUP_KEY_MAX_LENGTH = 600;
export const OTHER_GROUP_KEY = '\u0000other';
export const TILE_ID_PATTERN = /^[0-9A-Za-z_-]{6,40}$/;

/** URL keys follow the same primitive bounds as the dashboard request schema. */
export function isGroupKey(value: unknown): value is string | number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length <= GROUP_KEY_MAX_LENGTH)
  );
}

/** Dashboard addresses need the same bounded pivot keys without loading request schemas. */
export function parsePivotSlice(
  value: unknown,
): { row: (string | number | null)[]; column?: string | number | null } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const slice = value as { row?: unknown; column?: unknown; category?: unknown; series?: unknown };
  // The union accepts a valid category first, so a mixed object cannot become a pivot address.
  if (isGroupKey(slice.category) && (slice.series === undefined || isGroupKey(slice.series))) return null;
  if (!Array.isArray(slice.row) || slice.row.length > PIVOT_ROW_MAX || !slice.row.every(isGroupKey))
    return null;
  if (slice.column !== undefined && !isGroupKey(slice.column)) return null;
  return { row: slice.row, ...(slice.column !== undefined ? { column: slice.column } : {}) };
}
