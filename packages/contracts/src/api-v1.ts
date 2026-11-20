import { z } from 'zod';
import type { ErrorBody } from './errors.js';
import {
  DatabaseId,
  Choice,
  Description,
  FieldId,
  FieldOptions,
  FieldSpec,
  FieldType,
  LIMITS,
  Name,
  RecordId,
  type FieldMeta,
} from './data/fields.js';
import { FilterGroup, Sort } from './data/filters.js';
import type { TableMeta } from './data/schema.js';
import { FormSettings, ViewType, type ViewMeta } from './data/views.js';
import { RecordShape } from './api.js';
import { SecondStepProof } from './mfa.js';

/**
 * Personal access tokens let scripts and integrations act as the person who made them, limited to
 * the scopes and databases chosen.  Scope names follow Airtable's so moving an integration over
 * is mostly a matter of changing its URL.
 *
 * Routes (session): `GET /api/tokens`, `POST /api/tokens` (returns the token once),
 * `DELETE /api/tokens/:tokenId`.  Tokens authenticate as `Authorization: Bearer rio_pat_…` on
 * `/api/v1/…` routes only, never on the app's own routes.  A token is another way in, so someone
 * with a second step sends a fresh one in `proof` to create it.
 */
export const TOKEN_SCOPES = [
  'data.records:read',
  'data.records:write',
  'schema.bases:read',
  'schema.bases:write',
] as const;
export const TokenScope = z.enum(TOKEN_SCOPES);
export type TokenScope = z.infer<typeof TokenScope>;

export const TOKEN_PREFIX = 'rio_pat_';

export const TokenCreate = z.object({
  name: Name,
  scopes: z.array(TokenScope).min(1),
  /** Every database the person can open, now and later, or a fixed list */
  databases: z.union([z.literal('all'), z.array(DatabaseId).min(1).max(1_000)]),
  /** Null never expires */
  expiresInDays: z.number().int().min(1).max(3_650).nullable().default(null),
  /** A fresh second step, needed once the person has one */
  proof: SecondStepProof.optional(),
});
export type TokenCreate = z.infer<typeof TokenCreate>;

