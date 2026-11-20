import { describe, expect, it } from 'vitest';
import { formulaBuilder, parse } from './index.js';

describe('formula builder recognition', () => {
  it.each([
    [
      'concatenate({First}, "\\"\\\\\\n", {Last})',
      { kind: 'combine', first: 'First', second: 'Last', separator: '"\\\n' },
    ],
    [
      'DATETIME_DIFF({End}, {Start}, "hours")',
      { kind: 'difference', start: 'Start', end: 'End', unit: 'hours' },
    ],
    [
      'IF(({Name} = ""), "yes", "no")',
      { kind: 'mapping', field: 'Name', match: '', then: 'yes', otherwise: 'no' },
    ],
    [
      'IF({Number} < -2.5, "low", "high")',
      { kind: 'bucket', field: 'Number', boundary: -2.5, then: 'low', otherwise: 'high' },
    ],
    ['ARRAYJOIN(ARRAYSLICE({Links}, 2, 2), "")', { kind: 'links', field: 'Links', position: 2 }],
  ])('recognizes the complete shape of %s', (source, expected) => {
    const result = parse(source as string);
    expect('ast' in result && formulaBuilder(result.ast)).toEqual(expected);
  });

  it.each([
    'CONCATENATE({First}, " ", {Last}, "!")',
    'CONCATENATE(UPPER({First}), " ", {Last})',
    'DATETIME_DIFF({End}, {Start}, "months")',
    'IF({Name} != "x", "yes", "no")',
    'IF({Number} <= 2, "low", "high")',
    'IF({Number} < 2, "low", IF({Number} < 4, "middle", "high"))',
    'IF({Name} = "x", 1, 0)',
    'ARRAYJOIN(ARRAYSLICE({Links}, 1, 2), "")',
    'ARRAYJOIN(ARRAYSLICE({Links}, 0, 0), "")',
    'ARRAYJOIN(ARRAYSLICE({Links}, 1.5, 1.5), "")',
    'ARRAYJOIN(ARRAYSLICE({Links}, 1, 1), ", ")',
    'CONCATENATE(Other[Name], " ", {Last})',
    'CONCATENATE({First}, " ", {Last}) & "!"',
  ])('leaves unrepresentable expressions in the formula editor: %s', (source) => {
    const result = parse(source);
    expect('ast' in result).toBe(true);
    if ('ast' in result) expect(formulaBuilder(result.ast)).toBeUndefined();
  });
});
