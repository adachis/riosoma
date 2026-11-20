import { describe as suite, expect, it } from 'vitest';
import {
  check,
  describe,
  evaluate,
  fieldType,
  FUNCTIONS,
  isError,
  parse,
  references,
  resolve,
  type Ast,
  type EvaluationContext,
  type FormulaField,
  type FormulaRecord,
  type FormulaValue,
} from './index.js';

export const fields: FormulaField[] = [
  { id: 'n', name: 'Number', type: 'number' },
  { id: 't', name: 'Text', type: 'text' },
  { id: 'b', name: 'Boolean', type: 'checkbox' },
  { id: 'd', name: 'Date', type: 'date' },
  { id: 'dt', name: 'Instant', type: 'date', options: { includeTime: true } },
  { id: 'a', name: 'Choices', type: 'multipleSelect' },
  { id: 's', name: 'Choice', type: 'singleSelect' },
  { id: 'p', name: 'Person', type: 'createdBy' },
  { id: 'r', name: 'Trip', type: 'dateRange' },
  { id: 'rt', name: 'Shift', type: 'dateRange', options: { includeTime: true } },
  { id: 'g', name: 'Signed', type: 'signature' },
  { id: 'l', name: 'Place', type: 'location' },
  { id: 'j', name: 'Data', type: 'json' },
  { id: 'remote_n', name: 'Amount', type: 'number', tableId: 'totals', tableName: 'Totals' },
  { id: 'remote_t', name: 'Key', type: 'text', tableId: 'totals', tableName: 'Totals' },
];
export const record: FormulaRecord = {
  id: 'rec1',
  createdAt: '2024-01-01T01:02:03.000Z',
  updatedAt: '2024-02-02T02:03:04.000Z',
  values: {
    n: 4,
    t: 'hello',
    b: true,
    d: '2024-02-29',
    dt: '2024-03-10T09:30:45.000Z',
    a: ['x', 'y', 'x'],
    s: 'x',
    p: 'u',
    r: { start: '2024-02-27', end: '2024-03-02' },
    rt: { start: '2024-03-10T09:00:00.000Z', end: '2024-03-10T17:30:00.000Z' },
    g: { drawing: null, name: 'Pat', signedBy: null, signedAt: '2024-03-01T12:00:00.000Z' },
    l: { lat: 40.7128, lng: -74.006, label: 'New York' },
    j: '{"a":[1,2]}',
  },
  fieldUpdatedAt: { n: '2024-01-05T00:00:00.000Z', t: '2024-01-06T00:00:00.000Z' },
};
export const context: EvaluationContext = {
  now: '2024-03-10T09:30:45.000Z',
  timeZone: 'UTC',
  records: [
    { ...record, id: 'before', createdAt: '2023-01-01T00:00:00.000Z', values: { ...record.values, n: 2 } },
    record,
    { ...record, id: 'after', createdAt: '2025-01-01T00:00:00.000Z', values: { ...record.values, n: 8 } },
  ],
  tables: new Map([
    [
      'totals',
      [
        { ...record, id: 'first', values: { remote_n: 3, remote_t: 'a' } },
        { ...record, id: 'second', values: { remote_n: 7, remote_t: 'a' } },
      ],
    ],
  ]),
  choices: new Map([
    ['x', 'Red'],
    ['y', 'Blue'],
  ]),
  people: new Map([['u', 'Pat']]),
};
export function astOf(source: string): Ast {
  const parsed = parse(source);
  if ('error' in parsed) throw new Error(JSON.stringify(parsed));
  const resolved = resolve(parsed.ast, fields);
  if ('error' in resolved) throw new Error(JSON.stringify(resolved));
  return resolved.ast;
}
function run(source: string, row = record, ctx = context): FormulaValue {
  const ast = astOf(source);
  expect(check(ast), source).toHaveProperty('type');
  return evaluate(ast, row, ctx);
}
const error = (messageKey: string) => ({ error: '#ERROR!' as const, messageKey });
const numberError = error('formula.runtime.number');
const divisionError = error('formula.runtime.divisionByZero');
const explicitError = error('formula.runtime.explicit');
type Case = readonly [string, FormulaValue];
const cases: Record<string, readonly Case[]> = {
  XLOOKUP: [
    ['XLOOKUP("a", Totals[Key], Totals[Amount])', 3],
    ['XLOOKUP("missing", Totals[Key], Totals[Amount], 9)', 9],
    ['XLOOKUP(ERROR(), Totals[Key], Totals[Amount])', explicitError],
  ],
  SUMIFS: [
    ['SUMIFS(Totals[Amount], Totals[Key], "a")', 10],
    ['SUMIFS(Totals[Amount], Totals[Key], "missing")', 0],
    ['SUMIFS(Totals[Amount], Totals[Key], ERROR())', explicitError],
  ],
  COUNTIFS: [
    ['COUNTIFS(Totals[Key], "a")', 2],
    ['COUNTIFS(Totals[Amount], ">" & {Number})', 1],
    ['COUNTIFS(Totals[Key], ERROR())', explicitError],
  ],
  AVERAGEIFS: [
    ['AVERAGEIFS(Totals[Amount], Totals[Key], "a")', 5],
    ['AVERAGEIFS(Totals[Amount], Totals[Key], "missing")', divisionError],
    ['AVERAGEIFS(Totals[Amount], Totals[Key], ERROR())', explicitError],
  ],
  MAXIFS: [
    ['MAXIFS(Totals[Amount], Totals[Key], "a")', 7],
    ['MAXIFS(Totals[Amount], Totals[Key], "missing")', 0],
    ['MAXIFS(Totals[Amount], Totals[Key], ERROR())', explicitError],
  ],
  MINIFS: [
    ['MINIFS(Totals[Amount], Totals[Key], "a")', 3],
    ['MINIFS(Totals[Amount], Totals[Key], "missing")', 0],
    ['MINIFS(Totals[Amount], Totals[Key], ERROR())', explicitError],
  ],
  RANK: [
    ['RANK({Number})', 2],
    ['RANK(BLANK())', null],
    ['RANK(ERROR())', explicitError],
  ],
  PREVIOUS: [
    ['PREVIOUS({Number})', 2],
    ['PREVIOUS(BLANK())', null],
    ['PREVIOUS(ERROR())', explicitError],
  ],
  NEXT: [
    ['NEXT({Number})', 8],
    ['NEXT(BLANK())', null],
    ['NEXT(ERROR())', explicitError],
  ],
  RUNNINGSUM: [
    ['RUNNINGSUM({Number})', 6],
    ['RUNNINGSUM(BLANK())', 0],
    ['RUNNINGSUM(ERROR())', explicitError],
  ],
  RUNNINGCOUNT: [
    ['RUNNINGCOUNT()', 2],
    ['RUNNINGCOUNT(BLANK())', 0],
    ['RUNNINGCOUNT(ERROR())', explicitError],
  ],
  ABS: [
    ['ABS(-2)', 2],
    ['ABS(BLANK())', 0],
    ['ABS(ERROR())', explicitError],
  ],
  ROUND: [
    ['ROUND(-1.5,0)', -1],
    ['ROUND(1.25,1)', 1.3],
    ['ROUND(BLANK(),2)', 0],
    ['ROUND(2,400)', numberError],
  ],
  ROUNDUP: [
    ['ROUNDUP(-1.1,0)', -2],
    ['ROUNDUP(123,-1)', 130],
    ['ROUNDUP(BLANK(),0)', 0],
  ],
  ROUNDDOWN: [
    ['ROUNDDOWN(-1.9,0)', -1],
    ['ROUNDDOWN(1.29,1)', 1.2],
    ['ROUNDDOWN(BLANK(),0)', 0],
  ],
  CEILING: [
    ['CEILING(-1.9)', -1],
    ['CEILING(1.01,.1)', 1.1],
    ['CEILING(BLANK())', 0],
    ['CEILING(2,0)', numberError],
  ],
  FLOOR: [
    ['FLOOR(-1.1)', -2],
    ['FLOOR(1.99,.1)', 1.9000000000000001],
    ['FLOOR(BLANK())', 0],
  ],
  INT: [
    ['INT(-1.9)', -2],
    ['INT(1.9)', 1],
    ['INT(BLANK())', 0],
  ],
  MOD: [
    ['MOD(7,5)', 2],
    ['MOD(-7,5)', -2],
    ['MOD(1,BLANK())', divisionError],
  ],
  POWER: [
    ['POWER(3,3)', 27],
    ['POWER(BLANK(),0)', 1],
    ['POWER(-1,.5)', numberError],
  ],
  SQRT: [
    ['SQRT(9)', 3],
    ['SQRT(BLANK())', 0],
    ['SQRT(-1)', numberError],
  ],
  EXP: [
    ['EXP(1)', Math.E],
    ['EXP(BLANK())', 1],
    ['EXP(1000)', numberError],
  ],
  LOG: [
    ['LOG(1024,2)', 10],
    ['LOG(100)', 2],
    ['LOG(BLANK())', numberError],
  ],
  LOG10: [
    ['LOG10(1000)', 3],
    ['LOG10(1)', 0],
    ['LOG10(BLANK())', numberError],
  ],
  MAX: [
    ['MAX(1,3,-1)', 3],
    ['MAX(-2,BLANK())', -2],
    ['MAX(BLANK())', 0],
  ],
  MIN: [
    ['MIN(1,3,-1)', -1],
    ['MIN(2,BLANK())', 2],
    ['MIN(BLANK())', 0],
  ],
  SUM: [
    ['SUM(1,2,3)', 6],
    ['SUM(1,BLANK())', 1],
    ['SUM(ERROR(),2)', explicitError],
  ],
  AVERAGE: [
    ['AVERAGE(1,3)', 2],
    ['AVERAGE(4,BLANK())', 4],
    ['AVERAGE(BLANK())', divisionError],
  ],
  COUNT: [
    ['COUNT(1,2,"3")', 2],
    ['COUNT(BLANK())', 0],
    ['COUNT({Choices})', 0],
  ],
  COUNTA: [
    ['COUNTA(0,FALSE(),"",BLANK())', 2],
    ['COUNTA({Choices})', 3],
    ['COUNTA(BLANK())', 0],
  ],
  COUNTALL: [
    ['COUNTALL(0,FALSE(),"",BLANK())', 4],
    ['COUNTALL({Choices})', 3],
    ['COUNTALL(BLANK())', 1],
  ],
  VALUE: [
    ['VALUE("$1,000.25")', 1000.25],
    ['VALUE("-1e2")', -100],
    ['VALUE(BLANK())', numberError],
  ],
  EVEN: [
    ['EVEN(2.2)', 4],
    ['EVEN(-1.6)', -2],
    ['EVEN(BLANK())', 0],
  ],
  ODD: [
    ['ODD(1.1)', 3],
    ['ODD(-1.1)', -3],
    ['ODD(BLANK())', 1],
  ],
  CONCATENATE: [
    ['CONCATENATE("x",3,TRUE())', 'x31'],
    ['CONCATENATE(BLANK())', ''],
    ['CONCATENATE({Choice},{Person})', 'RedPat'],
  ],
  LEN: [
    ['LEN("hi")', 2],
    ['LEN("😀")', 2],
    ['LEN(BLANK())', 0],
  ],
  LEFT: [
    ['LEFT("hello",2)', 'he'],
    ['LEFT(BLANK(),2)', ''],
    ['LEFT("hi",-1)', error('formula.runtime.argument')],
  ],
  RIGHT: [
    ['RIGHT("hello",2)', 'lo'],
    ['RIGHT("hi",0)', ''],
    ['RIGHT(BLANK(),2)', ''],
  ],
  MID: [
    ['MID("hello",2,3)', 'ell'],
    ['MID(BLANK(),1,3)', ''],
    ['MID("hi",0,1)', error('formula.runtime.argument')],
  ],
  FIND: [
    ['FIND("l","hello")', 3],
    ['FIND("l","hello",4)', 4],
    ['FIND("z",BLANK())', 0],
  ],
  SEARCH: [
    ['SEARCH("HE","hello")', 1],
    ['SEARCH("l","hello",4)', 4],
    ['SEARCH("z",BLANK())', null],
  ],
  SUBSTITUTE: [
    ['SUBSTITUTE("a a","a","b")', 'b b'],
    ['SUBSTITUTE("a a","a","$&",2)', 'a $&'],
    ['SUBSTITUTE(BLANK(),"a","b")', ''],
  ],
  REPLACE: [
    ['REPLACE("database",2,5,"o")', 'dose'],
    ['REPLACE(BLANK(),1,0,"x")', 'x'],
    ['REPLACE("x",0,1,"y")', error('formula.runtime.argument')],
  ],
  LOWER: [
    ['LOWER("HELLO")', 'hello'],
    ['LOWER("É")', 'é'],
    ['LOWER(BLANK())', ''],
  ],
  UPPER: [
    ['UPPER("hello")', 'HELLO'],
    ['UPPER("ß")', 'SS'],
    ['UPPER(BLANK())', ''],
  ],
  TRIM: [
    ['TRIM(" a  b ")', 'a  b'],
    ['TRIM("\u00a0hi\uFEFF")', 'hi'],
    ['TRIM(BLANK())', ''],
  ],
  REPT: [
    ['REPT("ab",3)', 'ababab'],
    ['REPT(BLANK(),2)', ''],
    ['REPT("x",-1)', error('formula.runtime.limit')],
  ],
  T: [
    ['T("text")', 'text'],
    ['T(42)', null],
    ['T(BLANK())', null],
  ],
  ENCODE_URL_COMPONENT: [
    ['ENCODE_URL_COMPONENT("a & b")', 'a%20%26%20b'],
    ['ENCODE_URL_COMPONENT("!()*")', '%21%28%29%2A'],
    ['ENCODE_URL_COMPONENT(BLANK())', ''],
  ],
  REGEX_MATCH: [
    ['REGEX_MATCH("abc12","[0-9]+")', true],
    ['REGEX_MATCH(BLANK(),"x")', false],
    ['REGEX_MATCH("x","[")', error('formula.runtime.regex')],
  ],
  REGEX_EXTRACT: [
    ['REGEX_EXTRACT("abc12","[0-9]+")', '12'],
    ['REGEX_EXTRACT("abc","(b)")', 'b'],
    ['REGEX_EXTRACT(BLANK(),"x")', error('formula.runtime.regexNoMatch')],
  ],
  REGEX_REPLACE: [
    ['REGEX_REPLACE("a1b2","[0-9]","x")', 'axbx'],
    ['REGEX_REPLACE("ab","(a)(b)","$2$1")', 'ba'],
    ['REGEX_REPLACE(BLANK(),"x","y")', ''],
  ],
  IF: [
    ['IF(TRUE(),3,ERROR())', 3],
    ['IF(FALSE(),ERROR(),4)', 4],
    ['IF(BLANK(),3)', null],
  ],
  SWITCH: [
    ['SWITCH(2,1,ERROR(),2,4,ERROR())', 4],
    ['SWITCH(3,1,2,4)', 4],
    ['SWITCH(BLANK(),BLANK(),5)', 5],
  ],
  AND: [
    ['AND(1,TRUE())', true],
    ['AND(BLANK(),ERROR())', false],
    ['AND(TRUE(),ERROR())', explicitError],
  ],
  OR: [
    ['OR(0,TRUE())', true],
    ['OR(TRUE(),ERROR())', true],
    ['OR(BLANK(),FALSE())', false],
  ],
  NOT: [
    ['NOT(TRUE())', false],
    ['NOT(0)', true],
    ['NOT(BLANK())', true],
  ],
  XOR: [
    ['XOR(TRUE(),TRUE(),TRUE())', true],
    ['XOR(TRUE(),TRUE())', false],
    ['XOR(BLANK())', false],
  ],
  BLANK: [
    ['BLANK()', null],
    ['BLANK()+1', 1],
    ['BLANK()&"a"', 'a'],
  ],
  ERROR: [
    ['ERROR()', explicitError],
    ['ERROR("x")', { ...explicitError, params: { detail: 'x' } }],
    ['IF(FALSE(),ERROR())', null],
  ],
  ISERROR: [
    ['ISERROR(1/0)', true],
    ['ISERROR(BLANK())', false],
    ['ISERROR(IF(FALSE(),ERROR(),1))', false],
  ],
  TRUE: [
    ['TRUE()', true],
    ['NOT(TRUE())', false],
    ['TRUE() + BLANK()', 1],
  ],
  FALSE: [
    ['FALSE()', false],
    ['NOT(FALSE())', true],
    ['FALSE() + BLANK()', 0],
  ],
  TODAY: [
    ['TODAY()', '2024-03-10'],
    ['DATESTR(TODAY())', '2024-03-10'],
    ['TODAY() = BLANK()', false],
  ],
  NOW: [
    ['NOW()', '2024-03-10T09:30:45.000Z'],
    ['HOUR(NOW())', 9],
    ['NOW() = BLANK()', false],
  ],
  DATEADD: [
    ['DATEADD({Date},1,"year")', '2025-02-28T00:00:00.000Z'],
    ['DATEADD({Date},-1,"month")', '2024-01-29T00:00:00.000Z'],
    ['DATEADD(BLANK(),1,"day")', null],
    ['DATEADD({Date},1,"bad")', error('formula.runtime.unit')],
  ],
  DATETIME_DIFF: [
    ['DATETIME_DIFF("2024-03-01","2024-02-29","day")', 1],
    ['DATETIME_DIFF("2024-02-29","2024-03-01","day")', -1],
    ['DATETIME_DIFF(BLANK(),NOW())', null],
  ],
  DATETIME_FORMAT: [
    ['DATETIME_FORMAT({Date},"YYYY/MM/DD")', '2024/02/29'],
    ['DATETIME_FORMAT({Date},"MMM Do, YYYY [day] DDD")', 'Feb 29th, 2024 day 60'],
    ['DATETIME_FORMAT(BLANK(),"YYYY")', null],
  ],
  DATETIME_PARSE: [
    ['DATETIME_PARSE("4 Mar 2017 23:00","D MMM YYYY HH:mm")', '2017-03-04T23:00:00.000Z'],
    ['DATETIME_PARSE(BLANK())', null],
    ['DATETIME_PARSE("2024-02-30")', error('formula.runtime.date')],
  ],
  YEAR: [
    ['YEAR({Date})', 2024],
    ['YEAR("1999-12-31")', 1999],
    ['YEAR(BLANK())', null],
  ],
  MONTH: [
    ['MONTH({Date})', 2],
    ['MONTH("1999-12-31")', 12],
    ['MONTH(BLANK())', null],
  ],
  DAY: [
    ['DAY({Date})', 29],
    ['DAY("1999-12-31")', 31],
    ['DAY(BLANK())', null],
  ],
  HOUR: [
    ['HOUR({Instant})', 9],
    ['HOUR({Date})', 0],
    ['HOUR(BLANK())', null],
  ],
  MINUTE: [
    ['MINUTE({Instant})', 30],
    ['MINUTE({Date})', 0],
    ['MINUTE(BLANK())', null],
  ],
  SECOND: [
    ['SECOND({Instant})', 45],
    ['SECOND({Date})', 0],
    ['SECOND(BLANK())', null],
  ],
  WEEKDAY: [
    ['WEEKDAY({Date})', 4],
    ['WEEKDAY({Date},"Monday")', 3],
    ['WEEKDAY(BLANK())', null],
  ],
  WEEKNUM: [
    ['WEEKNUM("2013-02-17")', 8],
    ['WEEKNUM("2024-01-01","Monday")', 1],
    ['WEEKNUM(BLANK())', null],
  ],
  WORKDAY: [
    ['WORKDAY("2020-10-16",10,"2020-10-16,2020-10-19")', '2020-11-02'],
    ['WORKDAY("2024-03-04",-1)', '2024-03-01'],
    ['WORKDAY(BLANK(),3)', null],
  ],
  WORKDAY_DIFF: [
    ['WORKDAY_DIFF("2020-10-16","2020-11-02","2020-10-16,2020-10-19")', 10],
    ['WORKDAY_DIFF("2024-03-01","2024-03-01")', 1],
    ['WORKDAY_DIFF(BLANK(),TODAY())', null],
  ],
  IS_BEFORE: [
    ['IS_BEFORE({Date},NOW())', true],
    ['IS_BEFORE(NOW(),{Date})', false],
    ['IS_BEFORE(BLANK(),NOW())', false],
  ],
  IS_AFTER: [
    ['IS_AFTER({Date},NOW())', false],
    ['IS_AFTER(NOW(),{Date})', true],
    ['IS_AFTER(BLANK(),NOW())', false],
  ],
  IS_SAME: [
    ['IS_SAME({Instant},NOW())', true],
    ['IS_SAME({Date},NOW(),"year")', true],
    ['IS_SAME(BLANK(),NOW())', false],
  ],
  SET_TIMEZONE: [
    ['SET_TIMEZONE({Instant},"America/Los_Angeles")', '2024-03-10T09:30:45.000Z'],
    ['HOUR(SET_TIMEZONE({Instant},"America/Los_Angeles"))', 1],
    ['SET_TIMEZONE(BLANK(),"UTC")', null],
  ],
  DATESTR: [
    ['DATESTR({Instant})', '2024-03-10'],
    ['DATESTR({Date})', '2024-02-29'],
    ['DATESTR(BLANK())', null],
  ],
  TIMESTR: [
    ['TIMESTR({Instant})', '09:30:45'],
    ['TIMESTR({Date})', '00:00:00'],
    ['TIMESTR(BLANK())', null],
  ],
  RECORD_ID: [
    ['RECORD_ID()', 'rec1'],
    ['RECORD_ID() & BLANK()', 'rec1'],
    ['LEN(RECORD_ID())', 4],
  ],
  CREATED_TIME: [
    ['CREATED_TIME()', '2024-01-01T01:02:03.000Z'],
    ['YEAR(CREATED_TIME())', 2024],
    ['CREATED_TIME() = BLANK()', false],
  ],
  LAST_MODIFIED_TIME: [
    ['LAST_MODIFIED_TIME()', '2024-02-02T02:03:04.000Z'],
    ['LAST_MODIFIED_TIME({Number},{Text})', '2024-01-06T00:00:00.000Z'],
    ['LAST_MODIFIED_TIME({Date})', error('formula.runtime.modificationUnavailable')],
  ],
  ARRAYJOIN: [
    ['ARRAYJOIN({Choices},";")', 'Red;Blue;Red'],
    ['ARRAYJOIN({Choices})', 'Red, Blue, Red'],
    ['ARRAYJOIN(BLANK(),",")', ''],
  ],
  ARRAYUNIQUE: [
    ['ARRAYUNIQUE({Choices})', ['Red', 'Blue']],
    ['ARRAYUNIQUE(BLANK())', []],
    ['ARRAYUNIQUE(ARRAYUNIQUE({Choices}))', ['Red', 'Blue']],
  ],
  ARRAYCOMPACT: [
    ['ARRAYCOMPACT({Choices})', ['Red', 'Blue', 'Red']],
    ['ARRAYCOMPACT(BLANK())', []],
    ['ARRAYCOMPACT(ARRAYSLICE({Choices},5))', []],
  ],
  ARRAYFLATTEN: [
    ['ARRAYFLATTEN({Choices})', ['Red', 'Blue', 'Red']],
    ['ARRAYFLATTEN(BLANK())', []],
    ['ARRAYFLATTEN(ARRAYUNIQUE({Choices}))', ['Red', 'Blue']],
  ],
  ARRAYSLICE: [
    ['ARRAYSLICE({Choices},2,3)', ['Blue', 'Red']],
    ['ARRAYSLICE({Choices},-1)', ['Red']],
    ['ARRAYSLICE(BLANK(),1)', []],
  ],
  START: [
    ['START({Trip})', '2024-02-27'],
    ['START({Shift})', '2024-03-10T09:00:00.000Z'],
    ['START(BLANK())', null],
  ],
  END: [
    ['END({Trip})', '2024-03-02'],
    ['DATETIME_DIFF(END({Trip}),START({Trip}),"days")', 4],
    ['END(BLANK())', null],
  ],
};

