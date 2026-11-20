import { useState } from 'react';
import { Icon } from '@riosoma/icons';
import { faLock } from '@fortawesome/free-solid-svg-icons';
import { Focusable } from 'react-aria-components';
import { useLingui } from '@lingui/react/macro';
import { GridConfig, visibleFieldIds } from '@riosoma/contracts';
import type { FieldMeta } from '@riosoma/contracts';
import {
  Button,
  SearchField,
  Switch,
  Tooltip,
  TooltipTrigger,
  SortableList,
  SortableItem,
  SortableDropZone,
  moveList,
} from '@riosoma/ui';
import './view.css';

export interface HideFieldsEditorProps {
  fields: readonly FieldMeta[];
  primaryFieldId: string;
  fieldOrder: string[];
  hiddenFieldIds: string[];
  onChange: (value: { fieldOrder: string[]; hiddenFieldIds: string[] }) => void;
  readOnly?: boolean;
  readOnlyReason?: string;
}

export function HideFieldsEditor({
  fields,
  primaryFieldId,
  fieldOrder,
  hiddenFieldIds,
  onChange,
  readOnly = false,
  readOnlyReason,
}: HideFieldsEditorProps) {
  const { t, i18n } = useLingui();
  const [search, setSearch] = useState('');
  const order = [
    ...new Set(visibleFieldIds(GridConfig.parse({ fieldOrder, hiddenFieldIds: [] }), fields, primaryFieldId)),
  ];
  const byId = new Map(fields.map((field) => [field.id, field]));
  const displayed = order.filter((id) =>
    byId.get(id)!.name.toLocaleLowerCase(i18n.locale).includes(search.toLocaleLowerCase(i18n.locale)),
  );
  const hidden = hiddenFieldIds.filter((id) => id !== primaryFieldId);
  function change(fieldOrder: string[], hiddenFieldIds: string[]) {
    if (!readOnly) onChange({ fieldOrder, hiddenFieldIds });
  }
  function reorder(id: string, target: string | undefined) {
    if (!target || id === primaryFieldId || target === primaryFieldId || id === target) return;
    change([...moveList(order, order.indexOf(id), order.indexOf(target))], hidden);
  }
  return (
    <div className="rio-view-editor">
      <SearchField
        aria-label={t({ id: 'view.hide.find', message: 'Find a field' })}
        placeholder={t({ id: 'view.hide.find', message: 'Find a field' })}
        value={search}
        onChange={setSearch}
      />
      <div className="rio-view-actions">
        <Button isDisabled={readOnly} onPress={() => change(order, [])}>
          {t({ id: 'view.hide.showAll', message: 'Show all' })}
        </Button>
        <Button
          isDisabled={readOnly}
          onPress={() =>
            change(
              order,
              order.filter((id) => id !== primaryFieldId),
            )
          }
        >
          {t({ id: 'view.hide.hideAll', message: 'Hide all' })}
        </Button>
      </div>
      <SortableList
        items={displayed.map((id) => ({
          id,
          name: byId.get(id)!.name,
          disabledReason:
            id === primaryFieldId
              ? t({ id: 'view.hide.primaryPosition', message: 'The primary field stays first.' })
              : undefined,
        }))}
        onMove={(from, to) => reorder(displayed[from]!, displayed[to])}
        disabledReason={
          readOnly
            ? (readOnlyReason ??
              t({ id: 'sortable.readOnly', message: 'You don’t have permission to rearrange these items.' }))
            : undefined
        }
      >
        {displayed.map((id) => {
          const field = byId.get(id)!;
          const primary = id === primaryFieldId;
          const name = field.name;
          return (
            <SortableItem id={id} key={id} className="rio-view-row">
              <>
                {primary ? (
                  <>
                    <Switch isSelected isDisabled>
                      {name}
                    </Switch>
                    <TooltipTrigger>
                      <Focusable>
                        <span
                          tabIndex={0}
                          role="img"
                          aria-label={t({ id: 'view.hide.primary', message: 'Always shown' })}
                        >
                          <Icon icon={faLock} />
                        </span>
                      </Focusable>
                      <Tooltip>{t({ id: 'view.hide.primary', message: 'Always shown' })}</Tooltip>
                    </TooltipTrigger>
                  </>
                ) : (
                  <Switch
                    isSelected={!hidden.includes(id)}
                    isDisabled={readOnly}
                    onChange={(shown) =>
                      change(
                        order,
                        shown ? hidden.filter((key) => key !== id) : [...new Set([...hidden, id])],
                      )
                    }
                  >
                    {name}
                  </Switch>
                )}
              </>
            </SortableItem>
          );
        })}
        <SortableDropZone />
      </SortableList>
    </div>
  );
}