export interface TokenMeta {
  id: string;
  name: string;
  scopes: TokenScope[];
  databases: 'all' | string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface TokenCreated extends TokenMeta {
  /** Shown once; only its hash is stored */
  token: string;
}

/**
 * The public REST API, `/api/v1`.  Records go through the same command bus as the app, so
 * permissions, validation, undo history, audit, and realtime all apply.
 *
 * - `GET /api/v1/databases`
 * - `GET /api/v1/databases/:databaseId/tables` (tables with fields and views)
 * - `GET /api/v1/tables/:tableId/records` (`RecordsQuery`)
 * - `GET /api/v1/tables/:tableId/records/:recordId`
 * - `POST /api/v1/tables/:tableId/records` (`RecordsWrite`, creates)
 * - `PATCH /api/v1/tables/:tableId/records` (`RecordsWrite` with IDs, changes only the fields given)
 * - `PUT /api/v1/tables/:tableId/records` (`RecordsWrite` with IDs, clears fields left out)
 * - `DELETE /api/v1/tables/:tableId/records?records=rec…&records=rec…`
 * - `GET /api/v1/openapi.json`
 *
 * Values in `fields` use outside-friendly forms: select options by name, people as
 * `{ id, email, name }`, files as `{ id, url, filename, size, type, thumbnails }`, links as record
 * IDs, dates as `YYYY-MM-DD` or ISO instants, percent as fractions, and durations in seconds.
 * Long text with rich text is its Markdown text, in both cell formats (see `FieldOptions.longText`).
 * Writes accept the same forms (people by ID or email; with `typecast`, unknown option names
 * become new options).
 */
export const RecordsQuery = z.object({
  /** A view's filter and fields apply, and its sorts break ties after `sort` */
  view: z.string().optional(),
  /** Field names or IDs to return; all visible fields when left out */
  fields: z.array(z.string()).max(500).optional(),
  filter: FilterGroup.optional(),
  sort: z.array(Sort).max(10).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().max(200).optional(),
  shape: RecordShape.default('keyed'),
  /** Key record fields by name (default) or by ID */
  fieldKey: z.enum(['name', 'id']).default('name'),
  /** `string` formats every value as the app shows it, in `locale` and `timeZone` */
  cellFormat: z.enum(['json', 'string']).default('json'),
  timeZone: z.string().optional(),
  locale: z.string().optional(),
});
export type RecordsQuery = z.infer<typeof RecordsQuery>;

export const RecordsWrite = z.object({
  records: z
    .array(
      z.object({
        id: RecordId.optional(),
        fields: z.record(z.string(), z.unknown()),
        /** Starting values for long text, Markdown, and JSON, using the same keys and shapes as fields. */
        baseFields: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1)
    .max(1_000),
  typecast: z.boolean().default(false),
  /** Writes AI fields too, which a model otherwise fills in and writes refuse, like formulas */
  overrideAiFields: z.boolean().default(false),
  fieldKey: z.enum(['name', 'id']).default('name'),
});
export type RecordsWrite = z.infer<typeof RecordsWrite>;

/**
 * Schema writes, with the `schema.bases:write` scope.  Each one runs the same commands as the app,
 * answers with what it changed and its `undoGroupId`, and puts trashed tables, fields, and views in
 * the trash.  The server picks new IDs.  A select choice may leave out its `id` and `color`: a new
 * one gets both, and one named like a current choice keeps that choice's ID.
 *
 * - `POST /api/v1/databases/:databaseId/tables`, `PATCH` and `DELETE /api/v1/tables/:tableId`
 * - `POST /api/v1/tables/:tableId/fields`, `PATCH` and `DELETE /api/v1/fields/:fieldId`
 * - `POST /api/v1/tables/:tableId/views`, `PATCH` and `DELETE /api/v1/views/:viewId`
 */
const SchemaChoices = z
  .array(Choice.extend({ id: Choice.shape.id.optional(), color: Choice.shape.color.optional() }))
  .max(LIMITS.choicesPerField);
const SchemaFieldSpec = z.discriminatedUnion('type', [
  FieldSpec.options[0],
  ...FieldSpec.options.slice(1).map((spec) => {
    if (spec.shape.type.value === 'singleSelect')
      return z.object({
        type: z.literal('singleSelect'),
        options: FieldOptions.singleSelect.extend({ choices: SchemaChoices.default([]) }).prefault({}),
      });
    if (spec.shape.type.value === 'multipleSelect')
      return z.object({
        type: z.literal('multipleSelect'),
        options: FieldOptions.multipleSelect.extend({ choices: SchemaChoices.default([]) }).prefault({}),
      });
    return spec;
  }),
]);
export const SchemaFieldCreate = z.intersection(
  z.object({ name: Name, description: Description.default('') }),
  SchemaFieldSpec,
);
export type SchemaFieldCreate = z.input<typeof SchemaFieldCreate>;

const someChange = (value: object) => Object.values(value).some((item) => item !== undefined);
/** A place among its siblings, counting from 0.  Past the end moves it last. */
const Index = z.number().int().min(0).max(100_000);

export const SchemaTableCreate = z.object({
  name: Name,
  description: Description.default(''),
  /** The first field is the primary field */
  fields: z.array(SchemaFieldCreate).min(1).max(LIMITS.fieldsPerTable),
  /** The name of the grid view the table starts with */
  viewName: Name.default('Grid view'),
});
export type SchemaTableCreate = z.input<typeof SchemaTableCreate>;

export const SchemaTableUpdate = z
  .object({ name: Name.optional(), description: Description.optional(), index: Index.optional() })
  .refine(someChange);
export type SchemaTableUpdate = z.input<typeof SchemaTableUpdate>;

/** A new `type` converts the field as the app's field dialog does.  `options` replace its options. */
export const SchemaFieldUpdate = z
  .object({
    name: Name.optional(),
    description: Description.optional(),
    type: FieldType.optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
  .refine(someChange);
export type SchemaFieldUpdate = z.input<typeof SchemaFieldUpdate>;

export const SchemaViewCreate = z.object({ name: Name, type: ViewType.default('grid') });
export type SchemaViewCreate = z.input<typeof SchemaViewCreate>;

export const SchemaViewUpdate = z
  .object({
    name: Name.optional(),
    index: Index.optional(),
    /** The view's field order, by ID.  Fields left out keep their order after the ones listed. */
    fieldOrder: z.array(FieldId).max(LIMITS.fieldsPerTable).optional(),
    form: FormSettings.optional(),
  })
  .refine(someChange);
export type SchemaViewUpdate = z.input<typeof SchemaViewUpdate>;

/** Schema writes return the visible result and the action to undo in the app. */
export interface SchemaTableResult {
  table: (TableMeta & { fields: FieldMeta[]; views: ViewMeta[] }) | null;
  undoGroupId: string;
}

export interface SchemaFieldResult {
  field: FieldMeta | null;
  undoGroupId: string;
}

export interface SchemaViewResult {
  view: ViewMeta | null;
  undoGroupId: string;
}

export interface SchemaTrashResult {
  id: string;
  undoGroupId: string;
}

/**
 * How many attachments one write may name by address, as `{ url, filename }` items, which the
 * server downloads before it changes anything.
 */
export const ATTACHMENT_ADDRESS_LIMITS = { perRecord: 10, perRequest: 50 } as const;

/** Errors carry the app's message key plus plain English for people reading API responses. */
export interface ApiV1Error {
  error: {
    fields?: Record<string, string>;
    issues?: ErrorBody['error']['issues'];
    conflicts?: ErrorBody['error']['conflicts'];
    code: string;
    messageKey: string;
    message: string;
    params?: Record<string, unknown>;
  };
}
