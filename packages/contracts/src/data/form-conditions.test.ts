import { describe, expect, it } from 'vitest';
import { visibleFormQuestions } from './views.js';

describe('form visibility', () => {
  const parent = { fieldId: 'parent' };
  const child = { fieldId: 'child', showIf: { fieldId: 'parent', equals: 'Yes' } };
  const grandchild = { fieldId: 'grandchild', showIf: { fieldId: 'child', equals: 'Ready' } };

  it('keeps empty comparisons dormant even for a forged multiple select answer', () => {
    const dormant = { fieldId: 'child', showIf: { fieldId: 'parent', equals: '' } };
    expect(visibleFormQuestions([parent, dormant], { parent: [''] })).toEqual([parent]);
  });

  it('matches exact scalars and selected choices, including zero and false', () => {
    for (const equals of ['Yes', 0, false]) {
      const question = { fieldId: 'child', showIf: { fieldId: 'parent', equals } };
      expect(visibleFormQuestions([parent, question], { parent: equals })).toEqual([parent, question]);
    }
    expect(visibleFormQuestions([parent, child], { parent: ['No', 'Yes'] })).toEqual([parent, child]);
    for (const value of [undefined, null, '', [], 'yes'])
      expect(visibleFormQuestions([parent, child], { parent: value })).toEqual([parent]);
  });

  it('ignores forged hidden answers and missing or later dependencies', () => {
    expect(visibleFormQuestions([parent, child, grandchild], { parent: 'No', child: 'Ready' })).toEqual([
      parent,
    ]);
    expect(visibleFormQuestions([child, grandchild], { parent: 'Yes', child: 'Ready' })).toEqual([]);
    expect(visibleFormQuestions([child, parent], { parent: 'Yes' })).toEqual([parent]);
    expect(visibleFormQuestions([parent, child, grandchild], { parent: 'Yes', child: 'Ready' })).toEqual([
      parent,
      child,
      grandchild,
    ]);
  });
});
