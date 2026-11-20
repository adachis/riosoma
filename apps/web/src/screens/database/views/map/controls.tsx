import { SettingsTrigger } from '../../view/ToolbarSettings';
import { useState } from 'react';
import { faList, faLocationDot, faPlus } from '@fortawesome/free-solid-svg-icons';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { cellValue, newId, type FieldMeta, type RowData } from '@riosoma/contracts';
import { Button, Dialog as PanelDialog, DialogBody, DialogTitle, Modal, Popover } from '@riosoma/ui';
import { Dialog } from 'react-aria-components';
import type { CommandInput } from '../../../../data/types';
import { formatCell, type FormatContext } from '../../../../grid/format';
import { reportError } from '../../../../grid/view/actions';
import { ColorMark } from '../../colors/ColorMark';
import type { ViewColors } from '../../colors/paint';
import { FieldSelect } from '../timeline/controls';
import type { ViewComponentProps } from '../types';
import { placeOf, placeText } from './pins';

/** Records a list shows before offering more, so a long list opens at once. */
const LIST_PAGE = 100;

export interface RecordNames {
  primary: FieldMeta | undefined;
  format: FormatContext;
}

function useRecordName({ primary, format }: RecordNames) {
  const { t } = useLingui();
  const untitled = t({ id: 'views.map.untitled', message: 'Untitled record' });
  return (row: RowData) => (primary ? formatCell(primary, cellValue(row, primary), format) : '') || untitled;
}

/**
 * The accessible way through a map: every record in the view's order with its place, and the
 * color field's option when there is one.  A record a color rule colors has the rule's mark,
 * named for screen readers.  Each record opens, and each place can be shown on the map when
 * there's a map to show it on.
 */