suite('date ranges, signatures, locations, and JSON', () => {
  it.each<Case>([
    ['{Trip}', ['2024-02-27', '2024-03-02']],
    ['DATETIME_DIFF(END({Shift}),START({Shift}),"minutes")', 510],
    ['IS_BEFORE(START({Trip}),{Date})', true],
    ['{Signed}', '2024-03-01T12:00:00.000Z'],
    ['IF({Signed},"signed","waiting")', 'signed'],
    ['IS_BEFORE({Signed},"2024-03-05")', true],
    ['{Place}', '40.7128, -74.006'],
    [
      '"https://maps.example.com/?q=" & ENCODE_URL_COMPONENT({Place})',
      'https://maps.example.com/?q=40.7128%2C%20-74.006',
    ],
    ['{Data}', '{"a":[1,2]}'],
    ['LEN({Data})', 11],
  ])('%s', (source, expected) => {
    expect(run(source)).toEqual(expected);
  });

  it('reads an empty range, signature, or location as blank', () => {
    const empty = { ...record, values: { ...record.values, r: null, g: null, l: null } };
    expect(run('START({Trip})', empty)).toBeNull();
    expect(run('IF({Signed},"signed","waiting")', empty)).toBe('waiting');
    expect(run('{Place}', empty)).toBeNull();
  });

  it('takes the ends of dates only', () => {
    for (const source of ['START({Place})', 'END({Choices})', 'START({Date})'])
      expect(check(astOf(source)), source).toHaveProperty('error');
  });
});

