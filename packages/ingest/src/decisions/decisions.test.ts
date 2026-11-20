import { describe, expect, it } from 'vitest';
import {
  RULE_LIMITS,
  STANDARD_QUESTIONS,
  checkAnswer,
  compareExact,
  createQuestion,
  decide,
  evaluateCondition,
  isCalendarDay,
  offeredScopes,
  questionHold,
  questionIdentity,
  questionVersion,
  responseAllowed,
  tableQuestionKind,
  validateRule,
  type Condition,
  type DecisionItem,
  type DecisionRequest,
  type DecisionRule,
  type ExactValue,
  type QuestionKind,
  type RuleDocument,
  type RuleScope,
  type Truth,
} from './index.js';

const text = (value: string): ExactValue => ({ type: 'text', value });
const number = (value: string): ExactValue => ({ type: 'decimal', value });
const kind = STANDARD_QUESTIONS.find((entry) => entry.id === 'unfamiliarListValue')!;
const sender = { id: 'approved-address', kind: 'address' as const, value: 'sender@example.test' };
const item: DecisionItem = {
  kind,
  value: 'West',
  sender,
  format: 'format-1',
  inputs: { text: text('West') },
};
const form = {
  type: 'choices' as const,
  choices: [
    { id: 'a', messageId: 'test.choice.a' },
    { id: 'b', messageId: 'test.choice.b' },
  ],
};
const target = {
  type: 'field' as const,
  file: 'file-1',
  rows: [{ sheet: 'Sheet', row: 4 }],
  field: 'region',
};
const question = createQuestion(
  kind,
  {
    key: 'region',
    values: [text('West')],
    form,
    evidence: [{ file: 'file-1', sheet: 'Sheet', row: 4, column: 'A', examples: ['West'] }],
    target,
    exits: ['removeRow', 'skipFile'],
  },
  { sender, format: item.format, value: item.value },
);
const rule = (id: string, scope: RuleScope = { type: 'table' }, answer = 'a'): DecisionRule => ({
  id,
  enabled: true,
  kind: kind.id,
  scope,
  condition: { present: 'text' },
  answer: { type: 'choice', value: answer },
});
const document = (condition: Condition = { present: 'text' }): RuleDocument => {
  const { id: _id, enabled: _enabled, ...data } = rule('r');
  return { ...data, condition };
};
const request = (overrides: Partial<DecisionRequest> = {}): DecisionRequest => ({
  item,
  rules: [],
  question,
  key: 'region',
  target,
  attempt: 'unused',
  ...overrides,
});

const truths: Truth[] = ['true', 'false', 'unknown'];
const conditionFor = (truth: Truth): Condition =>
  truth === 'unknown'
    ? { present: 'heading' }
    : { eq: { input: 'text', value: text(truth === 'true' ? 'West' : 'East') } };

