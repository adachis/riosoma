import { describe, expect, it } from 'vitest';
import { IngestDecisionAnswer, IngestDecisionQuestion, IngestDecisionRule } from './ingest-decisions.js';

const rule = {
  id: 'rule',
  orgId: 'org',
  tableId: 'table',
  kind: 'decimalPoint',
  scope: { type: 'table' },
  condition: { eq: { input: 'text', value: { type: 'decimal', value: '0.30000000000000004' } } },
  answer: { type: 'choice', value: 'point' },
  enabled: true,
  createdBy: 'person',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const answer = {
  id: 'answer',
  orgId: 'org',
  tableId: 'table',
  questionId: 'question',
  questionVersion: 'version',
  response: { type: 'answer', answer: { type: 'date', value: '2024-02-29' } },
  answeredBy: 'person',
  answeredAt: '2026-01-01T00:00:00Z',
};

describe('ingest decision API contracts', () => {
  it('preserves explicit identity selections and refuses malformed positions and extra properties', () => {
    const selected = {
      type: 'choice',
      value: 'takeFile',
      selections: [
        { identity: 'source', row: 1 },
        { identity: 'destination', recordId: 'record' },
      ],
    };
    expect(
      IngestDecisionAnswer.parse({ ...answer, response: { type: 'answer', answer: selected } }).response,
    ).toEqual({ type: 'answer', answer: selected });
    for (const entry of [
      { identity: 'source', row: -1 },
      { identity: 'source', row: 1.5 },
      { identity: 'source', recordId: '' },
      { identity: 'source', row: 1, extra: true },
    ])
      expect(
        IngestDecisionAnswer.safeParse({
          ...answer,
          response: { type: 'answer', answer: { ...selected, selections: [entry] } },
        }).success,
      ).toBe(false);
  });
  it('preserves exact decimal strings and refuses floats', () => {
    expect(IngestDecisionRule.parse(rule).condition).toEqual(rule.condition);
    expect(
      IngestDecisionRule.safeParse({
        ...rule,
        condition: { eq: { input: 'text', value: { type: 'decimal', value: 0.3 } } },
      }).success,
    ).toBe(false);
  });
  it('closes rule documents, conditions, operands, and scopes', () => {
    const cases = [
      { ...rule, executable: 'x' },
      { ...rule, condition: { regex: 'x' } },
      { ...rule, condition: { eq: { ...rule.condition.eq, extra: 'x' } } },
      { ...rule, condition: { lt: { input: 'text', value: { type: 'text', value: 'abc' } } } },
      { ...rule, scope: { type: 'table', sender: 'x' } },
    ];
    for (const value of cases) expect(IngestDecisionRule.safeParse(value).success).toBe(false);
  });
  it('refuses condition trees beyond the node and depth limits', () => {
    let condition: unknown = { present: 'text' };
    for (let depth = 1; depth < 16; depth++) condition = { not: condition };
    expect(IngestDecisionRule.safeParse({ ...rule, condition }).success).toBe(true);
    expect(IngestDecisionRule.safeParse({ ...rule, condition: { not: condition } }).success).toBe(false);
    expect(
      IngestDecisionRule.safeParse({
        ...rule,
        condition: {
          all: Array.from({ length: 4 }, () => ({
            all: Array.from({ length: 64 }, () => ({ present: 'text' })),
          })),
        },
      }).success,
    ).toBe(false);
  });
  it('accepts strict dates and months, and refuses impossible calendar values', () => {
    expect(IngestDecisionAnswer.safeParse(answer).success).toBe(true);
    for (const value of ['2026-02-30', '1900-02-29', '0000-01-01'])
      expect(
        IngestDecisionAnswer.safeParse({
          ...answer,
          response: { type: 'answer', answer: { type: 'date', value } },
        }).success,
      ).toBe(false);
    expect(
      IngestDecisionAnswer.safeParse({
        ...answer,
        response: { type: 'answer', answer: { type: 'month', value: '2026-13' } },
      }).success,
    ).toBe(false);
  });
  it('represents all question forms and limits evidence to three examples', () => {
    const base = {
      id: 'question',
      orgId: 'org',
      tableId: 'table',
      kind: 'territory',
      key: 'field',
      version: 'version',
      values: [{ type: 'text', value: 'West' }],
      messageId: 'table.questions.territory',
      evidence: [{ file: 'file', sheet: 'Sheet', row: 2, column: 'A', examples: ['West'] }],
      target: { type: 'field', file: 'file', rows: [{ row: 2 }], field: 'field' },
      scopeContext: {},
      defaultScope: 'table',
      allowedScopes: ['table'],
      allowUnknown: true,
      businessOnly: true,
      exits: ['skipFile'],
      active: true,
    };
    for (const form of [
      { type: 'choices', choices: [{ id: 'west', messageId: 'table.choice.west' }] },
      ...['date', 'month', 'number', 'text'].map((type) => ({ type })),
      { type: 'mapping', columns: [{ heading: 'Region', examples: ['West'], fields: ['field'] }] },
    ])
      expect(IngestDecisionQuestion.safeParse({ ...base, form }).success).toBe(true);
    expect(
      IngestDecisionQuestion.safeParse({
        ...base,
        form: { type: 'text' },
        evidence: [{ file: 'file', examples: ['a', 'b', 'c', 'd'] }],
      }).success,
    ).toBe(false);
  });
});
