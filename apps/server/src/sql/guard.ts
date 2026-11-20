import { AppError } from '@riosoma/contracts';
import { parse, scan, type ScanToken } from 'libpg-query';

export const quoteName = (name: string): string => `"${name.replaceAll('"', '""')}"`;
function refused(reason: string): never {
  throw new AppError('validation_failed', reason);
}
const FUNCTIONS = new Set(
  `abs ceil ceiling floor round trunc mod power sqrt cbrt exp ln log sign pi
  sin cos tan asin acos atan atan2 degrees radians greatest least coalesce nullif
  lower upper length char_length character_length octet_length concat concat_ws trim btrim ltrim rtrim
  replace reverse left right substr substring strpos split_part starts_with repeat lpad rpad
  regexp_replace regexp_match regexp_matches regexp_split_to_array
  date_part date_trunc age make_date make_time make_timestamp make_timestamptz to_char to_date to_timestamp
  json_array_length jsonb_array_length json_typeof jsonb_typeof json_extract_path jsonb_extract_path
  json_extract_path_text jsonb_extract_path_text json_build_array jsonb_build_array json_build_object
  jsonb_build_object to_json to_jsonb json_strip_nulls jsonb_strip_nulls
  count sum avg min max bool_and bool_or every array_agg string_agg json_agg jsonb_agg
  json_object_agg jsonb_object_agg stddev stddev_pop stddev_samp variance var_pop var_samp
  row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value nth_value
  array_length cardinality array_to_string array_position array_positions array_append array_prepend
  array_cat array_remove array_replace unnest`.split(/\s+/),
);
const TYPES = new Set(
  'text varchar bpchar char boolean bool int2 int4 int8 smallint integer bigint numeric decimal float4 float8 real double precision date time timetz timestamp timestamptz interval json jsonb uuid'.split(
    ' ',
  ),
);
const OPERATORS = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  '=',
  '<>',
  '!=',
  '<',
  '>',
  '<=',
  '>=',
  '||',
  '~~',
  '!~~',
  '~~*',
  '!~~*',
  '~',
  '~*',
  '!~',
  '!~*',
  '->',
  '->>',
  '#>',
  '#>>',
  '@>',
  '<@',
  '?',
  '?|',
  '?&',
  '&',
  '|',
  '#',
  '<<',
  '>>',
]);
export function reserved(name: string): boolean {
  return /^(pg_|sql_)/i.test(name) || ['information_schema', 'pg_catalog'].includes(name.toLowerCase());
}