suite('function conformance', () => {
  for (const [name, examples] of Object.entries(cases)) {
    it.each(examples)(`${name}: %s`, (source, expected) => {
      expect(run(source)).toEqual(expected);
    });
  }
  it('covers every declared function with at least three fixed cases', () => {
    expect(Object.keys(cases).sort()).toEqual(Object.keys(FUNCTIONS).sort());
    for (const examples of Object.values(cases)) expect(examples.length).toBeGreaterThanOrEqual(3);
  });
  it('propagates errors from strict arguments for every applicable function', () => {
    const special = new Set(['IF', 'SWITCH', 'ISERROR', 'LAST_MODIFIED_TIME']);
    for (const [name, signature] of Object.entries(FUNCTIONS)) {
      if (signature.min < 1 || special.has(name)) continue;
      const source =
        name === 'XLOOKUP'
          ? 'XLOOKUP(ERROR(), Totals[Key], Totals[Amount])'
          : name === 'COUNTIFS'
            ? 'COUNTIFS(Totals[Key], ERROR())'
            : name.endsWith('IFS')
              ? `${name}(Totals[Amount], Totals[Key], ERROR())`
              : `${name}(ERROR()${', BLANK()'.repeat(signature.min - 1)})`;
      expect(run(source), source).toEqual(explicitError);
    }
  });
});

