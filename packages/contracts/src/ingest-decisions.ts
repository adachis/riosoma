import { z } from 'zod';

const text = z.string().max(4096);
const key = text.min(1);
const decimal = text.regex(/^[+-]?\d+(?:\.\d+)?$/);
const day = text.regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const date = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return (
    year > 0 &&
    month >= 1 &&
    month <= 12 &&
    date >= 1 &&
    date <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
  );
});
const month = text.regex(/^\d{4}-(0[1-9]|1[0-2])$/).refine((value) => !value.startsWith('0000'));
const exact = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), value: text }),
  z.strictObject({ type: z.literal('decimal'), value: decimal }),
  z.strictObject({ type: z.literal('date'), value: day }),
]);
const sender = z.strictObject({ id: key, kind: z.enum(['address', 'domain']), value: key });
const scopeKind = z.enum(['valueFromSender', 'valueFromAnyone', 'format', 'sender', 'table']);
const scope = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('valueFromSender'), value: text, sender }),
  z.strictObject({ type: z.literal('valueFromAnyone'), value: text }),
  z.strictObject({ type: z.literal('format'), format: key }),
  z.strictObject({ type: z.literal('sender'), sender }),
  z.strictObject({ type: z.literal('table') }),
]);
type Input = 'text' | 'field' | 'heading' | 'sender' | 'format' | `sibling:${string}`;
const input = z.union([
  z.enum(['text', 'field', 'heading', 'sender', 'format']),
  key.regex(/^sibling:.+$/),
]) as z.ZodType<Input>;
type Exact = z.infer<typeof exact>;
type ComparisonOperand = { input: Input; value: Exact };
type TextOperand = { input: Input; value: string };
type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { present: Input }
  | { eq: ComparisonOperand }
  | { ne: ComparisonOperand }
  | { lt: ComparisonOperand }
  | { lte: ComparisonOperand }
  | { gt: ComparisonOperand }
  | { gte: ComparisonOperand }
  | { in: { input: Input; values: Exact[] } }
  | { contains: TextOperand }
  | { startsWith: TextOperand }
  | { endsWith: TextOperand };
const operand = z.strictObject({ input, value: exact });
const ordered = z.strictObject({
  input,
  value: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('decimal'), value: decimal }),
    z.strictObject({ type: z.literal('date'), value: day }),
  ]),
});
const literalText = z.strictObject({ input, value: text });
const conditionTree: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(conditionTree).max(64) }),
    z.strictObject({ any: z.array(conditionTree).max(64) }),
    z.strictObject({ not: conditionTree }),
    z.strictObject({ present: input }),
    z.strictObject({ eq: operand }),
    z.strictObject({ ne: operand }),
    z.strictObject({ lt: ordered }),
    z.strictObject({ lte: ordered }),
    z.strictObject({ gt: ordered }),
    z.strictObject({ gte: ordered }),
    z.strictObject({ in: z.strictObject({ input, values: z.array(exact).max(64) }) }),
    z.strictObject({ contains: literalText }),
    z.strictObject({ startsWith: literalText }),
    z.strictObject({ endsWith: literalText }),
  ]),
);
const condition = z
  .unknown()
  .superRefine((value, context) => {
    const pending = [{ value, depth: 1 }];
    let nodes = 0;
    while (pending.length) {
      const entry = pending.pop()!;
      if (++nodes > 256 || entry.depth > 16) {
        context.addIssue({ code: 'custom', message: 'ingest.decisions.ruleLimit' });
        return;
      }
      if (!entry.value || typeof entry.value !== 'object' || Array.isArray(entry.value)) continue;
      const node = entry.value as Record<string, unknown>;
      if ('not' in node) pending.push({ value: node.not, depth: entry.depth + 1 });
      for (const op of ['all', 'any'])
        if (Array.isArray(node[op]))
          for (const child of node[op]) pending.push({ value: child, depth: entry.depth + 1 });
    }
  })
  .pipe(conditionTree);
const answerValue = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('choice'),
    value: key,
    selections: z
      .array(
        z.strictObject({
          identity: key,
          row: z.number().int().nonnegative().optional(),
          recordId: key.optional(),
        }),
      )
      .optional(),
  }),
  z.strictObject({ type: z.literal('text'), value: text }),
  z.strictObject({ type: z.literal('number'), value: decimal }),
  z.strictObject({ type: z.literal('date'), value: day }),
  z.strictObject({ type: z.literal('month'), value: month }),
  z.strictObject({
    type: z.literal('mapping'),
    value: z.array(z.strictObject({ heading: text, field: key.nullable() })).max(64),
  }),
]);
const response = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('answer'), answer: answerValue }),
  z.strictObject({ type: z.enum(['unknown', 'removeRow', 'skipFile']) }),
]);
const location = z.strictObject({
  sheet: text.optional(),
  row: z.number().int().positive().optional(),
  page: z.number().int().positive().optional(),
  line: z.number().int().positive().optional(),
  table: z.number().int().positive().optional(),
});
const target = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('file'), file: key }),
  z.strictObject({ type: z.literal('rows'), file: key, rows: z.array(location) }),
  z.strictObject({ type: z.literal('field'), file: key, rows: z.array(location), field: key }),
]);
const form = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('choices'),
    choices: z.array(
      z.strictObject({
        id: key,
        messageId: key,
        answer: answerValue.optional(),
        params: z.record(z.string(), z.string()).optional(),
      }),
    ),
    selections: z
      .array(
        z.strictObject({
          identity: key,
          rows: z.array(z.number().int().nonnegative()),
          recordIds: z.array(key),
        }),
      )
      .optional(),
  }),
  z.strictObject({ type: z.enum(['date', 'month', 'number', 'text']) }),
  z.strictObject({
    type: z.literal('mapping'),
    columns: z
      .array(
        z.strictObject({
          heading: text,
          examples: z.array(text).max(3),
          fields: z.array(key).max(64),
        }),
      )
      .max(64),
  }),
]);

export const IngestDecisionQuestion = z.strictObject({
  id: key,
  orgId: key,
  tableId: key,
  version: key,
  kind: key,
  key,
  values: z.array(exact),
  messageId: key,
  form,
  evidence: z.array(location.extend({ file: key, column: text.optional(), examples: z.array(text).max(3) })),
  target,
  scopeContext: z.strictObject({ value: text.optional(), sender: sender.optional(), format: key.optional() }),
  defaultScope: scopeKind.nullable(),
  allowedScopes: z.array(scopeKind).max(5),
  allowUnknown: z.boolean(),
  businessOnly: z.boolean(),
  exits: z.array(z.enum(['removeRow', 'skipFile'])).max(2),
  active: z.boolean(),
});
export type IngestDecisionQuestion = z.infer<typeof IngestDecisionQuestion>;

export const IngestDecisionAnswer = z.strictObject({
  id: key,
  orgId: key,
  tableId: key,
  questionId: key,
  questionVersion: key,
  response,
  answeredBy: key.nullable(),
  answeredAt: key,
});
export type IngestDecisionAnswer = z.infer<typeof IngestDecisionAnswer>;

export const IngestDecisionRule = z.strictObject({
  id: key,
  orgId: key,
  tableId: key,
  kind: key,
  scope,
  condition,
  answer: answerValue,
  enabled: z.boolean(),
  createdBy: key.nullable(),
  createdAt: key,
  updatedAt: key,
});
export type IngestDecisionRule = z.infer<typeof IngestDecisionRule>;