describe('three-valued conditions', () => {
  it.each(truths)('negates %s without treating unknown as false', (truth) => {
    expect(evaluateCondition({ not: conditionFor(truth) }, item.inputs).truth).toBe(
      truth === 'unknown' ? 'unknown' : truth === 'true' ? 'false' : 'true',
    );
  });
  for (const left of truths)
    for (const right of truths) {
      it(`combines ${left} and ${right} in all and any`, () => {
        expect(evaluateCondition({ all: [conditionFor(left), conditionFor(right)] }, item.inputs).truth).toBe(
          [left, right].includes('false') ? 'false' : [left, right].includes('unknown') ? 'unknown' : 'true',
        );
        expect(evaluateCondition({ any: [conditionFor(left), conditionFor(right)] }, item.inputs).truth).toBe(
          [left, right].includes('true') ? 'true' : [left, right].includes('unknown') ? 'unknown' : 'false',
        );
      });
    }
  it('distinguishes an absent input from a known blank, and reports missing inputs', () => {
    expect(evaluateCondition({ present: 'heading' }, {})).toEqual({ truth: 'unknown', missing: ['heading'] });
    expect(evaluateCondition({ present: 'heading' }, { heading: null })).toEqual({
      truth: 'false',
      missing: [],
    });
    expect(evaluateCondition({ eq: { input: 'heading', value: text('') } }, { heading: null })).toEqual({
      truth: 'unknown',
      missing: ['heading'],
    });
    expect(evaluateCondition({ all: [{ present: 'heading' }, { present: 'heading' }] }, {})).toEqual({
      truth: 'unknown',
      missing: ['heading'],
    });
  });
  it('keeps incomparable list members unknown unless another member matches', () => {
    const list: Condition = { in: { input: 'text', values: [number('0.3'), text('West')] } };
    expect(evaluateCondition(list, { text: text('East') })).toEqual({ truth: 'unknown', missing: ['text'] });
    expect(evaluateCondition({ not: list }, { text: text('East') }).truth).toBe('unknown');
    expect(evaluateCondition(list, item.inputs).truth).toBe('true');
  });
  it.each([
    [{ eq: { input: 'text', value: number('0.3') } }, 'false'],
    [{ ne: { input: 'text', value: number('0.3') } }, 'true'],
    [{ lt: { input: 'text', value: number('0.3') } }, 'false'],
    [{ lte: { input: 'text', value: number('0.3') } }, 'false'],
    [{ gt: { input: 'text', value: number('0.3') } }, 'true'],
    [{ gte: { input: 'text', value: number('0.3') } }, 'true'],
  ] as Array<[Condition, Truth]>)('compares decimal digits with %j', (condition, truth) => {
    expect(evaluateCondition(condition, { text: number('0.30000000000000004') }).truth).toBe(truth);
  });
  it('uses literal text tests and exact membership', () => {
    const inputs = { text: text('a.*b') };
    expect(evaluateCondition({ contains: { input: 'text', value: '.*' } }, inputs).truth).toBe('true');
    expect(evaluateCondition({ startsWith: { input: 'text', value: 'a.' } }, inputs).truth).toBe('true');
    expect(evaluateCondition({ endsWith: { input: 'text', value: '*b' } }, inputs).truth).toBe('true');
    expect(
      evaluateCondition({ in: { input: 'text', values: [number('0.30')] } }, { text: number('0.3') }).truth,
    ).toBe('true');
  });
});

