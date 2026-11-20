import { useLingui } from '@lingui/react/macro';
import type { TokenScope } from '@riosoma/contracts';

/**
 * Plain words for what each scope allows.  The scope names themselves are API identifiers, so the
 * list and the create dialog both show these instead, and one hook keeps the two in step.
 */
export function useScopeLabels(): Record<TokenScope, string> {
  const { t } = useLingui();
  return {
    'data.records:read': t({ id: 'tokens.scope.recordsRead', message: 'Read records' }),
    'data.records:write': t({
      id: 'tokens.scope.recordsWrite',
      message: 'Add, change, and delete records',
    }),
    'schema.bases:read': t({
      id: 'tokens.scope.schemaRead',
      message: 'Read tables, fields, and views',
    }),
    'schema.bases:write': t({
      id: 'tokens.scope.schemaWrite',
      message: 'Change tables, fields, views, and webhooks',
    }),
  };
}
