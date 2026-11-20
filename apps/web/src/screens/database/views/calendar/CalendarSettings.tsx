import { SettingsTrigger } from '../../view/ToolbarSettings';
import { faCalendarDays } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { Button, Popover, Select, ListBoxItem } from '@riosoma/ui';
import { Dialog } from 'react-aria-components';
import type { ViewComponentProps } from '../types';
import { isCalendarField } from './dates';
import { DateFormulaNote } from './DateFormulaNote';

export function StartFieldPicker({ fields, view, canEdit, onConfig }: ViewComponentProps) {
  const { t } = useLingui();
  return (
    <>
      {fields.filter(isCalendarField).length > 10 ? (
        <Select
          className="rio-calendar-view__setting"
          label={t({ id: 'calendar.start', message: 'Start date' })}
          isDisabled={!canEdit}
          selectedKey={view.config.calendar.startFieldId ?? ''}
          onSelectionChange={(key) =>
            onConfig({ calendar: { ...view.config.calendar, startFieldId: String(key) || null } })
          }
        >
          <ListBoxItem id="">
            {t({ id: 'calendar.chooseField', message: 'Choose a date field for this calendar' })}
          </ListBoxItem>
          {fields.filter(isCalendarField).map((field) => (
            <ListBoxItem key={field.id} id={field.id}>
              {field.name}
            </ListBoxItem>
          ))}
        </Select>
      ) : (
        <label className="rio-calendar-view__setting">
          {t({ id: 'calendar.start', message: 'Start date' })}
          <select
            disabled={!canEdit}
            value={view.config.calendar.startFieldId ?? ''}
            onChange={(event) =>
              onConfig({ calendar: { ...view.config.calendar, startFieldId: event.target.value || null } })
            }
          >
            <option value="">
              {t({ id: 'calendar.chooseField', message: 'Choose a date field for this calendar' })}
            </option>
            {fields.filter(isCalendarField).map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <DateFormulaNote fields={fields} />
    </>
  );
}

export function CalendarSettings(props: ViewComponentProps) {
  const { t } = useLingui();
  const { view, fields, canEdit, onConfig } = props;
  const config = view.config.calendar;
  const label = t({ id: 'calendar.settings', message: 'Calendar settings' });
  // In a popover: the toolbar row has room for one button, not three labeled menus.
  return (
    <SettingsTrigger label={label}>
      <Button variant="quiet" icon={faCalendarDays} aria-label={label}>
        <span className="rio-calendar-view__settings-label">{label}</span>
      </Button>
      <Popover placement="bottom end">
        <Dialog aria-label={label} className="rio-calendar-view__settings">
          <StartFieldPicker {...props} />

          {fields.filter(isCalendarField).length > 10 ? (
            <Select
              className="rio-calendar-view__setting"
              label={t({ id: 'calendar.end', message: 'End date' })}
              isDisabled={!canEdit}
              selectedKey={config.endFieldId ?? ''}
              onSelectionChange={(key) =>
                onConfig({ calendar: { ...config, endFieldId: String(key) || null } })
              }
            >
              <ListBoxItem id="">{t({ id: 'calendar.end.none', message: 'None' })}</ListBoxItem>
              {fields.filter(isCalendarField).map((field) => (
                <ListBoxItem key={field.id} id={field.id}>
                  {field.name}
                </ListBoxItem>
              ))}
            </Select>
          ) : (
            <label className="rio-calendar-view__setting">
              {t({ id: 'calendar.end', message: 'End date' })}
              <select
                disabled={!canEdit}
                value={config.endFieldId ?? ''}
                onChange={(event) =>
                  onConfig({ calendar: { ...config, endFieldId: event.target.value || null } })
                }
              >
                <option value="">{t({ id: 'calendar.end.none', message: 'None' })}</option>
                {fields.filter(isCalendarField).map((field) => (
                  <option key={field.id} value={field.id}>
                    {field.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="rio-calendar-view__setting">
            <span className="rio-calendar-view__sr-only">
              {t({ id: 'calendar.range', message: 'Calendar range' })}
            </span>
            <select
              disabled={!canEdit}
              value={config.range}
              onChange={(event) =>
                onConfig({
                  calendar: {
                    ...config,
                    range: event.target.value === 'week' ? 'week' : 'month',
                  },
                })
              }
            >
              <option value="month">{t({ id: 'calendar.month', message: 'Month' })}</option>
              <option value="week">{t({ id: 'calendar.week', message: 'Week' })}</option>
            </select>
          </label>
        </Dialog>
      </Popover>
    </SettingsTrigger>
  );
}
