import {
  AppError,
  checkCellValue,
  InterfaceCodeRequest,
  INTERFACE_LIMITS,
  roleAllows,
  type InterfaceCodeRequest as CodeRequest,
} from '@riosoma/contracts';
import type { BlockContext } from './context';

export type CodeChange = Extract<CodeRequest, { method: 'change' }>;

/** The frame names page blocks, never arbitrary tables, routes, or command kinds */
export async function codeRequest(
  context: BlockContext,
  input: unknown,
  propose: (request: CodeChange) => Promise<unknown>,
  preview = false,
): Promise<unknown> {
  const parsed = InterfaceCodeRequest.safeParse(input);
  if (!parsed.success) throw new AppError('validation_failed', 'errors.validationFailed');
  const request = parsed.data;
  const block = context.page.blocks.find((item) => item.id === request.blockId);
  if (block?.kind !== 'records') throw new AppError('not_found', 'errors.notFound');
  const { session } = context;
  if (request.method === 'records')
    return session.interfaceRecords(context.interfaceId, {
      pageId: context.page.id,
      blockId: block.id,
      filters: { ...context.filters },
      offset: request.offset,
      limit: INTERFACE_LIMITS.pageSize,
      timeZone: context.format.timeZone,
    });
  if (request.method === 'selected') {
    const recordId = context.selected[block.id];
    return recordId ? session.getRecord(block.source.tableId, recordId) : null;
  }
  if (preview) throw new AppError('forbidden', 'errors.forbidden');
  if (request.method === 'change' && !roleAllows(session.role(), 'editRecords'))
    throw new AppError('forbidden', 'errors.forbidden');
  const row = await session.getRecord(block.source.tableId, request.recordId);
  if (!row) throw new AppError('not_found', 'errors.notFound');
  if (request.method === 'open') {
    context.onSelect(block.id, row.id, { open: true });
    return null;
  }
  const values: Record<string, unknown> = {};
  const schema = session.getSchema();
  for (const [id, value] of Object.entries(request.values)) {
    const field = schema.fieldById.get(id);
    if (!field || field.tableId !== block.source.tableId) throw new AppError('not_found', 'errors.notFound');
    const checked = checkCellValue(field, value);
    if (!checked.ok) throw new AppError('validation_failed', checked.messageKey);
    values[id] = checked.value;
  }
  return propose({ ...request, values });
}

/** Approval is checked again against the current role and goes through the ordinary command bus */
export async function applyCodeChange(context: BlockContext, request: CodeChange) {
  if (!roleAllows(context.session.role(), 'editRecords')) throw new AppError('forbidden', 'errors.forbidden');
  const block = context.page.blocks.find((item) => item.id === request.blockId);
  if (block?.kind !== 'records') throw new AppError('not_found', 'errors.notFound');
  const result = await context.session.run([
    {
      kind: 'record.update',
      tableId: block.source.tableId,
      records: [{ id: request.recordId, values: request.values }],
    },
  ]).done;
  if (result.rejected) throw new AppError('forbidden', 'errors.forbidden');
  return null;
}

/** Opaque frames must also match the exact window and this mount's private channel */
export function isCodeCall(event: MessageEvent, source: Window | null, channel: string): boolean {
  const message = event.data;
  return (
    source !== null &&
    event.source === source &&
    event.origin === 'null' &&
    message !== null &&
    typeof message === 'object' &&
    message.type === 'interface-code-call' &&
    message.channel === channel &&
    Number.isSafeInteger(message.id) &&
    message.id > 0
  );
}