describe('exact values and a closed vocabulary', () => {
  it('preserves decimal digits beyond floating-point precision', () => {
    expect(compareExact(number('0.30000000000000004'), number('0.3'))).toBe(1);
    expect(compareExact(number('0.1000000000000000000000000001'), number('0.1'))).toBe(1);
    expect(compareExact(number('9007199254740993'), number('9007199254740992'))).toBe(1);
    expect(compareExact(number('-0001.20'), number('-1.2000'))).toBe(0);
    expect(compareExact(number('+0.30'), number('0.3'))).toBe(0);
    expect(compareExact(number('-0.01'), number('0'))).toBe(-1);
    expect(compareExact(number('1e2'), number('100'))).toBeNull();
  });
  it.each([
    '2026-02-30',
    '1900-02-29',
    '2026-04-31',
    '0000-01-01',
    '2026-13-01',
    '2026-1-01',
    '2026-02-01T00:00:00',
  ])('refuses the invalid calendar date %s', (value) => {
    expect(isCalendarDay(value)).toBe(false);
    expect(validateRule(document({ eq: { input: 'text', value: { type: 'date', value } } }), kind).ok).toBe(
      false,
    );
  });
  it('accepts leap years and orders dates, but refuses ordering text', () => {
    expect(isCalendarDay('2000-02-29')).toBe(true);
    expect(isCalendarDay('2024-02-29')).toBe(true);
    expect(compareExact({ type: 'date', value: '2024-02-29' }, { type: 'date', value: '2024-03-01' })).toBe(
      -1,
    );
    expect(validateRule(document({ lt: { input: 'text', value: text('z') } }), kind).ok).toBe(false);
    expect(validateRule(document({ ne: { input: 'text', value: text('z') } }), kind).ok).toBe(true);
  });
  it.each(['pattern', 'expression', 'code', 'regex', 'unknown'])('refuses the condition key %s', (key) => {
    expect(validateRule(document({ [key]: 'anything' } as unknown as Condition), kind).ok).toBe(false);
  });
  it('refuses extra keys throughout a rule instead of stripping them', () => {
    const base = document();
    const bad = [
      { ...base, code: 'x' },
      { ...base, condition: { present: 'text', not: { present: 'heading' } } },
      { ...base, condition: { eq: { input: 'text', value: text('West'), code: 'x' } } },
      { ...base, condition: { eq: { input: 'text', value: { ...text('West'), code: 'x' } } } },
      { ...base, scope: { type: 'table', code: 'x' } },
      { ...base, answer: { ...base.answer, code: 'x' } },
      { ...base, scope: { type: 'sender', sender: { ...sender, code: 'x' } } },
    ];
    for (const value of bad) expect(validateRule(value, kind).ok).toBe(false);
  });
  it('reads only declared inputs, including explicitly named siblings', () => {
    const custom = tableQuestionKind('territory', 'table.questions.territory', 'text', ['country']);
    const base = { ...document(), kind: custom.id, answer: { type: 'text', value: 'West' } };
    expect(validateRule({ ...base, condition: { present: 'sibling:country' } }, custom).ok).toBe(true);
    expect(validateRule({ ...base, condition: { present: 'sibling:secret' } }, custom).ok).toBe(false);
    expect(validateRule({ ...base, condition: { present: 'clock' } }, custom).ok).toBe(false);
  });
  it('enforces the depth limit at its boundary', () => {
    let condition: Condition = { present: 'text' };
    for (let depth = 1; depth < RULE_LIMITS.depth; depth++) condition = { not: condition };
    expect(validateRule(document(condition), kind).ok).toBe(true);
    expect(validateRule(document({ not: condition }), kind)).toEqual({
      ok: false,
      messageId: 'ingest.decisions.ruleLimit',
    });
  });
  it('enforces the node limit independently of depth and list length', () => {
    const groups = [63, 63, 63, 62].map((length) => ({
      all: Array.from({ length }, (): Condition => ({ present: 'text' })),
    }));
    expect(validateRule(document({ all: groups }), kind).ok).toBe(true);
    groups[3]!.all.push({ present: 'text' });
    expect(validateRule(document({ all: groups }), kind)).toEqual({
      ok: false,
      messageId: 'ingest.decisions.ruleLimit',
    });
  });
  it('enforces the list length limit', () => {
    const values = Array.from({ length: RULE_LIMITS.listLength }, () => text('West'));
    expect(validateRule(document({ in: { input: 'text', values } }), kind).ok).toBe(true);
    values.push(text('East'));
    expect(validateRule(document({ in: { input: 'text', values } }), kind)).toEqual({
      ok: false,
      messageId: 'ingest.decisions.ruleLimit',
    });
  });
  it('enforces text length in literals, scopes, and answers', () => {
    const value = 'x'.repeat(RULE_LIMITS.textLength);
    expect(validateRule(document({ eq: { input: 'text', value: text(value) } }), kind).ok).toBe(true);
    expect(validateRule(document({ eq: { input: 'text', value: text(`${value}x`) } }), kind).ok).toBe(false);
    expect(
      validateRule({ ...document(), scope: { type: 'valueFromAnyone', value: `${value}x` } }, kind).ok,
    ).toBe(false);
    expect(validateRule({ ...document(), answer: { type: 'choice', value: `${value}x` } }, kind).ok).toBe(
      false,
    );
  });
  it('bounds cyclic and extremely nested documents before recursion', () => {
    const cyclic: { not?: unknown } = {};
    cyclic.not = cyclic;
    expect(validateRule({ ...document(), condition: cyclic }, kind).ok).toBe(false);
    let deep: unknown = { present: 'text' };
    for (let index = 0; index < 10000; index++) deep = { not: deep };
    expect(validateRule({ ...document(), condition: deep }, kind).ok).toBe(false);
  });
});