type Body = Record<string, unknown>;
type Kind = 'string' | 'number' | 'boolean' | 'node' | 'nodes' | 'strings' | string;
const shapes: Record<string, Record<string, Kind>> = {
  SelectStmt: {
    distinctClause: 'nodes',
    targetList: 'nodes',
    fromClause: 'nodes',
    whereClause: 'node',
    groupClause: 'nodes',
    groupDistinct: 'boolean',
    havingClause: 'node',
    windowClause: 'nodes',
    sortClause: 'nodes',
    limitOffset: 'node',
    limitCount: 'node',
    limitOption: 'string',
    op: 'string',
    all: 'boolean',
    larg: 'SelectStmt',
    rarg: 'SelectStmt',
    withClause: 'WithClause',
  },
  WithClause: { ctes: 'nodes', recursive: 'boolean', location: 'number' },
  CommonTableExpr: {
    ctename: 'string',
    aliascolnames: 'nodes',
    ctematerialized: 'string',
    ctequery: 'node',
    location: 'number',
  },
  RangeVar: {
    relname: 'string',
    inh: 'boolean',
    relpersistence: 'string',
    alias: 'Alias',
    location: 'number',
  },
  Alias: { aliasname: 'string', colnames: 'nodes' },
  RangeSubselect: { lateral: 'boolean', subquery: 'node', alias: 'Alias' },
  JoinExpr: {
    jointype: 'string',
    isNatural: 'boolean',
    larg: 'node',
    rarg: 'node',
    usingClause: 'nodes',
    join_using_alias: 'Alias',
    quals: 'node',
    alias: 'Alias',
    rtindex: 'number',
  },
  ResTarget: { name: 'string', val: 'node', location: 'number' },
  ColumnRef: { fields: 'nodes', location: 'number' },
  String: { sval: 'string' },
  Integer: { ival: 'number' },
  Float: { fval: 'string' },
  Boolean: { boolval: 'boolean' },
  A_Star: {},
  A_Const: {
    ival: 'Integer',
    fval: 'Float',
    boolval: 'Boolean',
    sval: 'String',
    isnull: 'boolean',
    location: 'number',
  },
  A_Expr: {
    kind: 'string',
    name: 'nodes',
    lexpr: 'node',
    rexpr: 'node',
    rexpr_list_start: 'number',
    rexpr_list_end: 'number',
    location: 'number',
  },
  BoolExpr: { boolop: 'string', args: 'nodes', location: 'number' },
  FuncCall: {
    funcname: 'nodes',
    args: 'nodes',
    agg_order: 'nodes',
    agg_filter: 'node',
    over: 'WindowDef',
    agg_within_group: 'boolean',
    agg_star: 'boolean',
    agg_distinct: 'boolean',
    func_variadic: 'boolean',
    funcformat: 'string',
    location: 'number',
  },
  WindowDef: {
    name: 'string',
    refname: 'string',
    partitionClause: 'nodes',
    orderClause: 'nodes',
    frameOptions: 'number',
    startOffset: 'node',
    endOffset: 'node',
    location: 'number',
  },
  SortBy: { node: 'node', sortby_dir: 'string', sortby_nulls: 'string', location: 'number' },
  TypeCast: { arg: 'node', typeName: 'TypeName', location: 'number' },
  TypeName: { names: 'nodes', typmods: 'nodes', typemod: 'number', arrayBounds: 'nodes', location: 'number' },
  NullTest: { arg: 'node', nulltesttype: 'string', argisrow: 'boolean', location: 'number' },
  BooleanTest: { arg: 'node', booltesttype: 'string', location: 'number' },
  CaseExpr: { arg: 'node', args: 'nodes', defresult: 'node', location: 'number' },
  CaseWhen: { expr: 'node', result: 'node', location: 'number' },
  CoalesceExpr: { args: 'nodes', location: 'number' },
  MinMaxExpr: { op: 'string', args: 'nodes', location: 'number' },
  SQLValueFunction: { op: 'string', typmod: 'number', location: 'number' },
  SubLink: {
    subLinkType: 'string',
    subLinkId: 'number',
    testexpr: 'node',
    operName: 'nodes',
    subselect: 'node',
    location: 'number',
  },
  List: { items: 'nodes' },
  A_ArrayExpr: { elements: 'nodes', list_start: 'number', list_end: 'number', location: 'number' },
  RowExpr: { args: 'nodes', row_format: 'string', location: 'number' },
  A_Indirection: { arg: 'node', indirection: 'nodes' },
  A_Indices: { is_slice: 'boolean', lidx: 'node', uidx: 'node' },
  GroupingSet: { kind: 'string', content: 'nodes', location: 'number' },
  GroupingFunc: { args: 'nodes', location: 'number' },
};
const body = (value: unknown): Body => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refused('sql.guard.unsupported');
  return value as Body;
};
const names = (value: unknown): string[] => {
  if (!Array.isArray(value)) return refused('sql.guard.unsupported');
  return value.map((item: unknown) => {
    const name = body(body(item).String).sval;
    return typeof name === 'string' ? name : refused('sql.guard.unsupported');
  });
};
const PRIMITIVE = new Set(['string', 'number', 'boolean']);
/** Nodes the guard reads only where they belong in a statement, never as an expression */
const STRUCTURAL = new Set([
  'SelectStmt',
  'WithClause',
  'CommonTableExpr',
  'RangeVar',
  'RangeSubselect',
  'JoinExpr',
  'ResTarget',
  'Alias',
]);
const STAR = Symbol('star');

/** A stored table the person may read: the trusted subquery that stands in for it, and its columns. */
export interface ScopedTable {
  select: string;
  columns: readonly string[];
}
/** A column's name, or null when PostgreSQL names it in a way the guard doesn't rely on */
type Column = string | null;
/** A relation a qualified reference can name */
interface Relation {
  name: string;
  columns: readonly Column[];
}
/** What one FROM item gives the query: relations it can name, and columns it can use unqualified */
interface Item {
  relations: readonly Relation[];
  columns: readonly Column[];
}
/**
 * The names one query level resolves against.  `visible` is what PostgreSQL lets this part of the
 * query see.  `all` holds every relation the level has, seen or not, so a qualified name that
 * could reach more than one relation must be a column of each of them.
 */
