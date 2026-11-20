import { describe, expect, it } from 'vitest';
import { mergeText } from './text-merge.js';

describe('token three-way merge', () => {
  it.each([
    ['red green blue', 'RED green blue', 'red green BLUE', 'RED green BLUE'],
    ['one two three four', 'one TWO three four', 'one two three FOUR', 'one TWO three FOUR'],
    ['你好 世界 再见', '您好 世界 再见', '你好 世界 告别', '您好 世界 告别'],
    ['你好世界再见', '您好世界再见', '你好世界告别', '您好世界告别'],
    ['👨‍👩‍👧‍👦 cafe\u0301 🦋', '👩‍👩‍👧‍👦 cafe\u0301 🦋', '👨‍👩‍👧‍👦 cafe\u0301 🌷', '👩‍👩‍👧‍👦 cafe\u0301 🌷'],
    [
      '# Heading\n\n- first\n- [link](https://example.com)\n',
      '# Title\n\n- first\n- [link](https://example.com)\n',
      '# Heading\n\n- second\n- [link](https://example.com)\n',
      '# Title\n\n- second\n- [link](https://example.com)\n',
    ],
    ['a b c d e', 'A b c d E', 'a b C d e', 'A b C d E'],
    [
      '# Title\n\n- [old](https://example.com)\n',
      '# New\n\n- [old](https://example.com)\n',
      '# Title\n\n- [new](https://example.com)\n',
      '# New\n\n- [new](https://example.com)\n',
    ],
  ])('keeps independent edits in %s', (base, theirs, ours, text) => {
    expect(mergeText(base, theirs, ours)).toEqual({ clean: true, text });
    expect(mergeText(base, ours, theirs)).toEqual({ clean: true, text });
  });
  it.each([
    ['red green blue', 'red yellow blue', 'red purple blue'],
    ['one two', 'one new two', 'one other two'],
    ['one two three', 'one three', 'one TWO three'],
    ['abc', '', 'ABC'],
    ['a b c d', 'a X d', 'a b Y d'],
  ])('marks overlapping edits in %s', (base, theirs, ours) => {
    const result = mergeText(base, theirs, ours);
    expect(result.clean).toBe(false);
    if (!result.clean) expect(result.proposal).toContain('<<<<<<<');
  });
  it('coalesces identical insertions and preserves untouched text', () => {
    expect(mergeText('one two', 'one new two', 'one new two')).toEqual({ clean: true, text: 'one new two' });
    expect(mergeText('one', 'one', 'one')).toEqual({ clean: true, text: 'one' });
  });
  it('merges JSON by lines without damaging whitespace or brackets', () => {
    const base = '{\n  "a": 1,\n  "b": 2\n}';
    const text = '{\n  "a": 3,\n  "b": 4\n}';
    expect(mergeText(base, base.replace('1', '3'), base.replace('2', '4'), 'lines')).toEqual({
      clean: true,
      text,
    });
    expect(JSON.parse(text)).toEqual({ a: 3, b: 4 });
  });
  it('keeps complete combining marks and emoji in conflict proposals', () => {
    const result = mergeText('cafe\u0301 👨‍👩‍👧‍👦', 'cafe\u0301 👩‍👩‍👧‍👦', 'cafe\u0301 👨‍👨‍👦');
    expect(result.clean).toBe(false);
    if (!result.clean) {
      expect(result.proposal).toContain('cafe\u0301');
      expect(result.proposal).toContain('👩‍👩‍👧‍👦');
      expect(result.proposal).toContain('👨‍👨‍👦');
    }
  });
});