suite('syntax and resolution', () => {
  it.each<Case>([
    ['3 + 2 * 4', 11],
    ['(3 + 2) * 4', 20],
    ['-2*-3+1', 7],
    ['8/2/2', 2],
    ['.5+1e3+3.5', 1004],
    ['"a" & 1 + 2 = "a3"', true],
    ['TRUE || FALSE && FALSE', true],
    ['3 <> 2', true],
    ['3 != 3', false],
    ['3 >= 3 && 2 <= 3', true],
    ['"a\\n\\t\\u0042"', 'a\n\tB'],
    ["'a\\'b'", "a'b"],
    ['\nSuM ( 1 ,\n 2 ) ', 3],
  ])('parses %s', (source, expected) => {
    expect(run(source)).toEqual(expected);
  });
  it.each([
    ['', 0, 0],
    ['1 + )', 4, 5],
    ['SUM(1,)', 6, 7],
    ['1 2', 2, 3],
    ['1e', 1, 2],
    ['"abc', 0, 4],
    ['{abc', 0, 4],
    ['2 @ 3', 2, 3],
    ['(1', 2, 2],
    ['1e999', 0, 5],
  ])('locates errors in %j', (source, start, end) => {
    expect(parse(source)).toMatchObject({ error: { start, end } });
  });
  it('round trips escaped field names and current names after a rename', () => {
    const old = [{ id: 'x', name: 'A}\\B', type: 'text' } satisfies FormulaField];
    const parsed = parse('{A\\}\\\\B} & "!"');
    expect(parsed).toHaveProperty('ast');
    if ('error' in parsed) return;
    const resolved = resolve(parsed.ast, old);
    expect(resolved).toHaveProperty('ast');
    if ('error' in resolved) return;
    expect(references(resolved.ast)).toEqual(['x']);
    const renamed = [{ ...old[0]!, name: 'New name' }];
    expect(describe(resolved.ast, renamed)).toBe('({New name} & "!")');
    expect(resolve(resolved.ast, renamed)).toHaveProperty('ast');
    expect(resolve(parsed.ast, old, 'x')).toMatchObject({ error: { messageKey: 'formula.field.circular' } });
    expect(resolve(parsed.ast, [])).toMatchObject({ error: { messageKey: 'formula.field.unknown' } });
  });
  it('matches names without case and deduplicates references', () => {
    expect(references(astOf('{number}+{NUMBER}'))).toEqual(['n']);
    expect(describe(astOf('Number'), fields)).toBe('{Number}');
  });
  it('rejects ambiguous names', () => {
    const parsed = parse('{x}');
    if ('error' in parsed) throw new Error();
    expect(
      resolve(parsed.ast, [
        { id: 'a', name: 'x', type: 'text' },
        { id: 'b', name: 'X', type: 'text' },
      ]),
    ).toMatchObject({ error: { messageKey: 'formula.field.ambiguous' } });
  });
});

