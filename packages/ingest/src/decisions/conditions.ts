import type {
  AnswerValue,
  Condition,
  DecisionInput,
  DecisionInputs,
  Evaluation,
  ExactValue,
  QuestionKind,
  RuleDocument,
  RuleScope,
} from './types.js';

export const RULE_LIMITS = { depth: 16, nodes: 256, listLength: 64, textLength: 4096 } as const;
const decimalPattern = /^[+-]?\d+(?:\.\d+)?$/;

export function isDecimal(value: string): boolean {
  return value.length <= RULE_LIMITS.textLength && decimalPattern.test(value);
}

export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

export function isCalendarMonth(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value) && isCalendarDay(`${value}-01`);
}

function decimalParts(value: string) {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^[+-]/, '').split('.');
  const digits = (whole! + fraction).replace(/^0+/, '') || '0';
  return { coefficient: BigInt(`${negative ? '-' : ''}${digits}`), scale: fraction.length };
}

/** Only digit strings enter arithmetic, so binary floating-point rounding cannot change a decision. */
export function compareExact(left: ExactValue, right: ExactValue): -1 | 0 | 1 | null {
  if (!validExact(left) || !validExact(right) || left.type !== right.type) return null;
  if (left.type === 'text') return left.value === right.value ? 0 : null;
  if (left.type === 'date') return left.value === right.value ? 0 : left.value < right.value ? -1 : 1;
  const a = decimalParts(left.value);
  const b = decimalParts(right.value);
  const scale = Math.max(a.scale, b.scale);
  const x = a.coefficient * 10n ** BigInt(scale - a.scale);
  const y = b.coefficient * 10n ** BigInt(scale - b.scale);
  return x === y ? 0 : x < y ? -1 : 1;
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === expected.length &&
    Object.keys(value).every((key) => expected.includes(key))
  );
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length <= RULE_LIMITS.textLength;
}
export function validExact(value: unknown): value is ExactValue {
  if (!keys(value, ['type', 'value']) || !text(value.value)) return false;
  return (
    value.type === 'text' ||
    (value.type === 'decimal' && isDecimal(value.value)) ||
    (value.type === 'date' && isCalendarDay(value.value))
  );
}
export function validAnswer(value: unknown): value is AnswerValue {
  if (record(value) && value.type === 'choice' && Object.hasOwn(value, 'selections')) {
    return (
      keys(value, ['type', 'value', 'selections']) &&
      text(value.value) &&
      value.value.length > 0 &&
      Array.isArray(value.selections) &&
      value.selections.every(
        (entry) =>
          record(entry) &&
          keys(entry, [
            'identity',
            ...(Object.hasOwn(entry, 'row') ? ['row'] : []),
            ...(Object.hasOwn(entry, 'recordId') ? ['recordId'] : []),
          ]) &&
          text(entry.identity) &&
          entry.identity.length > 0 &&
          (!Object.hasOwn(entry, 'row') || (Number.isSafeInteger(entry.row) && Number(entry.row) >= 0)) &&
          (!Object.hasOwn(entry, 'recordId') || (text(entry.recordId) && entry.recordId.length > 0)),
      )
    );
  }
  if (!keys(value, ['type', 'value'])) return false;
  switch (value.type) {
    case 'choice':
      return text(value.value) && value.value.length > 0;
    case 'text':
      return text(value.value);
    case 'number':
      return text(value.value) && isDecimal(value.value);
    case 'date':
      return text(value.value) && isCalendarDay(value.value);
    case 'month':
      return text(value.value) && isCalendarMonth(value.value);
    case 'mapping':
      return (
        Array.isArray(value.value) &&
        value.value.length <= RULE_LIMITS.listLength &&
        value.value.every(
          (entry) =>
            keys(entry, ['heading', 'field']) &&
            text(entry.heading) &&
            (entry.field === null || text(entry.field)),
        )
      );
    default:
      return false;
  }
}
export function validScope(value: unknown): value is RuleScope {
  if (!record(value)) return false;
  const sender = (input: unknown) =>
    keys(input, ['id', 'kind', 'value']) &&
    text(input.id) &&
    input.id.length > 0 &&
    text(input.value) &&
    input.value.length > 0 &&
    (input.kind === 'address' || input.kind === 'domain');
  switch (value.type) {
    case 'table':
      return keys(value, ['type']);
    case 'format':
      return keys(value, ['type', 'format']) && text(value.format) && value.format.length > 0;
    case 'sender':
      return keys(value, ['type', 'sender']) && sender(value.sender);
    case 'valueFromAnyone':
      return keys(value, ['type', 'value']) && text(value.value);
    case 'valueFromSender':
      return keys(value, ['type', 'value', 'sender']) && text(value.value) && sender(value.sender);
    default:
      return false;
  }
}

export type RuleValidation =
  | { ok: true; rule: RuleDocument }
  | {
      ok: false;
      messageId: 'ingest.decisions.invalidRule' | 'ingest.decisions.ruleLimit';
    };

