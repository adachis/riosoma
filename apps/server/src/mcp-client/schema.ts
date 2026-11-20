import { AppError } from '@riosoma/contracts';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from '@modelcontextprotocol/sdk/validation/types.js';

/** Schema keywords are inspected only where a schema is expected, never in property names or data. */
export class RemoteSchemaValidator implements jsonSchemaValidator {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const blocked = () => new AppError('validation_failed', 'remote.schemaBlocked');
    if (Buffer.byteLength(JSON.stringify(schema)) > 16000) throw blocked();
    let nodes = 0;
    const visit = (value: unknown, depth: number, refs: Set<string>): unknown => {
      if (++nodes > 1000 || depth > 12) throw blocked();
      if (typeof value === 'boolean') return value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw blocked();
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, child] of Object.entries(value)) {
        if (['pattern', 'patternProperties', '$dynamicRef', '$recursiveRef'].includes(key)) throw blocked();
        if (['format', '$schema', '$id', '$defs', 'definitions'].includes(key)) continue;
        if (key === '$ref') {
          if (typeof child !== 'string' || !/^#\/(\$defs|definitions)\/[^/]+$/.test(child) || refs.has(child))
            throw blocked();
          const parts = child
            .slice(2)
            .split('/')
            .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
          let target: unknown = schema;
          for (const part of parts)
            target =
              target && typeof target === 'object' && Object.hasOwn(target, part)
                ? (target as Record<string, unknown>)[part]
                : undefined;
          result.allOf = [
            ...((result.allOf as unknown[]) ?? []),
            visit(target, depth + 1, new Set([...refs, child])),
          ];
        } else if (['properties', 'dependentSchemas'].includes(key)) {
          if (!child || typeof child !== 'object' || Array.isArray(child)) throw blocked();
          result[key] = Object.fromEntries(
            Object.entries(child).map(([name, item]) => [name, visit(item, depth + 1, refs)]),
          );
        } else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key)) {
          if (!Array.isArray(child)) throw blocked();
          const items = child.map((item) => visit(item, depth + 1, refs));
          result[key] = key === 'allOf' ? [...((result.allOf as unknown[]) ?? []), ...items] : items;
        } else if (
          [
            'items',
            'additionalItems',
            'additionalProperties',
            'unevaluatedProperties',
            'unevaluatedItems',
            'contains',
            'propertyNames',
            'not',
            'if',
            'then',
            'else',
          ].includes(key)
        ) {
          result[key] = Array.isArray(child)
            ? child.map((item) => visit(item, depth + 1, refs))
            : visit(child, depth + 1, refs);
        } else if (key === 'dependencies') {
          if (!child || typeof child !== 'object' || Array.isArray(child)) throw blocked();
          result[key] = Object.fromEntries(
            Object.entries(child).map(([name, item]) => [
              name,
              Array.isArray(item) ? item : visit(item, depth + 1, refs),
            ]),
          );
        } else result[key] = child;
      }
      return result;
    };
    try {
      const expanded = visit(schema, 0, new Set()) as JsonSchemaType;
      if (Buffer.byteLength(JSON.stringify(expanded)) > 64000) throw blocked();
      return new AjvJsonSchemaValidator().getValidator<T>(expanded);
    } catch {
      throw blocked();
    }
  }
}

/** Results are size-limited untrusted data, so remote output schemas never execute validation code. */
export const remoteOutputValidator: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input: unknown) => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};
