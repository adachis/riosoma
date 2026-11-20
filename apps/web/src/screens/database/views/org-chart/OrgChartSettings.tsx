import { useLingui } from '@lingui/react/macro';
import { isParentField } from '@riosoma/contracts';
import { SettingsBar } from '../../view/ToolbarSettings';
import { FieldSelect, SettingsPanel } from '../timeline/controls';
import type { ViewComponentProps } from '../types';
import '../timeline/timeline.css';

export function OrgChartSettings({ view, fields, canEdit, onConfig }: ViewComponentProps) {
  const { t } = useLingui();
  return (
    <SettingsBar className="rio-timeline-settings">
      <SettingsPanel label={t({ id: 'views.orgChart.settings', message: 'Org chart settings' })}>
        <FieldSelect
          label={t({ id: 'views.orgChart.parent', message: 'Parent link field' })}
          fields={fields.filter(isParentField)}
          selected={view.config.orgChart.parentFieldId}
          none={t({ id: 'views.orgChart.none', message: 'None' })}
          isDisabled={!canEdit}
          onChange={(parentFieldId) => onConfig({ orgChart: { parentFieldId } })}
        />
      </SettingsPanel>
    </SettingsBar>
  );
}