describe('the fixed order and scope precedence', () => {
  it('uses rules before questions, and asks before allowing an attempt', () => {
    expect(decide(request({ rules: [rule('r')] }))).toMatchObject({ status: 'decided', ruleId: 'r' });
    expect(decide(request())).toMatchObject({ status: 'ask', question });
    expect(decide(request({ question: undefined }))).toEqual({ status: 'attemptAllowed', tried: [] });
    expect(decide(request({ question: undefined, attempt: 'exhausted' }))).toMatchObject({
      status: 'hold',
      messageId: 'ingest.decisions.unresolved',
    });
  });
  it('tries built-in evidence, known lists, and setup before remembered rules', () => {
    const builtin = (source: 'file' | 'knownList' | 'setup') => ({ ...rule(source), source });
    expect(
      decide(
        request({
          rules: [rule('user')],
          builtIns: [builtin('setup'), builtin('knownList'), builtin('file')],
        }),
      ),
    ).toMatchObject({ status: 'decided', ruleId: 'file' });
    expect(decide(request({ builtIns: [builtin('setup'), builtin('knownList')] }))).toMatchObject({
      status: 'decided',
      ruleId: 'knownList',
    });
  });
  const scopes: RuleScope[] = [
    { type: 'valueFromSender', value: 'West', sender },
    { type: 'valueFromAnyone', value: 'West' },
    { type: 'format', format: 'format-1' },
    { type: 'sender', sender },
    { type: 'table' },
  ];
  for (let narrow = 0; narrow < scopes.length - 1; narrow++) {
    it(`prefers ${scopes[narrow]!.type} to all wider scopes`, () => {
      const rules = scopes
        .slice(narrow)
        .map((scope, index) => rule(`r${index}`, scope, index === 0 ? 'a' : 'b'))
        .reverse();
      expect(decide(request({ rules }))).toMatchObject({ status: 'decided', ruleId: 'r0' });
    });
  }
  it('holds equal-scope conflicts as their own question, even after an attempt', () => {
    for (const scope of scopes) {
      const result = decide(
        request({ rules: [rule('a', scope), rule('b', scope, 'b')], attempt: 'exhausted' }),
      );
      expect(result).toMatchObject({
        status: 'ask',
        holdReason: 'ingest.decisions.ruleConflict',
        question: { kind: 'ruleConflict', allowUnknown: false },
      });
      if (result.status !== 'ask' || result.question.form.type !== 'choices')
        throw new Error('Expected conflict question');
      const selected = result.question.form.choices[0]!;
      expect(selected.answer).toBeDefined();
      expect(
        decide(
          request({
            rules: [rule('a', scope), rule('b', scope, 'b')],
            answer: {
              questionId: result.question.id,
              questionVersion: result.question.version,
              response: { type: 'answer', answer: { type: 'choice', value: selected.id } },
            },
          }),
        ),
      ).toMatchObject({ status: 'decided', response: { answer: selected.answer } });
    }
  });
  it('keeps large valid rule answers within a conflict question’s identity value limits', () => {
    const textKind: QuestionKind = { ...kind, answerType: 'text' };
    const rules = [rule('a'), rule('b')].map((entry, index) => ({
      ...entry,
      answer: { type: 'text' as const, value: (index ? 'b' : 'a').repeat(RULE_LIMITS.textLength) },
    }));
    const result = decide(
      request({
        item: { ...item, kind: textKind },
        rules,
        question: undefined,
        key: 'k'.repeat(RULE_LIMITS.textLength),
      }),
    );
    expect(result.status).toBe('ask');
    if (result.status !== 'ask' || result.question.form.type !== 'choices')
      throw new Error('Expected conflict question');
    expect(result.question.key.length).toBeLessThanOrEqual(RULE_LIMITS.textLength);
    expect(result.question.values.every((value) => value.value.length <= RULE_LIMITS.textLength)).toBe(true);
    expect(result.question.form.choices[0]!.answer!.value).toHaveLength(RULE_LIMITS.textLength);
  });
  it('does not treat equivalent exact numeric answers as a conflict', () => {
    const numeric: QuestionKind = { ...kind, answerType: 'number' };
    const rules = [rule('a'), rule('b')].map((entry, index) => ({
      ...entry,
      answer: { type: 'number' as const, value: index ? '00.300' : '+0.3' },
    }));
    expect(decide(request({ item: { ...item, kind: numeric }, rules }))).toMatchObject({ status: 'decided' });
  });
  it('reports unknown rules, ignores disabled rules, and tries wider scopes', () => {
    const unknown = { ...rule('unknown', scopes[0]), condition: { present: 'heading' as const } };
    expect(
      decide(request({ rules: [unknown, { ...rule('off'), enabled: false }, rule('wide')] })),
    ).toMatchObject({
      status: 'decided',
      ruleId: 'wide',
      tried: [
        { ruleId: 'unknown', truth: 'unknown', missing: ['heading'] },
        { ruleId: 'wide', truth: 'true' },
      ],
    });
  });
  it('allows one attempt after an unknown answer, but holds business-only facts', () => {
    const answer = {
      questionId: question.id,
      questionVersion: question.version,
      response: { type: 'unknown' as const },
    };
    expect(decide(request({ answer })).status).toBe('attemptAllowed');
    expect(decide(request({ answer, attempt: 'exhausted' })).status).toBe('hold');
    expect(
      decide(request({ item: { ...item, kind: { ...kind, businessOnly: true } }, answer })),
    ).toMatchObject({ status: 'hold', messageId: 'ingest.decisions.businessKnowledgeRequired' });
  });
  it('holds an unresolved two-digit year for a person who knows the business', () => {
    const yearKind = STANDARD_QUESTIONS.find((entry) => entry.id === 'twoDigitYear')!;
    const yearQuestion = createQuestion(
      yearKind,
      {
        key: 'date-century',
        values: [text('01/02/26'), text('1926'), text('2026')],
        form: {
          type: 'choices',
          choices: [
            { id: '1926', messageId: 'test.year.1926' },
            { id: '2026', messageId: 'test.year.2026' },
          ],
        },
        evidence: [{ file: 'file-1', examples: ['01/02/26'] }],
        target,
        exits: ['skipFile'],
      },
      { format: 'format-1' },
    );
    const yearRequest = request({
      item: { ...item, kind: yearKind, value: '01/02/26' },
      key: yearQuestion.key,
      question: yearQuestion,
    });
    expect(decide(yearRequest)).toMatchObject({ status: 'ask', question: yearQuestion });
    expect(
      decide({
        ...yearRequest,
        answer: {
          questionId: yearQuestion.id,
          questionVersion: yearQuestion.version,
          response: { type: 'unknown' },
        },
      }),
    ).toEqual({ status: 'hold', messageId: 'ingest.decisions.businessKnowledgeRequired', tried: [] });
    expect(yearKind.businessOnly).toBe(true);
    expect(yearQuestion.businessOnly).toBe(true);
  });
  it('offers no sender scope for a dropped file', () => {
    expect(offeredScopes(kind, undefined, 'format-1')).toEqual({
      allowedScopes: ['valueFromAnyone', 'format', 'table'],
      defaultScope: 'valueFromAnyone',
    });
    expect(
      decide(
        request({
          item: { ...item, sender: undefined },
          rules: [rule('sender', scopes[0]), rule('any', scopes[1])],
        }),
      ),
    ).toMatchObject({ status: 'decided', ruleId: 'any' });
  });
});

