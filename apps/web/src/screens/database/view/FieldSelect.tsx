import { useLingui } from '@lingui/react/macro';
import type { FieldMeta } from '@riosoma/contracts';
import { ListBoxItem, Select } from '@riosoma/ui';
import { fieldTypeInfo } from '../fields/fieldTypes';
import { restrictedFieldLabel, useRestrictedFields } from '../permissions/restricted';

export function FieldSelect({
  fields,
  value,
  onChange,
  readOnly = false,
  disabledKeys,
}: {
  fields: readonly FieldMeta[];
  value: string;
  onChange: (id: string) => void;
  readOnly?: boolean;
  disabledKeys?: Iterable<string>;
}) {
  const { t, i18n } = useLingui();
  // A field this person can't see keeps its place, named only as restricted.
  const restricted = useRestrictedFields().has(value) && !fields.some((field) => field.id === value);
  return (
    <Select
      listId="database.fields"
      aria-label={t({ id: 'view.filter.field', message: 'Field' })}
      selectedKey={value}
      isDisabled={readOnly || restricted}
      disabledKeys={restricted ? [...(disabledKeys ?? []), value] : disabledKeys}
      onSelectionChange={(key) => {
        if (key != null) onChange(String(key));
      }}
    >
      {restricted ? (
        <ListBoxItem key={value} id={value} textValue={i18n._(restrictedFieldLabel)}>
          {i18n._(restrictedFieldLabel)}
        </ListBoxItem>
      ) : null}
      {fields.map((field) => {
        const info = fieldTypeInfo(field.type);
        return (
          <ListBoxItem
            key={field.id}
            id={field.id}
            textValue={field.name}
            group={field.type}
            groupName={i18n._(info.name)}
            icon={info.icon}
            description={i18n._(info.name)}
          >
            {field.name}
          </ListBoxItem>
        );
      })}
    </Select>
  );
}
