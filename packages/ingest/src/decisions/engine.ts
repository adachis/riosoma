import { evaluateCondition, validateRule } from './conditions.js';
import { canonical, createQuestion, decisionHash, responseAllowed } from './questions.js';
import type {
  AnswerValue,
  DecisionAnswer,
  DecisionInput,
  DecisionItem,
  DecisionQuestion,
  DecisionRule,
  QuestionKind,
  QuestionResponse,
  QuestionTarget,
  RuleDocument,
  RuleScope,
  ScopeKind,
  Truth,
} from './types.js';

export const SCOPE_PRECEDENCE: Readonly<Record<ScopeKind, number>> = {
  valueFromSender: 1,
  valueFromAnyone: 2,
  format: 3,
  sender: 4,
  table: 5,
};

export function scopeMatches(scope: RuleScope, item: DecisionItem): boolean {
  const sender = 'sender' in scope && item.sender && canonical(scope.sender) === canonical(item.sender);
  switch (scope.type) {
    case 'valueFromSender':
      return !!sender && scope.value === item.value;
    case 'valueFromAnyone':
      return scope.value === item.value;
    case 'format':
      return scope.format === item.format;
    case 'sender':
      return !!sender;
    case 'table':
      return true;
  }
}
export interface RuleTrial {
  ruleId: string;
  truth: Truth | 'invalid';
  missing: DecisionInput[];
}
export interface BuiltInRule extends RuleDocument {
  id: string;
  source: 'file' | 'knownList' | 'setup';
}
export type DecisionOutcome =
  | {
      status: 'decided';
      response: QuestionResponse;
      ruleId?: string;
      questionId?: string;
      tried: RuleTrial[];
    }
  | { status: 'ask'; question: DecisionQuestion; tried: RuleTrial[]; holdReason?: string }
  | { status: 'attemptAllowed'; tried: RuleTrial[] }
  | { status: 'hold'; messageId: string; tried: RuleTrial[] };
export interface DecisionRequest {
  item: DecisionItem;
  builtIns?: BuiltInRule[];
  rules: DecisionRule[];
  question?: DecisionQuestion;
  answer?: DecisionAnswer;
  target: QuestionTarget;
  key: string;
  attempt: 'unused' | 'exhausted';
}

function answerIdentity(answer: AnswerValue): string {
  if (answer.type === 'number') {
    const negative = answer.value.startsWith('-');
    const [whole, fraction = ''] = answer.value.replace(/^[+-]/, '').split('.');
    const integer = whole!.replace(/^0+/, '') || '0';
    const part = fraction.replace(/0+$/, '');
    return canonical({
      type: 'number',
      value: `${negative && (integer !== '0' || part) ? '-' : ''}${integer}${part ? `.${part}` : ''}`,
    });
  }
  return canonical(
    answer.type === 'mapping'
      ? {
          ...answer,
          value: [...answer.value].sort((a, b) =>
            a.heading < b.heading ? -1 : a.heading > b.heading ? 1 : 0,
          ),
        }
      : answer,
  );
}

/** Rules are grouped by standing, so input order cannot silently select a conflicting answer. */
export function decide(request: DecisionRequest): DecisionOutcome {
  const { item } = request;
  const tried: RuleTrial[] = [];
  const sourceOrder = { file: 0, knownList: 1, setup: 2 };
  const candidates = [
    ...(request.builtIns ?? []).map((rule) => ({ rule, standing: sourceOrder[rule.source] })),
    ...request.rules
      .filter((rule) => rule.enabled && scopeMatches(rule.scope, item))
      .map((rule) => ({ rule, standing: 3 + SCOPE_PRECEDENCE[rule.scope.type] })),
  ]
    .filter(({ rule }) => rule.kind === item.kind.id)
    .sort((a, b) => a.standing - b.standing || (a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0));
  for (const standing of [...new Set(candidates.map((entry) => entry.standing))]) {
    const matches: Array<{ id: string; answer: AnswerValue }> = [];
    for (const { rule } of candidates.filter((entry) => entry.standing === standing)) {
      const document = { kind: rule.kind, scope: rule.scope, condition: rule.condition, answer: rule.answer };
      // Built-ins need no remembered scope, but still obey the same closed language and input declaration.
      const kind = 'source' in rule ? { ...item.kind, allowedScopes: [rule.scope.type] } : item.kind;
      if (!validateRule(document, kind).ok) {
        tried.push({ ruleId: rule.id, truth: 'invalid', missing: [] });
        continue;
      }
      const result = evaluateCondition(rule.condition, item.inputs);
      tried.push({ ruleId: rule.id, ...result });
      if (result.truth === 'true') matches.push({ id: rule.id, answer: rule.answer });
    }
    if (!matches.length) continue;
    const distinct = new Map(matches.map((rule) => [answerIdentity(rule.answer), rule.answer]));
    if (distinct.size === 1)
      return {
        status: 'decided',
        response: { type: 'answer', answer: matches[0]!.answer },
        ruleId: matches[0]!.id,
        tried,
      };
    const answers = [...distinct.values()].sort((a, b) => (answerIdentity(a) < answerIdentity(b) ? -1 : 1));
    const conflictKind: QuestionKind = {
      ...item.kind,
      id: 'ruleConflict',
      messageId: 'ingest.decisions.ruleConflict',
      answerType: 'choices',
      allowUnknown: false,
      businessOnly: true,
      allowedScopes: [],
      defaultScope: null,
    };
    const question = createQuestion(conflictKind, {
      key: decisionHash({ kind: item.kind.id, key: request.key }),
      values: [
        ...(request.question?.values ??
          (item.value === undefined ? [] : [{ type: 'text' as const, value: item.value }])),
        ...answers.map((answer): { type: 'text'; value: string } => ({
          type: 'text',
          value: decisionHash(answerIdentity(answer)),
        })),
      ],
      form: {
        type: 'choices',
        choices: answers.map((answer) => ({
          id: decisionHash(answerIdentity(answer)),
          messageId: 'ingest.decisions.chooseRuleAnswer',
          answer,
        })),
      },
      evidence: request.question?.evidence ?? [],
      target: request.target,
      exits: [],
    });
    if (
      request.answer?.questionId === question.id &&
      request.answer.response.type === 'answer' &&
      responseAllowed(question, request.answer.response)
    ) {
      const selected = answers.find(
        (answer) =>
          decisionHash(answerIdentity(answer)) ===
          (request.answer!.response as { type: 'answer'; answer: AnswerValue }).answer.value,
      );
      if (selected)
        return {
          status: 'decided',
          response: { type: 'answer', answer: selected },
          questionId: question.id,
          tried,
        };
    }
    return { status: 'ask', question, tried, holdReason: 'ingest.decisions.ruleConflict' };
  }
  const question = request.question;
  if (question) {
    const answer =
      request.answer?.questionId === question.id && responseAllowed(question, request.answer.response)
        ? request.answer
        : undefined;
    if (!answer) return { status: 'ask', question, tried };
    if (answer.response.type !== 'unknown')
      return { status: 'decided', response: answer.response, questionId: question.id, tried };
  }
  if (item.kind.businessOnly || question?.businessOnly)
    return { status: 'hold', messageId: 'ingest.decisions.businessKnowledgeRequired', tried };
  return request.attempt === 'unused'
    ? { status: 'attemptAllowed', tried }
    : { status: 'hold', messageId: 'ingest.decisions.unresolved', tried };
}
