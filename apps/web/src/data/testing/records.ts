import type {
  CellValue,
  FieldMeta,
  FilterCondition,
  FilterGroup,
  RowData,
  ViewMeta,
} from '@riosoma/contracts';
import {
  cellValue,
  checkCondition,
  distanceKm,
  isDateRangeValue,
  isEmptyValue,
  isGroup,
  isLocationValue,
} from '@riosoma/contracts';

export interface LazyRecords {
  count: number;
  values?: (index: number) => Record<string, CellValue>;
}

/** The generated range has no per-record allocations until a read or write touches it. */
export class FakeRecords {
  private prefix: string;
  private overrides = new Map<string, RowData>();
  private extras: string[] = [];
  private deleted = new Set<string>();
  private transforms: Array<(row: RowData) => RowData> = [];
  generated = 0;
  constructor(
    readonly tableId: string,
    readonly lazy: LazyRecords,
    private readonly at: string,
  ) {
    this.prefix = tableId.slice(3, 10);
  }
  id(index: number): string {
    return `rec${this.prefix}${index.toString(36).padStart(7, '0')}`;
  }
  index(id: string): number | undefined {
    if (!id.startsWith(`rec${this.prefix}`)) return undefined;
    const index = Number.parseInt(id.slice(10), 36);
    return Number.isSafeInteger(index) && index >= 0 && index < this.lazy.count && this.id(index) === id
      ? index
      : undefined;
  }
  get(id: string, includeDeleted = false): RowData | undefined {
    if (!includeDeleted && this.deleted.has(id)) return undefined;
    const stored = this.overrides.get(id);
    if (stored) return structuredClone(stored);
    const index = this.index(id);
    if (index === undefined) return undefined;
    this.generated++;
    let row: RowData = {
      id,
      values: this.lazy.values?.(index) ?? {},
      createdAt: this.at,
      updatedAt: this.at,
      createdBy: null,
      updatedBy: null,
    };
    for (const transform of this.transforms) row = transform(row);
    return row;
  }
  set(row: RowData): void {
    if (this.index(row.id) === undefined && !this.overrides.has(row.id)) this.extras.push(row.id);
    this.overrides.set(row.id, structuredClone(row));
    this.deleted.delete(row.id);
  }
  trash(id: string): void {
    if (this.get(id, true)) this.deleted.add(id);
  }
  restore(id: string): void {
    this.deleted.delete(id);
  }
  transform(transform: (row: RowData) => RowData): void {
    this.transforms.push(transform);
    for (const [id, row] of this.overrides) this.overrides.set(id, transform(row));
  }
  capture(fieldId: string): () => void {
    const transforms = [...this.transforms];
    const overrides = structuredClone(this.overrides);
    return () =>
      this.transform((row) => {
        let before = overrides.get(row.id);
        const index = this.index(row.id);
        if (!before && index !== undefined) {
          before = {
            id: row.id,
            values: this.lazy.values?.(index) ?? {},
            createdAt: this.at,
            updatedAt: this.at,
            createdBy: null,
            updatedBy: null,
          };
          for (const transform of transforms) before = transform(before);
        }
        // A column backup restores that field without rewinding edits to other fields or row metadata.
        return { ...row, values: { ...row.values, [fieldId]: before?.values[fieldId] ?? null } };
      });
  }
  order(): FakeOrder {
    const removed = [...this.deleted]
      .flatMap((id) => {
        const index = this.index(id);
        return index === undefined ? [] : [index];
      })
      .sort((a, b) => a - b);
    const extras = this.extras.filter((id) => !this.deleted.has(id));
    const baseCount = this.lazy.count - removed.length;
    return {
      total: baseCount + extras.length,
      idAt: (position) => {
        if (position < 0 || position >= baseCount + extras.length) return undefined;
        if (position >= baseCount) return extras[position - baseCount];
        let lo = position,
          hi = position + removed.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (mid - lowerBound(removed, mid + 1) < position) lo = mid + 1;
          else hi = mid;
        }
        return this.id(lo);
      },
      position: (id) => {
        const index = this.index(id);
        if (index === undefined) {
          const extra = extras.indexOf(id);
          return extra < 0 ? null : baseCount + extra;
        }
        const before = lowerBound(removed, index);
        return removed[before] === index ? null : index - before;
      },
    };
  }
}
export interface FakeOrder {
  total: number;
  idAt(index: number): string | undefined;
  position(id: string): number | null;
}
function lowerBound(values: number[], value: number): number {
  let lo = 0,
    hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function viewOrder(
  records: FakeRecords,
  view: ViewMeta,
  fields: readonly FieldMeta[],
  timezone: string,
  now: number,
): FakeOrder {
  const source = records.order();
  if (!view.config.filter && !view.config.sorts.length) return source;
  const ordered: RowData[] = [];
  for (let index = 0; index < source.total; index++) {
    const row = records.get(source.idAt(index)!);
    if (row && matches(row, view.config.filter, fields, timezone, now)) ordered.push(row);
  }
  const collator = new Intl.Collator('und', { numeric: true, sensitivity: 'base' });
  ordered.sort((a, b) => {
    for (const sort of view.config.sorts) {
      const field = fields.find((field) => field.id === sort.fieldId);
      if (!field) continue;
      const left = cellValue(a, field),
        right = cellValue(b, field);
      if (isEmptyValue(left) || isEmptyValue(right)) {
        if (isEmptyValue(left) !== isEmptyValue(right)) return isEmptyValue(left) ? 1 : -1;
        continue;
      }
      const result =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : collator.compare(String(left), String(right));
      if (result) return sort.direction === 'asc' ? result : -result;
    }
    return 0;
  });
  const ids = ordered.map((row) => row.id);
  const positions = new Map(ids.map((id, index) => [id, index]));
  return { total: ids.length, idAt: (index) => ids[index], position: (id) => positions.get(id) ?? null };
}
export function matches(
  row: RowData,
  group: FilterGroup | null,
  fields: readonly FieldMeta[],
  timezone: string,
  now: number,
): boolean {
  if (!group || !group.conditions.length) return true;
  const conditions = group.conditions.filter(
    (condition) =>
      isGroup(condition) ||
      checkCondition(
        fields.find((field) => field.id === condition.fieldId),
        condition,
      ).usable,
  );
  if (!conditions.length) return true;
  const evaluate = (condition: FilterGroup | FilterCondition): boolean =>
    isGroup(condition)
      ? matches(row, condition, fields, timezone, now)
      : matchCondition(row, condition, fields, timezone, now);
  return group.conjunction === 'and' ? conditions.every(evaluate) : conditions.some(evaluate);
}
function day(value: string, timezone: string): string {
  if (value.length === 10) return value;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  return `${parts.find((part) => part.type === 'year')!.value}-${parts.find((part) => part.type === 'month')!.value}-${parts.find((part) => part.type === 'day')!.value}`;
}
function targetDate(target: { mode: string; date?: string; days?: number }, today: string): string {
  if (target.mode === 'exactDate') return target.date!;
  const date = new Date(`${today}T12:00:00Z`);
  const offsets: Record<string, number> = {
    today: 0,
    tomorrow: 1,
    yesterday: -1,
    oneWeekAgo: -7,
    oneWeekFromNow: 7,
  };
  if (target.mode === 'oneMonthAgo' || target.mode === 'oneMonthFromNow')
    date.setUTCMonth(date.getUTCMonth() + (target.mode === 'oneMonthAgo' ? -1 : 1));
  else
    date.setUTCDate(
      date.getUTCDate() + (offsets[target.mode] ?? (target.mode === 'daysAgo' ? -1 : 1) * (target.days ?? 0)),
    );
  return date.toISOString().slice(0, 10);
}
function matchCondition(
  row: RowData,
  condition: FilterCondition,
  fields: readonly FieldMeta[],
  timezone: string,
  now: number,
): boolean {
  const field = fields.find((field) => field.id === condition.fieldId);
  if (!field) return true;
  let actual = cellValue(row, field);
  let expected = condition.value;
  if (condition.operator === 'isEmpty') return isEmptyValue(actual);
  if (condition.operator === 'isNotEmpty') return !isEmptyValue(actual);
  if (field.type === 'location') {
    const point = expected as { lat: number; lng: number; km: number };
    return isLocationValue(actual) && distanceKm(actual, point) <= point.km;
  }
  if (field.type === 'dateRange') {
    if (!isDateRangeValue(actual)) return false;
    const zone = field.options.timeZone === 'client' ? timezone : field.options.timeZone;
    const [first, last] = [day(actual.start, zone), day(actual.end, zone)];
    const today = day(new Date(now).toISOString(), zone);
    const target = expected as { mode: string; date?: string; days?: number };
    if (condition.operator === 'isWithin' || condition.operator === 'overlaps') {
      const past = target.mode.startsWith('past');
      const days =
        target.days ?? (target.mode.endsWith('Week') ? 7 : target.mode.endsWith('Month') ? 30 : 365);
      const edge = targetDate({ mode: past ? 'daysAgo' : 'daysFromNow', days }, today);
      const [from, to] = past ? [edge, today] : [today, edge];
      return condition.operator === 'isWithin' ? first >= from && last <= to : first <= to && last >= from;
    }
    const wanted = targetDate(target, today);
    if (condition.operator === 'containsDate') return first <= wanted && last >= wanted;
    actual = first;
    expected = wanted;
  }
  if (field.type === 'date' || field.type === 'createdTime' || field.type === 'lastModifiedTime') {
    if (typeof actual !== 'string') return false;
    const zone = field.options.timeZone === 'client' ? timezone : field.options.timeZone;
    actual = day(actual, zone);
    const today = day(new Date(now).toISOString(), zone);
    const target = expected as { mode: string; date?: string; days?: number };
    if (condition.operator === 'isWithin') {
      const past = target.mode.startsWith('past');
      const days =
        target.days ?? (target.mode.endsWith('Week') ? 7 : target.mode.endsWith('Month') ? 30 : 365);
      const edge = targetDate({ mode: past ? 'daysAgo' : 'daysFromNow', days }, today);
      return past ? actual >= edge && actual <= today : actual >= today && actual <= edge;
    }
    expected = targetDate(target, today);
  }
  const equal = (left: unknown, right: unknown) =>
    typeof left === 'string' && typeof right === 'string'
      ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
      : left === right;
  const list = Array.isArray(expected) ? (expected as unknown[]) : [];
  const values = Array.isArray(actual) ? actual : [];
  const comparison =
    typeof actual === 'number' && typeof expected === 'number'
      ? actual - expected
      : typeof actual === 'string' && typeof expected === 'string'
        ? actual < expected
          ? -1
          : actual > expected
            ? 1
            : 0
        : null;
  switch (condition.operator) {
    case 'is':
    case 'eq':
      return equal(actual, expected);
    case 'isNot':
    case 'neq':
      return !equal(actual, expected);
    case 'contains':
      return String(actual ?? '')
        .toLowerCase()
        .includes(String(expected).toLowerCase());
    case 'doesNotContain':
      return !String(actual ?? '')
        .toLowerCase()
        .includes(String(expected).toLowerCase());
    case 'lt':
    case 'isBefore':
      return comparison !== null && comparison < 0;
    case 'lte':
    case 'isOnOrBefore':
      return comparison !== null && comparison <= 0;
    case 'gt':
    case 'isAfter':
      return comparison !== null && comparison > 0;
    case 'gte':
    case 'isOnOrAfter':
      return comparison !== null && comparison >= 0;
    case 'isAnyOf':
      return list.some((value) => equal(actual, value));
    case 'isNoneOf':
      return !list.some((value) => equal(actual, value));
    case 'hasAnyOf':
      return values.some((value) => list.includes(value));
    case 'hasAllOf':
      return list.every((value) => values.includes(String(value)));
    case 'hasNoneOf':
      return !values.some((value) => list.includes(value));
    case 'isExactly':
      return values.length === list.length && list.every((value) => values.includes(String(value)));
    case 'isWithin':
    case 'overlaps':
    case 'containsDate':
      return false;
  }
}