suite('types, blanks, dates, and performance', () => {
  it.each([
    ['ABS("x")', 4, 7, 'formula.type.argument'],
    ['IF(TRUE(),1,"x")', 12, 15, 'formula.type.branch'],
    ['{Number} = {Text}', 11, 17, 'formula.type.comparison'],
    ['MISSING(1)', 0, 10, 'formula.function.unknown'],
    ['ROUND(1)', 0, 8, 'formula.function.arity'],
    ['LAST_MODIFIED_TIME(1)', 19, 20, 'formula.type.fieldRequired'],
  ])('reports positioned type errors in %s', (source, start, end, messageKey) => {
    expect(check(astOf(source))).toMatchObject({ error: { start, end, messageKey } });
  });
  it('maps every contract field type', () => {
    for (const type of [
      'text',
      'longText',
      'email',
      'url',
      'phone',
      'singleSelect',
      'createdBy',
      'lastModifiedBy',
      'recordId',
    ] as const)
      expect(fieldType({ id: 'x', name: 'X', type })).toBe('text');
    expect(fieldType({ id: 'x', name: 'X', type: 'createdTime' })).toBe('datetime');
    expect(fieldType({ id: 'x', name: 'X', type: 'lastModifiedTime' })).toBe('datetime');
    for (const type of [
      'number',
      'currency',
      'percent',
      'duration',
      'rating',
      'autoNumber',
      'count',
    ] as const)
      expect(fieldType({ id: 'x', name: 'X', type })).toBe('number');
    for (const type of ['multipleSelect', 'user', 'link', 'attachment'] as const)
      expect(fieldType({ id: 'x', name: 'X', type })).toEqual({ array: 'text' });
    for (const field of fields) expect(check(astOf(`{${field.name}}`))).toEqual({ type: fieldType(field) });
  });
  it.each<Case>([
    ['BLANK()=BLANK()', true],
    ['BLANK()=0', false],
    ['BLANK()!=1', false],
    ['BLANK()<1', false],
    ['BLANK()>-1', false],
    ['""=BLANK()', true],
    ['FALSE()=BLANK()', false],
    ['BLANK()/1', 0],
    ['1/BLANK()', divisionError],
    ['IF(ISERROR(1/0),9,1/0)', 9],
  ])('handles %s', (source, expected) => {
    expect(run(source)).toEqual(expected);
  });
  it('uses the supplied clock and zone across DST and month ends', () => {
    const ctx = { ...context, now: '2024-03-10T00:30:00Z', timeZone: 'America/Los_Angeles' };
    expect(run('TODAY()', record, ctx)).toBe('2024-03-09');
    expect(run('DATEADD({Instant},1,"day")', record, ctx)).toBe('2024-03-11T08:30:45.000Z');
    expect(run('DATETIME_PARSE("2024-03-10 02:30")', record, ctx)).toBe('2024-03-10T10:30:00.000Z');
    expect(run('DATETIME_PARSE("2024-11-03 01:30")', record, ctx)).toBe('2024-11-03T08:30:00.000Z');
    expect(run('DATEADD("2024-01-31",1,"month")')).toBe('2024-02-29T00:00:00.000Z');
    expect(run('DATETIME_DIFF("2024-02-29","2024-01-31","month")')).toBe(1);
    expect(run('DATETIME_PARSE("31 décembre 2024","D MMMM YYYY","fr")')).toBe('2024-12-31T00:00:00.000Z');
  });
  it('evaluates 100,000 records with a formula exceeding 20 nodes in under a second', () => {
    const ast = astOf('IF({Number}>0,({Number}*2+3)/5+ABS({Number}-10)+MAX({Number},2),0)');
    evaluate(ast, record, context);
    const start = performance.now();
    let sum = 0;
    for (let i = 0; i < 100_000; i++) sum += evaluate(ast, record, context) as number;
    expect(sum).toBeGreaterThan(0);
    expect(performance.now() - start).toBeLessThan(1000);
  });
  it('does not leak cached records, contexts, or exceptions', () => {
    const ast = astOf('NOW()');
    expect(evaluate(ast, record, context)).not.toEqual(
      evaluate(ast, record, { ...context, now: '2025-01-01T00:00:00Z' }),
    );
    expect(isError(run('REGEX_MATCH("a","(?=a)")'))).toBe(true);
    expect(run('ARRAYJOIN({Choices})', { ...record, values: { a: null } })).toBe('');
    expect(run('{Person}')).toBe('Pat');
  });
});

