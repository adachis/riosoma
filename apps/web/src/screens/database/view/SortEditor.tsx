import { useLingui } from '@lingui/react/macro';
import { LIMITS } from '@riosoma/contracts';
import type { FieldMeta, GridGroup } from '@riosoma/contracts';
import {
  Button,
  SegmentedControl,
  SortableList,
  SortableItem,
  SortableDropZone,
  moveList,
} from '@riosoma/ui';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { resultField } from '../../../data/formulas';
import { AddFieldButton } from './AddFieldButton';
import { FieldSelect } from './FieldSelect';
import { directionFamily, directionLabels } from './messages';
import { anchor } from '../../../demos/anchors';
import './view.css';

export interface SortEditorProps {
  fields: readonly FieldMeta[];
  value: GridGroup[];
  onChange: (value: GridGroup[]) => void;
  readOnly?: boolean;
  readOnlyReason?: string;
  grouping?: boolean;
}

export function SortEditor({
  fields,
  value,
  onChange,
  readOnly = false,
  readOnlyReason,
  grouping = false,
}: SortEditorProps) {
  const { t, i18n } = useLingui();
  const limit = grouping ? 3 : LIMITS.sortsPerView;
  const used = new Set(value.map((sort) => sort.fieldId));
  // A button holds nothing to sort by.
  const unsortable = new Set(
    fields
      .filter(
        (field) =>
          (!grouping && field.type === 'formula' && !field.options.sortable) ||
          field.type === 'button' ||
          field.type === 'changeLog',
      )
      .map((field) => field.id),
  );
  const available = fields.filter((field) => !used.has(field.id) && !unsortable.has(field.id));
  function change(next: GridGroup[]) {
    if (!readOnly) onChange(next);
  }
  function reorder(from: number, to: number) {
    if (from !== to && from >= 0 && to >= 0 && to < value.length) change([...moveList(value, from, to)]);
  }
  return (
    <div className="rio-view-editor">
      {value.length === 0 && (
        <p>
          {grouping
            ? t({ id: 'view.group.none', message: 'No groups' })
            : t({ id: 'view.sort.none', message: 'No sorts' })}
        </p>
      )}
      <SortableList
        items={value.map((sort) => ({
          id: sort.fieldId,
          name:
            fields.find((field) => field.id === sort.fieldId)?.name ??
            t({ id: 'view.sort.move', message: 'Move sort' }),
          handleLabel: grouping
            ? t({ id: 'view.group.move', message: 'Move group' })
            : t({ id: 'view.sort.move', message: 'Move sort' }),
        }))}
        onMove={reorder}
        disabledReason={
          readOnly
            ? (readOnlyReason ??
              t({ id: 'sortable.readOnly', message: 'You don’t have permission to rearrange these items.' }))
            : undefined
        }
      >
        {value.map((sort, index) => {
          const field = fields.find((field) => field.id === sort.fieldId);
          const labels = directionLabels[directionFamily(field)];
          return (
            <SortableItem
              id={sort.fieldId}
              key={sort.fieldId}
              className={grouping ? 'rio-view-row rio-view-group-row' : 'rio-view-row'}
            >
              <>
                <span className="rio-view-lead">
                  {index === 0
                    ? grouping
                      ? t({ id: 'view.group.by', message: 'Group by' })
                      : t({ id: 'view.sort.by', message: 'Sort by' })
                    : t({ id: 'view.sort.thenBy', message: 'then by' })}
                </span>
                <FieldSelect
                  fields={fields.filter((field) => field.id === sort.fieldId || !used.has(field.id))}
                  disabledKeys={unsortable}
                  value={sort.fieldId}
                  readOnly={readOnly}
                  onChange={(fieldId) =>
                    change(
                      value.map((item, i) => (i === index ? { fieldId, direction: item.direction } : item)),
                    )
                  }
                />
                <SegmentedControl
                  className="rio-view-segments"
                  label={t({ id: 'view.sort.direction', message: 'Direction' })}
                  isDisabled={readOnly || unsortable.has(sort.fieldId)}
                  selectedId={sort.direction}
                  items={[
                    { id: 'asc', label: i18n._(labels[0]) },
                    { id: 'desc', label: i18n._(labels[1]) },
                  ]}
                  onChange={(direction) => {
                    if (direction === 'asc' || direction === 'desc')
                      change(value.map((item, i) => (i === index ? { ...item, direction } : item)));
                  }}
                />
                {grouping &&
                field &&
                ['date', 'createdTime', 'lastModifiedTime'].includes(resultField(field).type) ? (
                  <SegmentedControl
                    label={t({ id: 'view.group.granularity', message: 'Date granularity' })}
                    isDisabled={readOnly}
                    selectedId={sort.dateGranularity ?? 'day'}
                    items={[
                      { id: 'day', label: t({ id: 'view.group.day', message: 'Day' }) },
                      { id: 'week', label: t({ id: 'view.group.week', message: 'Week' }) },
                      { id: 'month', label: t({ id: 'view.group.month', message: 'Month' }) },
                      { id: 'year', label: t({ id: 'view.group.year', message: 'Year' }) },
                    ]}
                    onChange={(dateGranularity) => {
                      if (
                        dateGranularity === 'day' ||
                        dateGranularity === 'week' ||
                        dateGranularity === 'month' ||
                        dateGranularity === 'year'
                      )
                        change(value.map((item, i) => (i === index ? { ...item, dateGranularity } : item)));
                    }}
                  />
                ) : null}
                <Button
                  icon={faXmark}
                  variant="quiet"
                  isDisabled={readOnly}
                  aria-label={
                    grouping
                      ? t({ id: 'view.group.remove', message: 'Remove group' })
                      : t({ id: 'view.sort.remove', message: 'Remove sort' })
                  }
                  onPress={() => change(value.filter((_, i) => i !== index))}
                />
              </>
            </SortableItem>
          );
        })}
        <SortableDropZone />
      </SortableList>
      <AddFieldButton
        fields={available}
        anchorProps={grouping ? anchor('view.group.add') : anchor('view.sort.add')}
        isDisabled={readOnly || value.length >= limit}
        onPick={(field) => {
          if (value.length < limit) change([...value, { fieldId: field.id, direction: 'asc' }]);
        }}
        label={
          grouping
            ? t({ id: 'view.group.add', message: 'Add group' })
            : t({ id: 'view.sort.add', message: 'Add sort' })
        }
      />
    </div>
  );
}
