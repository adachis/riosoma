import { isDeepStrictEqual } from 'node:util';
import { existingPins, visiblePins } from '../permissions/view-config.js';
import { requireVisibleRecords } from '../permissions/enforce.js';
import { requireUnlockedTable } from './schema-records.js';
import { validateLockPolicy } from '../record-locks.js';
import { validateRecords } from './validation.js';
import { createJoined, validateJoined } from '../physical/joined.js';
import { createTableSource, sourceCommand, validateSourceTable } from '../../sources/commands.js';
import {
  AppError,
  joinedSources,
  mappedFieldSpec,
  GridConfig,
  changeSidebarNavigation,
  PINNED_RECORD_LIMIT,
  isPrimaryType,
  sameTheme,
  type Command,
  type TableCreate,
  type ThemePick,
  type ViewMeta,
} from '@riosoma/contracts';
import { compile, ident, join, query, sql } from '@riosoma/db';
import { auditEvent } from '../../auth/database.js';
import { requireThemeChoice } from '../../themes/choices.js';
import { parse } from '../../http/validate.js';
import { loadDatabase, loadFields, loadTables, loadViews } from '../metadata.js';
import { createRecordTable } from '../physical/ddl.js';
import { insertRecords } from '../physical/records.js';
import {
  databaseMeta,
  invalid,
  nextPosition,
  publicField,
  publicTable,
  scopeOf,
  setTrashed,
  table,
  uniqueName,
  unusedId,
  visibleField,
  view,
  type CommandContext,
  type Mutation,
} from './context.js';
import { guardViewPatch } from '../permissions/config-guard.js';
import { fillDefaults, savedDefault } from './defaults.js';
import { insertField, saveField, applyFields } from './fields.js';
import { aiSettingsFor } from '../../ai-fields/settings.js';
import { buttonSpec, computedSpec, createPair } from './links.js';
import { chain, rematchTable, settleMatches, validateMatch } from './matches.js';
import { validateViewSettings } from '../view-settings.js';
import { requireOwnPublicView } from './public-pages.js';

type SchemaCommand = Exclude<
  Extract<Command, { kind: `database.${string}` | `table.${string}` | `view.${string}` }>,
  { kind: 'table.duplicate' }
>;