it('reads people fields as lists of names, and attachments as lists of their IDs', () => {
  const lists: FormulaField[] = [
    { id: 'o', name: 'Owners', type: 'user' },
    { id: 'f', name: 'Files', type: 'attachment' },
  ];
  const astFor = (source: string) => {
    const parsed = parse(source);
    if ('error' in parsed) throw new Error(source);
    const resolved = resolve(parsed.ast, lists);
    if ('error' in resolved) throw new Error(source);
    return resolved.ast;
  };
  const row = { ...record, values: { o: ['u', 'gone'], f: ['att1'] } };
  expect(evaluate(astFor('{Owners}'), row, context)).toEqual(['Pat', null]);
  expect(evaluate(astFor('ARRAYJOIN(ARRAYCOMPACT({Owners}), " & ")'), row, context)).toBe('Pat');
  expect(evaluate(astFor('"Files: " & {Files}'), row, context)).toBe('Files: att1');
  expect(check(astFor('LEN({Owners})'))).toMatchObject({ error: { messageKey: 'formula.type.argument' } });
});

it('uses supplied type maps as the authority after field removal or type changes', () => {
  const ast = astOf('{Number}+1');
  expect(check(ast, new Map())).toMatchObject({ error: { messageKey: 'formula.field.unknown' } });
  expect(check(ast, new Map([['n', 'text']]))).toMatchObject({
    error: { messageKey: 'formula.type.argument' },
  });
});

