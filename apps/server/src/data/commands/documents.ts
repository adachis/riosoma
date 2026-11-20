import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { AppError, idsOf, type Command } from '@riosoma/contracts';
import { refreshLiveCells } from '../../sources/live.js';
import { loadFields } from '../metadata.js';
import { loadFiles } from '../files/metadata.js';
import { finishUpload } from '../files/finish.js';
import { fileStorage } from '../files/storage.js';
import { fillDocumentTemplate, TEMPLATE_LIMIT } from '../export/office/template.js';
import { fetchPageByRid } from '../physical/records.js';
import { ridsForIds } from '../physical/order.js';
import { scopeOf, table, type CommandContext } from './context.js';
import { applyCommand } from './index.js';

export const documentAttachmentId = (commandId: string) =>
  `att${createHash('sha256').update(commandId).digest('hex').slice(0, 14)}`;

async function documentSource(
  c: CommandContext,
  command: Extract<Command, { kind: 'record.generateDocument' }>,
  refresh = false,
) {
  await table(c, command.tableId);
  const scope = await scopeOf(c, command.tableId);
  await scope.require(c.databaseId, 'editRecords');
  await scope.requireUse(c.databaseId, 'export');
  const fields = scope.visibleFields(command.tableId, await loadFields(c.db, c.schemas, [command.tableId]));
  const source = fields.find((field) => field.id === command.templateFieldId);
  const target = fields.find((field) => field.id === command.attachmentFieldId);
  if (!source || source.type !== 'attachment' || !target || target.type !== 'attachment')
    throw new AppError('not_found', 'errors.notFound');
  if (!scope.canEditField(command.tableId, target))
    throw new AppError('forbidden', 'data.access.fieldLocked');
  if (refresh && c.live?.tableId === command.tableId && c.live.values)
    await refreshLiveCells(c, command.tableId, c.live.values);
  const rid = (await ridsForIds(c.db, c.schemas.data, command.tableId, [command.recordId])).get(
    command.recordId,
  );
  const rows =
    rid === undefined
      ? []
      : await fetchPageByRid(
          c.db,
          c.schemas.data,
          command.tableId,
          fields,
          [rid],
          scope.recordPredicate(command.tableId),
        );
  const row = rows[0];
  if (!row) throw new AppError('not_found', 'data.record.missing');
  if (!refresh && c.live?.tableId === command.tableId)
    Object.assign(row.values, c.live.values?.get(command.recordId));
  const ids = idsOf(row.values[source.id] ?? null);
  const files = new Map((await loadFiles(c.db, c.schemas.app, ids)).map((file) => [file.id, file]));
  const file = ids
    .map((id) => files.get(id))
    .find((item) => item?.name.toLowerCase().endsWith(`.${command.format}`));
  if (
    !file ||
    file.org_id !== c.actor.orgId ||
    file.table_id !== command.tableId ||
    file.field_id !== source.id ||
    file.scan_state !== 'clean'
  )
    throw new AppError('validation_failed', 'automations.document.template');
  return { file, row, target };
}

/** Decode and render before the command acquires the database write lock. */
export async function prepareDocument(
  c: CommandContext,
  command: Extract<Command, { kind: 'record.generateDocument' }>,
) {
  const { file } = await documentSource(c, command);
  if (!c.fileConfig) throw new AppError('unavailable', 'errors.unavailable');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of fileStorage(file.storage, c.db, c.schemas.app, c.fileConfig).read(
    file.storage_key,
  )) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > TEMPLATE_LIMIT) throw new AppError('payload_too_large', 'automations.document.invalid');
    chunks.push(bytes);
  }
  const bytes = await fillDocumentTemplate(Buffer.concat(chunks), command.format, command.values);
  return { commandId: command.id, templateId: file.id, bytes };
}

/** Recheck access and the template identity inside the attachment transaction. */
export async function generateDocument(
  c: CommandContext,
  command: Extract<Command, { kind: 'record.generateDocument' }>,
) {
  const prepared = c.preparedDocument ?? (c.simulation ? await prepareDocument(c, command) : undefined);
  const { file, row, target } = await documentSource(c, command, true);
  if (!prepared || prepared.commandId !== command.id || prepared.templateId !== file.id)
    throw new AppError('conflict', 'errors.conflict');
  if (!c.fileConfig) throw new AppError('unavailable', 'errors.unavailable');
  const { bytes } = prepared;
  const attachmentId = documentAttachmentId(command.id);
  // Database storage rolls back with a refused attachment or a simulation, including every byte.
  await finishUpload(
    c.db,
    c.schemas.app,
    c.fileConfig,
    {
      id: attachmentId,
      orgId: c.actor.orgId,
      userId: c.actor.userId,
      tableId: command.tableId,
      fieldId: target.id,
      name: command.filename,
      storage: 'postgres',
    },
    Readable.from([bytes]),
  );
  return applyCommand(c, {
    id: command.id,
    groupId: command.groupId,
    kind: 'record.update',
    tableId: command.tableId,
    records: [
      {
        id: command.recordId,
        values: { [target.id]: [...idsOf(row.values[target.id] ?? null), attachmentId] },
      },
    ],
  });
}
