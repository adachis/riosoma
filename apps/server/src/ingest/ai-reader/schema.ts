import type { IngestTableSettings, FieldMeta } from '@riosoma/contracts';
import type { OutputSchema } from '@riosoma/ai';
import { outputSchema } from '../../ai/schema-output.js';

export interface OutputField {
  key: string;
  type: FieldMeta['type'];
  meaning: string;
  required: boolean;
  allowedValues?: string[];
  includeTime?: boolean;
}
export interface ReaderOutput {
  rowMeaning: string;
  identity: IngestTableSettings['identity'];
  fields: OutputField[];
}
export interface ChunkReply {
  count: number;
  emptyReason?: string | null;
  rows: Array<{
    values: Record<string, unknown>;
    at: { sheet: number; row: number };
    sources: Record<string, string>;
    doubts: string[];
  }>;
}
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

function fieldSchema(field: OutputField, allowUnexpectedChoice: boolean): Record<string, unknown> {
  const choice = { type: 'string', ...(!allowUnexpectedChoice ? { enum: field.allowedValues ?? [] } : {}) };
  let schema: Record<string, unknown>;
  switch (field.type) {
    case 'singleSelect':
      schema = choice;
      break;
    case 'multipleSelect':
      schema = { type: 'array', items: choice };
      break;
    case 'checkbox':
      schema = { type: 'boolean' };
      break;
    case 'number':
    case 'currency':
    case 'percent':
    case 'duration':
    case 'rating':
    case 'count':
    case 'autoNumber':
      schema = { type: 'number' };
      break;
    case 'date':
      schema = { type: 'string', format: field.includeTime ? 'date-time' : 'date' };
      break;
    case 'link':
    case 'user':
    case 'attachment':
      schema = { type: 'array', items: { type: 'string' } };
      break;
    case 'dateRange':
      schema = object({
        start: { type: 'string', format: field.includeTime ? 'date-time' : 'date' },
        end: { type: 'string', format: field.includeTime ? 'date-time' : 'date' },
      });
      break;
    case 'location':
      schema = object(
        {
          lat: { type: 'number' },
          lng: { type: 'number' },
          label: { type: ['string', 'null'] },
        },
        ['lat', 'lng'],
      );
      break;
    case 'multiCurrency':
      schema = object({ amount: { type: 'number' }, code: { type: 'string' } });
      break;
    case 'lineItems':
      schema = { type: 'array', items: object({ id: { type: 'string' }, values: { type: 'object' } }) };
      break;
    case 'json':
      schema = { type: 'string' };
      break;
    // Computed values belong to the table, and signatures require the signer.
    case 'createdTime':
    case 'lastModifiedTime':
    case 'createdBy':
    case 'lastModifiedBy':
    case 'recordId':
    case 'signature':
    case 'lookup':
    case 'rollup':
    case 'formula':
    case 'changeLog':
      schema = { type: 'null' };
      break;
    case 'button':
      schema = { type: 'null' };
      break;
    default:
      schema = { type: 'string' };
  }
  return { anyOf: [schema, { type: 'null' }], description: field.meaning };
}

/** Choice violations remain evidence, so local validation preserves them for the reading checks. */
export function readingSchema(output: ReaderOutput): OutputSchema<ChunkReply> {
  const build = (tolerant: boolean) =>
    object(
      {
        count: { type: 'integer', minimum: 0 },
        emptyReason: { type: ['string', 'null'] },
        rows: {
          type: 'array',
          items: object({
            values: object(
              Object.fromEntries(output.fields.map((field) => [field.key, fieldSchema(field, tolerant)])),
              tolerant ? [] : output.fields.filter((field) => field.required).map((field) => field.key),
            ),
            at: object({ sheet: { type: 'integer' }, row: { type: 'integer' } }),
            sources: object(
              Object.fromEntries(output.fields.map((field) => [field.key, { type: 'string' }])),
              tolerant
                ? []
                : output.fields
                    .filter((field) => field.required || output.identity?.includes(field.key))
                    .map((field) => field.key),
            ),
            doubts: {
              type: 'array',
              items: { type: 'string', enum: output.fields.map((field) => field.key) },
              uniqueItems: true,
            },
          }),
        },
      },
      tolerant ? ['count', 'rows'] : ['count', 'emptyReason', 'rows'],
    );
  const validation = outputSchema<ChunkReply>(build(true));
  return outputSchema(build(false), validation.validate);
}