suite('lookups where one value belongs, and in totals', () => {
  const lookups: FormulaField[] = [
    ...fields,
    { id: 'price', name: 'Price', type: 'lookup', valueType: { array: 'number' } },
    { id: 'names', name: 'Names', type: 'lookup', valueType: { array: 'text' } },
    { id: 'paid', name: 'Paid', type: 'lookup', valueType: { array: 'boolean' } },
    { id: 'due', name: 'Due', type: 'lookup', valueType: { array: 'date' } },
    { id: 'seen', name: 'Seen', type: 'lookup', valueType: { array: 'datetime' } },
  ];
  const astFor = (source: string) => {
    const parsed = parse(source);
    if ('error' in parsed) throw new Error(source);
    const resolved = resolve(parsed.ast, lookups);
    if ('error' in resolved) throw new Error(source);
    return resolved.ast;
  };
  const row = (values: FormulaRecord['values']): FormulaRecord => ({
    ...record,
    values: { ...record.values, ...values },
  });
  const value = (source: string, values: FormulaRecord['values']) =>
    evaluate(astFor(source), row(values), context);

  it('types a lookup where one value belongs as its item, and says which ones do', () => {
    expect(check(astFor('{Price} * {Number}'))).toEqual({ type: 'number', oneValue: ['price'] });
    expect(check(astFor('LEN({Names}) + {Price}'))).toEqual({ type: 'number', oneValue: ['names', 'price'] });
    expect(check(astFor('{Price} > 3'))).toEqual({ type: 'boolean', oneValue: ['price'] });
    expect(check(astFor('{Paid} = TRUE()'))).toEqual({ type: 'boolean', oneValue: ['paid'] });
    expect(check(astFor('IS_BEFORE({Due}, TODAY())'))).toEqual({ type: 'boolean', oneValue: ['due'] });
    expect(check(astFor('DATETIME_FORMAT({Seen})'))).toEqual({ type: 'text', oneValue: ['seen'] });
    expect(check(astFor('SWITCH({Names}, "a", 1, 2)'))).toEqual({ type: 'number', oneValue: ['names'] });
    expect(check(astFor('{Price} = {Paid}'))).toEqual({ type: 'boolean', oneValue: ['price', 'paid'] });
  });

  it('keeps a lookup a list wherever a list already fits', () => {
    for (const source of [
      '{Price}',
      'ARRAYJOIN({Names})',
      '"Items: " & {Names}',
      'COUNTALL({Price})',
      'IF({Price}, "some", "none")',
      '{Price} = {Price}',
      '{Price} = BLANK()',
      'T({Names})',
    ])
      expect(check(astFor(source)), source).not.toHaveProperty('oneValue');
    expect(check(astFor('SUM({Price}, 1)'))).toEqual({ type: 'number' });
    expect(check(astFor('MAX({Paid})'))).toEqual({ type: 'number' });
  });

  it('refuses lists that no one value or total can use', () => {
    for (const source of [
      '{Names} * 2',
      'SUM({Names})',
      'LEN({Choices})',
      '{Choices} * 1',
      'IF(TRUE(), {Price}, 0)',
    ])
      expect(check(astFor(source)), source).toHaveProperty('error');
    expect(check(astFor('{Choices} = "Red"'))).toMatchObject({
      error: { messageKey: 'formula.type.comparison' },
    });
  });

  it('reads one item as itself, none as blank, and several as an error', () => {
    const several = { error: '#ERROR!', messageKey: 'formula.list.several' };
    expect(value('{Price} * 2', { price: [4.5] })).toBe(9);
    expect(value('{Price} * 2', { price: [] })).toBe(0);
    expect(value('{Price} * 2', { price: null })).toBe(0);
    expect(value('{Price} * 2', { price: [1, 2] })).toEqual(several);
    expect(value('ISERROR({Price} * 2)', { price: [1, 2] })).toBe(true);
    expect(value('IF(FALSE(), {Price} * 2, 0)', { price: [1, 2] })).toBe(0);
    expect(value('{Price} > 3', { price: [] })).toBe(false);
    expect(value('UPPER({Names})', { names: ['tea'] })).toBe('TEA');
    expect(value('{Paid} = TRUE()', { paid: [true] })).toBe(true);
    expect(value('DATESTR(DATEADD({Due}, 1, "day"))', { due: ['2024-02-28'] })).toBe('2024-02-29');
    expect(value('IS_AFTER({Seen}, {Instant})', { seen: ['2024-03-11T00:00:00.000Z'] })).toBe(true);
    // A lookup's own error comes first.
    expect(value('{Price} * 2', { price: explicitError })).toEqual(explicitError);
  });

  it('flattens lookups in totals, and counts and joins their items', () => {
    // A looked-up number too large for JavaScript reaches formulas as a blank item.
    const values = {
      price: [1.5, 2, null],
      names: ['a', 'b'],
      paid: [true, false],
    } as FormulaRecord['values'];
    expect(value('SUM({Price}, 10)', values)).toBe(13.5);
    expect(value('AVERAGE({Price})', values)).toBe(1.75);
    expect(value('MAX({Price}, 0)', values)).toBe(2);
    expect(value('MIN({Price}, {Paid})', values)).toBe(1.5);
    expect(value('COUNT({Price})', values)).toBe(2);
    expect(value('COUNTA({Price}, {Paid})', values)).toBe(4);
    expect(value('COUNTALL({Price})', values)).toBe(3);
    expect(value('CONCATENATE({Names}, "/", {Paid})', values)).toBe('a, b/1, 0');
    expect(value('SUM({Price})', { price: [] })).toBe(0);
    expect(value('COUNTALL({Price})', { price: null })).toBe(0);
    expect(value('AVERAGE({Price})', { price: [] })).toEqual(divisionError);
  });
});

