import type { RowLocation } from '../source.js';

export type ExactValue = { type: 'text' | 'decimal' | 'date'; value: string };
export type DecisionInput = 'text' | 'field' | 'heading' | 'sender' | 'format' | `sibling:${string}`;
export type Comparison = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
type ComparisonOperand = { input: DecisionInput; value: ExactValue };
type TextOperand = { input: DecisionInput; value: string };
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { present: DecisionInput }
  | { eq: ComparisonOperand }
  | { ne: ComparisonOperand }
  | { lt: ComparisonOperand }
  | { lte: ComparisonOperand }
  | { gt: ComparisonOperand }
  | { gte: ComparisonOperand }
  | { in: { input: DecisionInput; values: ExactValue[] } }
  | { contains: TextOperand }
  | { startsWith: TextOperand }
  | { endsWith: TextOperand };
export type Truth = 'true' | 'false' | 'unknown';
export interface Evaluation {
  truth: Truth;
  missing: DecisionInput[];
}
export type DecisionInputs = Partial<Record<DecisionInput, ExactValue | null>>;

/** Sender IDs identify approved entries, so address and domain approval remain distinct. */
export interface DecisionSender {
  id: string;
  kind: 'address' | 'domain';
  value: string;
}
export type ScopeKind = 'valueFromSender' | 'valueFromAnyone' | 'format' | 'sender' | 'table';
export type RuleScope =
  | { type: 'valueFromSender'; value: string; sender: DecisionSender }
  | { type: 'valueFromAnyone'; value: string }
  | { type: 'format'; format: string }
  | { type: 'sender'; sender: DecisionSender }
  | { type: 'table' };
export type AnswerValue =
  | {
      type: 'choice';
      value: string;
      selections?: Array<{ identity: string; row?: number; recordId?: string }>;
    }
  | { type: 'date' | 'month' | 'number' | 'text'; value: string }
  | { type: 'mapping'; value: Array<{ heading: string; field: string | null }> };
export type QuestionResponse =
  { type: 'answer'; answer: AnswerValue } | { type: 'unknown' | 'removeRow' | 'skipFile' };
export type QuestionForm =
  | {
      type: 'choices';
      choices: Array<{
        id: string;
        messageId: string;
        answer?: AnswerValue;
        params?: Record<string, string>;
      }>;
      /** Taking a file with repeated identities requires explicit source and destination selections. */
      selections?: Array<{ identity: string; rows: number[]; recordIds: string[] }>;
    }
  | { type: 'date' | 'month' | 'number' | 'text' }
  | { type: 'mapping'; columns: Array<{ heading: string; examples: string[]; fields: string[] }> };
export interface QuestionKind {
  id: string;
  class: 'convention' | 'value' | 'file';
  messageId: string;
  defaultScope: ScopeKind | null;
  allowedScopes: ScopeKind[];
  inputs: DecisionInput[];
  answerType: QuestionForm['type'];
  allowUnknown: boolean;
  businessOnly: boolean;
}
export interface QuestionEvidence extends RowLocation {
  file: string;
  column?: string;
  examples: string[];
}
export type QuestionTarget =
  | { type: 'file'; file: string }
  | { type: 'rows'; file: string; rows: RowLocation[] }
  | { type: 'field'; file: string; rows: RowLocation[]; field: string };
export interface DecisionQuestion {
  id: string;
  version: string;
  kind: string;
  key: string;
  values: ExactValue[];
  messageId: string;
  form: QuestionForm;
  evidence: QuestionEvidence[];
  target: QuestionTarget;
  scopeContext: { value?: string; sender?: DecisionSender; format?: string };
  defaultScope: ScopeKind | null;
  allowedScopes: ScopeKind[];
  allowUnknown: boolean;
  businessOnly: boolean;
  exits: Array<'removeRow' | 'skipFile'>;
}
export interface DecisionAnswer {
  questionId: string;
  questionVersion: string;
  response: QuestionResponse;
}
export interface RuleDocument {
  kind: string;
  scope: RuleScope;
  condition: Condition;
  answer: AnswerValue;
}
export interface DecisionRule extends RuleDocument {
  id: string;
  enabled: boolean;
}
export interface DecisionItem {
  kind: QuestionKind;
  value?: string;
  sender?: DecisionSender;
  format?: string;
  inputs: DecisionInputs;
}
