import {
  FieldSpec,
  GridConfig,
  newId,
  type DatabaseMeta,
  type FieldMeta,
  type FieldType,
  type SharedField,
  type SharedViewOpen,
  type TableMeta,
  type ViewMeta,
} from '@riosoma/contracts';

/**
 * A shared view rebuilt as the app's own shapes, so the same view components can draw it.  The
 * server sends only what showing the shared fields needs, so the parts that describe the rest of
 * the database (which table a link points at, which fields a lookup reads) are stand-ins here.
 */
export interface SharedSchema {
  database: DatabaseMeta;
  table: TableMeta;
  view: ViewMeta;
  /** The shared fields, in the view's order */
  fields: FieldMeta[];
  /** The shared fields and the stand-ins lookups format their values with */
  fieldById: ReadonlyMap<string, FieldMeta>;
}

/** Stand-in IDs for one page, so nothing the server kept private is needed to draw it. */
export interface SharedIds {
  databaseId: string;
  tableId: string;
  viewId: string;
  /** What links and lookups point at.  Never read, since the server sends names with each page. */
  elsewhere: { tableId: string; fieldId: string };
  /** The stand-in for the field a lookup reads, the same one every time for the same lookup */
  lookupTarget(fieldId: string): string;
}

export function sharedIds(): SharedIds {
  const targets = new Map<string, string>();
  return {
    databaseId: newId('database'),
    tableId: newId('table'),
    viewId: newId('view'),
    elsewhere: { tableId: newId('table'), fieldId: newId('field') },
    lookupTarget(fieldId) {
      let id = targets.get(fieldId);
      if (!id) {
        id = newId('field');
        targets.set(fieldId, id);
      }
      return id;
    },
  };
}

function standIns(
  type: FieldType,
  ids: SharedIds,
  targetId: string,
  /** A link to the view's own table, such as a list's parents */
  self: boolean,
): Record<string, unknown> {
  switch (type) {
    case 'link':
      return { linkedTableId: self ? ids.tableId : ids.elsewhere.tableId };
    case 'lookup':
      return { linkFieldId: ids.elsewhere.fieldId, targetFieldId: targetId };
    case 'rollup':
      return { linkFieldId: ids.elsewhere.fieldId, targetFieldId: ids.elsewhere.fieldId };
    case 'count':
      return { linkFieldId: ids.elsewhere.fieldId };
    default:
      return {};
  }
}

function fieldMeta(
  field: Pick<SharedField, 'id' | 'name' | 'type' | 'options'>,
  tableId: string,
  position: number,
  ids: SharedIds,
  targetId = ids.elsewhere.fieldId,
  self = false,
): FieldMeta | null {
  const spec = FieldSpec.safeParse({
    type: field.type,
    options: { ...field.options, ...standIns(field.type, ids, targetId, self) },
  });
  if (!spec.success) return null;
  return {
    ...spec.data,
    id: field.id,
    tableId,
    name: field.name,
    description: '',
    position,
    createdAt: '',
    updatedAt: '',
  };
}

export function sharedSchema(shared: SharedViewOpen, ids: SharedIds): SharedSchema {
  const fields: FieldMeta[] = [];
  const all = new Map<string, FieldMeta>();
  const parentFieldId =
    shared.display.orgChart?.parentFieldId ??
    shared.display.list?.parentFieldId ??
    shared.display.gantt?.dependencyFieldId ??
    null;
  shared.fields.forEach((field, position) => {
    // A lookup formats its values like the field it reads, which stands in under an ID of its own.
    const target = field.lookup
      ? fieldMeta(
          { id: ids.lookupTarget(field.id), name: field.name, ...field.lookup },
          ids.elsewhere.tableId,
          position,
          ids,
        )
      : null;
    const meta = fieldMeta(field, ids.tableId, position, ids, target?.id, field.id === parentFieldId);
    if (!meta) return;
    fields.push(meta);
    all.set(meta.id, meta);
    if (target) all.set(target.id, target);
  });
  const parsed = GridConfig.safeParse({
    ...shared.display,
    fieldOrder: fields.map((field) => field.id),
  });
  const config = parsed.success
    ? parsed.data
    : GridConfig.parse({ fieldOrder: fields.map((field) => field.id) });
  const table: TableMeta = {
    id: ids.tableId,
    databaseId: ids.databaseId,
    name: shared.name,
    description: '',
    primaryFieldId: shared.primaryFieldId,
    position: 0,
    createdAt: '',
    updatedAt: '',
  };
  return {
    database: {
      id: ids.databaseId,
      name: shared.name,
      description: '',
      icon: null,
      color: null,
      createdBy: null,
      createdAt: '',
      updatedAt: '',
      role: 'reader',
    },
    table,
    view: {
      id: ids.viewId,
      tableId: ids.tableId,
      name: shared.name,
      type: shared.type,
      config,
      position: 0,
      createdBy: null,
      createdAt: '',
      updatedAt: '',
    },
    fields,
    fieldById: all,
  };
}
