import { z } from 'zod';
import type { FieldSpec } from './fields.js';
import { parsePattern, PATTERN_LIMIT, PATTERN_PRESETS, validPattern } from './patterns.js';

const message = { message: z.string().trim().max(1000).optional() };
const Required = z.object(message);
const NumberRule = z.object({ value: z.number().finite(), ...message });
const LengthRule = z.object({ value: z.number().int().min(0).max(1_000_000), ...message });
const DateRule = z.object({
  value: z
    .string()
    .refine((value) => /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value) && Number.isFinite(Date.parse(value)), {
      message: 'data.validation.dateBound',
    }),
  ...message,
});
export const PatternRule = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('preset'),
    preset: z.enum(['email', 'url', 'phone', 'postalCode', 'digits', 'letters']),
    ...message,
  }),
  z.object({
    kind: z.literal('custom'),
    pattern: z.string().refine(validPattern, { message: 'data.validation.patternSyntax' }),
    ...message,
  }),
]);
export const RequiredValidation = z.object({ required: Required.optional() });
export const TextValidation = RequiredValidation.extend({
  minLength: LengthRule.optional(),
  maxLength: LengthRule.optional(),
  pattern: PatternRule.optional(),
}).refine((rules) => !rules.minLength || !rules.maxLength || rules.minLength.value <= rules.maxLength.value, {
  message: 'data.validation.bounds',
});
export const PatternValidation = RequiredValidation.extend({ pattern: PatternRule.optional() });
export const NumberValidation = RequiredValidation.extend({
  min: NumberRule.optional(),
  max: NumberRule.optional(),
}).refine((rules) => !rules.min || !rules.max || rules.min.value <= rules.max.value, {
  message: 'data.validation.bounds',
});
export const DateValidation = RequiredValidation.extend({
  min: DateRule.optional(),
  max: DateRule.optional(),
}).refine((rules) => !rules.min || !rules.max || Date.parse(rules.min.value) <= Date.parse(rules.max.value), {
  message: 'data.validation.bounds',
});
export const UNIQUE_TYPES = ['text', 'number', 'email', 'url', 'phone', 'date', 'singleSelect'] as const;
export interface ValidationIssue {
  messageKey: string;
  message?: string;
}
export interface FieldValidation {
  required?: { message?: string };
  min?: { value: number | string; message?: string };
  max?: { value: number | string; message?: string };
  minLength?: { value: number; message?: string };
  maxLength?: { value: number; message?: string };
  pattern?: z.infer<typeof PatternRule>;
}

const matchers = new Map<string, (value: string) => boolean>();
export function validateFieldValue(
  field: Pick<FieldSpec, 'type' | 'options'>,
  value: unknown,
): ValidationIssue | null {
  const rules = (field.options as { validation?: FieldValidation }).validation;
  if (!rules) return null;
  const issue = (rule: { message?: string }, key: string): ValidationIssue => ({
    messageKey: `data.validation.${key}`,
    ...(rule.message ? { message: rule.message } : {}),
  });
  const empty =
    value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length);
  if (empty) return rules.required ? issue(rules.required, 'required') : null;
  const comparable = field.type === 'date' ? Date.parse(String(value)) : Number(value);
  const bound = (value: number | string) =>
    field.type === 'date' ? Date.parse(String(value)) : Number(value);
  if (rules.min && comparable < bound(rules.min.value)) return issue(rules.min, 'min');
  if (rules.max && comparable > bound(rules.max.value)) return issue(rules.max, 'max');
  if (typeof value === 'string') {
    const length = Array.from(value).length;
    if (rules.minLength && length < rules.minLength.value) return issue(rules.minLength, 'minLength');
    if (rules.maxLength && length > rules.maxLength.value) return issue(rules.maxLength, 'maxLength');
    if (rules.pattern) {
      if (value.length > PATTERN_LIMIT) return issue(rules.pattern, 'patternLength');
      const source =
        rules.pattern.kind === 'custom' ? rules.pattern.pattern : PATTERN_PRESETS[rules.pattern.preset];
      let match = matchers.get(source);
      if (!match) {
        try {
          match = parsePattern(source);
        } catch {
          return issue(rules.pattern, 'patternSyntax');
        }
        if (matchers.size >= 256) matchers.clear();
        matchers.set(source, match);
      }
      if (!match(value)) return issue(rules.pattern, 'pattern');
    }
  }
  return null;
}