/** Every object is closed, including operands and scopes, so extra executable settings are refused whole. */
export function validateRule(document: unknown, kind: QuestionKind): RuleValidation {
  let nodes = 0;
  let exceeded = false;
  const input = (value: unknown): value is DecisionInput =>
    text(value) &&
    (['text', 'field', 'heading', 'sender', 'format'].includes(value) || /^sibling:.+$/.test(value)) &&
    kind.inputs.includes(value as DecisionInput);
  const condition = (value: unknown, depth: number): boolean => {
    nodes += 1;
    if (depth > RULE_LIMITS.depth || nodes > RULE_LIMITS.nodes) {
      exceeded = true;
      return false;
    }
    if (!record(value) || Object.keys(value).length !== 1) return false;
    const op = Object.keys(value)[0]!;
    const operand = value[op];
    if (op === 'not') return condition(operand, depth + 1);
    if (op === 'all' || op === 'any')
      return (
        Array.isArray(operand) &&
        operand.length <= RULE_LIMITS.listLength &&
        operand.every((child) => condition(child, depth + 1))
      );
    if (op === 'present') return input(operand);
    if (op === 'in')
      return (
        keys(operand, ['input', 'values']) &&
        input(operand.input) &&
        Array.isArray(operand.values) &&
        operand.values.length <= RULE_LIMITS.listLength &&
        operand.values.every(validExact)
      );
    if (['contains', 'startsWith', 'endsWith'].includes(op))
      return keys(operand, ['input', 'value']) && input(operand.input) && text(operand.value);
    if (['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].includes(op))
      return (
        keys(operand, ['input', 'value']) &&
        input(operand.input) &&
        validExact(operand.value) &&
        (['eq', 'ne'].includes(op) || operand.value.type !== 'text')
      );
    return false;
  };
  // Count text and lists everywhere in the document, including an answer's mapping table.
  const withinLimits = (value: unknown, seen = new Set<object>()): boolean => {
    if (typeof value === 'string') return value.length <= RULE_LIMITS.textLength;
    if (value === null || typeof value !== 'object') return true;
    if (seen.has(value)) return false;
    seen.add(value);
    const children = Array.isArray(value) ? value : Object.values(value);
    const valid =
      (!Array.isArray(value) || value.length <= RULE_LIMITS.listLength) &&
      children.every((child) => withinLimits(child, seen));
    seen.delete(value);
    return valid;
  };
  // Check the tree iteratively before recursive validation to bound hostile document nesting.
  const pending: Array<{ value: unknown; depth: number }> = [{ value: document, depth: 0 }];
  let objects = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (entry.value && typeof entry.value === 'object') {
      if (++objects > RULE_LIMITS.nodes * 5 || entry.depth > RULE_LIMITS.depth * 3 + 8)
        return { ok: false, messageId: 'ingest.decisions.ruleLimit' };
      for (const child of Object.values(entry.value)) pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
  if (!withinLimits(document)) return { ok: false, messageId: 'ingest.decisions.ruleLimit' };
  const valid =
    keys(document, ['kind', 'scope', 'condition', 'answer']) &&
    document.kind === kind.id &&
    validScope(document.scope) &&
    kind.allowedScopes.includes(document.scope.type) &&
    condition(document.condition, 1) &&
    validAnswer(document.answer) &&
    document.answer.type === (kind.answerType === 'choices' ? 'choice' : kind.answerType);
  return valid
    ? { ok: true, rule: document as unknown as RuleDocument }
    : { ok: false, messageId: exceeded ? 'ingest.decisions.ruleLimit' : 'ingest.decisions.invalidRule' };
}

export function evaluateCondition(condition: Condition, inputs: DecisionInputs): Evaluation {
  if ('all' in condition || 'any' in condition) {
    const all = 'all' in condition;
    const parts = (all ? condition.all : (condition as { any: Condition[] }).any).map((child) =>
      evaluateCondition(child, inputs),
    );
    const decisive = all ? 'false' : 'true';
    const truth = parts.some((part) => part.truth === decisive)
      ? decisive
      : parts.some((part) => part.truth === 'unknown')
        ? 'unknown'
        : all
          ? 'true'
          : 'false';
    return { truth, missing: [...new Set(parts.flatMap((part) => part.missing))] };
  }
  if ('not' in condition) {
    const result = evaluateCondition(condition.not, inputs);
    return {
      ...result,
      truth: result.truth === 'unknown' ? 'unknown' : result.truth === 'true' ? 'false' : 'true',
    };
  }
  const op = Object.keys(condition)[0]!;
  const operand = Object.values(condition)[0] as {
    input: DecisionInput;
    value: ExactValue | string;
    values: ExactValue[];
  };
  const input = 'present' in condition ? condition.present : operand.input;
  if (!Object.hasOwn(inputs, input)) return { truth: 'unknown', missing: [input] };
  const value = inputs[input];
  if (op === 'present') return { truth: value != null ? 'true' : 'false', missing: [] };
  if (!validExact(value)) return { truth: 'unknown', missing: [input] };
  let result: boolean;
  if (op === 'in') {
    result = operand.values.some((candidate) => compareExact(value, candidate) === 0);
    if (!result && operand.values.some((candidate) => candidate.type !== value.type))
      return { truth: 'unknown', missing: [input] };
  } else if (['contains', 'startsWith', 'endsWith'].includes(op)) {
    if (value.type !== 'text') return { truth: 'unknown', missing: [input] };
    const literal = operand.value as string;
    result =
      op === 'contains'
        ? value.value.includes(literal)
        : op === 'startsWith'
          ? value.value.startsWith(literal)
          : value.value.endsWith(literal);
  } else {
    const literal = operand.value as ExactValue;
    if (value.type !== literal.type || (value.type === 'text' && !['eq', 'ne'].includes(op)))
      return { truth: 'unknown', missing: [input] };
    const compared = compareExact(value, literal);
    result =
      op === 'eq'
        ? compared === 0
        : op === 'ne'
          ? compared !== 0
          : op === 'lt'
            ? compared === -1
            : op === 'lte'
              ? compared === -1 || compared === 0
              : op === 'gt'
                ? compared === 1
                : compared === 1 || compared === 0;
  }
  return { truth: result ? 'true' : 'false', missing: [] };
}