describe('questions, versions, and holds', () => {
  it('requires valid source and destination selections for every repeated identity', () => {
    const disagreement = createQuestion(
      STANDARD_QUESTIONS.find((entry) => entry.id === 'fileTableDisagreement')!,
      {
        ...question,
        target: { type: 'file', file: 'file-1' },
        form: {
          type: 'choices',
          choices: [
            { id: 'keepTable', messageId: 'test.keepTable' },
            { id: 'takeFile', messageId: 'test.takeFile' },
          ],
          selections: [
            { identity: 'a', rows: [0, 1], recordIds: [] },
            { identity: 'b', rows: [2], recordIds: ['first', 'second'] },
          ],
        },
      },
    );
    const accepted = [
      { identity: 'a', row: 1 },
      { identity: 'b', recordId: 'second' },
    ];
    const allows = (selections: unknown) =>
      responseAllowed(disagreement, {
        type: 'answer',
        answer: { type: 'choice', value: 'takeFile', selections },
      } as Parameters<typeof responseAllowed>[1]);
    expect(allows(accepted)).toBe(true);
    for (const selections of [
      [],
      [accepted[0]],
      [...accepted, accepted[0]],
      [{ identity: 'a', row: 2 }, accepted[1]],
      [accepted[0], { identity: 'b', recordId: 'other' }],
      [{ identity: 'a', row: -1 }, accepted[1]],
      [{ identity: 'a', row: 0.5 }, accepted[1]],
      [{ identity: 'a', row: 1, extra: true }, accepted[1]],
      [{ identity: 'other', row: 1 }, accepted[1]],
    ])
      expect(allows(selections)).toBe(false);
    expect(
      responseAllowed(disagreement, { type: 'answer', answer: { type: 'choice', value: 'takeFile' } }),
    ).toBe(false);
    expect(
      responseAllowed(disagreement, { type: 'answer', answer: { type: 'choice', value: 'keepTable' } }),
    ).toBe(true);
    expect(
      responseAllowed(question, {
        type: 'answer',
        answer: { type: 'choice', value: 'a', selections: accepted },
      }),
    ).toBe(false);
  });
  it('keeps identity across reads and row order changes, but changes it when stakes change', () => {
    expect(questionIdentity(kind.id, 'region', [text('West')])).toBe(question.id);
    expect(questionIdentity(kind.id, 'region', [text('West'), text('West')])).toBe(question.id);
    expect(questionVersion(JSON.parse(JSON.stringify(question)) as typeof question)).toBe(question.version);
    expect(
      questionVersion({ ...question, orgId: 'org', tableId: 'table', active: true } as typeof question),
    ).toBe(question.version);
    const reread = createQuestion(kind, {
      ...question,
      evidence: [],
      target: { ...target, rows: [{ row: 9 }, { row: 1 }] },
    });
    expect(reread.id).toBe(question.id);
    expect(reread.version).not.toBe(question.version);
    expect(questionIdentity(kind.id, 'region', [text('East')])).not.toBe(question.id);
    expect(questionIdentity(kind.id, 'region', [text('East'), text('West')])).toBe(
      questionIdentity(kind.id, 'region', [text('West'), text('East')]),
    );
  });
  it('refuses a stale screen and returns the current question', () => {
    const answer = {
      questionId: question.id,
      questionVersion: 'old',
      response: { type: 'answer' as const, answer: { type: 'choice' as const, value: 'a' } },
    };
    expect(checkAnswer(question, answer)).toEqual({
      status: 'stale',
      question,
      messageId: 'ingest.decisions.staleAnswer',
    });
    expect(checkAnswer(question, { ...answer, questionVersion: question.version }).status).toBe('accepted');
  });
  it('ignores retained answers when the question no longer arises', () => {
    const answer = {
      questionId: question.id,
      questionVersion: question.version,
      response: { type: 'answer' as const, answer: { type: 'choice' as const, value: 'a' } },
    };
    expect(decide(request({ question: undefined, answer })).status).toBe('attemptAllowed');
    expect(decide(request({ answer }))).toMatchObject({ status: 'decided', questionId: question.id });
  });
  it('holds exactly the file, incoming rows, or field that the question concerns', () => {
    expect(questionHold({ target: { type: 'file', file: 'f' } })).toEqual({
      type: 'file',
      file: 'f',
      write: false,
    });
    expect(questionHold({ target: { type: 'rows', file: 'f', rows: [{ row: 4 }] } })).toEqual({
      type: 'rows',
      file: 'f',
      rows: [{ row: 4 }],
      preserveExisting: true,
    });
    expect(questionHold(question)).toEqual({
      type: 'field',
      file: 'file-1',
      rows: target.rows,
      field: 'region',
      write: true,
      empty: true,
      flagged: true,
    });
  });
  it('bounds evidence examples and declares all standard and custom business questions', () => {
    expect(
      createQuestion(kind, { ...question, evidence: [{ file: 'f', examples: ['a', 'b', 'c', 'd'] }] })
        .evidence[0]!.examples,
    ).toEqual(['a', 'b', 'c']);
    expect(STANDARD_QUESTIONS).toHaveLength(21);
    expect(new Set(STANDARD_QUESTIONS.map((entry) => entry.id)).size).toBe(21);
    for (const id of ['missingDateYear', 'missingUnit'])
      expect(STANDARD_QUESTIONS.find((entry) => entry.id === id)?.businessOnly).toBe(true);
    expect(STANDARD_QUESTIONS.find((entry) => entry.id === 'numericDateOrder')?.defaultScope).toBe('format');
    expect(kind.defaultScope).toBe('valueFromSender');
    expect(tableQuestionKind('territory', 'table.questions.territory', 'text').businessOnly).toBe(true);
  });
});
