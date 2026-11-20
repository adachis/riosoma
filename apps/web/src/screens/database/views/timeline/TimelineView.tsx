import { personLabel } from '../../../../data/people';
import { useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';
import { isTimelineGroupField, type ChoiceColor, type FieldMeta } from '@riosoma/contracts';
import { Avatar, ChoicePill } from '@riosoma/ui';
import type { ViewComponentProps } from '../types';
import { useZoom } from './channel';
import { DateSetup } from './controls';
import { ALL_LANE, EMPTY_LANE, timelineLayout, type Bar } from './layout';
import { dateField, dateFields, labelField } from './model';
import { useViewRecords } from './records';
import { LINE_HEIGHT, TimeChart } from './TimeChart';

/** The width of the lane names beside a grouped timeline, in CSS pixels. */
const LANE_WIDTH = 200;

interface LaneInfo {
  name: string;
  color?: ChoiceColor;
  person?: boolean;
}

export function TimelineView(props: ViewComponentProps) {
  const start = dateField(props.fields, props.view.config.timeline.startFieldId);
  if (!start) return <DateSetup kind="timeline" view={props} />;
  return <Timeline key={`${props.view.id}:${start.id}`} {...props} start={start} />;
}

function Timeline(props: ViewComponentProps & { start: FieldMeta }) {
  const { t } = useLingui();
  const { session, view, fields, table, format, canEdit } = props;
  const settings = view.config.timeline;
  const [zoom] = useZoom(view.id, settings.zoom, canEdit);
  const records = useViewRecords(session, view.id);
  const end = dateField(fields, settings.endFieldId);
  const dates = useMemo(() => dateFields(props.start, end, format), [props.start, end, format]);
  const group = fields.find((field) => field.id === settings.groupFieldId && isTimelineGroupField(field));
  const label = labelField(fields, settings.labelFieldId, table.primaryFieldId);
  const untitled = t({ id: 'views.timeline.untitled', message: 'Untitled record' });
  const emptyLane = t({ id: 'views.timeline.lane.empty', message: 'Empty' });
  const unknownPerson = t({ id: 'views.timeline.lane.unknownPerson', message: 'Unknown person' });

  const lane = useMemo(() => {
    return (key: string): LaneInfo => {
      if (key === ALL_LANE || !group) return { name: '' };
      if (key === EMPTY_LANE) return { name: emptyLane };
      if (group.type === 'singleSelect') {
        const choice = group.options.choices.find((item) => item.id === key);
        return { name: choice?.name ?? emptyLane, color: choice?.color };
      }
      if (group.type === 'user')
        return { name: personLabel(format.collaborators.get(key), unknownPerson), person: true };
      return { name: format.linked?.get(key) || untitled };
    };
  }, [group, format, emptyLane, unknownPerson, untitled]);

  const layout = useMemo(() => {
    const collator = new Intl.Collator(format.locale, { numeric: true, sensitivity: 'base' });
    // Options keep the field's order, everything else goes by name, and Empty comes last.
    const sortLanes = (keys: string[]) => {
      const rank =
        group?.type === 'singleSelect'
          ? new Map(group.options.choices.map((choice, index) => [choice.id, index]))
          : null;
      return [...keys].sort((a, b) => {
        if (a === EMPTY_LANE || b === EMPTY_LANE) return a === EMPTY_LANE ? (b === EMPTY_LANE ? 0 : 1) : -1;
        if (rank) return (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
        return collator.compare(lane(a).name, lane(b).name) || (a < b ? -1 : a > b ? 1 : 0);
      });
    };
    return timelineLayout(records.rows, dates, group, zoom, sortLanes);
  }, [records.rows, dates, group, zoom, lane, format.locale]);

  const describe = (bar: Bar, labelText: string, when: string, fields: string) => {
    // The bar shows its label and field values together, so the name starts with those words.
    const text = fields ? `${labelText} ${fields}` : labelText;
    if (!group) return t({ id: 'views.timeline.bar', message: `${text}, ${when}` });
    const name = lane(layout.lanes[bar.lane]?.key ?? EMPTY_LANE).name;
    return t({ id: 'views.timeline.bar.lane', message: `${text}, ${when}, ${name}` });
  };

  const side = group
    ? {
        width: LANE_WIDTH,
        corner: <span className="rio-timeline__corner">{group.name}</span>,
        render: (fromLine: number, toLine: number) =>
          layout.lanes
            .filter((item) => item.first < toLine && item.first + item.lines > fromLine)
            .map((item) => {
              const info = lane(item.key);
              return (
                <div
                  key={item.key}
                  className="rio-timeline__lane"
                  style={{ insetBlockStart: item.first * LINE_HEIGHT, blockSize: item.lines * LINE_HEIGHT }}
                >
                  <div className="rio-timeline__lane-name">
                    {info.color ? (
                      <ChoicePill name={info.name} color={info.color} size="sm" />
                    ) : info.person ? (
                      <>
                        <Avatar
                          personId={item.key}
                          name={info.name}
                          color="blue"
                          size="sm"
                          aria-hidden="true"
                        />
                        <span className="rio-timeline__lane-text">{info.name}</span>
                      </>
                    ) : (
                      <span className="rio-timeline__lane-text">{info.name}</span>
                    )}
                    <span className="rio-timeline__lane-count">{item.count}</span>
                  </div>
                </div>
              );
            }),
      }
    : null;

  return (
    <TimeChart
      view={props}
      dates={dates}
      label={label}
      zoom={zoom}
      layout={layout}
      lineCount={layout.lines.length}
      side={side}
      describe={describe}
      overlay={(area) =>
        layout.lanes
          .filter((item) => item.first > 0 && item.first >= area.fromLine && item.first < area.toLine)
          .map((item) => (
            <div
              key={item.key}
              className="rio-timeline__lane-rule"
              aria-hidden="true"
              style={{ insetBlockStart: item.first * LINE_HEIGHT }}
            />
          ))
      }
      empty={
        records.loading
          ? null
          : records.count === 0
            ? t({ id: 'views.timeline.empty', message: 'No records in this view' })
            : layout.order.length === 0
              ? t({
                  id: 'views.timeline.noDates',
                  message: 'No records have a start date yet.  Records without one are under No date.',
                })
              : null
      }
      loading={records.loading}
      limited={records.limited}
    />
  );
}
