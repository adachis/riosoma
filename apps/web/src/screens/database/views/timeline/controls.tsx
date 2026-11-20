import { SettingsPicker, SettingsTrigger } from '../../view/ToolbarSettings';
import { useMemo, useState, type ReactNode } from 'react';
import {
  faCalendarXmark,
  faList,
  faMagnifyingGlass,
  faSliders,
  faPlus,
} from '@fortawesome/free-solid-svg-icons';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { newId, TIMELINE_ZOOMS, type FieldMeta, type RowData, type TimelineZoom } from '@riosoma/contracts';
import {
  Button,
  Dialog as PanelDialog,
  DialogBody,
  DialogTitle,
  ListBoxItem,
  Modal,
  Popover,
  Select,
} from '@riosoma/ui';
import { Dialog } from 'react-aria-components';
import type { CommandInput } from '../../../../data/types';
import type { FormatContext } from '../../../../grid/format';
import { reportError } from '../../../../grid/view/actions';
import { isCalendarField } from '../calendar/dates';
import type { ViewComponentProps } from '../types';
import { recordDays, recordLabel, type DateFields } from './model';
import { dayDate } from './scale';

/** Records a list shows before offering more, so a long list opens at once. */
const LIST_PAGE = 100;

export function ZoomSelect({ zoom, onChange }: { zoom: TimelineZoom; onChange(zoom: TimelineZoom): void }) {
  const { t } = useLingui();
  const names: Record<TimelineZoom, string> = {
    day: t({ id: 'views.timeline.zoom.day', message: 'Day' }),
    week: t({ id: 'views.timeline.zoom.week', message: 'Week' }),
    month: t({ id: 'views.timeline.zoom.month', message: 'Month' }),
    quarter: t({ id: 'views.timeline.zoom.quarter', message: 'Quarter' }),
    year: t({ id: 'views.timeline.zoom.year', message: 'Year' }),
  };
  return (
    <SettingsPicker
      icon={faMagnifyingGlass}
      value={names[zoom]}
      label={t({ id: 'views.timeline.zoom', message: 'Zoom' })}
    >
      <Select
        className="rio-timeline-settings__zoom"
        size="sm"
        aria-label={t({ id: 'views.timeline.zoom', message: 'Zoom' })}
        selectedKey={zoom}
        onSelectionChange={(key) => {
          const next = TIMELINE_ZOOMS.find((item) => item === key);
          if (next) onChange(next);
        }}
      >
        {TIMELINE_ZOOMS.map((item) => (
          <ListBoxItem key={item} id={item}>
            {names[item]}
          </ListBoxItem>
        ))}
      </Select>
    </SettingsPicker>
  );
}

/** A field picker for the settings panel.  `none` adds a choice for no field at all. */
export function FieldSelect({
  label,
  fields,
  selected,
  none,
  isDisabled,
  onChange,
}: {
  label: string;
  fields: readonly FieldMeta[];
  selected: string | null;
  none?: string;
  isDisabled: boolean;
  onChange(id: string | null): void;
}) {
  const known = selected !== null && fields.some((field) => field.id === selected);
  return (
    <Select
      label={label}
      isDisabled={isDisabled}
      selectedKey={known ? selected : none !== undefined ? '' : null}
      onSelectionChange={(key) => {
        if (key === '' || key === null) onChange(null);
        else if (fields.some((field) => field.id === key)) onChange(String(key));
      }}
    >
      {[
        ...(none !== undefined
          ? [
              <ListBoxItem key="" id="">
                {none}
              </ListBoxItem>,
            ]
          : []),
        ...fields.map((field) => (
          <ListBoxItem key={field.id} id={field.id}>
            {field.name}
          </ListBoxItem>
        )),
      ]}
    </Select>
  );
}

/** The settings panel: one button in the toolbar row, with the field pickers in a popover. */
export function SettingsPanel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <SettingsTrigger label={label}>
      <Button size="sm" variant="quiet" icon={faSliders} aria-label={label}>
        <span className="rio-timeline-settings__label">{label}</span>
      </Button>
      <Popover placement="bottom end">
        <Dialog aria-label={label} className="rio-timeline-settings__panel">
          {children}
        </Dialog>
      </Popover>
    </SettingsTrigger>
  );
}

export interface ListColumn {
  id: string;
  name: string;
  text(row: RowData): string;
}

/**
 * The accessible alternative to the chart: every record with its dates in a table, in the view's
 * order, a page at a time.
 */
