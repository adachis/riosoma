import { useState, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { FieldMeta, PivotAggregate } from '@riosoma/contracts';
import { Button, Spinner } from '@riosoma/ui';
import { serverMessage } from '../../../../messages/useServerMessage';
import { allPresent, groupFields, pivotFieldIds, pivotRequest } from '../summary/fields';
import { RecordsPanel, type RecordsTarget } from '../summary/RecordsPanel';
import { useSavedConfig, useSummary, type SummaryStore } from '../summary/store';
import type { ViewComponentProps } from '../types';
import { PivotTable } from './PivotTable';
import { recordsCopy } from './messages';
import './pivot.css';

export function PivotView(props: ViewComponentProps) {
  return <Pivot key={props.view.id} {...props} />;
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="rio-pivot">
      <div className="rio-pivot__status">{children}</div>
    </div>
  );
}

function Pivot(props: ViewComponentProps) {
  const { t, i18n } = useLingui();
  const { session, view, fields, canEdit } = props;
  const settings = view.config.pivot;
  const present = allPresent(pivotFieldIds(view.config), fields);
  const saved = useSavedConfig(session, view);
  const { state, store, collapsed } = useSummary(session, view, pivotRequest(saved, fields));

  if (!settings.rows.length)
    return (
      <Notice>
        <h2 className="rio-pivot__heading">
          {t({ id: 'views.pivot.setup.title', message: 'Choose rows for this table' })}
        </h2>
        <p>
          {!canEdit
            ? t({ id: 'views.pivot.setup.reader', message: 'This pivot table isn’t set up yet.' })
            : groupFields(fields).length
              ? t({
                  id: 'views.pivot.setup.choose',
                  message:
                    'Pick a field in Rows above, such as a single select or a date, to sum up the records by it.',
                })
              : t({
                  id: 'views.pivot.setup.noFields',
                  message:
                    'A pivot table groups records by a field, such as a single select or a date.  Add one to this table to use it.',
                })}
        </p>
      </Notice>
    );
  if (!present)
    return (
      <Notice>
        <p>
          {canEdit
            ? t({
                id: 'views.pivot.fieldMissing.editor',
                message:
                  'A field this pivot table uses was deleted, or you can’t see it.  Choose another above.',
              })
            : t({
                id: 'views.pivot.fieldMissing',
                message: 'A field this pivot table uses was deleted, or you can’t see it.',
              })}
        </p>
      </Notice>
    );
  if (state.status === 'error')
    return (
      <Notice>
        <p role="alert">
          {state.messageKey === 'dashboards.tile.unavailable'
            ? t({
                id: 'views.pivot.error.unavailable',
                message: 'This pivot table uses a field that was deleted or that you can’t see.',
              })
            : state.messageKey === 'dashboards.tile.badAggregate'
              ? t({
                  id: 'views.pivot.error.badAggregate',
                  message: 'One of the values doesn’t fit its field.',
                })
              : serverMessage(i18n, state.messageKey, state.params)}
        </p>
        <Button size="sm" onPress={() => store.retry()}>
          {t({ id: 'views.pivot.retry', message: 'Try again' })}
        </Button>
      </Notice>
    );
  if (state.status !== 'ready' || state.data.kind !== 'pivot')
    return (
      <Notice>
        <Spinner size="sm" />
      </Notice>
    );
  return (
    <PivotBody
      {...props}
      data={state.data}
      refreshing={state.refreshing}
      version={state.version}
      collapsed={collapsed}
      store={store}
    />
  );
}

interface BodyProps extends ViewComponentProps {
  data: PivotAggregate;
  refreshing: boolean;
  version: number;
  collapsed: ReadonlySet<string>;
  store: SummaryStore;
}

function PivotBody(props: BodyProps) {
  const { i18n } = useLingui();
  const { view, data, fields, format, collapsed, store } = props;
  const settings = view.config.pivot;
  const [target, setTarget] = useState<RecordsTarget | null>(null);
  const shown = settings.values.flatMap((value) =>
    fields.filter((field: FieldMeta) => field.id === value.fieldId),
  );
  return (
    <div className="rio-pivot">
      <div className="rio-pivot__body">
        <PivotTable
          data={data}
          settings={settings}
          fields={fields}
          format={format}
          label={view.name}
          refreshing={props.refreshing}
          collapsed={collapsed}
          onCollapsedChange={(next) => store.setCollapsed(next)}
          onPick={setTarget}
        />
        {target ? (
          <RecordsPanel
            prefix="rio-pivot"
            session={props.session}
            table={props.table}
            viewId={view.id}
            fields={fields}
            shown={shown}
            format={format}
            target={target}
            version={props.version}
            copy={recordsCopy(i18n)}
            onOpen={props.onExpand}
            onClose={() => setTarget(null)}
          />
        ) : null}
      </div>
    </div>
  );
}
