import { faIdCard, faTableColumns } from '@fortawesome/free-solid-svg-icons';
import { SettingsBar, SettingsPicker, SettingsTrigger } from '../../view/ToolbarSettings';
import { useLingui } from '@lingui/react/macro';
import { Button, Checkbox, ListBoxItem, Popover, Select } from '@riosoma/ui';
import { Dialog } from 'react-aria-components';
import { useSchema } from '../../../../data/hooks';
import type { ViewComponentProps } from '../types';
import { isStackField } from './model';
import './kanban.css';

export function StackPicker(props: ViewComponentProps) {
  const { t } = useLingui();
  useSchema(props.session);
  return (
    <SettingsPicker
      icon={faTableColumns}
      value={props.fields.find((field) => field.id === props.view.config.kanban.stackFieldId)?.name}
      label={t({ id: 'kanban.stackedBy', message: 'Stacked by' })}
    >
      <Select
        label={t({ id: 'kanban.stackedBy', message: 'Stacked by' })}
        placeholder={t({ id: 'kanban.chooseField', message: 'Choose a field to stack cards by' })}
        selectedKey={props.view.config.kanban.stackFieldId}
        isDisabled={!props.canEdit}
        onSelectionChange={(key) => {
          if (!props.canEdit || !props.fields.some((field) => field.id === key && isStackField(field)))
            return;
          props.onConfig({
            kanban: {
              ...props.view.config.kanban,
              stackFieldId: String(key),
              stackOrder: [],
              hiddenStacks: [],
            },
          });
        }}
      >
        {props.fields.filter(isStackField).map((field) => (
          <ListBoxItem key={field.id} id={field.id}>
            {field.name}
          </ListBoxItem>
        ))}
      </Select>
    </SettingsPicker>
  );
}

export function KanbanSettings(props: ViewComponentProps) {
  const { t } = useLingui();
  useSchema(props.session);
  const config = props.view.config.kanban;
  // These change the view, which takes the view's permission, not the one for moving cards.
  const disabled = !props.canEdit;
  const save = (patch: Partial<typeof config>) => {
    if (props.canEdit) props.onConfig({ kanban: { ...config, ...patch } });
  };
  return (
    <SettingsBar className="rio-kanban-settings">
      <StackPicker {...props} />
      <SettingsTrigger label={t({ id: 'kanban.cards', message: 'Cards' })} icon={faIdCard}>
        <Button>{t({ id: 'kanban.cards', message: 'Cards' })}</Button>
        <Popover>
          <Dialog
            className="rio-kanban-settings__panel"
            aria-label={t({ id: 'kanban.cards', message: 'Cards' })}
          >
            <Select
              label={t({ id: 'kanban.cover', message: 'Cover image' })}
              selectedKey={config.coverFieldId ?? 'none'}
              isDisabled={disabled}
              onSelectionChange={(key) => save({ coverFieldId: key === 'none' ? null : String(key) })}
            >
              <ListBoxItem id="none">{t({ id: 'kanban.cover.none', message: 'None' })}</ListBoxItem>
              {props.fields
                .filter((field) => field.type === 'attachment')
                .map((field) => (
                  <ListBoxItem key={field.id} id={field.id}>
                    {field.name}
                  </ListBoxItem>
                ))}
            </Select>
            <Select
              label={t({ id: 'kanban.coverFit', message: 'Fit' })}
              selectedKey={config.coverFit}
              isDisabled={disabled}
              onSelectionChange={(key) => {
                if (key === 'crop' || key === 'fit') save({ coverFit: key });
              }}
            >
              <ListBoxItem id="crop">
                {t({ id: 'kanban.coverFit.crop', message: 'Crop to fill' })}
              </ListBoxItem>
              <ListBoxItem id="fit">
                {t({ id: 'kanban.coverFit.fit', message: 'Show whole image' })}
              </ListBoxItem>
            </Select>
            <Checkbox
              isSelected={config.hideEmptyStacks}
              isDisabled={disabled}
              onChange={(hideEmptyStacks) => save({ hideEmptyStacks })}
            >
              {t({ id: 'kanban.hideEmpty', message: 'Hide empty stacks' })}
            </Checkbox>
          </Dialog>
        </Popover>
      </SettingsTrigger>
    </SettingsBar>
  );
}