export async function createTable(
  c: CommandContext,
  input: TableCreate,
  position?: number,
): Promise<Mutation> {
  const { db, schemas, actor } = c;
  await validateSourceTable(c, input);
  await validateJoined(c, input);
  await unusedId(c, 'table', input.id);
  await uniqueName(c, 'table', c.databaseId, input.name, input.id);
  if (!isPrimaryType(input.fields[0]!.type)) invalid('data.field.primaryType');
  const names = input.fields.map((f) => f.name.toLowerCase());
  if (new Set(names).size !== names.length) invalid('data.field.nameTaken');
  if (new Set(input.records.map((r) => r.id)).size !== input.records.length) invalid('data.record.exists');
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.app, 'tables')}
    (id, org_id, database_id, name, description, primary_field_id, position, created_by)
    VALUES (${input.id}, ${actor.orgId}, ${c.databaseId}, ${input.name}, ${input.description},
      ${input.fields[0]!.id}, ${position ?? (await nextPosition(c, 'table', c.databaseId))}, ${actor.userId})`,
  );
  for (const [index, f] of input.fields.entries())
    // A button's link may name the table's other new fields, which it stores by ID.
    await insertField(
      c,
      input.id,
      savedDefault(f.type === 'button' ? { ...f, ...buttonSpec(f, input.fields, f.id) } : f, undefined, {
        synced: Boolean(input.source || input.joined),
      }),
      index,
    );
  // So may an AI field's prompt, which is checked and stored once they all exist.
  for (const f of input.fields)
    if (f.ai)
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'fields')}
        SET ai = ${JSON.stringify(await aiSettingsFor(c, input.id, f.id, f.type, f.ai))}::jsonb WHERE id = ${f.id}`,
      );
  // A link that follows values is checked once the new fields it may name exist.
  for (const f of input.fields)
    if (f.type === 'link' && f.options.match) {
      await validateMatch(c, input.id, f.options.linkedTableId, f.options.match);
    }
  // Initial computed fields need the same visible references and ownership checks as later fields.
  for (const f of await loadFields(db, schemas, [input.id])) {
    const spec = await computedSpec(c, input.id, f, f.id, f.name);
    if (spec !== f) await saveField(c, { ...f, ...spec });
  }
  let fields = await loadFields(db, schemas, [input.id]);
  await createRecordTable(db, schemas.data, input.id, fields);
  // Each link gets its other side on the linked table, as `field.create` makes it.  History keeps
  // those changes together while table creation undo preserves the pairs like manual trash.
  const pairs: Mutation[] = [];
  for (const f of fields) for (const pair of await createPair(c, f)) pairs.push({ ...pair, prev: {} });
  if (pairs.length) {
    const own = new Set(input.fields.map((f) => f.id));
    fields = (await loadFields(db, schemas, [input.id])).filter((f) => own.has(f.id));
  }
  await createTableSource(c, input);
  await createJoined(c, input);
  const config = parse(GridConfig, { fieldOrder: fields.map((f) => f.id) });
  const createdView = await createView(
    c,
    { id: input.view.id, tableId: input.id, name: input.view.name, type: 'grid', config },
    0,
  );
  // A new table's first records start empty, apart from the defaults of its fields.
  const starters = input.records.map(({ id }) => ({ id, values: {} }));
  if (!input.source && !input.joined)
    await fillDefaults(
      c,
      fields,
      input.records.map(({ id }) => ({ id, values: {} })),
      starters,
      {
        form: false,
      },
    );
  await validateRecords(c, input.id, fields, starters, false);
  const records = await insertRecords(
    db,
    schemas.data,
    input.id,
    fields.filter((field) => field.type !== 'formula'),
    input.source ? [] : starters,
    actor.userId,
  );
  // A link that follows values starts with every record linked to its matches.
  const matched = pairs.length
    ? await settleMatches(
        c,
        (await loadFields(db, schemas, [input.id])).filter((f) => f.type === 'link' && f.options.match),
        false,
      )
    : undefined;
  return {
    body: {
      kind: 'table.created',
      table: publicTable(await table(c, input.id)),
      fields: fields.map(publicField),
      views: [createdView],
      records,
    },
    prev: {},
    ...(pairs.length ? { additional: chain(pairs, matched) } : {}),
  };
}

async function createView(
  c: CommandContext,
  input: Extract<Command, { kind: 'view.create' }>['view'],
  position?: number,
): Promise<ViewMeta> {
  await table(c, input.tableId);
  await unusedId(c, 'view', input.id);
  await uniqueName(c, 'view', input.tableId, input.name, input.id);
  const hidden = (await scopeOf(c)).hiddenFieldIds(c.databaseId);
  input = {
    ...input,
    config: parse(GridConfig, { ...input.config, ...guardViewPatch(hidden, null, input.config) }),
  };
  if (input.config.form.theme)
    await requireThemeChoice(
      c.db,
      `"${c.schemas.app}"`,
      c.actor,
      input.config.form.theme,
      c.appContext?.config ?? c.fileConfig,
    );
  await validateConfig(c, input.tableId, input.config, { type: input.type });
  await query(
    c.db,
    sql`INSERT INTO ${ident(c.schemas.app, 'views')}
    (id, org_id, table_id, name, type, config, position, created_by)
    VALUES (${input.id}, ${c.actor.orgId}, ${input.tableId}, ${input.name}, ${input.type},
      ${JSON.stringify(input.config)}::jsonb, ${position ?? (await nextPosition(c, 'view', input.tableId))}, ${c.actor.userId})`,
  );
  return (await view(c, input.id)).view;
}

