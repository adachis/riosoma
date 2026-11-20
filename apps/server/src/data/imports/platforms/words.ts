import type { ReaderContext } from './importer.js';

/** API callers may omit translated names.  These IDs share the web catalog's source text. */
const names = {
  body: { id: 'import.platform.field.body', message: 'Page body' },
  group: { id: 'import.platform.field.group', message: 'Group' },
  children: { id: 'import.platform.field.children', message: 'Subitems' },
  parent: { id: 'import.platform.field.parent', message: 'Parent item' },
  name: { id: 'import.platform.field.name', message: 'Name' },
};

export function fieldNames(context: ReaderContext) {
  return {
    body: context.fieldNames?.body ?? names.body.message,
    group: context.fieldNames?.group ?? names.group.message,
    children: context.fieldNames?.children ?? names.children.message,
    parent: context.fieldNames?.parent ?? names.parent.message,
    name: context.fieldNames?.name ?? names.name.message,
  };
}
