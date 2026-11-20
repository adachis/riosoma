/** Group headers occupy coordinates without allocating a slot for every record. */
export interface RowGroup {
  key: string;
  level: number;
  start: number;
  count: number;
}

export interface GroupLine {
  group: RowGroup;
  row: number;
  end: number;
  parent?: GroupLine;
  expanded: boolean;
}

type Segment = { row: number; length: number; start: number };

export class GroupLayout {
  readonly headers = new Map<number, GroupLine>();
  readonly segments: Segment[] = [];
  readonly lines: GroupLine[] = [];
  readonly count: number;

  constructor(
    readonly groups: readonly RowGroup[],
    count: number,
    collapsed: ReadonlySet<string>,
  ) {
    let row = 0;
    let record = 0;
    let hiddenUntil = -1;
    const active: GroupLine[] = [];
    const records = (end: number) => {
      if (end <= record) return;
      this.segments.push({ row, start: record, length: end - record });
      row += end - record;
      record = end;
    };
    for (const group of groups) {
      if (group.start < hiddenUntil || group.start >= count) continue;
      records(group.start);
      while (active.length && active.at(-1)!.group.start + active.at(-1)!.group.count <= group.start)
        active.pop()!.end = row;
      const line: GroupLine = {
        parent: active.at(-1),
        group,
        row: row++,
        end: 0,
        expanded: !collapsed.has(group.key),
      };
      this.headers.set(line.row, line);
      this.lines.push(line);
      active.push(line);
      if (!line.expanded) {
        hiddenUntil = Math.min(count, group.start + group.count);
        record = hiddenUntil;
      }
    }
    records(count);
    for (const line of active) line.end = row;
    this.count = row;
  }

  recordAt(row: number): number | null {
    if (this.headers.has(row)) return null;
    let lo = 0,
      hi = this.segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.segments[mid]!.row <= row) lo = mid + 1;
      else hi = mid;
    }
    const segment = this.segments[lo - 1];
    return segment && row < segment.row + segment.length ? segment.start + row - segment.row : null;
  }

  rowAt(record: number): number | null {
    let lo = 0,
      hi = this.segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.segments[mid]!.start <= record) lo = mid + 1;
      else hi = mid;
    }
    const segment = this.segments[lo - 1];
    return segment && record < segment.start + segment.length ? segment.row + record - segment.start : null;
  }

  recordRanges(start: number, end: number): Array<{ start: number; end: number }> {
    let lo = 0,
      hi = this.segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const segment = this.segments[mid]!;
      if (segment.row + segment.length <= start) lo = mid + 1;
      else hi = mid;
    }
    const ranges: Array<{ start: number; end: number }> = [];
    for (let index = lo; index < this.segments.length; index++) {
      const segment = this.segments[index]!;
      if (segment.row >= end) break;
      const first = Math.max(start, segment.row),
        last = Math.min(end, segment.row + segment.length);
      if (last > first)
        ranges.push({ start: segment.start + first - segment.row, end: segment.start + last - segment.row });
    }
    return ranges;
  }

  sticky(first: number): GroupLine[] {
    let lo = 0,
      hi = this.lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.lines[mid]!.row <= first) lo = mid + 1;
      else hi = mid;
    }
    const result: GroupLine[] = [];
    for (let line = this.lines[lo - 1]; line; line = line.parent) {
      if (line.expanded && line.end > first) result.unshift(line);
    }
    return result;
  }
}