async function validateConfig(
  c: CommandContext,
  tableId: string,
  config: GridConfig,
  view?: { type: string; previous?: GridConfig },
): Promise<void> {
  const fields = await loadFields(c.db, c.schemas, [tableId], { includeTrashed: true });
  const known = new Set(fields.map((f) => f.id));
  for (const setting of config.sparklines) {
    if (
      !setting.order ||
      JSON.stringify(view?.previous?.sparklines.find((item) => item.fieldId === setting.fieldId)) ===
        JSON.stringify(setting)
    )
      continue;
    const field = fields.find((field) => field.id === setting.fieldId);
    const order = await visibleField(c, setting.order.fieldId);
    if (
      !field?.relation ||
      order.tableId !== field.relation.linkedTableId ||
      order.type === 'button' ||
      (order.type === 'formula' && !order.options.sortable)
    )
      throw new AppError('validation_failed', 'data.view.badSetting', { params: { setting: 'sparklines' } });
  }
  validateViewSettings(config, await loadFields(c.db, c.schemas, [tableId]), known, view);
  // Pins, column groups, and header colors arrange a grid.  Another kind of view keeps whatever it
  // already stores, since a stored value is never rewritten here, but never gains or changes them.
  if (view?.type !== 'grid') {
    const empty = { pinnedRecordIds: '[]', columnGroups: '[]', headerColors: '{}' };
    for (const setting of ['pinnedRecordIds', 'columnGroups', 'headerColors'] as const)
      if (
        JSON.stringify(config[setting]) !==
        (view?.previous ? JSON.stringify(view.previous[setting]) : empty[setting])
      )
        throw new AppError('validation_failed', 'data.view.gridOnly');
  }
  if (JSON.stringify(config.pinnedRecordIds) !== JSON.stringify(view?.previous?.pinnedRecordIds ?? [])) {
    const added = config.pinnedRecordIds.filter((id) => !view?.previous?.pinnedRecordIds.includes(id));
    if (added.length) {
      await requireVisibleRecords(c.db, c.schemas, await scopeOf(c, tableId), tableId, added);
      const found = await query(
        c.db,
        sql`SELECT __id FROM ${ident(c.schemas.data, tableId)}
        WHERE __id = ANY(${added}::text[]) AND __deleted_at IS NULL AND NOT __source_gone`,
      );
      if (found.rowCount !== added.length) throw new AppError('not_found', 'errors.notFound');
    }
  }
  const referenced = [
    ...Object.keys(config.headerColors),
    ...config.columnGroups.flatMap((group) => group.fieldIds),
    ...config.fieldOrder,
    ...config.hiddenFieldIds,
    ...Object.keys(config.columnWidths),
    // A summary that stopped fitting its field when the field changed type shows nothing, so it
    // never blocks saving the view.  Only the field it names has to exist.
    ...Object.keys(config.summaries),
    ...config.sorts.map((s) => s.fieldId),
    ...config.groups.map((group) => group.fieldId),
  ];
  const ordered = new Set(config.sorts.map((sort) => sort.fieldId));
  const collect = (filter: NonNullable<GridConfig['filter']>) => {
    for (const condition of filter.conditions) {
      if ('fieldId' in condition) {
        referenced.push(condition.fieldId);
        ordered.add(condition.fieldId);
      } else collect(condition);
    }
  };
  if (config.filter) collect(config.filter);
  if (referenced.some((id) => !known.has(id))) throw new AppError('not_found', 'errors.notFound');
  if (
    fields.some(
      (field) =>
        field.type === 'changeLog' &&
        (ordered.has(field.id) || config.groups.some((group) => group.fieldId === field.id)),
    )
  )
    throw new AppError('validation_failed', 'errors.validationFailed');
  if (fields.some((field) => field.type === 'formula' && ordered.has(field.id) && !field.options.sortable))
    throw new AppError('validation_failed', 'data.formula.notSortable');
}

/**
 * Forces a theme on everyone who opens the database, or stops forcing one.  Only the owner may,
 * and only with a theme that exists and that the owner may choose.  Sending the theme the database
 * already has changes nothing, so it asks nothing of whoever sends it.
 */
async function changeDatabaseTheme(
  c: CommandContext,
  command: Extract<Command, { kind: 'database.update' }>,
  previous: ThemePick | null,
): Promise<void> {
  if (command.theme === undefined || sameTheme(command.theme, previous)) return;
  const { db, schemas } = c;
  await (await scopeOf(c)).require(c.databaseId, 'manage');
  const theme = command.theme;
  if (theme)
    await requireThemeChoice(db, `"${schemas.app}"`, c.actor, theme, c.appContext?.config ?? c.fileConfig);
  await query(
    db,
    theme
      ? sql`UPDATE ${ident(schemas.app, 'databases')} SET settings = jsonb_set(settings, '{theme}', ${JSON.stringify(theme)}::jsonb) WHERE id = ${c.databaseId}`
      : sql`UPDATE ${ident(schemas.app, 'databases')} SET settings = settings - 'theme' WHERE id = ${c.databaseId}`,
  );
  const metadata = { databaseId: c.databaseId, theme, previous, commandId: command.id };
  if (c.deferredAudit) c.deferredAudit.push({ action: 'data.database.themeChanged', metadata });
  else
    await auditEvent(
      db,
      compile(sql`${ident(schemas.audit)}`).text,
      'data.database.themeChanged',
      c.actor,
      metadata,
    );
}

