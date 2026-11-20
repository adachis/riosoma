import { ingestCapability } from '../../ingest/tables/capability.js';
import { cascadeValidationFields, requireRemovableChoices } from './select-options.js';
import {
  conversionSourceChoices,
  fixedSourceChoices,
  isSelect,
  resolveSelectOptions,
  sourceChoices,
} from '../select-options.js';
import { requireUnlockedTable } from './schema-records.js';
import { requireUnlockedRecordsInScope } from '../record-locks.js';
import { validateRecords } from './validation.js';
import {
  buildUniqueIndex,
  changeUniqueIndex,
  duplicatesError,
  isUnique,
  uniqueDuplicates,
} from '../physical/unique.js';
import { requireLiveField } from '../../sources/live-commands.js';
import {
  AppError,
  canConvert,
  FieldSpec,
  GridConfig,
  LIMITS,
  fieldOptionsSchema,
  isPrimaryType,
  type AiFieldSettings,
  type Command,
  type ChangeBody,
  type FieldCreate,
  fieldDefault,
  idsOf,
  isAiOutputType,
  jsonEqual,
  keptDefault,
  templateFieldIds,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { parse } from '../../http/validate.js';
import { managedRefused } from '../managed.js';
import { loadCollaborators, loadField, loadFields, loadTable } from '../metadata.js';
import { resumeAutoNumber, suspendAutoNumber } from '../physical/autonumber.js';
import { columnType } from '../physical/columns.js';
import { convertColumn } from '../physical/convert.js';
import { addFieldColumn } from '../physical/ddl.js';
import { dropFieldIndexes } from '../physical/indexes.js';
import { convertLinks } from '../physical/convert-links.js';
import { isMatchable } from '../physical/matches.js';
import { readsBack } from '../physical/formulas.js';
import { clearChoices } from '../physical/records.js';
import type { StoredField } from '../types.js';
import {
  bumpVersion,
  field,
  invalid,
  nextPosition,
  publicField,
  publicTable,
  scopeOf,
  setTrashed,
  storedField,
  table,
  uniqueName,
  unusedId,
  view,
  visibleField,
  type CommandContext,
  type Mutation,
} from './context.js';
import { computedSpec, createPair, conversionPrimary } from './links.js';
import {
  chain,
  dropUnusedMatchKeys,
  mirrorMatch,
  rematch,
  sameMatch,
  settleMatches,
  unmatch,
  validateMatch,
} from './matches.js';
import { messages } from './messages.js';
import { requireOwnPublicFields } from './public-pages.js';
import { savedDefault } from './defaults.js';
import { aiSettingsFor } from '../../ai-fields/settings.js';

type FieldCommand = Exclude<Extract<Command, { kind: `field.${string}` }>, { kind: 'field.duplicate' }>;

/** Presentation changes leave stored values alone, while the process owns its schema. */
export function requireIngestFieldChange(
  c: Pick<CommandContext, 'ingestCapability'>,
  before: StoredField | undefined,
  after: StoredField | 'delete' | 'mark' | 'convert',
): void {
  if (c.ingestCapability === ingestCapability) return;
  if (after === 'mark' || (typeof after !== 'string' && !before?.ingest && after.ingest))
    throw new AppError('forbidden', 'ingest.fields.locked');
  if (!before?.ingest) return;
  const presentation = new Set(['dateFormat', 'timeFormat', 'thousands', 'color', 'icon', 'format']);
  const values = (options: StoredField['options']) =>
    Object.fromEntries(Object.entries(options).filter(([key]) => !presentation.has(key)));
  if (
    after === 'delete' ||
    after === 'convert' ||
    before.type !== after.type ||
    !jsonEqual(before.ingest, after.ingest) ||
    !jsonEqual(values(before.options), values(after.options)) ||
    !jsonEqual(before.ai, after.ai)
  )
    throw new AppError('forbidden', 'ingest.fields.locked');
}

/** Conversions replace stored cells, and removing choices clears them across the table. */
export async function requireSchemaCells(
  c: CommandContext,
  before: StoredField,
  action: 'convert' | 'choices',
): Promise<void> {
  const scope = await scopeOf(c, before.tableId);
  let locked = scope.fieldLocked(before.tableId, before);
  if (action === 'convert' && before.type === 'link' && before.options.inverseFieldId) {
    const inverse = await loadField(c.db, c.schemas, before.options.inverseFieldId);
    if (inverse && !inverse.trashed) locked ||= scope.fieldLocked(inverse.tableId, inverse);
  }
  if (!locked) return;
  if (action === 'convert') throw new AppError('forbidden', 'data.access.fieldLockedConversion');
  if ((await scope.databaseRole(c.databaseId)) !== 'owner')
    throw new AppError('forbidden', 'data.access.fieldLockedChoices');
}

export async function insertField(
  c: CommandContext,
  tableId: string,
  input: FieldCreate,
  position: number,
  /** An AI field's settings as `aiSettingsFor` checked them, since any on `input` are never stored as sent */
  ai?: AiFieldSettings | null,
): Promise<void> {
  if ((input.type === 'singleSelect' || input.type === 'multipleSelect') && input.options.source)
    input = { ...input, options: { ...input.options, choices: [], sourceTruncated: undefined } };
  if (input.source && isUnique(input)) invalid('data.validation.uniqueSource');
  await unusedId(c, 'field', input.id);
  await uniqueName(c, 'field', tableId, input.name, input.id);
  await query(
    c.db,
    sql`INSERT INTO ${ident(c.schemas.app, 'fields')}
    (id, org_id, table_id, name, description, type, options, column_name, position, created_by, source, ai)
    VALUES (${input.id}, ${c.actor.orgId}, ${tableId}, ${input.name}, ${input.description}, ${input.type},
      ${JSON.stringify(input.options)}::jsonb, ${input.id}, ${position}, ${c.actor.userId}, ${JSON.stringify(input.source ?? null)}::jsonb,
      ${JSON.stringify(ai ?? null)}::jsonb)`,
  );
}

async function checkLimit(c: CommandContext, tableId: string): Promise<void> {
  if ((await loadFields(c.db, c.schemas, [tableId])).length >= LIMITS.fieldsPerTable)
    invalid('data.field.tooMany');
}

export async function saveField(c: CommandContext, value: StoredField): Promise<void> {
  const before = await loadField(c.db, c.schemas, value.id);
  // Undo snapshots can outlive setup, so a removed mark must stay removed on an ordinary table.
  if (before && !before.ingest && value.ingest && !(await loadTable(c.db, c.schemas, before.tableId))?.ingest)
    value = { ...value, ingest: undefined };
  if (before) requireIngestFieldChange(c, before, value);
  if (isSelect(value) && value.options.source)
    value = { ...value, options: { ...value.options, choices: [], sourceTruncated: undefined } };
  await resumeAutoNumber(c.db, c.schemas.data, value);
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'fields')} SET name = ${value.name}, description = ${value.description},
    type = ${value.type}, options = ${JSON.stringify(value.options)}::jsonb, column_name = ${value.columnName},
    link_id = ${value.type === 'link' || value.type === 'lineItems' ? (value.linkId ?? value.relation?.linkId ?? null) : null},
    position = ${value.position}, ai = ${JSON.stringify(value.ai ?? null)}::jsonb,
    ingest = ${value.ingest ? JSON.stringify(value.ingest) : null}::jsonb,
    updated_at = statement_timestamp() WHERE id = ${value.id}`,
  );
}

export async function backupColumn(c: CommandContext, value: StoredField): Promise<void> {
  if (!columnType(value)) return;
  await suspendAutoNumber(c.db, c.schemas.data, value);
  await query(
    c.db,
    sql`INSERT INTO ${ident(c.schemas.app, 'column_backups')} (table_id, column_name, field_id)
    VALUES (${value.tableId}, ${value.columnName}, ${value.id}) ON CONFLICT DO NOTHING`,
  );
}

async function convert(
  c: CommandContext,
  before: StoredField,
  to: FieldSpec,
  options: { dateOrder: 'mdy' | 'dmy' | 'ymd'; timeZone: string },
  joinedEdit = false,
): Promise<StoredField> {
  requireIngestFieldChange(c, before, 'convert');
  await requireUnlockedTable(c, before.tableId, sql`TRUE`, joinedEdit ? before : undefined);
  const columns = await query<{ name: string }>(
    c.db,
    sql`SELECT a.attname AS name FROM pg_attribute a
    JOIN pg_class t ON t.oid = a.attrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = ${c.schemas.data} AND t.relname = ${before.tableId} AND a.attnum > 0 AND NOT a.attisdropped`,
  );
  const used = new Set(columns.rows.map((r) => r.name));
  // Computed fields have no physical column, but their metadata still reserves the name.
  used.add(before.columnName);
  let number = 1;
  while (used.has(`${before.id}_${number}`)) number += 1;
  const columnName = `${before.id}_${number}`;
  const scope = await scopeOf(c, before.tableId);
  const collaborators = await loadCollaborators(c.db, c.schemas, c.actor.orgId, scope);
  await backupColumn(c, before);
  const [readFrom] = await resolveSelectOptions(
    c.db,
    c.schemas,
    scope,
    scope.visibleFields(before.tableId, [before]),
  );
  if (
    isSelect(before) &&
    before.options.source &&
    (!isSelect(to) || to.options.source?.tableId !== before.options.source.tableId)
  )
    await conversionSourceChoices(c.db, c.schemas, scope, before);
  if (isSelect(before) && before.options.source && isSelect(to) && !to.options.source)
    to = {
      ...to,
      options: { ...to.options, choices: await fixedSourceChoices(c.db, c.schemas, scope, before) },
    };
  if (isSelect(to) && to.options.source)
    to = {
      ...to,
      options: {
        ...to.options,
        choices: await sourceChoices(
          c.db,
          c.schemas,
          scope,
          { ...before, ...to },
          isSelect(readFrom!) ? { names: readFrom!.options.choices.map((choice) => choice.name) } : {},
        ),
      },
    };
  const result = await convertColumn(c.db, c.schemas.data, before.tableId, readFrom!, to, columnName, {
    ...options,
    appSchema: c.schemas.app,
    userNames: new Map(collaborators.map((person) => [person.id, person.name])),
    userEmails: new Map(collaborators.map((person) => [person.id, person.email])),
  });
  await dropFieldIndexes(c.db, c.schemas, before.tableId, before.id);
  const spec = parse(FieldSpec, { type: to.type, options: result.options });
  // An AI field stays one only as a type a model can write.  A default the new type can't hold,
  // whether the change names it or the field had it before, goes away.
  const after = keptDefault(
    { ...before, ...spec, columnName, ai: isAiOutputType(spec.type) ? before.ai : undefined },
    fieldDefault(to) ?? fieldDefault(before),
  );
  await saveField(c, after);
  if (
    ('validation' in after.options && after.options.validation) ||
    (isSelect(after) && (after.options.cascade || after.options.source))
  ) {
    const rows = await query<{ id: string }>(
      c.db,
      sql`SELECT __id AS id FROM ${ident(c.schemas.data, before.tableId)} WHERE __deleted_at IS NULL`,
    );
    const validationFields = cascadeValidationFields(
      await loadFields(c.db, c.schemas, [before.tableId]),
      after,
    );
    for (let start = 0; start < rows.rows.length; start += 1000)
      await validateRecords(
        c,
        before.tableId,
        validationFields,
        rows.rows.slice(start, start + 1000).map((row) => ({ id: row.id, values: {} })),
        true,
        [],
        true,
      );
  }
  await bumpVersion(c, before.tableId);
  return storedField(await field(c, before.id));
}

export async function applyFields(
  c: CommandContext,
  command: FieldCommand,
  paired = false,
  joinedEdit = false,
): Promise<Mutation> {
  const { db, schemas } = c;
  const parentId =
    'tableId' in command ? command.tableId : (await loadField(db, schemas, command.fieldId))?.tableId;
  if (paired && parentId) {
    const parent = await table(c, parentId, false, 'editSchema');
    c = { ...c, databaseId: parent.databaseId };
  }
  if (!joinedEdit && parentId && (await table(c, parentId)).joined) {
    const parent = await table(c, parentId);
    const mapped =
      'fieldId' in command && parent.joined!.fields.some((item) => item.outputFieldId === command.fieldId);
    const rename =
      command.kind === 'field.update' && command.options === undefined && command.ai === undefined;
    if (mapped && !rename && command.kind !== 'field.setPrimary')
      throw new AppError('forbidden', 'joined.readOnly');
  }
  // A managed field, such as a payment result, keeps the definition Riosoma gave it.
  if ('fieldId' in command && (await loadField(db, schemas, command.fieldId))?.managed)
    throw managedRefused();
  if ('fieldId' in command) {
    const before = await loadField(db, schemas, command.fieldId);
    if (before && command.kind === 'field.trash') requireIngestFieldChange(c, before, 'delete');
    if (before && command.kind === 'field.convert') requireIngestFieldChange(c, before, 'convert');
    if (before && command.kind === 'field.update')
      requireIngestFieldChange(c, before, {
        ...before,
        options:
          command.options === undefined
            ? before.options
            : parse(fieldOptionsSchema(before.type), command.options),
        ai:
          command.ai === null
            ? undefined
            : command.ai === undefined
              ? before.ai
              : { ...command.ai, runAsId: c.actor.userId },
      } as StoredField);
  }
  switch (command.kind) {
    case 'field.create': {
      if (command.field.source) invalid('sources.sourceField');
      const parent = await table(c, command.tableId);
      await requireLiveField(c, command.tableId, command.field);
      await checkLimit(c, command.tableId);
      const previousView = command.placement ? (await view(c, command.placement.viewId)).view : undefined;
      if (previousView?.config.locked) invalid('data.locks.viewLocked');
      if (previousView && previousView.tableId !== command.tableId)
        throw new AppError('not_found', 'errors.notFound');
      const fields = await loadFields(db, schemas, [command.tableId]);
      if (command.field.type === 'link' && command.field.options.match)
        await validateMatch(
          c,
          command.tableId,
          command.field.options.linkedTableId,
          command.field.options.match,
        );
      const ai = command.field.ai
        ? await aiSettingsFor(c, command.tableId, command.field.id, command.field.type, command.field.ai)
        : null;
      await insertField(
        c,
        command.tableId,
        savedDefault(
          {
            ...command.field,
            ...(await computedSpec(c, command.tableId, command.field, command.field.id, command.field.name)),
          },
          undefined,
          { synced: Boolean(parent.source) },
        ),
        await nextPosition(c, 'field', command.tableId),
        ai,
      );
      let created = await field(c, command.field.id);
      const additional = await createPair(c, created);
      created = await field(c, command.field.id);
      // A link that shares every field its view shows takes a new field at once, and reads it
      // with its sharer's access.
      await requireOwnPublicFields(c, [created]);
      await addFieldColumn(db, schemas.data, command.tableId, created);
      // A link that follows values starts with every record linked to its matches.
      const matched = await settleMatches(c, [created], false);
      const views = [];
      if (previousView && command.placement) {
        const order = [...previousView.config.fieldOrder];
        for (const f of fields) if (!order.includes(f.id)) order.push(f.id);
        order.splice(command.placement.index, 0, created.id);
        const config = parse(GridConfig, { ...previousView.config, fieldOrder: order });
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'views')} SET config = ${JSON.stringify(config)}::jsonb,
          updated_at = statement_timestamp() WHERE id = ${previousView.id}`,
        );
        views.push((await view(c, previousView.id)).view);
      }
      return {
        body: { kind: 'field.created', field: publicField(created), views },
        additional: chain(additional, matched),
        prev: { views: previousView ? [previousView] : [] },
      };
    }
    case 'field.update': {
      const before = storedField(await visibleField(c, command.fieldId));
      const name = command.name ?? before.name;
      await uniqueName(c, 'field', before.tableId, name, before.id);
      const options =
        command.options === undefined
          ? before.options
          : parse(fieldOptionsSchema(before.type), command.options);
      let spec = parse(FieldSpec, { type: before.type, options });
      if (
        isSelect(before) &&
        isSelect(spec) &&
        spec.options.source &&
        before.options.source?.tableId !== spec.options.source.tableId
      ) {
        const populated = await query(
          db,
          sql`SELECT 1 FROM ${ident(schemas.data, before.tableId)}
          WHERE ${ident(before.columnName)} IS NOT NULL LIMIT 1`,
        );
        if (populated.rowCount && !c.restoredSelectSources?.has(before.id))
          invalid('data.select.conversionRequired');
      }
      if (isSelect(before) && before.options.source && isSelect(spec) && !spec.options.source)
        spec = {
          ...spec,
          options: {
            ...spec.options,
            choices: await conversionSourceChoices(db, schemas, await scopeOf(c, before.tableId), before),
          },
        };
      if (before.type === 'lineItems' && spec.type === 'lineItems') {
        if (JSON.stringify(before.options.columns) !== JSON.stringify(spec.options.columns))
          invalid('errors.validationFailed');
        spec = {
          ...spec,
          options: {
            ...spec.options,
            linkedTableId: before.options.linkedTableId,
            inverseFieldId: before.options.inverseFieldId,
          },
        };
      }
      let matchChanged = false;
      if (before.type === 'link' && spec.type === 'link') {
        spec = {
          ...spec,
          options: {
            ...spec.options,
            linkedTableId: before.options.linkedTableId,
            inverseFieldId: before.options.inverseFieldId,
            oneWay: before.options.oneWay,
          },
        };
        matchChanged = !sameMatch(before.options.match, spec.options.match);
        if (matchChanged && spec.options.match)
          await validateMatch(c, before.tableId, before.options.linkedTableId, spec.options.match);
        // Links that follow values may name several records, and the preference only shapes editing.
        if (spec.options.prefersSingle && !before.options.prefersSingle && !spec.options.match) {
          const loaded = await field(c, before.id);
          if (loaded.relation) {
            const side = loaded.relation.side;
            const result = await query(
              db,
              sql`SELECT 1 FROM ${ident(schemas.data, `lnk_${loaded.relation.linkId}`)}
              GROUP BY ${ident(`${side}_rid`)} HAVING count(*) > 1 LIMIT 1`,
            );
            if (result.rowCount) invalid('data.link.single');
          }
        }
      }
      if (command.options !== undefined) spec = await computedSpec(c, before.tableId, spec, before.id, name);
      // Saving an AI field's settings makes whoever saves them the person its runs act as.
      const ai =
        command.ai === undefined
          ? before.ai
          : command.ai === null
            ? undefined
            : await aiSettingsFor(c, before.tableId, before.id, spec.type, command.ai);
      const after = savedDefault(
        {
          ...before,
          ...spec,
          name,
          description: command.description ?? before.description,
          ai,
        },
        before,
        { synced: Boolean((await table(c, before.tableId)).source) },
      );
      if (columnType(before) !== columnType(after) && (isUnique(before) || isUnique(after)))
        invalid('data.validation.uniqueConvert');
      // What a field holds follows its options, and so does everything worked out from it, down
      // to the names of its choices.  A new name or description changes none of that.
      if (!jsonEqual(after.options, before.options)) await requireOwnPublicFields(c, [before]);
      if (c.preview && isUnique(after)) {
        if ((await scopeOf(c, after.tableId)).limitsRecords(after.tableId))
          throw new AppError('forbidden', 'data.access.recordHidden');
        const duplicates = await uniqueDuplicates(db, schemas, after);
        if (duplicates.length) throw duplicatesError(after, c.databaseId, duplicates);
        await buildUniqueIndex(db, schemas, after, false);
      }
      await changeUniqueIndex(db, schemas, before, after);
      const remaining =
        spec.type === 'singleSelect' || spec.type === 'multipleSelect'
          ? new Set(spec.options.choices.map((choice) => choice.id))
          : new Set<string>();
      const removedChoiceIds =
        before.type === 'singleSelect' || before.type === 'multipleSelect'
          ? before.options.choices.filter((choice) => !remaining.has(choice.id)).map((choice) => choice.id)
          : [];
      if (removedChoiceIds.length) await requireSchemaCells(c, before, 'choices');
      if (columnType(before) !== columnType(after)) await requireSchemaCells(c, before, 'convert');
      if (removedChoiceIds.length) {
        const column = ident(before.columnName);
        await requireUnlockedTable(
          c,
          before.tableId,
          before.type === 'singleSelect'
            ? sql`${column} = ANY(${removedChoiceIds}::text[])`
            : sql`${column} && ${removedChoiceIds}::text[]`,
        );
      }
      await requireRemovableChoices(c, before, removedChoiceIds);
      const cleared = await clearChoices(
        db,
        schemas.data,
        before.tableId,
        before,
        removedChoiceIds,
        c.actor.userId,
      );
      await validateRecords(
        c,
        before.tableId,
        cascadeValidationFields(await loadFields(db, schemas, [before.tableId]), after),
        cleared.map((cell) => ({ id: cell.id, values: {} })),
        true,
        [],
        true,
      );
      const choiceCells = cleared.map((cell) => {
        const kept = idsOf(cell.prev).filter((id) => !removedChoiceIds.includes(id));
        return { ...cell, written: kept.length ? kept : null };
      });
      if (columnType(before) !== columnType(after)) {
        const converted = await convert(c, before, spec, { dateOrder: 'mdy', timeZone: 'UTC' });
        await saveField(c, { ...after, columnName: converted.columnName });
      } else await saveField(c, after);
      // Formulas read choices by name, here and through lookups in linked tables, so renaming one
      // changes what they read.
      if (
        cleared.length ||
        ['link', 'lookup', 'rollup', 'count', 'formula'].includes(before.type) ||
        (command.options !== undefined &&
          (before.type === 'singleSelect' || before.type === 'multipleSelect')) ||
        (command.options !== undefined &&
          (await loadFields(db, schemas, [before.tableId])).some((field) => field.type === 'formula'))
      )
        await bumpVersion(c, before.tableId);
      let additional: AsyncIterable<Mutation> | undefined;
      if (matchChanged && before.type === 'link') {
        // Both sides of a link agree on what it follows.  Following values replaces the links it
        // had, and turning that off keeps the links as they are.
        const saved = await field(c, before.id);
        const mirror = await mirrorMatch(c, saved);
        additional = chain(mirror, await settleMatches(c, [await field(c, before.id)], false));
        if (before.options.match)
          await dropUnusedMatchKeys(c, [before.options.match.fieldId, before.options.match.linkedFieldId]);
      }
      const cascades: Mutation[] = [];
      if (removedChoiceIds.length) {
        for (const child of await loadFields(db, schemas, [before.tableId])) {
          if (!isSelect(child) || child.options.cascade?.fieldId !== before.id) continue;
          const mapping = Object.fromEntries(
            Object.entries(child.options.cascade.mapping).filter(([id]) => !removedChoiceIds.includes(id)),
          );
          if (Object.keys(mapping).length === Object.keys(child.options.cascade.mapping).length) continue;
          const updated = {
            ...child,
            options: { ...child.options, cascade: { ...child.options.cascade, mapping } },
          };
          await saveField(c, updated);
          cascades.push({
            body: { kind: 'field.updated', field: publicField(updated), removedChoiceIds: [] },
            prev: { field: child },
          });
        }
      }
      additional = chain(additional, cascades);
      return {
        body: { kind: 'field.updated', field: publicField(await field(c, before.id)), removedChoiceIds },
        prev: { field: before, choiceCells },
        ...(additional ? { additional } : {}),
      };
    }
    case 'field.convert': {
      if (!joinedEdit && (await visibleField(c, command.fieldId)).source)
        throw new AppError('forbidden', 'sources.sourceField');
      const loaded = await field(c, command.fieldId);
      if (isUnique(loaded) || isUnique(command.to)) invalid('data.validation.uniqueConvert');
      const before = storedField(loaded);
      await requireSchemaCells(c, before, 'convert');
      const parent = await table(c, before.tableId);
      if (parent.primaryFieldId === before.id && !isPrimaryType(command.to.type))
        invalid('data.field.primaryType');
      if (!canConvert(before.type, command.to.type)) invalid('data.field.cannotConvert');
      await requireOwnPublicFields(c, [before]);
      await requireLiveField(c, before.tableId, command.to);
      const to = await computedSpec(c, before.tableId, command.to, before.id);
      const additional: Mutation[] = [];
      let after: StoredField;
      let linkChanges: AsyncIterable<ChangeBody> | undefined;
      let matchChanges: AsyncIterable<Mutation> | undefined;
      if (to.type === 'link') {
        if (before.type === 'link' && before.options.linkedTableId === to.options.linkedTableId) {
          return applyFields(c, {
            kind: 'field.update',
            id: command.id,
            groupId: command.groupId,
            fieldId: before.id,
            options: {
              ...to.options,
              inverseFieldId: before.options.inverseFieldId,
              oneWay: before.options.oneWay,
            },
          });
        }
        const match = to.options.match;
        if (match) {
          // The field becomes the link, so its own values can't be what the link follows.
          if (match.fieldId === before.id || match.linkedFieldId === before.id)
            invalid('errors.validationFailed');
          await validateMatch(c, before.tableId, to.options.linkedTableId, match);
        }
        const linkedPrimary = await conversionPrimary(c, to.options.linkedTableId);
        const sourceScope = await scopeOf(c, before.tableId);
        const collaborators = await loadCollaborators(db, schemas, c.actor.orgId, sourceScope);
        const [readFrom] = await resolveSelectOptions(
          db,
          schemas,
          sourceScope,
          sourceScope.visibleFields(before.tableId, [loaded]),
        );
        await query(db, sql`LOCK TABLE ${ident(schemas.data, before.tableId)} IN ACCESS EXCLUSIVE MODE`);
        await query(db, sql`LOCK TABLE ${ident(schemas.data, to.options.linkedTableId)} IN SHARE MODE`);
        await requireUnlockedTable(c, before.tableId);
        await backupColumn(c, before);
        await dropFieldIndexes(db, schemas, before.tableId, before.id);
        await saveField(c, { ...before, ...to, ai: undefined });
        additional.push(...(await createPair(c, { ...before, ...to, ai: undefined })));
        after = await field(c, before.id);
        if (match) matchChanges = await settleMatches(c, [after], false);
        else
          linkChanges = await convertLinks(
            db,
            schemas.data,
            readFrom!,
            after,
            to,
            {
              ...command,
              appSchema: schemas.app,
              linkedPrimary,
              userNames: new Map(collaborators.map((person) => [person.id, person.name])),
              userEmails: new Map(collaborators.map((person) => [person.id, person.email])),
              linkedPredicate: (await scopeOf(c, to.options.linkedTableId)).recordPredicate(
                to.options.linkedTableId,
                'target',
              ),
            },
            c.actor.userId,
            async (ids) => {
              await requireUnlockedRecordsInScope(
                db,
                schemas,
                await scopeOf(c, to.options.linkedTableId),
                to.options.linkedTableId,
                ids,
              );
            },
          );
        await bumpVersion(c, before.tableId);
      } else after = await convert(c, loaded, to, command, joinedEdit);
      if (before.type === 'link' && before.options.inverseFieldId) {
        const inverse = await field(c, before.options.inverseFieldId, false, 'editSchema');
        await setTrashed(c, 'field', inverse.id, true);
        additional.push({
          body: { kind: 'field.trashed', tableId: inverse.tableId, fieldId: inverse.id },
          prev: { dependent: true },
        });
      }
      // Links that follow this field's values follow the converted values, or become ordinary links
      // when the field no longer holds values they can follow.
      if (isMatchable(before.type)) {
        if (isMatchable(after.type)) matchChanges = chain(matchChanges, await rematch(c, before.id, false));
        else additional.push(...(await unmatch(c, before.id)));
      }
      return {
        body: { kind: 'field.converted', field: publicField(after) },
        prev: { field: before },
        additional: (async function* () {
          yield* additional;
          if (linkChanges) for await (const body of linkChanges) yield { body, prev: {} };
          if (matchChanges) yield* matchChanges;
        })(),
      };
    }
    case 'field.trash':
    case 'field.restore': {
      const before = paired
        ? await field(c, command.fieldId, true)
        : await visibleField(c, command.fieldId, true);
      const parent = await table(c, before.tableId);
      if (parent.primaryFieldId === before.id) invalid('data.field.primary');
      const trash = command.kind === 'field.trash';
      if (
        trash &&
        (await loadFields(db, schemas, [before.tableId])).some(
          (child) => isSelect(child) && child.options.cascade?.fieldId === before.id,
        )
      )
        invalid('data.select.parentInUse');
      if (!trash && isSelect(before) && before.options.cascade) {
        const parent = await loadField(db, schemas, before.options.cascade.fieldId);
        if (!parent || parent.trashed) invalid('data.select.restoreParent');
      }
      if (!trash && before.trashed) {
        await checkLimit(c, before.tableId);
        let name = before.name;
        let attempt = 0;
        for (;;) {
          try {
            await uniqueName(c, 'field', before.tableId, name, before.id);
            break;
          } catch (error) {
            if (!(error instanceof AppError) || error.messageKey !== 'data.field.nameTaken') throw error;
            attempt += 1;
            const suffix = messages['en-US']['names.restoredSuffix'] + (attempt > 1 ? ` ${attempt}` : '');
            name = before.name.slice(0, LIMITS.nameLength - suffix.length) + suffix;
          }
        }
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'fields')} SET name = ${name} WHERE id = ${before.id}`,
        );
      }
      const additional: Mutation[] = [];
      if (
        !paired &&
        (before.type === 'link' || before.type === 'lineItems') &&
        before.options.inverseFieldId
      ) {
        const inverse = await applyFields(c, { ...command, fieldId: before.options.inverseFieldId }, true);
        inverse.prev.dependent = true;
        additional.push(inverse);
      }
      await setTrashed(c, 'field', before.id, trash);
      // Trashing only takes away.  A field that comes back is shown again wherever it was, holding
      // whatever it and the fields it reads work out to now.
      if (!trash && before.trashed) await requireOwnPublicFields(c, [before]);
      if (
        before.type === 'link' ||
        before.type === 'formula' ||
        (await loadFields(db, schemas, [before.tableId])).some((field) => field.type === 'formula')
      )
        await bumpVersion(c, before.tableId);
      // Trashing a field that links follow makes them ordinary links, keeping the links they have.
      // Anything that comes back and is still followed catches up with the values it missed.
      let matched: AsyncIterable<Mutation> | undefined;
      if (!paired && trash && isMatchable(before.type)) additional.push(...(await unmatch(c, before.id)));
      if (!paired && !trash) matched = await rematch(c, before.id, true);
      return {
        body: trash
          ? { kind: 'field.trashed', tableId: before.tableId, fieldId: before.id }
          : { kind: 'field.restored', field: publicField(await field(c, before.id)) },
        prev: { field: storedField(before), trashed: before.trashed },
        additional: chain(additional, matched),
      };
    }
    case 'field.setPrimary': {
      const before = publicTable(await table(c, command.tableId));
      const target = await visibleField(c, command.fieldId);
      if (target.tableId !== before.id) throw new AppError('not_found', 'errors.notFound');
      if (!isPrimaryType(target.type)) invalid('data.field.primaryType');
      // Formulas and AI fields read linked records by their primary field, so one that reads its
      // own table's names through a link can't become what names them.
      if (target.type === 'formula' || target.ai) {
        const own = await loadFields(db, schemas, [before.id]);
        const reads =
          target.type === 'formula'
            ? (target.formula?.fields ?? [])
            : templateFieldIds(target.ai!.prompt).flatMap((id) => own.find((item) => item.id === id) ?? []);
        const loop = readsBack(reads, target.id, own, { tableId: before.id, field: target });
        if (loop) invalid(loop === 'aiField' ? 'aiFields.loop' : 'formula.field.circular');
      }
      // The primary field names the table's records wherever they are linked, and a link to any
      // of the table's views shares it whatever the view hides.
      if (target.id !== before.primaryFieldId)
        await requireOwnPublicFields(c, [{ id: before.primaryFieldId, tableId: before.id }]);
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'tables')} SET primary_field_id = ${target.id},
        updated_at = statement_timestamp() WHERE id = ${before.id}`,
      );
      return {
        body: { kind: 'field.primarySet', table: publicTable(await table(c, before.id)) },
        prev: { table: before },
      };
    }
  }
}
