import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { CHOICE_COLORS, newId, type ChoiceColor, type FieldMeta, type GridConfig } from '@riosoma/contracts';
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle, Modal, TextField } from '@riosoma/ui';
import { colorNames } from '../../screens/database/colors/labels';

export function GridAppearance({
  field,
  fields,
  primaryFieldId,
  config,
  onSave,
  onClose,
}: {
  field: FieldMeta;
  fields: readonly FieldMeta[];
  primaryFieldId: string;
  config: GridConfig;
  onSave(patch: Partial<GridConfig>): void;
  onClose(): void;
}) {
  const { t, i18n } = useLingui();
  const existing = config.columnGroups.find((group) => group.fieldIds.includes(field.id));
  const [color, setColor] = useState<ChoiceColor | ''>(config.headerColors[field.id] ?? '');
  const [groupId, setGroupId] = useState(existing?.id ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [groupColor, setGroupColor] = useState<ChoiceColor | ''>(existing?.color ?? '');
  const [members, setMembers] = useState(existing?.fieldIds ?? [field.id]);
  const noColor = t({ id: 'grid.appearance.noColor', message: 'No color' });
  const colors = (value: string, change: (value: ChoiceColor | '') => void, label: string) => (
    <label>
      {label}
      <select
        aria-label={label}
        value={value}
        onChange={(event) => change(event.target.value as ChoiceColor | '')}
      >
        <option value="">{noColor}</option>
        {CHOICE_COLORS.map((item) => (
          <option key={item} value={item}>
            {i18n._(colorNames[item])}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <Modal
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="rio-grid-appearance"
    >
      <Dialog aria-label={t({ id: 'grid.appearance.title', message: 'Headers and column groups' })}>
        <DialogTitle>{t({ id: 'grid.appearance.title', message: 'Headers and column groups' })}</DialogTitle>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const headerColors = { ...config.headerColors };
            if (color) headerColors[field.id] = color;
            else delete headerColors[field.id];
            const id = groupId === 'new' ? newId('action') : groupId;
            const chosen = groupId ? [...new Set([...members, field.id])] : [];
            const columnGroups = config.columnGroups.flatMap((group) => {
              if (group.id === id) return [];
              const fieldIds = group.fieldIds.filter((item) => item !== field.id && !chosen.includes(item));
              return fieldIds.length ? [{ ...group, fieldIds }] : [];
            });
            if (id && name.trim())
              columnGroups.push({
                id,
                name: name.trim(),
                fieldIds: chosen,
                collapsed: config.columnGroups.find((group) => group.id === id)?.collapsed ?? false,
                ...(groupColor ? { color: groupColor } : {}),
              });
            onSave({ headerColors, columnGroups });
            onClose();
          }}
        >
          <DialogBody>
            {colors(color, setColor, t({ id: 'grid.appearance.headerColor', message: 'Header color' }))}
            {field.id !== primaryFieldId && (
              <>
                <label>
                  {t({ id: 'grid.appearance.group', message: 'Column group' })}
                  <select
                    aria-label={t({ id: 'grid.appearance.group', message: 'Column group' })}
                    value={groupId}
                    onChange={(event) => {
                      const id = event.target.value;
                      const group = config.columnGroups.find((item) => item.id === id);
                      setGroupId(id);
                      setName(group?.name ?? '');
                      setGroupColor(group?.color ?? '');
                      setMembers(group?.fieldIds ?? [field.id]);
                    }}
                  >
                    <option value="">{t({ id: 'grid.appearance.noGroup', message: 'No group' })}</option>
                    <option value="new">
                      {t({ id: 'grid.appearance.newGroup', message: 'New column group' })}
                    </option>
                    {config.columnGroups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </label>
                {groupId && (
                  <>
                    <TextField
                      label={t({ id: 'grid.appearance.groupName', message: 'Group name' })}
                      value={name}
                      onChange={setName}
                      maxLength={100}
                      isRequired
                    />
                    {colors(
                      groupColor,
                      setGroupColor,
                      t({ id: 'grid.appearance.groupColor', message: 'Group color' }),
                    )}
                    <fieldset>
                      <legend>{t({ id: 'grid.appearance.fields', message: 'Fields in this group' })}</legend>
                      {fields
                        .filter((item) => item.id !== primaryFieldId)
                        .map((item) => (
                          <label key={item.id}>
                            <input
                              type="checkbox"
                              checked={item.id === field.id || members.includes(item.id)}
                              disabled={item.id === field.id}
                              onChange={(event) =>
                                setMembers(
                                  event.target.checked
                                    ? [...members, item.id]
                                    : members.filter((id) => id !== item.id),
                                )
                              }
                            />
                            {item.name}
                          </label>
                        ))}
                    </fieldset>
                  </>
                )}
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <Button onPress={onClose}>{t({ id: 'grid.appearance.cancel', message: 'Cancel' })}</Button>
            <Button type="submit" variant="primary" isDisabled={Boolean(groupId && !name.trim())}>
              {t({ id: 'grid.appearance.save', message: 'Save' })}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </Modal>
  );
}
