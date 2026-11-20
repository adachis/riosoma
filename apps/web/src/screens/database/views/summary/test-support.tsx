import { useMemo, type ReactElement } from 'react';
import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { render } from '@testing-library/react';
import {
  FieldMeta,
  GridConfig,
  newId,
  roleAllows,
  type DatabaseRole,
  type TableMeta,
  type ViewMeta,
} from '@riosoma/contracts';
import { useSchema } from '../../../../data/hooks';
import { openDatabase } from '../../../../data/session';
import { FakeServer } from '../../../../data/testing';
import type { DatabaseSession, SchemaState } from '../../../../data/types';
import { useViewConfig } from '../../screen/useViewConfig';
import type { ViewComponentProps } from '../types';

export const OPEN = 'cho00000000000001';
export const DONE = 'cho00000000000002';

export interface SummaryIds {
  tableId: string;
  viewId: string;
  name: string;
  number: string;
  status: string;
  due: string;
}

/**
 * A table with Name, Number, Status, and Due fields and records numbered from zero, shown as a
 * chart or pivot view.  Records alternate between Open and Done, and each falls due a month after
 * the one before, from January 2026.
 */
export async function summaryFixture(
  type: 'chart' | 'pivot',
  options: {
    config?: (ids: SummaryIds) => Record<string, unknown>;
    count?: number;
    role?: DatabaseRole;
    /** Leaves out the Status and Due fields, for a table with nothing to group by */
    plain?: boolean;
  } = {},
) {
  const server = new FakeServer();
  const count = options.count ?? 4;
  const fixture = server.createDatabase(count);
  const database = server.database(fixture.databaseId);
  const base = database.field(fixture.textFieldId);
  const status = FieldMeta.parse({
    ...base,
    id: newId('field'),
    name: 'Status',
    position: 2,
    type: 'singleSelect',
    options: {
      choices: [
        { id: OPEN, name: 'Open', color: 'blue' },
        { id: DONE, name: 'Done', color: 'green' },
      ],
    },
  });
  const due = FieldMeta.parse({
    ...base,
    id: newId('field'),
    name: 'Due',
    position: 3,
    type: 'date',
    options: {},
  });
  if (!options.plain) {
    database.schema.fields.push(status, due);
    for (let index = 0; index < count; index++) {
      const row = database.rows(fixture.tableId).get(fixture.recordId(index))!;
      row.values[status.id] = index % 2 ? DONE : OPEN;
      row.values[due.id] = `${2026 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-15`;
      database.rows(fixture.tableId).set(row);
    }
  }
  database.schema.database.role = options.role ?? 'owner';
  const ids: SummaryIds = {
    tableId: fixture.tableId,
    viewId: fixture.viewId,
    name: fixture.textFieldId,
    number: fixture.numberFieldId,
    status: status.id,
    due: due.id,
  };
  const view = database.view(fixture.viewId);
  view.type = type;
  view.config = GridConfig.parse(options.config?.(ids) ?? {});
  const session = await openDatabase(fixture.databaseId, server.deps());
  const requests = () => server.requests.filter((request) => request.path.endsWith('/aggregate'));
  const commands = () =>
    server.requests
      .filter((request) => request.path.endsWith('/commands'))
      .flatMap((request) => (request.options.body as { commands: Array<Record<string, unknown>> }).commands);
  return { server, fixture, session, ids, requests, commands };
}

interface HarnessProps {
  session: DatabaseSession;
  viewId: string;
  View(props: ViewComponentProps): ReactElement;
  Settings(props: ViewComponentProps): ReactElement;
  onExpand?(recordId: string): void;
}

/**
 * A view and its settings bar as the database screen shows them: the latest schema, and settings
 * kept as a draft and saved through the session by the screen's own hook.
 */
export function Harness(props: HarnessProps) {
  const schema = useSchema(props.session);
  const view = schema?.viewById.get(props.viewId);
  const table = view ? schema?.tableById.get(view.tableId) : undefined;
  if (!schema || !view || !table) return null;
  return <Screen {...props} schema={schema} view={view} table={table} />;
}

function Screen({
  session,
  schema,
  view,
  table,
  View,
  Settings,
  onExpand = () => undefined,
}: HarnessProps & { schema: SchemaState; view: ViewMeta; table: TableMeta }) {
  const fields = schema.fields.get(table.id) ?? noFields;
  const { config, change } = useViewConfig(session, view, fields);
  const format = useMemo(
    () => ({ locale: 'en-US', timeZone: 'UTC', collaborators: schema.collaborators }),
    [schema.collaborators],
  );
  const props: ViewComponentProps = {
    session,
    table,
    view: { ...view, config },
    fields,
    format,
    canEdit: roleAllows(session.role(), 'editSchema'),
    onConfig: change,
    onExpand,
  };
  return (
    <>
      <div className="rio-database-controls">
        <Settings {...props} />
      </div>
      <View {...props} />
    </>
  );
}

const noFields: readonly FieldMeta[] = [];

export function mount(element: ReactElement) {
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  return render(element, { wrapper: ({ children }) => <I18nProvider i18n={i18n}>{children}</I18nProvider> });
}

export function closeAll(sessions: DatabaseSession[]): void {
  for (const session of sessions.splice(0)) session.close();
}
