import { isCalendarDay, isCalendarMonth, isDecimal, validAnswer } from './conditions.js';
import type {
  DecisionAnswer,
  DecisionQuestion,
  DecisionSender,
  ExactValue,
  QuestionKind,
  QuestionResponse,
  QuestionTarget,
  ScopeKind,
} from './types.js';

/** Sorted object keys make identities independent of a JSON serializer's insertion order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** A portable 128-bit content hash.  Identity is never an authorization token. */
export function decisionHash(value: unknown): string {
  let hash = 0x6c62272e07bb014262b821756295c58dn;
  const mask = (1n << 128n) - 1n;
  for (const character of canonical(value)) {
    const point = character.codePointAt(0)!;
    const bytes =
      point < 0x80
        ? [point]
        : point < 0x800
          ? [0xc0 | (point >> 6), 0x80 | (point & 63)]
          : point < 0x10000
            ? [0xe0 | (point >> 12), 0x80 | ((point >> 6) & 63), 0x80 | (point & 63)]
            : [
                0xf0 | (point >> 18),
                0x80 | ((point >> 12) & 63),
                0x80 | ((point >> 6) & 63),
                0x80 | (point & 63),
              ];
    for (const byte of bytes) hash = ((hash ^ BigInt(byte)) * 0x1000000000000000000013bn) & mask;
  }
  return hash.toString(16).padStart(32, '0');
}

export function questionIdentity(kind: string, key: string, values: ExactValue[]): string {
  return `iq_${decisionHash({ kind, key, values: [...new Set(values.map(canonical))].sort() })}`;
}

export function offeredScopes(kind: QuestionKind, sender?: DecisionSender, format?: string) {
  const allowedScopes = kind.allowedScopes.filter(
    (scope) =>
      (sender || (scope !== 'sender' && scope !== 'valueFromSender')) && (format || scope !== 'format'),
  );
  const defaultScope: ScopeKind | null =
    kind.defaultScope && allowedScopes.includes(kind.defaultScope)
      ? kind.defaultScope
      : (allowedScopes[0] ?? null);
  return { allowedScopes, defaultScope };
}

export function createQuestion(
  kind: QuestionKind,
  input: Pick<DecisionQuestion, 'key' | 'values' | 'form' | 'evidence' | 'target' | 'exits'>,
  context: { value?: string; sender?: DecisionSender; format?: string } = {},
): DecisionQuestion {
  if (input.form.type !== kind.answerType) throw new Error('ingest.decisions.invalidQuestion');
  const body = {
    key: input.key,
    values: input.values,
    form: input.form,
    target: input.target,
    exits: input.exits,
    scopeContext: { ...context, value: context.value ?? input.values[0]?.value },
    kind: kind.id,
    messageId: kind.messageId,
    allowUnknown: kind.allowUnknown,
    businessOnly: kind.businessOnly,
    ...offeredScopes(kind, context.sender, context.format),
    evidence: input.evidence.map((evidence) => ({ ...evidence, examples: evidence.examples.slice(0, 3) })),
  };
  return { ...body, id: questionIdentity(kind.id, input.key, input.values), version: decisionHash(body) };
}

export function responseAllowed(question: DecisionQuestion, response: QuestionResponse): boolean {
  if (response.type === 'unknown') return question.allowUnknown;
  if (response.type !== 'answer') return question.exits.includes(response.type);
  const answer = response.answer;
  if (!validAnswer(answer)) return false;
  const form = question.form;
  if (form.type === 'choices') {
    if (answer.type !== 'choice' || !form.choices.some((choice) => choice.id === answer.value)) return false;
    if (!form.selections?.length) return !answer.selections?.length;
    if (answer.value !== 'takeFile') return !answer.selections?.length;
    const selections = answer.selections ?? [];
    return (
      new Set(selections.map((entry) => entry.identity)).size === selections.length &&
      selections.length === form.selections.length &&
      form.selections.every((group) => {
        const selected = selections.find((entry) => entry.identity === group.identity);
        if (!selected) return false;
        return (
          (group.rows.length > 1
            ? group.rows.includes(selected.row ?? -1)
            : selected.row === undefined || group.rows.includes(selected.row)) &&
          (group.recordIds.length > 1
            ? group.recordIds.includes(selected.recordId ?? '')
            : selected.recordId === undefined || group.recordIds.includes(selected.recordId))
        );
      })
    );
  }
  if (form.type !== answer.type) return false;
  if (answer.type === 'date') return isCalendarDay(answer.value);
  if (answer.type === 'month') return isCalendarMonth(answer.value);
  if (answer.type === 'number') return isDecimal(answer.value);
  if (form.type === 'mapping' && answer.type === 'mapping') {
    return (
      answer.value.length === form.columns.length &&
      new Set(answer.value.map((entry) => entry.heading)).size === answer.value.length &&
      form.columns.every((column) =>
        answer.value.some(
          (entry) =>
            entry.heading === column.heading && (entry.field === null || column.fields.includes(entry.field)),
        ),
      )
    );
  }
  return true;
}

export function checkAnswer(
  question: DecisionQuestion,
  answer: DecisionAnswer,
):
  | { status: 'accepted'; answer: DecisionAnswer }
  | { status: 'stale' | 'invalid'; question: DecisionQuestion; messageId: string } {
  if (answer.questionId !== question.id || answer.questionVersion !== question.version)
    return { status: 'stale', question, messageId: 'ingest.decisions.staleAnswer' };
  return responseAllowed(question, answer.response)
    ? { status: 'accepted', answer }
    : { status: 'invalid', question, messageId: 'ingest.decisions.invalidAnswer' };
}

export function questionVersion(question: DecisionQuestion): string {
  return decisionHash({
    kind: question.kind,
    key: question.key,
    values: question.values,
    messageId: question.messageId,
    form: question.form,
    evidence: question.evidence,
    target: question.target,
    scopeContext: question.scopeContext,
    defaultScope: question.defaultScope,
    allowedScopes: question.allowedScopes,
    allowUnknown: question.allowUnknown,
    businessOnly: question.businessOnly,
    exits: question.exits,
  });
}

export type QuestionHold =
  | { type: 'file'; file: string; write: false }
  | {
      type: 'rows';
      file: string;
      rows: Extract<QuestionTarget, { type: 'rows' }>['rows'];
      preserveExisting: true;
    }
  | {
      type: 'field';
      file: string;
      field: string;
      rows: Extract<QuestionTarget, { type: 'field' }>['rows'];
      write: true;
      empty: true;
      flagged: true;
    };

/** Only incoming rows are held.  A field question writes its rows with that field empty and flagged. */
export function questionHold(question: Pick<DecisionQuestion, 'target'>): QuestionHold {
  const target = question.target;
  if (target.type === 'file') return { type: 'file', file: target.file, write: false };
  if (target.type === 'rows')
    return { type: 'rows', file: target.file, rows: target.rows, preserveExisting: true };
  return {
    type: 'field',
    file: target.file,
    field: target.field,
    rows: target.rows,
    write: true,
    empty: true,
    flagged: true,
  };
}
