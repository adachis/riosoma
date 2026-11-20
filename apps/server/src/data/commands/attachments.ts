import { AppError, idsOf, type Command } from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import { AttachmentAddresses } from '../../api-v1/attachments.js';
import { refreshLiveCells } from '../../sources/live.js';
import { loadFields } from '../metadata.js';
import { fetchRowsById } from '../physical/records.js';
import { writeGuard } from '../permissions/enforce.js';
import { scopeOf, table, type CommandContext } from './context.js';
import { applyCommand } from './index.js';
import { imageSelection } from '../files/image-search.js';

type Attach = Extract<Command, { kind: 'record.attachFromUrl' }>;

async function target(c: CommandContext, command: Attach, refresh = false) {
  await table(c, command.tableId);
  const scope = await scopeOf(c, command.tableId);
  await scope.require(c.databaseId, 'editRecords');
  if (command.imageSearchToken) {
    await scope.requireUse(c.databaseId, 'provider', { fieldIds: [command.fieldId] });
    await scope.requireUse(c.databaseId, 'external', { fieldIds: [command.fieldId] });
  }
  if (refresh && c.live?.values) await refreshLiveCells(c, command.tableId, c.live.values);
  const fields = await loadFields(c.db, c.schemas, [command.tableId]);
  const guard = writeGuard(c.db, c.schemas, scope, command.tableId, fields);
  const field = guard.visible.find((field) => field.id === command.fieldId);
  if (!field || field.type !== 'attachment') throw new AppError('not_found', 'errors.notFound');
  await guard.requireVisible([command.recordId]);
  await guard.requireEditable([{ id: command.recordId, values: { [field.id]: [] } }]);
  const [row] = await fetchRowsById(c.db, c.schemas.data, command.tableId, [field], [command.recordId]);
  if (!row) throw new AppError('not_found', 'data.record.missing');
  if (!refresh && c.live?.values) Object.assign(row.values, c.live.values.get(row.id));
  return { field, row };
}

/** Download before acquiring the write lock, after checking the destination's access and locks. */
export async function prepareAttachment(app: FastifyInstance, c: CommandContext, command: Attach) {
  const { field } = await target(c, command);
  const selection = command.imageSearchToken
    ? await imageSelection(app.ctx, c.actor, command, command.imageSearchToken)
    : undefined;
  if (selection && selection.url !== command.url)
    throw new AppError('forbidden', 'knowledge.searchUnavailable');
  const addresses = new AttachmentAddresses(
    app,
    c.actor,
    selection
      ? {
          url: selection.sourceUrl,
          imageUrl: selection.url,
          license: selection.license,
        }
      : undefined,
  );
  const [placeholder] = addresses.cell(field, command.recordId, 0, [
    { url: command.url, filename: command.filename },
  ]);
  await addresses.fetch(command.tableId);
  const [fileId] = addresses.resolve([placeholder]) as string[];
  return {
    commandId: command.id,
    fileId: fileId!,
    discard: () => addresses.discard(),
  };
}

export async function attachFromUrl(c: CommandContext, command: Attach) {
  const { field, row } = await target(c, command, true);
  const held = idsOf(row.values[field.id] ?? null);
  // A proposal checks the destination without contacting an outside host or storing a file.
  if (c.preview || c.simulation)
    return {
      body: { kind: 'record.updated' as const, tableId: command.tableId, records: [row] },
      prev: { records: [row] },
    };
  const prepared = c.preparedAttachment;
  if (!prepared || prepared.commandId !== command.id) throw new AppError('conflict', 'errors.conflict');
  return applyCommand(c, {
    id: command.id,
    groupId: command.groupId,
    kind: 'record.update',
    tableId: command.tableId,
    records: [{ id: command.recordId, values: { [field.id]: [...held, prepared.fileId] } }],
  });
}
