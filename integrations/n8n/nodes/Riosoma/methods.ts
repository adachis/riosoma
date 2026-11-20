import type {
  FieldType,
  ILoadOptionsFunctions,
  INodePropertyOptions,
  ResourceMapperField,
  ResourceMapperFields,
} from 'n8n-workflow';
import { canMatch } from '../../shared/filters';
import { chosenTableMeta, searchDatabases, searchTables } from '../../shared/metadata';
import type { FieldMeta } from '../../shared/types';
import { isWritable, NUMBER_TYPES } from '../../shared/values';

/** The mapper's input for a field.  Lists and files take text with commas, or a list from an expression. */
function mapperType(field: FieldMeta): FieldType {
  if (NUMBER_TYPES.includes(field.type)) return 'number';
  if (field.type === 'checkbox') return 'boolean';
  if (field.type === 'date') return 'dateTime';
  if (field.type === 'singleSelect') return 'options';
  return 'string';
}

function describeType(field: FieldMeta): string {
  return field.type.replace(/([A-Z])/g, ' $1').toLowerCase();
}

async function fieldOptions(
  context: ILoadOptionsFunctions,
  include: (field: FieldMeta) => boolean,
): Promise<INodePropertyOptions[]> {
  const table = await chosenTableMeta(context);
  if (!table) return [];
  return table.fields
    .filter(include)
    .map((field) => ({ name: field.name, value: field.id, description: describeType(field) }));
}

export async function getFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  return fieldOptions(this, () => true);
}

export async function getSortableFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  return fieldOptions(this, (field) => field.type !== 'button' && field.options?.sortable !== false);
}

export async function getMatchFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  return fieldOptions(this, canMatch);
}

export async function getViews(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  const table = await chosenTableMeta(this);
  if (!table) return [];
  return table.views.map((view) => ({ name: view.name, value: view.id, description: `${view.type} view` }));
}

/** The fields a write can set, keyed by name so values from items map to them by name. */
export async function getColumns(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
  const table = await chosenTableMeta(this);
  if (!table) return { fields: [], emptyFieldsNotice: 'Choose a database and a table first' };
  const fields: ResourceMapperField[] = table.fields.filter(isWritable).map((field) => ({
    id: field.name,
    displayName: field.name,
    required: false,
    defaultMatch: false,
    canBeUsedToMatch: canMatch(field),
    display: true,
    type: mapperType(field),
    ...(field.type === 'singleSelect'
      ? {
          options: (field.options?.choices ?? []).map((choice) => ({
            name: choice.name,
            value: choice.name,
          })),
        }
      : {}),
  }));
  return { fields };
}

export const methods = {
  listSearch: { searchDatabases, searchTables },
  loadOptions: { getFields, getSortableFields, getMatchFields, getViews },
  resourceMapping: { getColumns },
};
