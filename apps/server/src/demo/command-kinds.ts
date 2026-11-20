import * as contracts from '@riosoma/contracts';
import type { z } from 'zod';
import { AuthenticationCommand } from '../data/commands/authentication.js';

/** Command schemas are discovered by their exported names, including nested action envelopes. */
export function registeredCommandKinds(): string[] {
  const kinds = new Set<string>();
  const visited = new Set<unknown>();
  const visit = (schema: unknown): void => {
    if (!schema || typeof schema !== 'object' || visited.has(schema)) return;
    visited.add(schema);
    const node = schema as { options?: unknown[]; shape?: Record<string, unknown>; values?: Set<string> };
    if (node.options) for (const option of node.options) visit(option);
    if (node.shape?.kind) {
      const kind = node.shape.kind as z.ZodLiteral<string> | z.ZodEnum<Record<string, string>>;
      if ('values' in kind) for (const value of kind.values) kinds.add(value);
      else if ('options' in kind) for (const value of kind.options) kinds.add(value);
    }
    if (node.shape?.action) visit(node.shape.action);
    if (node.shape?.actions) visit((node.shape.actions as { element?: unknown }).element);
  };
  for (const [name, schema] of Object.entries(contracts)) if (/(?:Command|Action)$/.test(name)) visit(schema);
  visit(AuthenticationCommand);
  return [...kinds].sort();
}