export async function applySchema(c: CommandContext, command: SchemaCommand): Promise<Mutation> {
  const { db, schemas } = c;
  switch (command.kind) {
    case 'database.update': {
      const before = await databaseMeta(c);
      if (command.navigation) {
        const folders = new Map(command.navigation.folders.map((folder) => [folder.id, folder]));
        for (const [id, folderId] of Object.entries(command.navigation.parents)) {
          const section = folders.get(folderId)!.section;
          if (
            before.navigation?.parents[id] === folderId &&
            before.navigation.folders.find((folder) => folder.id === folderId)?.section === section
          )
            continue;
          const relation = {
            table: 'tables',
            dashboard: 'dashboards',
            automation: 'automations',
            interface: 'interfaces',
            script: 'scripts',
          }[section];
          const found = await query(
            c.db,
            sql`SELECT id FROM ${ident(schemas.app, relation)} WHERE id = ${id} AND database_id = ${c.databaseId} AND org_id = ${c.actor.orgId} AND trashed_at IS NULL`,
          );
          if (!found.rowCount) invalid('errors.notFound');
        }
        await query(
          c.db,
          sql`UPDATE ${ident(schemas.app, 'databases')} SET settings = jsonb_set(settings, '{navigation}', ${JSON.stringify(command.navigation)}::jsonb) WHERE id = ${c.databaseId}`,
        );
      }
      await changeDatabaseTheme(c, command, before.theme ?? null);
      const values = {
        name: command.name ?? before.name,
        description: command.description ?? before.description,
        icon: command.icon === undefined ? before.icon : command.icon,
        color: command.color === undefined ? before.color : command.color,
      };
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'databases')} SET
        ${join(
          Object.entries(values).map(([key, value]) => sql`${ident(key)} = ${value}`),
          ', ',
        )},
        updated_at = statement_timestamp() WHERE id = ${c.databaseId}`,
      );
      return {
        body: { kind: 'database.updated', database: await databaseMeta(c) },
        prev: {
          database: Object.fromEntries(
            ['name', 'description', 'icon', 'color', 'navigation', 'theme']
              .filter((key) => key in command)
              .map((key) => [
                key,
                key === 'navigation'
                  ? (before.navigation ?? { folders: [], parents: {} })
                  : key === 'theme'
                    ? (before.theme ?? null)
                    : before[key as keyof typeof before],
              ]),
          ),
        },
      };
    }
    case 'database.navigation': {
      const before = await databaseMeta(c);
      const current = before.navigation ?? { folders: [], parents: {} };
      const change = command.change;
      if (change.kind === 'folder.create' && current.folders.some((folder) => folder.id === change.folder.id))
        invalid('errors.conflict');
      if (
        ['folder.move', 'folder.rename', 'folder.delete'].includes(change.kind) &&
        'id' in change &&
        !current.folders.some((folder) => folder.id === change.id)
      )
        invalid('errors.notFound');
      let result: ReturnType<typeof changeSidebarNavigation>;
      try {
        result = changeSidebarNavigation(current, change);
      } catch {
        return invalid('errors.validationFailed');
      }
      for (const [id, parentId] of Object.entries(result.navigation.parents)) {
        if (current.parents[id] === parentId) continue;
        const folder = result.navigation.folders.find((folder) => folder.id === parentId)!;
        const relation = {
          table: 'tables',
          dashboard: 'dashboards',
          automation: 'automations',
          interface: 'interfaces',
          script: 'scripts',
        }[folder.section];
        const found = await query(
          db,
          sql`SELECT id FROM ${ident(schemas.app, relation)} WHERE id = ${id} AND database_id = ${c.databaseId} AND org_id = ${c.actor.orgId} AND trashed_at IS NULL`,
        );
        if (!found.rowCount) invalid('errors.notFound');
      }
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'databases')} SET settings = jsonb_set(settings, '{navigation}', ${JSON.stringify(result.navigation)}::jsonb), updated_at = statement_timestamp() WHERE id = ${c.databaseId}`,
      );
      return {
        body: { kind: 'database.updated', database: await databaseMeta(c) },
        prev: { navigation: result.inverse },
      };
    }
    case 'database.trash':
    case 'database.restore': {
      if (command.kind === 'database.trash')
        for (const item of await loadTables(db, schemas, c.databaseId))
          await requireUnlockedTable(c, item.id);
      const before = await loadDatabase(db, schemas, c.databaseId);
      if (command.kind === 'database.restore') {
        const parent = await query(
          db,
          sql`SELECT f.id FROM ${ident(schemas.app, 'folder_databases')} fd
          JOIN ${ident(schemas.app, 'folders')} leaf ON leaf.org_id = fd.org_id AND leaf.id = fd.folder_id
          JOIN ${ident(schemas.app, 'folders')} f ON f.org_id = leaf.org_id AND (f.id = leaf.id OR f.id = ANY(leaf.path))
          WHERE fd.database_id = ${c.databaseId} AND f.trashed_at IS NOT NULL`,
        );
        if (parent.rowCount) throw new AppError('conflict', 'home.folders.restoreParent');
      }
      await setTrashed(c, 'database', c.databaseId, command.kind === 'database.trash');
      return {
        body: { kind: command.kind === 'database.trash' ? 'database.trashed' : 'database.restored' },
        prev: { trashed: before!.trashed },
      };
    }
    case 'table.create':
      return createTable(c, command.table, command.position);
    case 'table.update':
    case 'table.move': {
      const before = publicTable(await table(c, command.tableId));
      if (
        command.kind === 'table.update' &&
        ((command.allowComputedOverrides !== undefined &&
          command.allowComputedOverrides !== (before.allowComputedOverrides ?? false)) ||
          (command.historyRetentionDays !== undefined &&
            command.historyRetentionDays !== (before.historyRetentionDays ?? 90)))
      )
        await (await scopeOf(c)).require(c.databaseId, 'manage');
      if (command.kind === 'table.update' && command.joined) {
        if ((await table(c, command.tableId)).ingest)
          throw new AppError('conflict', 'ingest.tables.exclusive');
        return remapJoined(c, command);
      }
      if (command.kind === 'table.update' && command.name !== undefined)
        await uniqueName(c, 'table', c.databaseId, command.name, command.tableId);
      const name = command.kind === 'table.update' ? (command.name ?? before.name) : before.name;
      const description =
        command.kind === 'table.update' ? (command.description ?? before.description) : before.description;
      const position = command.kind === 'table.move' ? command.position : before.position;
      const recordLock =
        command.kind === 'table.update' ? (command.recordLock ?? before.recordLock) : before.recordLock;
      if (command.kind === 'table.update' && command.recordLock)
        await validateLockPolicy(c, command.tableId, command.recordLock);
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'tables')} SET name = ${name}, description = ${description},
        position = ${position}, record_lock = ${JSON.stringify(recordLock ?? null)}::jsonb,
        allow_computed_overrides = ${command.kind === 'table.update' ? (command.allowComputedOverrides ?? before.allowComputedOverrides ?? false) : (before.allowComputedOverrides ?? false)},
        history_retention_days = ${command.kind === 'table.update' ? (command.historyRetentionDays ?? before.historyRetentionDays ?? 90) : (before.historyRetentionDays ?? 90)},
        updated_at = statement_timestamp() WHERE id = ${command.tableId}`,
      );
      return {
        body: { kind: 'table.updated', table: publicTable(await table(c, command.tableId)) },
        prev: { table: before },
      };
    }
    case 'table.trash':
    case 'table.restore': {
      const before = await table(c, command.tableId, true);
      const trash = command.kind === 'table.trash';
      if (trash) await requireUnlockedTable(c, before.id);
      if (trash && !before.trashed && (await loadTables(db, schemas, c.databaseId)).length <= 1)
        invalid('data.table.last');
      if (!trash) await uniqueName(c, 'table', c.databaseId, before.name, before.id);
      await setTrashed(c, 'table', before.id, trash);
      return {
        body: trash
          ? { kind: 'table.trashed', tableId: before.id }
          : {
              kind: 'table.restored',
              table: publicTable(await table(c, before.id)),
              fields: (await loadFields(db, schemas, [before.id])).map(publicField),
              views: await loadViews(db, schemas, [before.id]),
            },
        prev: { trashed: before.trashed },
        // Links that follow values catch up with whatever changed while the table was away.
        ...(trash ? {} : { additional: await rematchTable(c, before.id) }),
      };
    }
    case 'view.create':
      return {
        body: { kind: 'view.created', view: await createView(c, command.view, command.position) },
        prev: {},
      };
    case 'view.update':
    case 'view.move': {
      const before = (await view(c, command.viewId)).view;
      const unlockOnly =
        command.kind === 'view.update' &&
        command.name === undefined &&
        command.config?.locked === false &&
        Object.keys(command.config).length === 1;
      if (before.config.locked && !unlockOnly && !c.copyViewPlacement) invalid('data.locks.viewLocked');
      if (command.kind === 'view.update' && command.config?.locked !== undefined)
        await (await scopeOf(c)).require(c.databaseId, 'editSchema');
      const name = command.kind === 'view.update' ? (command.name ?? before.name) : before.name;
      const hidden = (await scopeOf(c)).hiddenFieldIds(c.databaseId);
      const patch = command.kind === 'view.update' ? { ...command.config } : {};
      if (patch.pinnedRecordIds) {
        const shown = await visiblePins(c.db, c.schemas, await scopeOf(c, before.tableId), before);
        const existing = await existingPins(c.db, c.schemas, before);
        patch.pinnedRecordIds = [
          ...new Set([
            ...patch.pinnedRecordIds.filter(
              (id) => !before.config.pinnedRecordIds.includes(id) || existing.has(id),
            ),
            ...before.config.pinnedRecordIds.filter((id) => existing.has(id) && !shown.has(id)),
          ]),
        ];
        if (patch.pinnedRecordIds.length > PINNED_RECORD_LIMIT) invalid('data.view.pinLimit');
      }
      const config =
        command.kind === 'view.update'
          ? parse(GridConfig, {
              ...before.config,
              ...guardViewPatch(hidden, before.config, patch),
            })
          : before.config;
      const position = command.kind === 'view.move' ? command.position : before.position;
      // A form's public page may pick its own theme, which has to be one its picker may choose.
      const formTheme = config.form.theme;
      if (formTheme && !sameTheme(formTheme, before.config.form.theme))
        await requireThemeChoice(
          db,
          `"${schemas.app}"`,
          c.actor,
          formTheme,
          c.appContext?.config ?? c.fileConfig,
        );
      await uniqueName(c, 'view', before.tableId, name, before.id);
      await validateConfig(c, before.tableId, config, { type: before.type, previous: before.config });
      // A public page shows what the view's settings say, so someone a rule limits changes none of
      // them on a view another person made public.  Placing a copied field moves nothing the view
      // already had, and a new name shows nothing more.
      if (!c.copyViewPlacement && JSON.stringify(config) !== JSON.stringify(before.config))
        await requireOwnPublicView(c, before);
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'views')} SET name = ${name}, config = ${JSON.stringify(config)}::jsonb,
        position = ${position}, updated_at = statement_timestamp() WHERE id = ${before.id}`,
      );
      return {
        body: { kind: 'view.updated', view: (await view(c, before.id)).view },
        prev: { view: before },
      };
    }
    case 'table.updateSource':
    case 'table.sync':
      return sourceCommand(c, command);
    case 'view.trash':
    case 'view.restore': {
      const before = await view(c, command.viewId, true);
      const trash = command.kind === 'view.trash';
      if (before.view.config.locked) invalid('data.locks.viewLocked');
      if (trash && !before.trashed && (await loadViews(db, schemas, [before.view.tableId])).length <= 1)
        invalid('data.view.last');
      if (!trash) await uniqueName(c, 'view', before.view.tableId, before.view.name, before.view.id);
      await setTrashed(c, 'view', before.view.id, trash);
      return {
        body: trash
          ? { kind: 'view.trashed', tableId: before.view.tableId, viewId: before.view.id }
          : { kind: 'view.restored', view: (await view(c, before.view.id)).view },
        prev: { trashed: before.trashed },
      };
    }
  }
}

