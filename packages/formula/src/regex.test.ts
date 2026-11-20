import { expect, it } from 'vitest';
import { regex } from './regex.js';

it.each([
  ['a+', 'caaab', 'aaa'],
  ['a+?', 'caaab', 'a'],
  ['a|ab', 'ab', 'a'],
  ['ab|a', 'ab', 'ab'],
  ['(a+)+$', 'aaaa', 'aaaa'],
  ['(a+)+$', 'aaaab', null],
  ['^a$', 'a\n', null],
  ['(?m)^a$', 'b\na\nb', 'a'],
  ['(?i:abc)d', 'ABCd', 'ABCd'],
  ['(?i:abc)d', 'ABCD', null],
  ['(?i)a(?-i)b', 'Ab', 'Ab'],
  ['(?U)a+', 'aaa', 'a'],
  ['a{2,3}', 'aaaa', 'aaa'],
  ['a{2,3}?', 'aaaa', 'aa'],
  ['[[:alpha:]]+', '123abc!', 'abc'],
  ['[[:^alpha:]]+', 'abc123', '123'],
  ['[^\\d]+', '123abc', 'abc'],
  ['\\p{Greek}+', 'aαβb', 'αβ'],
  ['\\PN+', '12abc', 'abc'],
  ['\\s', '\u00a0', null],
  ['\\Aabc\\z', 'abc', 'abc'],
  ['\\Q[a]+\\E', 'x[a]+y', '[a]+'],
  ['\\x{1f600}+', '😀😀', '😀😀'],
  ['\\141', 'a', 'a'],
  ['\\bcat\\b', 'a cat b', 'cat'],
  ['(?:ab)*c', 'abababc', 'abababc'],
])('matches %s', (pattern, text, expected) => {
  expect(regex(pattern).match(text)?.groups[0] ?? null).toBe(expected);
});
it('preserves captures, leftmost priority, and replacement indexes', () => {
  expect(regex('(?P<first>a+)(b)').match('aaab')?.groups).toEqual(['aaab', 'aaa', 'b']);
  expect(regex('(a)(b)').replace('ab ab', '$2$1')).toBe('ba ba');
  expect(regex('(?<x>a)').replace('aa', '$<x>!')).toBe('a!a!');
  expect(regex('').replace('😀a', '-')).toBe('-😀-a-');
  expect(regex('a*').replace('aa', 'x')).toBe('xx');
  expect(regex('(a|aa)*').match('aaa')?.groups).toEqual(['aaa', 'a']);
});
it.each(['(?=a)', '(?!a)', '(?<=a)', '(a)\\1', 'a{1001}', 'a++', '[z-a]', '(abc', '\\q'])(
  'rejects %s',
  (pattern) => {
    expect(() => regex(pattern)).toThrow('formula.runtime.regex');
  },
);
it('matches nested repetition in linear time without backtracking', () => {
  const start = performance.now();
  expect(regex('(a+)+$').match('a'.repeat(100_000) + '!')).toBeNull();
  expect(performance.now() - start).toBeLessThan(1000);
});
it('applies repetition to the last character in a quoted sequence', () => {
  expect(regex('\\Qab\\E+').match('abbb')?.groups[0]).toBe('abbb');
});
it('supports byte matching alongside Unicode character matching', () => {
  expect(regex('\\C{4}').match('😀')?.groups[0]).toBe('😀');
  expect(regex('\\C').match('😀')?.groups[0]).toBe('�');
  expect(regex('(?:\\C\\C|é)').match('é')?.groups[0]).toBe('é');
  expect(regex('(?:é|\\C\\C)').match('é')?.groups[0]).toBe('é');
  expect(regex('\\C{2}').replace('éé', 'x')).toBe('xx');
});