export function PlacesTable({
  rows,
  location,
  color,
  names,
  colors,
  onOpen,
  onShow,
}: {
  rows: ReadonlyArray<RowData | undefined>;
  location: FieldMeta;
  color: FieldMeta | undefined;
  names: RecordNames;
  /** The view's conditional colors */
  colors?: ViewColors;
  onOpen(recordId: string): void;
  onShow?(recordId: string): void;
}) {
  const { t } = useLingui();
  const [limit, setLimit] = useState(LIST_PAGE);
  const name = useRecordName(names);
  const listed = rows.filter((row) => row !== undefined);
  const none = t({ id: 'views.map.list.none', message: 'No location' });
  return (
    <>
      <table
        className="rio-map-view-list"
        aria-label={t({ id: 'views.map.list.title', message: 'Records and places' })}
      >
        <thead>
          <tr>
            <th scope="col">{t({ id: 'views.map.list.record', message: 'Record' })}</th>
            <th scope="col">{location.name}</th>
            {color && <th scope="col">{color.name}</th>}
            {onShow && (
              <th scope="col">
                <span className="rio-map-view__sr-only">
                  {t({ id: 'views.map.list.actions', message: 'Map' })}
                </span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {listed.slice(0, limit).map((row) => {
            const place = placeOf(row, location);
            const title = name(row);
            return (
              <tr key={row.id}>
                <th scope="row">
                  <span className="rio-map-view-list__record">
                    <ColorMark record={colors?.record(row)} />
                    <Button variant="quiet" size="sm" onPress={() => onOpen(row.id)}>
                      {title}
                    </Button>
                  </span>
                </th>
                <td>{place ? placeText(place) : none}</td>
                {color && <td>{formatCell(color, cellValue(row, color), names.format)}</td>}
                {onShow && (
                  <td>
                    {place && (
                      <Button
                        variant="quiet"
                        size="sm"
                        aria-label={t({
                          id: 'views.map.list.show.label',
                          message: `Show on map: ${title}`,
                        })}
                        onPress={() => onShow(row.id)}
                      >
                        {t({ id: 'views.map.list.show', message: 'Show on map' })}
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {listed.length > limit && (
        <Button onPress={() => setLimit(limit + LIST_PAGE)}>
          {t({ id: 'views.map.list.more', message: 'Show more' })}
        </Button>
      )}
    </>
  );
}

/** The settings bar's List button, which opens the table of records and places. */
export function PlacesDialog(
  props: Omit<Parameters<typeof PlacesTable>[0], 'onOpen' | 'onShow'> & {
    onOpen(recordId: string): void;
    onShow(recordId: string): void;
  },
) {
  const { t } = useLingui();
  return (
    <SettingsTrigger label={t({ id: 'views.map.list.open', message: 'List records and places' })}>
      <Button
        size="sm"
        variant="quiet"
        icon={faList}
        aria-label={t({ id: 'views.map.list.open', message: 'List records and places' })}
      >
        <span className="rio-timeline-settings__label">{t({ id: 'views.map.list', message: 'List' })}</span>
      </Button>
      <Modal isDismissable size="lg">
        <PanelDialog>
          {({ close }) => (
            <>
              <DialogTitle>{t({ id: 'views.map.list.title', message: 'Records and places' })}</DialogTitle>
              <DialogBody>
                <PlacesTable
                  {...props}
                  onOpen={(recordId) => {
                    close();
                    props.onOpen(recordId);
                  }}
                  onShow={(recordId) => {
                    close();
                    props.onShow(recordId);
                  }}
                />
              </DialogBody>
            </>
          )}
        </PanelDialog>
      </Modal>
    </SettingsTrigger>
  );
}

/** Counts the records with no place, which have no pin, and lists them to open. */
export function NoLocationButton({
  rows,
  names,
  onOpen,
}: {
  rows: readonly RowData[];
  names: RecordNames;
  onOpen(recordId: string): void;
}) {
  const { t } = useLingui();
  const [limit, setLimit] = useState(LIST_PAGE);
  const name = useRecordName(names);
  if (!rows.length) return null;
  const count = rows.length;
  const heading = t({
    id: 'views.map.unplaced.heading',
    message: plural(count, { one: '# record has no location', other: '# records have no location' }),
  });
  return (
    <SettingsTrigger
      label={t({
        id: 'views.map.unplaced.button',
        message: plural(count, { one: 'No location, # record', other: 'No location, # records' }),
      })}
      icon={faLocationDot}
      shortLabel={t({ id: 'views.map.unplaced', message: 'No location' })}
      count={count}
      onOpenChange={(open) => {
        if (!open) setLimit(LIST_PAGE);
      }}
    >
      <Button
        size="sm"
        variant="quiet"
        aria-label={t({
          id: 'views.map.unplaced.button',
          message: plural(count, { one: 'No location, # record', other: 'No location, # records' }),
        })}
      >
        {t({ id: 'views.map.unplaced', message: 'No location' })}
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
                        onOpen(row.id);
                      }}
                    >
                      {name(row)}
                    </Button>
                  </li>
                ))}
              </ul>
              {count > limit && (
                <Button size="sm" onPress={() => setLimit(limit + LIST_PAGE)}>
                  {t({ id: 'views.map.unplaced.more', message: 'Show more' })}
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
 * Shown until a map has a location field to read: it says why, and offers the table's location
 * fields, or a new one when the table has none.
 */
export function LocationSetup({ view: props }: { view: ViewComponentProps }) {
  const { t } = useLingui();
  const locations = props.fields.filter((field) => field.type === 'location');
  const label = t({ id: 'views.map.location', message: 'Location' });

  function choose(id: string | null) {
    if (id) props.onConfig({ map: { ...props.view.config.map, locationFieldId: id } });
  }

  function add() {
    const taken = new Set(props.fields.map((field) => field.name.trim().toLowerCase()));
    let name = t({ id: 'views.map.newField', message: 'Location' });
    const base = name;
    for (let number = 2; taken.has(name.toLowerCase()); number++)
      name = t({ id: 'views.map.numberedName', message: `${base} ${number}` });
    const id = newId('field');
    const commands: CommandInput[] = [
      { kind: 'field.create', tableId: props.table.id, field: { id, name, type: 'location', options: {} } },
      {
        kind: 'view.update',
        viewId: props.view.id,
        config: { map: { ...props.view.config.map, locationFieldId: id } },
      },
    ];
    try {
      props.session.run(commands);
    } catch (error) {
      reportError(error);
    }
  }

  return (
    <div className="rio-timeline-setup">
      <h2>{t({ id: 'views.map.setup.title', message: 'This map needs a location field' })}</h2>
      <p>{t({ id: 'views.map.setup.help', message: 'Each record with a place in it becomes a pin.' })}</p>
      {locations.length ? (
        <FieldSelect
          label={label}
          fields={locations}
          selected={null}
          isDisabled={!props.canEdit}
          onChange={choose}
        />
      ) : props.canEdit && !(props.table.source || props.table.joined) ? (
        <>
          <p>{t({ id: 'views.map.setup.none', message: 'This table has no location fields yet.' })}</p>
          <Button
            variant="primary"
            onPress={add}
            aria-label={t({ id: 'views.map.setup.add', message: 'Add a location field' })}
            icon={faPlus}
          />
        </>
      ) : (
        <p>
          {t({
            id: 'views.map.setup.ask',
            message: 'This table has no location fields yet.  Someone who can change it can add one.',
          })}
        </p>
      )}
    </div>
  );
}
