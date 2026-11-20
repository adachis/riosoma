import type { I18n } from '@lingui/core';
import type { FieldMeta } from '@riosoma/contracts';
import { ListBoxItem } from '@riosoma/ui';
import { fieldTypeInfo } from '../../fields/fieldTypes';

/** A field in a select, with its type's icon and name, as the dashboard tile editor shows it. */
export function fieldOption(field: FieldMeta, i18n: I18n) {
  const info = fieldTypeInfo(field.type);
  return (
    <ListBoxItem
      key={field.id}
      id={field.id}
      textValue={field.name}
      icon={info.icon}
      description={i18n._(info.name)}
    >
      {field.name}
    </ListBoxItem>
  );
}

/** The key for "nothing chosen" in selects that allow it */
export const NONE = '__none__';