interface Scope {
  visible: readonly Item[];
  all: Relation[];
  parent: Scope | null;
}
interface Cte {
  name: string;
  query: unknown;
  colnames: string[];
  recursive: boolean;
  state: 'pending' | 'active' | 'done';
  columns: Column[] | null;
  env: Env | null;
  scope: Scope | null;
}
interface Env {
  ctes: ReadonlyMap<string, Cte>;
  parent: Env | null;
}
interface From {
  all: Relation[];
  parent: Scope | null;
  env: Env | null;
  /** The items a LATERAL subquery here may see */
  lateral: readonly Item[];
}

/**
 * Only parser locations choose replacement spans.  Unclassified syntax never reaches execution.
 *
 * Every column reference must resolve against the known columns of a relation in scope, as
 * PostgreSQL resolves it.  PostgreSQL reads `p.name` as a call of the function `name` on the whole
 * row when `name` isn't one of p's columns, so a reference that doesn't resolve is refused rather
 * than left to PostgreSQL.
 */
export async function rewriteSql(source: string, tables: ReadonlyMap<string, ScopedTable>): Promise<string> {
  if (Buffer.byteLength(source) > 100_000 || source.includes('\0')) refused('sql.guard.size');
  let parsed: { stmts: Array<{ stmt: Record<string, unknown> }> };
  let tokens: ScanToken[];
  try {
    parsed = (await parse(source)) as unknown as typeof parsed;
    tokens = (await scan(source)).tokens;
  } catch {
    return refused('sql.guard.syntax');
  }
  if (parsed.stmts.length !== 1 || !parsed.stmts[0]?.stmt?.SelectStmt) refused('sql.guard.select');
  const bytes = Buffer.from(source);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let visited = 0;
  const active: Cte[] = [];

  /** A node's fields, refusing any field its shape doesn't name or of the wrong primitive type */
  function fields(type: string, value: unknown, depth: number): Body {
    if (++visited > 20_000 || depth > 100) refused('sql.guard.size');
    const spec = shapes[type];
    if (!spec) refused('sql.guard.unsupported');
    const current = body(value);
    for (const [key, item] of Object.entries(current)) {
      if (!Object.hasOwn(spec, key)) refused('sql.guard.unsupported');
      const kind = spec[key]!;
      if (PRIMITIVE.has(kind) && typeof item !== kind) refused('sql.guard.unsupported');
      if (kind === 'nodes' && !Array.isArray(item)) refused('sql.guard.unsupported');
    }
    return current;
  }
  function unwrap(value: unknown): [string, unknown] {
    const entries = Object.entries(body(value));
    if (entries.length !== 1) refused('sql.guard.unsupported');
    return entries[0]!;
  }
  const list = (value: unknown): unknown[] => (value === undefined ? [] : (value as unknown[]));
  function statement(value: unknown): unknown {
    const [type, contents] = unwrap(value);
    if (type !== 'SelectStmt') refused('sql.guard.select');
    return contents;
  }

  function lookup(env: Env | null, name: string): Cte | undefined {
    for (let frame = env; frame; frame = frame.parent) {
      const found = frame.ctes.get(name);
      if (found) return found;
    }
    return undefined;
  }
  function rename(columns: readonly Column[], colnames: readonly string[]): Column[] {
    if (colnames.length > columns.length) refused('sql.guard.unsupported');
    return columns.map((column, index) => (index < colnames.length ? colnames[index]! : column));
  }
  function relationsNamed(scope: Scope | null, name: string, visible: boolean): Relation[][] {
    const levels: Relation[][] = [];
    for (let level = scope; level; level = level.parent)
      levels.push(
        (visible ? level.visible.flatMap((item) => item.relations) : level.all).filter(
          (relation) => relation.name === name,
        ),
      );
    return levels;
  }
  /** The relation PostgreSQL finds for a qualified name: the nearest level that sees one by it */
  function nearest(scope: Scope, name: string): Relation {
    const level = relationsNamed(scope, name, true).find((found) => found.length);
    if (!level || level.length !== 1) refused('sql.run.column');
    return level[0]!;
  }
  /** `relation.column`, which must be a column of every relation the name could reach */
  function qualified(scope: Scope, relation: string, column: string) {
    nearest(scope, relation);
    for (const candidate of relationsNamed(scope, relation, false).flat())
      if (!candidate.columns.includes(column)) refused('sql.run.column');
  }
  /** An unqualified name, which must be a column the query sees, or one of its output names */
  function unqualified(scope: Scope, column: string, outputs: readonly Column[] | null) {
    if (outputs?.includes(column)) return;
    for (let level: Scope | null = scope; level; level = level.parent)
      if (level.visible.some((item) => item.columns.includes(column))) return;
    refused('sql.run.column');
  }
  /** `relation.*`: the columns of the relation PostgreSQL finds, the same whichever it could be */
  function starOf(scope: Scope, name: string): readonly Column[] {
    const found = nearest(scope, name);
    const same = (a: readonly Column[], b: readonly Column[]) =>
      a.length === b.length && a.every((column, index) => column === b[index]);
    for (const candidate of relationsNamed(scope, name, false).flat())
      if (!same(candidate.columns, found.columns)) refused('sql.guard.unsupported');
    return found.columns;
  }
  function parts(value: unknown, depth: number): Array<string | typeof STAR> {
    const ref = fields('ColumnRef', value, depth);
    const items = list(ref.fields).map((part) => {
      const [type, contents] = unwrap(part);
      if (type === 'A_Star') {
        fields('A_Star', contents, depth + 1);
        return STAR;
      }
      if (type !== 'String') refused('sql.guard.unsupported');
      const name = fields('String', contents, depth + 1).sval;
      return typeof name === 'string' ? name : refused('sql.guard.unsupported');
    });
    if (!items.length || items.length > 2 || items.slice(0, -1).includes(STAR))
      refused('sql.guard.unsupported');
    return items;
  }
  /** A column reference in an expression.  A whole row is only ever `relation.*`. */
  function columnRef(value: unknown, scope: Scope, depth: number, outputs: readonly Column[] | null = null) {
    const ref = parts(value, depth);
    const [first, second] = ref;
    if (first === STAR) refused('sql.guard.unsupported');
    if (second === undefined) unqualified(scope, first as string, outputs);
    else if (second === STAR) nearest(scope, first as string);
    else qualified(scope, first as string, second);
  }
  /** A bare name, as ORDER BY and GROUP BY may use an output column's name */
  function bareName(value: unknown): string | null {
    const [type, contents] = unwrap(value);
    if (type !== 'ColumnRef') return null;
    const ref = list(body(contents).fields);
    if (ref.length !== 1) return null;
    const [partType, part] = unwrap(ref[0]);
    return partType === 'String' ? (body(part).sval as string) : null;
  }

  function expr(value: unknown, scope: Scope, env: Env | null, depth: number) {
    if (value === null) return;
    const [type, contents] = unwrap(value);
    typed(type, contents, scope, env, depth + 1);
  }
  function typed(type: string, value: unknown, scope: Scope, env: Env | null, depth: number) {
    if (STRUCTURAL.has(type)) refused('sql.guard.unsupported');
    if (type === 'ColumnRef') return columnRef(value, scope, depth);
    const current = fields(type, value, depth);
    if (type === 'SubLink') {
      checkOperator(type, current);
      expr(current.testexpr ?? null, scope, env, depth);
      select(statement(current.subselect), scope, env, depth + 1);
      return;
    }
    if (type === 'FuncCall') {
      const fn = names(current.funcname);
      if (fn.length !== 1 || !FUNCTIONS.has(fn[0]!)) refused('sql.guard.function');
    }
    if (type === 'TypeName') {
      const parts = names(current.names);
      const spelling = parts.at(-1)!;
      if (parts.length > 2 || (parts.length === 2 && parts[0] !== 'pg_catalog') || !TYPES.has(spelling))
        refused('sql.guard.type');
      const token = tokens.find((item) => item.start === current.location);
      // The grammar adds pg_catalog for type keywords, but an identifier spells an explicit schema.
      if (parts.length === 2 && (!token || token.tokenName === 'IDENT' || token.tokenName === 'UIDENT'))
        refused('sql.guard.type');
    }
    if (type === 'A_Expr') checkOperator(type, current);
    if (type === 'A_Indirection' && list(current.indirection).some((part) => !body(part).A_Indices))
      refused('sql.guard.unsupported');
    if (
      type === 'SQLValueFunction' &&
      ![
        'SVFOP_CURRENT_DATE',
        'SVFOP_CURRENT_TIME',
        'SVFOP_CURRENT_TIMESTAMP',
        'SVFOP_LOCALTIME',
        'SVFOP_LOCALTIMESTAMP',
      ].includes(String(current.op))
    )
      refused('sql.guard.function');
    const spec = shapes[type]!;
    for (const [key, item] of Object.entries(current)) {
      const kind = spec[key]!;
      if (kind === 'node') expr(item, scope, env, depth);
      else if (kind === 'nodes') for (const child of item as unknown[]) expr(child, scope, env, depth);
      else if (!PRIMITIVE.has(kind)) typed(kind, item, scope, env, depth + 1);
    }
  }
  function checkOperator(type: string, current: Body) {
    if (type === 'SubLink' && !current.operName) return;
    const ops = names(type === 'A_Expr' ? current.name : current.operName);
    if (
      ops.length !== 1 ||
      (!OPERATORS.has(ops[0]!) &&
        !(
          type === 'A_Expr' &&
          ['AEXPR_BETWEEN', 'AEXPR_NOT_BETWEEN', 'AEXPR_BETWEEN_SYM', 'AEXPR_NOT_BETWEEN_SYM'].includes(
            String(current.kind),
          ) &&
          ['BETWEEN', 'NOT BETWEEN', 'BETWEEN SYMMETRIC', 'NOT BETWEEN SYMMETRIC'].includes(ops[0]!)
        ))
    )
      refused('sql.guard.unsupported');
  }
  /** The expression an ORDER BY item sorts by */
  function sortKey(value: unknown, depth: number): unknown {
    const [type, contents] = unwrap(value);
    if (type !== 'SortBy') refused('sql.guard.unsupported');
    return fields('SortBy', contents, depth).node;
  }
  /** An ORDER BY or GROUP BY item, where a bare name may also be an output column's name */
  function ordering(
    value: unknown,
    scope: Scope,
    env: Env | null,
    depth: number,
    outputs: readonly Column[],
  ) {
    const name = bareName(value);
    if (name === null) expr(value, scope, env, depth);
    else columnRef(unwrap(value)[1], scope, depth + 1, outputs);
  }

  function withClause(value: unknown, parent: Scope | null, env: Env | null, depth: number): Env {
    const clause = fields('WithClause', value, depth);
    const recursive = clause.recursive === true;
    const entries = list(clause.ctes).map((item): Cte => {
      const [type, contents] = unwrap(item);
      if (type !== 'CommonTableExpr') refused('sql.guard.unsupported');
      const cte = fields('CommonTableExpr', contents, depth + 1);
      const name = cte.ctename;
      if (typeof name !== 'string' || reserved(name)) refused('sql.guard.table');
      return {
        name,
        query: cte.ctequery,
        colnames: cte.aliascolnames === undefined ? [] : names(cte.aliascolnames),
        recursive,
        state: 'pending',
        columns: null,
        env: null,
        scope: parent,
      };
    });
    if (!entries.length || new Set(entries.map((entry) => entry.name)).size !== entries.length)
      refused('sql.guard.unsupported');
    if (recursive) {
      // Every name in a recursive list reaches every member, including those later in the list.
      const frame: Env = { ctes: new Map(entries.map((entry) => [entry.name, entry])), parent: env };
      for (const entry of entries) entry.env = frame;
      for (const entry of entries) if (entry.state === 'pending') analyze(entry, depth + 1);
      return frame;
    }
    let current = env;
    for (const entry of entries) {
      entry.env = current;
      analyze(entry, depth + 1);
      current = { ctes: new Map([[entry.name, entry]]), parent: current };
    }
    return current!;
  }
  function analyze(entry: Cte, depth: number) {
    entry.state = 'active';
    active.push(entry);
    const outputs = select(
      statement(entry.query),
      entry.scope,
      entry.env,
      depth + 1,
      entry.recursive
        ? (left) => {
            entry.columns = rename(left, entry.colnames);
          }
        : undefined,
    );
    entry.columns = rename(outputs, entry.colnames);
    active.pop();
    entry.state = 'done';
  }

  function named(
    alias: unknown,
    name: string | undefined,
    columns: readonly Column[],
    from: From,
    depth: number,
  ): Item {
    const given = alias === undefined ? undefined : fields('Alias', alias, depth);
    const renamed = rename(columns, given?.colnames === undefined ? [] : names(given.colnames));
    const relationName = (given?.aliasname as string | undefined) ?? name;
    if (relationName === undefined) return { relations: [], columns: renamed };
    const relation = { name: relationName, columns: renamed };
    from.all.push(relation);
    return { relations: [relation], columns: renamed };
  }
  function fromItem(value: unknown, from: From, depth: number): Item {
    const [type, contents] = unwrap(value);
    if (type === 'RangeVar') {
      const current = fields('RangeVar', contents, depth);
      const name = current.relname;
      if (typeof name !== 'string' || reserved(name) || current.inh !== true) refused('sql.guard.table');
      const cte = lookup(from.env, name);
      if (cte) {
        if (cte.state === 'pending') analyze(cte, depth + 1);
        // Only the member being read may refer to itself, and only once its first term is known.
        else if (cte.state === 'active' && (active.at(-1) !== cte || !cte.columns))
          refused('sql.guard.unsupported');
        return named(current.alias, name, cte.columns!, from, depth + 1);
      }
      const table = tables.get(name);
      if (!table) refused('sql.guard.table');
      const token = tokens.find((item) => item.start === current.location);
      if (!token || token.tokenName !== 'IDENT') refused('sql.guard.unsupported');
      edits.push({
        start: token!.start,
        end: token!.end,
        text: `(${table!.select})${current.alias ? '' : ` AS ${quoteName(name)}`}`,
      });
      return named(current.alias, name, table!.columns, from, depth + 1);
    }
    if (type === 'RangeSubselect') {
      const current = fields('RangeSubselect', contents, depth);
      // A subquery without LATERAL sees none of its own level, only the levels around it.
      const scope: Scope = {
        visible: current.lateral === true ? from.lateral : [],
        all: from.all,
        parent: from.parent,
      };
      const outputs = select(statement(current.subquery), scope, from.env, depth + 1);
      return named(current.alias, undefined, outputs, from, depth + 1);
    }
    if (type === 'JoinExpr') {
      const current = fields('JoinExpr', contents, depth);
      if (!['JOIN_INNER', 'JOIN_LEFT', 'JOIN_FULL', 'JOIN_RIGHT'].includes(String(current.jointype)))
        refused('sql.guard.unsupported');
      const left = fromItem(current.larg, from, depth + 1);
      const right = fromItem(current.rarg, { ...from, lateral: [...from.lateral, left] }, depth + 1);
      const using = current.usingClause === undefined ? [] : names(current.usingClause);
      let merged = using;
      if (current.isNatural === true) {
        if (using.length || current.quals !== undefined) refused('sql.guard.unsupported');
        // Only known names can say which columns a natural join merges.
        if (left.columns.includes(null) || right.columns.includes(null)) refused('sql.guard.unsupported');
        merged = left.columns.filter((column) => right.columns.includes(column)) as string[];
      }
      const count = (columns: readonly Column[], name: string) =>
        columns.filter((column) => column === name).length;
      if (new Set(merged).size !== merged.length) refused('sql.guard.unsupported');
      for (const name of merged)
        if (count(left.columns, name) !== 1 || count(right.columns, name) !== 1) refused('sql.run.column');
      const rest = (columns: readonly Column[]) =>
        columns.filter((column) => column === null || !merged.includes(column));
      const columns = [...merged, ...rest(left.columns), ...rest(right.columns)];
      // ON sees only the join's own two sides, and the levels around the query.
      if (current.quals !== undefined)
        expr(current.quals, { visible: [left, right], all: from.all, parent: from.parent }, from.env, depth);
      const relations = [...left.relations, ...right.relations];
      if (current.join_using_alias !== undefined) {
        const alias = fields('Alias', current.join_using_alias, depth + 1);
        if (!using.length || alias.colnames !== undefined) refused('sql.guard.unsupported');
        const relation = { name: alias.aliasname as string, columns: using };
        from.all.push(relation);
        relations.push(relation);
      }
      // An alias hides the names of the tables inside the join.
      if (current.alias !== undefined) return named(current.alias, undefined, columns, from, depth + 1);
      return { relations, columns };
    }
    return refused('sql.guard.unsupported');
  }
  function target(value: unknown, scope: Scope, env: Env | null, depth: number): Column[] {
    const [type, contents] = unwrap(value);
    if (type !== 'ResTarget') refused('sql.guard.unsupported');
    const current = fields('ResTarget', contents, depth);
    const alias = current.name as string | undefined;
    const [valueType, valueContents] = unwrap(current.val);
    if (valueType !== 'ColumnRef') {
      expr(current.val, scope, env, depth);
      // Only an alias names an expression's column for certain.
      return [alias ?? null];
    }
    const ref = parts(valueContents, depth + 1);
    if (ref.at(-1) === STAR) {
      if (alias !== undefined) refused('sql.guard.unsupported');
      if (ref.length === 1) return scope.visible.flatMap((item) => item.columns);
      return [...starOf(scope, ref[0] as string)];
    }
    columnRef(valueContents, scope, depth + 1);
    return [alias ?? (ref.at(-1) as string)];
  }

  /** Checks a SELECT and returns its output columns' names. */
  function select(
    value: unknown,
    parent: Scope | null,
    outer: Env | null,
    depth: number,
    left?: (columns: Column[]) => void,
  ): Column[] {
    const current = fields('SelectStmt', value, depth);
    const env =
      current.withClause === undefined ? outer : withClause(current.withClause, parent, outer, depth + 1);
    const limits = (scope: Scope) => {
      expr(current.limitOffset ?? null, scope, env, depth);
      expr(current.limitCount ?? null, scope, env, depth);
    };
    if (current.op !== undefined && current.op !== 'SETOP_NONE') {
      if (
        !['SETOP_UNION', 'SETOP_INTERSECT', 'SETOP_EXCEPT'].includes(String(current.op)) ||
        current.larg === undefined ||
        current.rarg === undefined ||
        [
          'targetList',
          'fromClause',
          'whereClause',
          'groupClause',
          'havingClause',
          'windowClause',
          'distinctClause',
        ].some((key) => current[key] !== undefined)
      )
        refused('sql.guard.unsupported');
      const outputs = select(current.larg, parent, env, depth + 1);
      left?.(outputs);
      select(current.rarg, parent, env, depth + 1);
      // A set operation's ORDER BY sees only its output columns.
      const result: Scope = { visible: [{ relations: [], columns: outputs }], all: [], parent };
      for (const item of list(current.sortClause)) expr(sortKey(item, depth + 1), result, env, depth + 1);
      limits(result);
      return outputs;
    }
    if (current.larg !== undefined || current.rarg !== undefined || !Array.isArray(current.targetList))
      refused('sql.guard.unsupported');
    const all: Relation[] = [];
    const items: Item[] = [];
    for (const item of list(current.fromClause))
      items.push(fromItem(item, { all, parent, env, lateral: [...items] }, depth + 1));
    const scope: Scope = { visible: items, all, parent };
    expr(current.whereClause ?? null, scope, env, depth);
    const outputs = (current.targetList as unknown[]).flatMap((item) => target(item, scope, env, depth + 1));
    for (const item of list(current.groupClause)) ordering(item, scope, env, depth, outputs);
    expr(current.havingClause ?? null, scope, env, depth);
    for (const item of list(current.windowClause)) expr(item, scope, env, depth);
    for (const item of list(current.distinctClause)) expr(item, scope, env, depth);
    for (const item of list(current.sortClause))
      ordering(sortKey(item, depth + 1), scope, env, depth + 1, outputs);
    limits(scope);
    return outputs;
  }

  select(statement(parsed.stmts[0]!.stmt), null, null, 0);
  // Statement terminators and trailing comments cannot swallow the enclosing row limit.
  const last = tokens
    .filter((token) => token.tokenName !== 'SQL_COMMENT' && token.tokenName !== 'C_COMMENT')
    .at(-1);
  const end = last?.text === ';' ? last.start : bytes.length;
  let rewritten = bytes.subarray(0, end).toString();
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    const encoded = Buffer.from(rewritten);
    rewritten =
      encoded.subarray(0, edit.start).toString() + edit.text + encoded.subarray(edit.end).toString();
  }
  try {
    await parse(`SELECT * FROM (${rewritten}\n) AS result LIMIT 1`);
  } catch {
    refused('sql.guard.unsupported');
  }
  return `${rewritten}\n`;
}
