import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { SettingsTrigger } from '../../view/ToolbarSettings';
import { faFilter } from '@fortawesome/free-solid-svg-icons';
import { Dialog } from 'react-aria-components';
import { Button, Popover } from '@riosoma/ui';
import { useSchema } from '../../../../data/hooks';
import { FilterEditor } from '../../view/FilterEditor';
import { conditionsOf } from '../../view/filterValues';
import { namedFields, useRestrictedFields } from '../../permissions/restricted';
import type { ViewComponentProps } from '../types';

/**
 * The view's filter, for views that show no toolbar: a chart or pivot reads only the records it
 * lets through.  Sorting and hiding fields change nothing in them, so they have no controls here.
 */
export function FilterControl({
  props,
  label,
}: {
  props: ViewComponentProps;
  /** The button's words: how many fields filter the view, and the one field's name when there's one */
  label(count: number, name: string | undefined): string;
}) {
  const { t } = useLingui();
  const { session, view, fields, table, canEdit, onConfig } = props;
  const schema = useSchema(session);
  const ids = namedFields(
    conditionsOf(view.config.filter).map((condition) => condition.fieldId),
    fields,
    useRestrictedFields(),
  );
  const filterCount = ids.length;
  const text = label(
    ids.length,
    ids.length === 1 ? fields.find((field) => field.id === ids[0])?.name : undefined,
  );
  return (
    <SettingsTrigger
      helpTopic={{ id: 'views', section: 'filter', anchorId: 'view.filter' }}
      label={text}
      priority={100}
      count={ids.length}
      shortLabel={
        ids.length
          ? t({
              id: 'view.toolbar.filtersShort',
              message: plural(filterCount, { one: '# filter', other: '# filters' }),
            })
          : undefined
      }
    >
      <Button variant="quiet" icon={faFilter} data-active={ids.length > 0 || undefined}>
        {text}
      </Button>
      <Popover placement="bottom start" className="rio-view-popover">
        <Dialog aria-label={text} className="rio-view-dialog">
          <FilterEditor
            session={session}
            fields={fields}
            primaryFieldId={table.primaryFieldId}
            collaborators={schema?.collaborators}
            value={view.config.filter}
            readOnly={!canEdit}
            onChange={(filter) => {
              if (canEdit) onConfig({ filter });
            }}
          />
        </Dialog>
      </Popover>
    </SettingsTrigger>
  );
}
