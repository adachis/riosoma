import { describe, expect, it } from 'vitest';
import { compile, EMPTY, ident, join, keyword, sql } from './sql.js';

describe('sql', () => {
  it('turns values into numbered parameters, including inside nested fragments', () => {
    const where = sql`a = ${1} AND b = ${'x'}`;
    const q = sql`SELECT * FROM ${ident('rio_data', 'tbl00000000000001')} WHERE ${where} LIMIT ${10}`;
    expect(compile(q)).toEqual({
      text: 'SELECT * FROM "rio_data"."tbl00000000000001" WHERE a = $1 AND b = $2 LIMIT $3',
      values: [1, 'x', 10],
    });
  });

  it('joins fragments and allows only listed keywords', () => {
    const parts = [sql`a = ${1}`, sql`b = ${2}`, sql`c IS ${keyword('NULL')}`];
    expect(compile(sql`WHERE ${join(parts, ' OR ')}`)).toEqual({
      text: 'WHERE a = $1 OR b = $2 OR c IS NULL',
      values: [1, 2],
    });
    expect(compile(join([], ', '))).toEqual({ text: '', values: [] });
    expect(compile(sql`x${EMPTY}y`).text).toBe('xy');
    expect(() => keyword('DROP' as never)).toThrow();
  });

  it('refuses identifiers that could break out of quotes', () => {
    expect(() => ident('a"; DROP TABLE x; --')).toThrow();
    expect(() => ident('')).toThrow();
    expect(() => ident('1abc')).toThrow();
    expect(compile(sql`${ident('__rid')}`).text).toBe('"__rid"');
  });

  it('never splices a string value into the text', () => {
    const evil = "'; DROP TABLE users; --";
    const { text, values } = compile(sql`SELECT ${evil}`);
    expect(text).toBe('SELECT $1');
    expect(values).toEqual([evil]);
  });
});
