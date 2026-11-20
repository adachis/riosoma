import { useLingui } from '@lingui/react/macro';
import type { FieldSpec } from '@riosoma/contracts';
import { ListBoxItem, Select } from '@riosoma/ui';
import type { SchemaState } from '../../../data';
import { FilterEditor } from '../view/FilterEditor';
import { anchor } from '../../../demos/anchors';

export function LinkChoiceOptions({
  spec,
  schema,
  tableId,
  fieldId,
  onChange,
}: {
  spec: Extract<FieldSpec, { type: 'link' }>;
  schema?: SchemaState;
  tableId?: string;
  fieldId?: string;
  onChange(options: FieldSpec['options']): void;
}) {
  const { t } = useLingui();
  const { filter, limitToViewId, displayFieldIds = [], ...rest } = spec.options;
  const targetFields = (schema?.fields.get(spec.options.linkedTableId) ?? []).filter(
    (field) => field.id !== fieldId,
  );
  const mode = limitToViewId ? 'view' : filter ? 'filter' : 'all';
  const options = {
    ...rest,
    ...(filter ? { filter } : {}),
    ...(limitToViewId ? { limitToViewId } : {}),
    displayFieldIds,
  };
  return (
    <>
      {!spec.options.match && (
        <>
          <Select
            {...anchor('field.link.limit')}
            label={t({ id: 'field.link.limit', message: 'Limit choices' })}
            selectedKey={mode}
            onSelectionChange={(key) =>
              onChange({
                ...rest,
                displayFieldIds,
                ...(key === 'view'
                  ? { limitToViewId: schema?.views.get(spec.options.linkedTableId)?.[0]?.id }
                  : {}),
                ...(key === 'filter' ? { filter: { conjunction: 'and', conditions: [] } } : {}),
              })
            }
          >
            <ListBoxItem id="all">{t({ id: 'field.link.limit.all', message: 'All records' })}</ListBoxItem>
            <ListBoxItem id="view">
              {t({ id: 'field.link.limit.view', message: 'Records in a view' })}
            </ListBoxItem>
            <ListBoxItem id="filter">
              {t({ id: 'field.link.limit.filter', message: 'Records matching a filter' })}
            </ListBoxItem>
          </Select>
          {mode === 'view' && (
            <Select
              label={t({ id: 'field.link.view', message: 'Allowed view' })}
              selectedKey={limitToViewId ?? null}
              onSelectionChange={(key) => {
                if (key !== null) onChange({ ...rest, displayFieldIds, limitToViewId: String(key) });
              }}
            >
              {(schema?.views.get(spec.options.linkedTableId) ?? []).map((view) => (
                <ListBoxItem id={view.id} key={view.id}>
                  {view.name}
                </ListBoxItem>
              ))}
            </Select>
          )}
          {mode === 'filter' && (
            <FilterEditor
              fields={targetFields}
              collaborators={schema?.collaborators}
              currentFields={(schema?.fields.get(tableId ?? '') ?? []).filter(
                (field) => field.id !== fieldId,
              )}
              value={filter ?? null}
              onChange={(value) =>
                onChange({
                  ...rest,
                  displayFieldIds,
                  filter: value ?? { conjunction: 'and', conditions: [] },
                })
              }
            />
          )}
        </>
      )}
      {[0, 1, 2].map((index) => {
        const number = index + 1;
        return (
          <Select
            key={index}
            {...(index === 0 ? anchor('field.link.details') : {})}
            label={t({ id: 'field.link.detail', message: `Extra field ${number}` })}
            selectedKey={displayFieldIds[index] ?? 'none'}
            onSelectionChange={(key) => {
              if (key === null) return;
              const next = [...displayFieldIds];
              if (key === 'none') next.splice(index, 1);
              else next[index] = String(key);
              onChange({ ...options, displayFieldIds: next.filter(Boolean) });
            }}
          >
            <ListBoxItem id="none">{t({ id: 'field.link.detail.none', message: 'None' })}</ListBoxItem>
            {targetFields
              .filter(
                (field) =>
                  field.id !== schema?.tableById.get(spec.options.linkedTableId)?.primaryFieldId &&
                  !displayFieldIds.some((id, chosen) => id === field.id && chosen !== index),
              )
              .map((field) => (
                <ListBoxItem id={field.id} key={field.id}>
                  {field.name}
                </ListBoxItem>
              ))}
          </Select>
        );
      })}
    </>
  );
}