async function remapJoined(
  c: CommandContext,
  command: Extract<Command, { kind: 'table.update' }>,
): Promise<Mutation> {
  const before = await table(c, command.tableId);
  const joined = command.joined!;
  if (
    !before.joined ||
    joined.baseTableId !== before.joined.baseTableId ||
    !isDeepStrictEqual(joined.steps, before.joined.steps)
  )
    throw new AppError('validation_failed', 'joined.invalid');
  const fields = await loadFields(c.db, c.schemas, [before.id]);
  const outputs =
    command.joinedFields ??
    fields.filter((field) => joined.fields.some((mapping) => mapping.outputFieldId === field.id));
  if (!outputs.some((field) => field.id === before.primaryFieldId))
    throw new AppError('validation_failed', 'joined.invalid');
  const names = outputs.map((field) => field.name.toLowerCase());
  if (new Set(names).size !== names.length) throw new AppError('validation_failed', 'data.field.nameTaken');
  const scope = await scopeOf(c);
  const readable = new Set(scope.visibleFields(before.id, fields).map((field) => field.id));
  for (const output of fields) {
    const previous = before.joined.fields.find((mapping) => mapping.outputFieldId === output.id);
    const next = joined.fields.find((mapping) => mapping.outputFieldId === output.id);
    if (!isDeepStrictEqual(previous, next) && !readable.has(output.id))
      throw new AppError('forbidden', 'data.access.fieldHidden');
  }
  for (const mapping of before.joined.fields) {
    const next = joined.fields.find((item) => item.outputFieldId === mapping.outputFieldId);
    if (isDeepStrictEqual(next, mapping)) continue;
    for (const source of joinedSources(mapping)) {
      const known = await loadFields(c.db, c.schemas, [source.tableId]);
      if (!scope.visibleFields(source.tableId, known).some((field) => field.id === source.fieldId))
        throw new AppError('forbidden', 'data.access.fieldHidden');
    }
  }
  await validateJoined(
    c,
    {
      id: before.id,
      name: before.name,
      description: before.description,
      fields: outputs,
      records: [],
      view: { id: before.id, name: before.name },
      joined,
    },
    { joined: before.joined, fields },
  );
  const mutations: Mutation[] = [];
  for (const output of outputs) {
    const existing = fields.find((field) => field.id === output.id);
    const converts =
      existing &&
      JSON.stringify({ type: existing.type, options: existing.options }) !==
        JSON.stringify({ type: output.type, options: output.options });
    if (converts) {
      const common = mappedFieldSpec([existing, { ...existing, ...output }]);
      if (
        !common ||
        JSON.stringify(common) !== JSON.stringify({ type: output.type, options: output.options })
      )
        throw new AppError('validation_failed', 'joined.mapping.lossy');
      mutations.push(
        await applyFields(
          c,
          {
            ...command,
            kind: 'field.convert',
            fieldId: output.id,
            to: common,
            dateOrder: 'mdy',
            timeZone: 'UTC',
          },
          false,
          true,
        ),
      );
    }
    if (!existing)
      mutations.push(
        await applyFields(
          c,
          { ...command, kind: 'field.create', tableId: before.id, field: { ...output, source: undefined } },
          false,
          true,
        ),
      );
    else if (existing.name !== output.name || existing.description !== output.description)
      mutations.push(
        await applyFields(
          c,
          {
            ...command,
            kind: 'field.update',
            fieldId: output.id,
            name: output.name,
            description: output.description,
          },
          false,
          true,
        ),
      );
  }
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'fields')} f SET source = item -> 'source', updated_at = statement_timestamp()
      FROM jsonb_array_elements(${JSON.stringify(outputs.map((output) => ({ id: output.id, source: output.source ?? null })))}::jsonb) item
      WHERE f.id = item ->> 'id' AND f.table_id = ${before.id} AND f.source IS DISTINCT FROM item -> 'source'`,
  );
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'tables')} SET joined = ${JSON.stringify(joined)}::jsonb,
    updated_at = statement_timestamp() WHERE id = ${before.id}`,
  );
  c.scope = undefined;
  const updated = await applySchema(c, { ...command, joined: undefined, joinedFields: undefined });
  mutations.push({ ...updated, prev: { table: publicTable(before) } });
  for (const field of fields)
    if (
      before.joined.fields.some((mapping) => mapping.outputFieldId === field.id) &&
      !outputs.some((output) => output.id === field.id)
    )
      mutations.push(
        await applyFields(c, { ...command, kind: 'field.trash', fieldId: field.id }, false, true),
      );
  const first = mutations.shift()!;
  return { ...first, refreshJoined: true, additional: chain(mutations, first.additional) };
}