export function RecordsDialog({
  rows,
  dates,
  label,
  columns,
  format,
  onExpand,
}: {
  rows: ReadonlyArray<RowData | undefined>;
  dates: DateFields;
  label: FieldMeta | undefined;
  columns: ListColumn[];
  format: FormatContext;
  onExpand(recordId: string): void;
}) {
  const { t } = useLingui();
  const [limit, setLimit] = useState(LIST_PAGE);
  const dayFormat = useMemo(
    () => new Intl.DateTimeFormat(format.locale, { dateStyle: 'medium', timeZone: 'UTC' }),
    [format.locale],
  );
  const dayText = (day: number | null) => (day === null ? null : dayFormat.format(dayDate(day)));
  const listed = rows.filter((row) => row !== undefined);
  const none = t({ id: 'views.timeline.list.none', message: 'None' });
  const untitled = t({ id: 'views.timeline.untitled', message: 'Untitled record' });
  const title = t({ id: 'views.timeline.list.title', message: 'Records and dates' });
  return (
    <SettingsTrigger
      label={t({ id: 'views.timeline.list.open', message: 'List records and dates' })}
      onOpenChange={(open) => {
        if (!open) setLimit(LIST_PAGE);
      }}
    >
      <Button
        size="sm"
        variant="quiet"
        icon={faList}
        aria-label={t({ id: 'views.timeline.list.open', message: 'List records and dates' })}
      >
        <span className="rio-timeline-settings__label">
          {t({ id: 'views.timeline.list', message: 'List' })}
        </span>
      </Button>
      <Modal isDismissable size="lg">
        <PanelDialog>
          {({ close }) => (
            <>
              <DialogTitle>{title}</DialogTitle>
              <DialogBody>
                <table className="rio-timeline-list">
                  <thead>
                    <tr>
                      <th scope="col">{t({ id: 'views.timeline.list.record', message: 'Record' })}</th>
                      <th scope="col">{dates.start.name}</th>
                      {dates.end && <th scope="col">{dates.end.name}</th>}
                      {columns.map((column) => (
                        <th scope="col" key={column.id}>
                          {column.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {listed.slice(0, limit).map((row) => {
                      const days = recordDays(row, dates);
                      return (
                        <tr key={row.id}>
                          <th scope="row">
                            <Button
                              variant="quiet"
                              size="sm"
                              onPress={() => {
                                close();
                                onExpand(row.id);
                              }}
                            >
                              {recordLabel(row, label, format) || untitled}
                            </Button>
                          </th>
                          <td>{dayText(days.start) ?? none}</td>
                          {dates.end && <td>{dayText(days.end) ?? none}</td>}
                          {columns.map((column) => (
                            <td key={column.id}>{column.text(row)}</td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {listed.length > limit && (
                  <Button onPress={() => setLimit(limit + LIST_PAGE)}>
                    {t({ id: 'views.timeline.list.more', message: 'Show more' })}
                  </Button>
                )}
              </DialogBody>
            </>
          )}
        </PanelDialog>
      </Modal>
    </SettingsTrigger>
  );
}

/** Counts the records with no start date, which have no bar, and lists them to open. */
export function NoDateButton({
  rows,
  label,
  format,
  onExpand,
}: {
  rows: readonly RowData[];
  label: FieldMeta | undefined;
  format: FormatContext;
  onExpand(recordId: string): void;
}) {
  const { t } = useLingui();
  const [limit, setLimit] = useState(LIST_PAGE);
  if (!rows.length) return null;
  const count = rows.length;
  const untitled = t({ id: 'views.timeline.untitled', message: 'Untitled record' });
  const heading = t({
    id: 'views.timeline.undated.heading',
    message: plural(count, { one: '# record has no start date', other: '# records have no start date' }),
  });
  return (
    <SettingsTrigger
      label={t({
        id: 'views.timeline.undated.button',
        message: plural(count, { one: 'No date, # record', other: 'No date, # records' }),
      })}
      icon={faCalendarXmark}
      shortLabel={t({ id: 'views.timeline.undated', message: 'No date' })}
      count={count}
      onOpenChange={(open) => {
        if (!open) setLimit(LIST_PAGE);
      }}
    >
      <Button
        size="sm"
        variant="quiet"
        aria-label={t({
          id: 'views.timeline.undated.button',
          message: plural(count, { one: 'No date, # record', other: 'No date, # records' }),
        })}
      >
        {t({ id: 'views.timeline.undated', message: 'No date' })}
        <span className="rio-timeline-settings__count" aria-hidden="true">
          {count}
        </span>
      </Button>
      <Popover placement="bottom end">
        <Dialog aria-label={heading} className="rio-timeline-undated">
          {({ close }) => (
            <>
              <p className="rio-timeline-undated__heading">{heading}</p>
              <ul className="rio-timeline-undated__list">
                {rows.slice(0, limit).map((row) => (
                  <li key={row.id}>
                    <Button
                      variant="quiet"
                      size="sm"
                      onPress={() => {
                        close();
                        onExpand(row.id);
                      }}
                    >
                      {recordLabel(row, label, format) || untitled}
                    </Button>
                  </li>
                ))}
              </ul>
              {count > limit && (
                <Button size="sm" onPress={() => setLimit(limit + LIST_PAGE)}>
                  {t({ id: 'views.timeline.undated.more', message: 'Show more' })}
                </Button>
              )}
            </>
          )}
        </Dialog>
      </Popover>
    </SettingsTrigger>
  );
}

/**
 * Shown until a timeline or Gantt chart has a start date to read: it says why, and offers the
 * table's date fields, or a new one when the table has none.
 */
export function DateSetup({ kind, view: props }: { kind: 'timeline' | 'gantt'; view: ViewComponentProps }) {
  const { t } = useLingui();
  const dates = props.fields.filter(isCalendarField);
  const title =
    kind === 'timeline'
      ? t({ id: 'views.timeline.setup.title', message: 'This timeline needs a date field' })
      : t({ id: 'views.gantt.setup.title', message: 'This Gantt chart needs date fields' });
  const help =
    kind === 'timeline'
      ? t({
          id: 'views.timeline.setup.help',
          message: 'Each record becomes a bar from its start date to its end date.',
        })
      : t({
          id: 'views.gantt.setup.help',
          message: 'Each record becomes a bar from its start date to its end date, on its own row.',
        });
  const startLabel = t({ id: 'views.timeline.start', message: 'Start date' });

  function choose(id: string | null) {
    if (!id) return;
    if (kind === 'timeline')
      props.onConfig({ timeline: { ...props.view.config.timeline, startFieldId: id } });
    else props.onConfig({ gantt: { ...props.view.config.gantt, startFieldId: id } });
  }

  function add() {
    const taken = new Set(props.fields.map((field) => field.name.trim().toLowerCase()));
    const unique = (base: string) => {
      let name = base;
      for (let number = 2; taken.has(name.toLowerCase()); number++)
        name = t({ id: 'views.timeline.numberedName', message: `${base} ${number}` });
      taken.add(name.toLowerCase());
      return name;
    };
    const create = (id: string, name: string): CommandInput => ({
      kind: 'field.create',
      tableId: props.table.id,
      field: { id, name: unique(name), type: 'date', options: {} },
    });
    const start = newId('field');
    const commands: CommandInput[] = [];
    if (kind === 'timeline') {
      commands.push(create(start, t({ id: 'views.timeline.newField', message: 'Date' })));
      commands.push({
        kind: 'view.update',
        viewId: props.view.id,
        config: { timeline: { ...props.view.config.timeline, startFieldId: start } },
      });
    } else {
      const end = newId('field');
      commands.push(create(start, t({ id: 'views.gantt.newStart', message: 'Start date' })));
      commands.push(create(end, t({ id: 'views.gantt.newEnd', message: 'End date' })));
      commands.push({
        kind: 'view.update',
        viewId: props.view.id,
        config: { gantt: { ...props.view.config.gantt, startFieldId: start, endFieldId: end } },
      });
    }
    try {
      props.session.run(commands);
    } catch (error) {
      reportError(error);
    }
  }

  return (
    <div className="rio-timeline-setup" data-kind={kind}>
      <h2>{title}</h2>
      <p>{help}</p>
      {dates.length ? (
        <FieldSelect
          label={startLabel}
          fields={dates}
          selected={null}
          isDisabled={!props.canEdit}
          onChange={choose}
        />
      ) : props.canEdit && !(props.table.source || props.table.joined) ? (
        <>
          <p>{t({ id: 'views.timeline.setup.none', message: 'This table has no date fields yet.' })}</p>
          <Button
            variant="primary"
            onPress={add}
            aria-label={
              kind === 'timeline'
                ? t({ id: 'views.timeline.setup.add', message: 'Add a date field' })
                : t({ id: 'views.gantt.setup.add', message: 'Add start and end date fields' })
            }
            icon={faPlus}
          />
        </>
      ) : (
        <p>
          {t({
            id: 'views.timeline.setup.ask',
            message: 'This table has no date fields yet.  Someone who can change it can add one.',
          })}
        </p>
      )}
    </div>
  );
}
