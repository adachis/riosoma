import { querySql } from '../sql.js';
import type { SourceObject, SourceSelect } from '@riosoma/contracts';
import { ConnectorError } from '../types.js';
import type { WarehouseSession } from '../warehouses/frame.js';
import type { Described } from '../warehouses/mapping.js';
import { objectMissing } from '../warehouses/errors.js';
import { guard, TRINO } from '../warehouses/sql.js';
import { type EngineHttp, record, records, nameOf, type Row } from './http.js';
import { engineColumn, sampled } from './search.js';

/**
 * Flux evaluates interpolation inside every string literal, including catalog names.  A `$` is
 * written as its byte escape because Flux's scanner reads `$` with whatever follows it as one
 * interpolation token, so a backslash before it would only be swallowed: a name holding `$"`, `$\`,
 * or `$${` could never be read as a literal.
 */
function fluxString(value: string): string {
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('$', '\\x24')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')}"`;
}

/** Unicode escapes are decoded once before parsing, so a literal backslash must be encoded */
function cypherLabel(name: string): string {
  return `\`${name.replaceAll('\\', '\\u005c').replaceAll('`', '``')}\``;
}

/** Quoted text is removed before checking clauses so property values never become commands */
export function readCypher(query: string): string {
  let words = '';
  for (let i = 0; i < query.length; i++) {
    const c = query[i]!;
    const next = query[i + 1];
    // A backslash, a statement separator, a comment, or a character outside ASCII could hide a
    // clause from the word check below, so a query with one isn't read at all.
    if (c === '\\' || c === ';' || c.charCodeAt(0) > 127 || (c === '/' && (next === '/' || next === '*')))
      throw new ConnectorError('sources.engines.readOnly');
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let ended = false;
      for (i++; i < query.length; i++) {
        if (query[i] === '\\') {
          i++;
          continue;
        }
        if (query[i] === quote) {
          if (query[i + 1] === quote) {
            i++;
            continue;
          }
          ended = true;
          break;
        }
      }
      if (!ended) throw new ConnectorError('sources.engines.readOnly');
      words += ' ';
    } else words += c;
  }
  if (
    !/^\s*(MATCH|OPTIONAL\s+MATCH|WITH|RETURN|UNWIND)\b/i.test(words) ||
    /\b(CREATE|INSERT|MERGE|SET|DELETE|REMOVE|DROP|ALTER|RENAME|CALL|LOAD|FOREACH|GRANT|DENY|REVOKE|TRANSACTIONS|USE)\b/i.test(
      words,
    )
  )
    throw new ConnectorError('sources.engines.readOnly');
  return query;
}

