import { z } from 'zod';

export const NAMED_FUNCTION_LIMITS = {
  definitions: 100,
  parameters: 32,
  nameLength: 64,
  bodyLength: 10_000,
  expandedNodes: 10_000,
  depth: 256,
} as const;

const identifier = z
  .string()
  .min(1)
  .max(NAMED_FUNCTION_LIMITS.nameLength)
  .regex(/^[A-Za-z_][A-Za-z_0-9]*$/);

/** Parameters are local, case-insensitive names; their value types are inferred at each call. */
export const NamedFunctionDefinition = z.strictObject({
  name: identifier,
  parameters: z.array(identifier).max(NAMED_FUNCTION_LIMITS.parameters),
  body: z
    .string()
    .min(1)
    .max(NAMED_FUNCTION_LIMITS.bodyLength)
    .refine((body) => body.trim().length > 0),
});
export type NamedFunctionDefinition = z.infer<typeof NamedFunctionDefinition>;

/** One database supplies its own registry; registries are never shared across databases. */
export const NamedFunctionDefinitions = z
  .array(NamedFunctionDefinition)
  .max(NAMED_FUNCTION_LIMITS.definitions);

export const NamedFunctionId = z.string().regex(/^fnc[0-9A-Za-z]{14}$/);
export const NamedFunctionInput = NamedFunctionDefinition.extend({
  description: z.string().max(10_000).default(''),
});
export type NamedFunctionInput = z.infer<typeof NamedFunctionInput>;
export const NamedFunctionUpdate = z.strictObject({
  definition: NamedFunctionInput,
  revision: z.number().int().positive(),
});
export type NamedFunctionUpdate = z.infer<typeof NamedFunctionUpdate>;
export const NamedFunctionDelete = z.strictObject({
  revision: z.number().int().positive(),
  confirmUsed: z.boolean().optional(),
});
export type NamedFunctionDelete = z.infer<typeof NamedFunctionDelete>;
export const NamedFunctionMeta = NamedFunctionInput.extend({
  id: NamedFunctionId,
  databaseId: z.string(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number().int().positive(),
});
export type NamedFunctionMeta = z.infer<typeof NamedFunctionMeta>;
export const NamedFunctionResult = z.object({
  definition: NamedFunctionMeta.nullable(),
  undoGroupId: z.string(),
});
export type NamedFunctionResult = z.infer<typeof NamedFunctionResult>;
