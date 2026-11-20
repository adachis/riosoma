import type { CellValues, FieldType } from '@riosoma/contracts';

export type FormulaType =
  'number' | 'text' | 'boolean' | 'date' | 'datetime' | 'blank' | { array: FormulaType };
export interface Span {
  readonly start: number;
  readonly end: number;
}
export interface FormulaError extends Span {
  messageKey: string;
  params?: Readonly<Record<string, string | number>>;
}
export type Result<T> = T | { error: FormulaError };
export type BinaryOperator =
  '+' | '-' | '*' | '/' | '&' | '=' | '!=' | '<>' | '<' | '<=' | '>' | '>=' | '&&' | '||';
export type Ast = Span &
  (
    | { readonly kind: 'literal'; readonly value: string | number | boolean }
    | {
        readonly kind: 'field';
        readonly name: string;
        readonly tableName?: string;
        readonly tableId?: string;
        readonly fieldId?: string;
        readonly fieldType?: FieldType;
        readonly valueType?: FormulaType;
      }
    | { readonly kind: 'unary'; readonly operand: Ast }
    | { readonly kind: 'binary'; readonly operator: BinaryOperator; readonly left: Ast; readonly right: Ast }
    | { readonly kind: 'call'; readonly name: string; readonly args: readonly Ast[] }
  );
export interface FormulaField {
  tableId?: string;
  tableName?: string;
  id: string;
  name: string;
  type: FieldType;
  options?: { includeTime?: boolean; choices?: readonly { id: string; name: string }[] };
  /**
   * What a computed field holds when its type alone can't say, like a lookup's list of numbers.
   * It wins over the type's own.
   */
  valueType?: FormulaType;
}
export type Fields = readonly FormulaField[] | ReadonlyMap<string, FormulaField>;
export type FieldTypes = ReadonlyMap<string, FormulaType | FormulaField>;
export interface FormulaRecord {
  /**
   * A field whose own value failed, such as a rollup of an erroring formula, holds that error.  A
   * link field holds its linked records' names, in link order, which the caller looks up: the
   * formula reads names, never record IDs.
   */
  values: Readonly<Record<string, CellValues[string] | ErrorValue>>;
  id: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string | null;
  updatedBy?: string | null;
  /** Required only by LAST_MODIFIED_TIME with explicit field arguments. */
  fieldUpdatedAt?: Readonly<Record<string, string | null>>;
}
export interface EvaluationContext {
  /** Complete readable records, already restricted by record rules and field permissions. */
  records?: readonly FormulaRecord[];
  tables?: ReadonlyMap<string, readonly FormulaRecord[]>;
  now: Date | string;
  timeZone: string;
  choices?: ReadonlyMap<string, string>;
  people?: ReadonlyMap<string, string>;
}
export interface ErrorValue {
  error: '#ERROR!';
  messageKey: string;
  params?: Readonly<Record<string, string | number>>;
}
export type FormulaValue = string | number | boolean | null | ErrorValue | FormulaValue[];
export function fieldList(fields: Fields): readonly FormulaField[] {
  return Array.isArray(fields) ? fields : [...(fields as ReadonlyMap<string, FormulaField>).values()];
}
export function fieldType(field: FormulaField): FormulaType {
  if (field.valueType) return field.valueType;
  switch (field.type) {
    // Each holds a plain number: an amount, a fraction (0.25 for 25%), seconds, or a whole number.
    case 'number':
    case 'currency':
    case 'percent':
    case 'duration':
    case 'rating':
    case 'autoNumber':
    case 'count':
      return 'number';
    case 'checkbox':
      return 'boolean';
    case 'date':
      return field.options?.includeTime ? 'datetime' : 'date';
    case 'createdTime':
    case 'lastModifiedTime':
      return 'datetime';
    // Choices, people, and linked records read by name, and attachments by ID.
    case 'changeLog':
    case 'multipleSelect':
    case 'user':
    case 'lineItems':
    case 'link':
    case 'attachment':
      return { array: 'text' };
    // A range is its two ends, which START() and END() take apart.
    case 'dateRange':
      return { array: field.options?.includeTime ? 'datetime' : 'date' };
    // When it was signed: whether it's signed at all, and whether that was in time.
    case 'signature':
      return 'datetime';
    default:
      return 'text';
  }
}
export function diagnostic(node: Span, messageKey: string, params?: FormulaError['params']): FormulaError {
  return { messageKey, start: node.start, end: node.end, ...(params ? { params } : {}) };
}
