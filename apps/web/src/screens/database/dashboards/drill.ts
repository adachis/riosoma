import {
  GROUP_KEY_MAX_LENGTH,
  OTHER_GROUP_KEY,
  TILE_ID_PATTERN,
  isGroupKey,
  parsePivotSlice,
  type DashboardSlice as Slice,
  type GroupKey,
} from '@riosoma/contracts';

// A key's UTF-16 unit can take three UTF-8 bytes, each escaped as three characters in the address.
const MAX_DRILL_TOKEN_LENGTH = 256 + 4 * GROUP_KEY_MAX_LENGTH * 9;

/**
 * The part of a chart tile whose records are open, as the dashboard's address keeps it:
 * `?drill=<tileId>:<category>[:<series>]`.  Each key is `e` for empty, `o` for "Other", `n` and a
 * number, or `t` and text with its reserved characters escaped, so a link reopens the same list.
 * Pivot cells use `p` and their escaped JSON row and column keys.
 */
export interface Drill {
  tileId: string;
  slice: Slice;
}

function token(key: GroupKey): string {
  if (key === null) return 'e';
  if (key === OTHER_GROUP_KEY) return 'o';
  return typeof key === 'number' ? `n${key}` : `t${encodeURIComponent(key)}`;
}

function keyOf(text: string): GroupKey | undefined {
  if (text === 'e') return null;
  if (text === 'o') return OTHER_GROUP_KEY;
  const rest = text.slice(1);
  if (text.startsWith('n') && rest) {
    const number = Number(rest);
    return Number.isFinite(number) ? number : undefined;
  }
  if (text.startsWith('t'))
    try {
      return decodeURIComponent(rest);
    } catch {
      return undefined;
    }
  return undefined;
}

export function drillToken({ tileId, slice }: Drill): string {
  if ('row' in slice) return `${tileId}:p${encodeURIComponent(JSON.stringify(slice))}`;
  return [tileId, token(slice.category), ...(slice.series === undefined ? [] : [token(slice.series)])].join(
    ':',
  );
}

/** The part an address names, or null when it doesn't name one. */
export function parseDrill(text: string | null | undefined): Drill | null {
  if (!text || text.length > MAX_DRILL_TOKEN_LENGTH) return null;
  const [tileId, category, series, ...extra] = text.split(':');
  if (!tileId || !TILE_ID_PATTERN.test(tileId) || category === undefined || extra.length) return null;
  if (category.startsWith('p') && series === undefined) {
    try {
      const slice = parsePivotSlice(JSON.parse(decodeURIComponent(category.slice(1))));
      return slice ? { tileId, slice } : null;
    } catch {
      return null;
    }
  }
  const categoryKey = keyOf(category);
  const seriesKey = series === undefined ? undefined : keyOf(series);
  if (categoryKey === undefined || (series !== undefined && seriesKey === undefined)) return null;
  if (!isGroupKey(categoryKey) || (seriesKey !== undefined && !isGroupKey(seriesKey))) return null;
  return {
    tileId,
    slice: { category: categoryKey, ...(seriesKey === undefined ? {} : { series: seriesKey }) },
  };
}