/** Flux accepts only a pipeline of pure table operations without imports or function aliases */
export function readFlux(query: string): string {
  const strings = query.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const allowed = new Set([
    'from',
    'range',
    'filter',
    'map',
    'keep',
    'drop',
    'rename',
    'group',
    'sort',
    'limit',
    'first',
    'last',
    'mean',
    'sum',
    'min',
    'max',
    'count',
    'aggregateWindow',
    'window',
    'pivot',
    'yield',
    'time',
    'duration',
    'int',
    'float',
    'string',
    'bool',
    'now',
  ]);
  if (
    query.includes('${') ||
    !/^\s*from\s*\(/.test(strings) ||
    /\b(import|option|to|experimental)\b|;|\/\*|\/\/|\\|[^\x20-\x7e\r\n\t]/.test(strings) ||
    /(?<![<>=!:])=(?!=|>)/.test(strings)
  )
    throw new ConnectorError('sources.engines.readOnly');
  for (const match of strings.matchAll(/([A-Za-z_][\w.]*)\s*\(/g))
    if (!allowed.has(match[1]!)) throw new ConnectorError('sources.engines.readOnly');
  return query;
}

/**
 * A person's Flux query as it runs, with a preview's limit on the end.  The source's own window is
 * never appended: Flux requires the query to name a range itself, and a second range after an
 * aggregate would filter on the aggregate's time and drop every row.  A pipeline that yields its
 * tables takes no operation after that, so its preview reads whatever it returns.
 */
export function fluxPreview(query: string, limit?: number): string {
  return limit === undefined || /\byield\s*\(/.test(query) ? query : `${query} |> limit(n: ${limit})`;
}

export function csvRows(text: string): Row[] {
  const lines: string[][] = [];
  let line: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      line.push(cell.replace(/\r$/, ''));
      cell = '';
      if (c === '\n') {
        lines.push(line);
        line = [];
      }
    } else cell += c;
  }
  if (quoted) throw new ConnectorError('sources.engines.response');
  if (cell || line.length) {
    line.push(cell);
    lines.push(line);
  }
  let types: string[] = [];
  let defaults: string[] = [];
  let names: string[] | undefined;
  const out: Row[] = [];
  for (const row of lines) {
    if (row.every((value) => !value)) {
      names = undefined;
      continue;
    }
    if (row[0] === '#datatype') {
      types = row;
      names = undefined;
      continue;
    }
    if (row[0] === '#default') {
      defaults = row;
      continue;
    }
    if (row[0]?.startsWith('#')) continue;
    if (!names) {
      names = row;
      continue;
    }
    if (names.includes('error')) throw new ConnectorError('sources.engines.partial');
    if (row.length !== names.length) throw new ConnectorError('sources.engines.response');
    out.push(
      Object.fromEntries(
        names.flatMap((name, at) => {
          if (!name || name === 'result' || name === 'table') return [];
          const value = row[at] || defaults[at] || '';
          const type = types[at];
          const parsed =
            value === ''
              ? null
              : type === 'boolean'
                ? value === 'true'
                : type === 'double'
                  ? Number(value)
                  : type === 'long' || type === 'unsignedLong'
                    ? Number.isSafeInteger(Number(value))
                      ? Number(value)
                      : value
                    : value;
          return [[name, parsed]];
        }),
      ),
    );
  }
  return out;
}

export class GraphMetricsSession implements WarehouseSession {
  private readonly end: string;
  private readonly start: string;
  constructor(readonly http: EngineHttp) {
    const settings = http.settings;
    // Rolling range evaluations share a step grid so overlapping samples keep their record keys.
    const automatic = (time: number) =>
      new Date(
        settings.kind === 'prometheus'
          ? Math.floor(time / (settings.stepSeconds * 1_000)) * settings.stepSeconds * 1_000
          : time,
      ).toISOString();
    this.end = 'end' in settings && settings.end ? settings.end : automatic(Date.now());
    this.start =
      'start' in settings && settings.start
        ? settings.start
        : automatic(
            Date.parse(this.end) - ('windowMinutes' in settings ? settings.windowMinutes : 60) * 60_000,
          );
    if (Date.parse(this.start) >= Date.parse(this.end)) throw new ConnectorError('sources.engines.window');
  }
  close() {
    return this.http.close();
  }
  async estimate() {
    return null;
  }
  async keys(): Promise<string[][]> {
    return this.http.settings.kind === 'neo4j'
      ? [['_id']]
      : this.http.settings.kind === 'prometheus'
        ? [['_series', 'time']]
        : [];
  }
  async version() {
    const objects = await this.list();
    if (objects[0])
      for await (const _rows of this.rows({ kind: 'object', object: objects[0] }, [], 1, 1)) break;
    return this.http.settings.kind;
  }
  async cypher(statement: string, parameters: Row = {}): Promise<Row[]> {
    const settings = this.http.settings;
    if (settings.kind !== 'neo4j') throw new ConnectorError('sources.engines.response');
    const body = record(
      await this.http.json(`/db/${encodeURIComponent(settings.database)}/query/v2`, {
        statement,
        parameters,
        accessMode: 'Read',
      }),
    );
    if (Array.isArray(body.errors) && body.errors.length) throw new ConnectorError('sources.engines.query');
    const data = record(body.data);
    if (!Array.isArray(data.fields) || !Array.isArray(data.values))
      throw new ConnectorError('sources.engines.response');
    const fields = data.fields.map(nameOf);
    return data.values.map((values) => {
      if (!Array.isArray(values) || values.length !== fields.length)
        throw new ConnectorError('sources.engines.response');
      return Object.fromEntries(fields.map((name, at) => [name, values[at]]));
    });
  }
  async flux(query: string): Promise<Row[]> {
    const settings = this.http.settings;
    if (settings.kind !== 'influxdb') throw new ConnectorError('sources.engines.response');
    return csvRows(
      await this.http.text(`/api/v2/query?org=${encodeURIComponent(settings.organization)}`, {
        query,
        type: 'flux',
        dialect: {
          annotations: ['datatype', 'group', 'default'],
          header: true,
          delimiter: ',',
          commentPrefix: '#',
          dateTimeFormat: 'RFC3339',
        },
      }),
    );
  }
  async sql(query: string): Promise<Row[]> {
    const settings = this.http.settings;
    if (settings.kind !== 'influxdb') throw new ConnectorError('sources.engines.response');
    return records(
      await this.http.json('/api/v3/query_sql', { db: settings.database, q: query, format: 'json' }),
    );
  }
  async list(): Promise<SourceObject[]> {
    const settings = this.http.settings;
    const object = (name: string): SourceObject => ({ schema: null, name, type: 'table', rowEstimate: null });
    if (settings.kind === 'neo4j')
      return (await this.cypher('CALL db.labels() YIELD label RETURN label ORDER BY label')).map((row) =>
        object(nameOf(row.label)),
      );
    if (settings.kind === 'influxdb') {
      // The request names the source's database, so its catalog lists only that one's tables.
      if (settings.version === '3')
        return (await this.sql('SELECT table_name FROM information_schema.tables')).map((row) =>
          object(nameOf(row.table_name)),
        );
      return (await this.measurements({ start: this.start, stop: this.end })).map((row) => object(row));
    }
    if (settings.kind === 'prometheus') {
      const result = record(await this.http.json('/api/v1/status/buildinfo'));
      if (result.status !== 'success') throw new ConnectorError('sources.engines.query');
      return [object('query')];
    }
    throw new ConnectorError('sources.engines.response');
  }
  /**
   * The measurement names an InfluxDB 2 bucket holds.  A start and a stop list only the measurements
   * with points inside them, which is what the picker shows.  Without them the question reaches back
   * to the epoch, so a measurement that has been quiet through the current window is still named.
   */
  private async measurements(window?: { start: string; stop: string }): Promise<string[]> {
    const settings = this.http.settings;
    if (settings.kind !== 'influxdb') throw new ConnectorError('sources.engines.response');
    const bounds = window
      ? `start: time(v: ${fluxString(window.start)}), stop: time(v: ${fluxString(window.stop)})`
      : 'start: time(v: 0)';
    return (
      await this.flux(
        `import "influxdata/influxdb/schema"\nschema.measurements(bucket: ${fluxString(settings.database)}, ${bounds})`,
      )
    ).map((row) => nameOf(row._value));
  }
  async describe(select: SourceSelect): Promise<Described[]> {
    const sample: Row[] = [];
    for await (const rows of this.rows(select, [], 500, 1_000)) sample.push(...rows);
    const columns = sampled(sample);
    for (const column of columns)
      if (column.column.name === 'time' || column.column.name === '_time')
        Object.assign(column, engineColumn(column.column.name, 'datetime'));
      else if (column.column.name === '_timeKey')
        Object.assign(column, engineColumn(column.column.name, 'keyword'));
    if (
      this.http.settings.kind === 'neo4j' &&
      select.kind === 'object' &&
      !columns.some((c) => c.column.name === '_id')
    )
      columns.unshift(engineColumn('_id', 'keyword'));
    if (this.http.settings.kind === 'prometheus')
      for (const [name, type] of [
        ['time', 'datetime'],
        ['value', 'double'],
        ['_series', 'keyword'],
      ])
        if (!columns.some((c) => c.column.name === name)) columns.push(engineColumn(name!, type!));
    return columns;
  }
  async *rows(
    select: SourceSelect,
    _columns: readonly Described[],
    size: number,
    limit = Infinity,
  ): AsyncGenerator<Row[]> {
    if (select.kind === 'object' && (select.filter || select.nativeFilter))
      throw new ConnectorError('sources.filterUnsupported');
    const settings = this.http.settings;
    let count = 0;
    if (settings.kind === 'neo4j') {
      const query = select.kind === 'query' ? readCypher(select.sql) : undefined;
      let label: string | undefined;
      if (select.kind === 'object') {
        if (!(await this.list()).some((object) => object.name === select.object.name))
          throw objectMissing(select.object.name);
        label = cypherLabel(select.object.name);
      }
      let after = '';
      while (count < limit) {
        const take = Math.min(size, 1_000, limit - count);
        const statement = query
          ? `CALL { ${query}\n } RETURN * SKIP $offset LIMIT $limit`
          : `MATCH (n:${label}) WHERE elementId(n) > $after WITH n ORDER BY elementId(n) LIMIT $limit RETURN properties(n) AS properties, elementId(n) AS _id, [(n)-[r]->(m) | {type: type(r), labels: labels(m), id: elementId(m)}] AS _relationships ORDER BY _id`;
        const rows = await this.cypher(statement, {
          offset: count,
          limit: take,
          after,
        });
        if (!rows.length) return;
        count += rows.length;
        after = String(rows.at(-1)!._id ?? '');
        yield query
          ? rows
          : rows.map((row) => {
              const links = new Map<string, Set<string>>();
              for (const edge of records(row._relationships ?? [])) {
                if (!Array.isArray(edge.labels)) throw new ConnectorError('sources.engines.response');
                for (const label of edge.labels) {
                  const name = `_links.${nameOf(edge.type)}.${nameOf(label)}`;
                  const ids = links.get(name) ?? new Set<string>();
                  ids.add(nameOf(edge.id));
                  links.set(name, ids);
                }
              }
              return {
                ...record(row.properties),
                _id: nameOf(row._id),
                ...Object.fromEntries([...links].map(([name, ids]) => [name, [...ids].sort()])),
              };
            });
        if (rows.length < take) return;
      }
      return;
    }
    if (settings.kind === 'influxdb') {
      if (select.kind === 'object') {
        // A sparse measurement with no points in the current window still exists, and no rows is the
        // answer a quiet window deserves: refusing it would fail a sync, a preview, and a
        // description of a table that simply has nothing new.  So the name is checked against the
        // catalog itself, which version 3 already lists without a window.
        const names =
          settings.version === '2'
            ? await this.measurements()
            : (await this.list()).map((object) => object.name);
        if (!names.includes(select.object.name)) throw objectMissing(select.object.name);
      }
      let rows: Row[];
      if (settings.version === '2') {
        const preview = Number.isFinite(limit) ? limit : undefined;
        const window = `range(start: time(v: ${fluxString(this.start)}), stop: time(v: ${fluxString(this.end)}))`;
        rows = await this.flux(
          select.kind === 'query'
            ? fluxPreview(readFlux(select.sql), preview)
            : `from(bucket: ${fluxString(settings.database)}) |> ${window} |> filter(fn: (r) => r._measurement == ${fluxString(select.object.name)}) |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")${preview === undefined ? '' : ` |> limit(n: ${preview})`}`,
        );
      } else {
        const source =
          select.kind === 'query' ? `(${guard(select.sql, TRINO)})` : TRINO.quote(select.object.name);
        rows = await this.sql(
          `SELECT * FROM ${source} AS rio_source WHERE time >= '${this.start}' AND time < '${this.end}' ORDER BY time${Number.isFinite(limit) ? ` LIMIT ${limit}` : ''}`,
        );
      }
      rows = rows.map((row) => ({ ...row, _timeKey: row._time ?? row.time ?? null }));
      for (let offset = 0; offset < Math.min(rows.length, limit); offset += size)
        yield rows.slice(offset, Math.min(offset + size, limit));
      return;
    }
    if (settings.kind !== 'prometheus') throw new ConnectorError('sources.engines.response');
    if (select.kind === 'query') querySql(select.sql, 'postgres');
    const step = settings.stepSeconds * 1_000;
    for (
      let start = Date.parse(this.start);
      start <= Date.parse(this.end) && count < limit;
      start += step * 1_000
    ) {
      const end = Math.min(Date.parse(this.end), start + step * 999);
      const params = new URLSearchParams({
        query: select.kind === 'query' ? select.sql : settings.query,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        step: String(settings.stepSeconds),
      });
      const answer = record(await this.http.json(`/api/v1/query_range?${params}`));
      // An answer Prometheus couldn't produce says why in its own words, which stay in the log.
      if (answer.status !== 'success') throw new ConnectorError('sources.engines.query');
      const data = record(answer.data);
      if (data.resultType !== 'matrix') throw new ConnectorError('sources.engines.response');
      const rows: Row[] = [];
      for (const series of records(data.result)) {
        const labels = record(series.metric);
        if (series.histograms) throw new ConnectorError('sources.engines.histograms');
        if (!Array.isArray(series.values)) throw new ConnectorError('sources.engines.response');
        for (const pair of series.values) {
          if (!Array.isArray(pair) || pair.length !== 2) throw new ConnectorError('sources.engines.response');
          rows.push({
            ...Object.fromEntries(Object.entries(labels).map(([name, value]) => [`label.${name}`, value])),
            _series: JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))),
            time: new Date(Number(pair[0]) * 1_000).toISOString(),
            value: Number.isFinite(Number(pair[1])) ? Number(pair[1]) : null,
          });
        }
      }
      for (let offset = 0; offset < rows.length && count < limit; offset += size) {
        const batch = rows.slice(offset, offset + Math.min(size, limit - count));
        count += batch.length;
        yield batch;
      }
    }
  }
}
