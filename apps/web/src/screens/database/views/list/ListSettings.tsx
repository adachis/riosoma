import { SettingsBar } from '../../view/ToolbarSettings';
import { useLingui } from '@lingui/react/macro';
import {
  LIST_FIELD_COUNT,
  isParentField,
  isTimelineGroupField,
  type ListSettings as Settings,
} from '@riosoma/contracts';
import { ListBoxItem, Select } from '@riosoma/ui';
import { FieldSelect, SettingsPanel } from '../timeline/controls';
import type { ViewComponentProps } from '../types';
import '../timeline/timeline.css';
import './list.css';

const COUNTS = Array.from(
  { length: LIST_FIELD_COUNT.max - LIST_FIELD_COUNT.min + 1 },
  (_, index) => LIST_FIELD_COUNT.min + index,
);

/**
 * The list's part of the settings bar: what it groups or nests by, and how many fields each line
 * shows.  Grouping and nesting take turns, so choosing one clears the other.
 */
export function ListSettings({ view, fields, format, canEdit, onConfig }: ViewComponentProps) {
  const { t } = useLingui();
  const settings = view.config.list;
  const save = (patch: Partial<Settings>) => onConfig({ list: { ...settings, ...patch } });
  const parents = fields.filter(isParentField);
  const none = t({ id: 'views.list.settings.none', message: 'None' });
  return (
    <SettingsBar className="rio-timeline-settings rio-list-view-settings">
      <SettingsPanel label={t({ id: 'views.list.settings', message: 'List settings' })}>
        <FieldSelect
          label={t({ id: 'views.list.settings.group', message: 'Group by' })}
          fields={fields.filter(isTimelineGroupField)}
          selected={settings.groupFieldId}
          none={none}
          isDisabled={!canEdit}
          onChange={(id) => save(id ? { groupFieldId: id, parentFieldId: null } : { groupFieldId: null })}
        />
        <FieldSelect
          label={t({ id: 'views.list.settings.parent', message: 'Nest by' })}
          fields={parents}
          selected={settings.parentFieldId}
          none={none}
          isDisabled={!canEdit}
          onChange={(id) => save(id ? { parentFieldId: id, groupFieldId: null } : { parentFieldId: null })}
        />
        {parents.length === 0 && (
          <p className="rio-list-view-settings__hint">
            {t({
              id: 'views.list.settings.parentHint',
              message: 'To nest records under others, add a field that links to this table.',
            })}
          </p>
        )}
        <Select
          label={t({ id: 'views.list.settings.fields', message: 'Fields on each line' })}
          isDisabled={!canEdit}
          selectedKey={String(settings.visibleFieldCount)}
          onSelectionChange={(key) => {
            const count = COUNTS.find((item) => String(item) === key);
            if (count !== undefined) save({ visibleFieldCount: count });
          }}
        >
          {COUNTS.map((count) => (
            <ListBoxItem key={count} id={String(count)}>
              {count === 0
                ? t({ id: 'views.list.settings.fields.none', message: 'None' })
                : new Intl.NumberFormat(format.locale).format(count)}
            </ListBoxItem>
          ))}
        </Select>
      </SettingsPanel>
    </SettingsBar>
  );
}
