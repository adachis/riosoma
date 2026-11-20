import { useLingui } from '@lingui/react/macro';
import type { FieldType } from '@riosoma/contracts';
import { ListBoxItem, Select } from '@riosoma/ui';
import { AI_FIELD_INFO, FIELD_TYPE_INFO } from './fieldTypes';
import { useLevel } from '../../../levels/context';
import { anchor } from '../../../demos/anchors';

/** A field's type as the menu offers it: one of the stored types, or an AI field of one of them. */
export type PickedType = FieldType | 'ai';

export interface FieldTypePickerProps {
  value: PickedType;
  onChange: (type: PickedType) => void;
  allowed?: readonly FieldType[];
  disabled?: boolean;
  /** Offers the AI field, which a primary, synced, or live field can't be */
  offerAi?: boolean;
  /** Why AI fields can't be made now, shown under their entry, already localized */
  aiNote?: string;
  /** The type a field had when its dialog opened, offered whatever the person's level */
  kept?: PickedType;
}

export function FieldTypePicker({
  value,
  onChange,
  allowed,
  disabled,
  offerAi,
  aiNote,
  kept,
}: FieldTypePickerProps) {
  const { i18n, t } = useLingui();
  const { offers } = useLevel();
  // The person's level decides which types to offer.  The field's own type always shows, so a
  // formula someone else made opens, edits, and can go back to being a formula at Simple.
  const entries = (offerAi || value === 'ai' ? [...FIELD_TYPE_INFO, AI_FIELD_INFO] : FIELD_TYPE_INFO).filter(
    ({ type }) => type === value || type === kept || offers('fieldTypePicker', type),
  );
  return (
    <Select
      {...anchor('field.type')}
      isDisabled={disabled}
      label={t({ id: 'field.dialog.type', message: 'Type' })}
      selectedKey={value}
      onSelectionChange={(key) => {
        if (key === 'ai') {
          if (offerAi && !aiNote) onChange('ai');
          return;
        }
        const next = entries.find(
          (entry): entry is (typeof FIELD_TYPE_INFO)[number] => entry.type !== 'ai' && entry.type === key,
        );
        if (next && (!allowed || allowed.includes(next.type))) onChange(next.type);
      }}
    >
      {entries.map(({ type, icon, name, description }) => (
        <ListBoxItem
          key={type}
          id={type}
          icon={icon}
          textValue={i18n._(name)}
          description={type === 'ai' && aiNote ? aiNote : description ? i18n._(description) : undefined}
          isDisabled={type === 'ai' ? Boolean(aiNote) || !offerAi : allowed && !allowed.includes(type)}
        >
          {i18n._(name)}
        </ListBoxItem>
      ))}
    </Select>
  );
}