suite('links and choices, which read by name', () => {
  const named: FormulaField[] = [...fields, { id: 'client', name: 'Client', type: 'link' }];
  const astFor = (source: string) => {
    const parsed = parse(source);
    if ('error' in parsed) throw new Error(source);
    const resolved = resolve(parsed.ast, named);
    if ('error' in resolved) throw new Error(source);
    return resolved.ast;
  };
  const value = (source: string, values: FormulaRecord['values']) =>
    evaluate(astFor(source), { ...record, values: { ...record.values, ...values } }, context);

  it('reads a link as the names the caller hands it, in link order', () => {
    const client = ['Forrester Legal Partners'];
    expect(value('{Client} & " Order #" & {Number}', { client })).toBe('Forrester Legal Partners Order #4');
    expect(value('{Client} & ""', { client: ['Smith, Jones', 'Say "hi"'] })).toBe('Smith, Jones, Say "hi"');
    expect(value('ARRAYJOIN({Client}, " + ")', { client: ['b', '', 'a'] })).toBe('b +  + a');
    expect(value('COUNTA({Client})', { client: ['b', '', 'a'] })).toBe(2);
    expect(value('COUNTALL({Client})', { client: ['b', '', 'a'] })).toBe(3);
    // A record linked to nothing holds an empty list, not a blank.
    expect(value('{Client}', { client: null })).toEqual([]);
    expect(value('COUNTALL({Client})', { client: null })).toBe(0);
    expect(value('RECORD_ID()', { client })).toBe('rec1');
  });

  it('reads a link where one value belongs as its one name', () => {
    expect(check(astFor('{Client} = "Forrester"'))).toEqual({ type: 'boolean', oneValue: ['client'] });
    expect(check(astFor('LEN({Client})'))).toEqual({ type: 'number', oneValue: ['client'] });
    expect(check(astFor('{Client} & "!"'))).toEqual({ type: 'text' });
    expect(value('{Client} = "Forrester"', { client: ['Forrester'] })).toBe(true);
    expect(value('{Client} = "Forrester"', { client: [] })).toBe(false);
    expect(value('{Client} = "Forrester"', { client: ['Forrester', 'Other'] })).toEqual({
      error: '#ERROR!',
      messageKey: 'formula.list.several',
    });
  });

  it('reads choices as names, and an empty multiple select as an empty list', () => {
    expect(value('{Choice} = "Red"', {})).toBe(true);
    expect(value('{Choices} & ""', {})).toBe('Red, Blue, Red');
    expect(value('{Choices}', { a: null })).toEqual([]);
    expect(value('COUNTALL({Choices})', { a: null })).toBe(0);
    expect(value('COUNTALL({Choices})', { a: ['x', 'gone'] })).toBe(2);
    expect(value('COUNTA({Choices})', { a: ['x', 'gone'] })).toBe(1);
    // A multiple select is a list of choices, never one value.
    expect(check(astFor('{Choices} = "Red"'))).toMatchObject({
      error: { messageKey: 'formula.type.comparison' },
    });
  });
});
