import { faXmark, faDownload } from '@fortawesome/free-solid-svg-icons';
import { Select, ListBoxItem } from '@riosoma/ui';
import { useEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Button as AriaButton } from 'react-aria-components';
import { useQuery } from '@tanstack/react-query';
import {
  DATABASE_ROLES,
  type Collaborator,
  type SqlAccess,
  type SqlHistory,
  type SqlLogin,
  type SqlResult,
  type SqlSetupIssue,
  type SqlSettings,
} from '@riosoma/contracts';
import { Button, Dialog, DialogBody, DialogTitle, Modal } from '@riosoma/ui';
import { api, apiFile, ApiError } from '../../../api';
import { useServerMessage } from '../../../messages/useServerMessage';
import { ScriptField } from '../automations/ScriptField';
import { useLevel } from '../../../levels/context';
import { useFeatureCommands } from '../../../levels/palette';
import { isDemoSession } from '../../../demo';
import './sql.css';

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const shown = (value: unknown): string =>
  value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);

export function SqlLauncher({ databaseId, people }: { databaseId: string; people: readonly Collaborator[] }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const { offers, tidies } = useLevel();
  const access = useQuery({
    queryKey: ['sql', databaseId],
    queryFn: async () => (isDemoSession() ? null : api<SqlAccess>(`/api/databases/${databaseId}/sql`)),
  });
  const available = Boolean(access.data && (access.data.allowed || access.data.admin));
  const title = t({ id: 'sql.title', message: 'SQL' });
  // SQL is Advanced.  Below it, someone who has run queries here, or an admin whose database has
  // its read-only login on, keeps the way in.  The palette always has it.
  const looking = available && tidies('sql');
  const base = `/api/databases/${databaseId}/sql`;
  const history = useQuery({
    queryKey: ['sql-history', databaseId, 0],
    queryFn: () => api<SqlHistory[]>(`${base}/history`),
    enabled: looking && Boolean(access.data?.allowed),
  });
  const login = useQuery({
    queryKey: ['sql-login', base],
    queryFn: () => api<SqlLogin>(`${base}/login`),
    enabled: looking && Boolean(access.data?.admin),
  });
  useFeatureCommands(
    'database.sql',
    available ? [{ place: 'databaseSidebar:sql', run: () => setOpen(true) }] : [],
  );
  if (!access.data || !available) return null;
  const held = { sqlQueries: history.data?.length ?? 0, sqlLogin: Boolean(login.data?.enabled) };
  return (
    <>
      {offers('databaseSidebar', 'sql', held) ? (
        <AriaButton className="rio-shell__nav-item rio-shell__nav-button" onPress={() => setOpen(true)}>
          {title}
        </AriaButton>
      ) : null}
      {open && (
        <Modal isOpen size="lg" onOpenChange={(value) => setOpen(value)}>
          <Dialog>
            <DialogTitle>{t({ id: 'sql.title', message: 'SQL' })}</DialogTitle>
            <DialogBody>
              <SqlScreen
                databaseId={databaseId}
                access={access.data}
                people={people}
                refresh={() => {
                  void access.refetch();
                }}
              />
              <Button
                onPress={() => setOpen(false)}
                aria-label={t({ id: 'sql.close', message: 'Close' })}
                icon={faXmark}
              />
            </DialogBody>
          </Dialog>
        </Modal>
      )}
    </>
  );
}

export function SqlScreen({
  databaseId,
  access,
  people,
  refresh,
}: {
  databaseId: string;
  access: SqlAccess;
  people: readonly Collaborator[];
  refresh(): void;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const base = `/api/databases/${databaseId}/sql`;
  const [source, setSource] = useState('');
  const [running, setRunning] = useState<string | null>(null);
  const runId = useRef<string | null>(null);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [paging, setPaging] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const history = useQuery({
    queryKey: ['sql-history', databaseId, historyVersion],
    queryFn: () => api<SqlHistory[]>(`${base}/history`),
    enabled: access.allowed,
  });
  const fail = (reason: unknown) =>
    setError(
      reason instanceof ApiError
        ? message(reason.info.messageKey, reason.info.params)
        : t({ id: 'sql.client.failed', message: 'The request failed.  Try again.' }),
    );
  useEffect(
    () => () => {
      if (runId.current)
        void api(`${base}/runs/${runId.current}/cancel`, { body: {} }).catch(() => undefined);
    },
    [base],
  );
  const run = async () => {
    const id = crypto.randomUUID();
    runId.current = id;
    setRunning(id);
    setError(null);
    setResult(null);
    try {
      const next = await api<SqlResult>(`${base}/run`, { body: { id, query: source } });
      setResult(next);
      setOffset(0);
    } catch (reason) {
      fail(reason);
    } finally {
      runId.current = null;
      setRunning(null);
      setHistoryVersion((value) => value + 1);
    }
  };
  const page = async (next: number) => {
    if (!result) return;
    setPaging(true);
    try {
      setResult(await api<SqlResult>(`${base}/runs/${result.id}?offset=${next}`));
      setOffset(next);
    } catch (reason) {
      setResult(null);
      fail(reason);
    } finally {
      setPaging(false);
    }
  };
  const download = async (format: 'csv' | 'xlsx') => {
    if (!result) return;
    try {
      const params = new URLSearchParams({
        format,
        title: t({ id: 'sql.results', message: 'Query results' }),
      });
      const file = await apiFile(`${base}/runs/${result.id}?${params}`);
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.filename ?? `${result.id}.${format}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      fail(reason);
    }
  };
  const count = result?.rowCount ?? 0;
  const duration = result?.durationMs ?? 0;
  return (
    <div className="rio-sql">
      {access.allowed && (
        <>
          <p>
            {t({
              id: 'sql.help',
              message:
                'Run one SELECT using the quoted table and field names below.  Your field and record permissions apply.',
            })}
          </p>
          <ScriptField
            value={source}
            onChange={setSource}
            readOnly={running !== null}
            label={t({ id: 'sql.query', message: 'SQL query' })}
            completions={[
              ...new Set(
                access.tables.flatMap((table) => [
                  quote(table.name),
                  ...table.fields.map((field) => quote(field.name)),
                ]),
              ),
            ]}
          />
          <details>
            <summary>{t({ id: 'sql.catalog', message: 'Tables and fields' })}</summary>
            {access.tables.map((table) => (
              <div key={table.id}>
                <code>{quote(table.name)}</code>
                <p>{table.fields.map((field) => quote(field.name)).join(', ')}</p>
              </div>
            ))}
          </details>
          <div className="rio-sql__actions">
            <Button
              isDisabled={!source.trim() || running !== null}
              onPress={() => {
                void run();
              }}
            >
              {t({ id: 'sql.run', message: 'Run' })}
            </Button>
            <Button
              isDisabled={!running}
              onPress={() => {
                if (running) void api(`${base}/runs/${running}/cancel`, { body: {} }).catch(fail);
              }}
            >
              {t({ id: 'sql.cancel', message: 'Cancel' })}
            </Button>
          </div>
          <details>
            <summary>{t({ id: 'sql.history', message: 'Recent queries' })}</summary>
            {history.data?.map((item) => (
              <button
                type="button"
                key={item.id}
                disabled={running !== null}
                onClick={() => setSource(item.query)}
              >
                <code>{item.query}</code>
              </button>
            ))}
          </details>
          {result && (
            <>
              <p role="status">{t({ id: 'sql.result.count', message: `${count} rows in ${duration} ms` })}</p>
              {result.capped && (
                <p>
                  {t({
                    id: 'sql.result.capped',
                    message: 'The row limit was reached.  Add a filter to narrow the results.',
                  })}
                </p>
              )}
              <div className="rio-sql__grid">
                <table aria-label={t({ id: 'sql.results', message: 'Query results' })}>
                  <thead>
                    <tr>
                      {result.columns.map((column, index) => (
                        <th key={index} scope="col">
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, index) => (
                      <tr key={index}>
                        {row.map((value, column) => (
                          <td key={column}>{shown(value)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="rio-sql__actions">
                <Button
                  isDisabled={paging || offset === 0}
                  onPress={() => {
                    void page(offset - 100);
                  }}
                >
                  {t({ id: 'sql.previous', message: 'Previous page' })}
                </Button>
                <Button
                  isDisabled={paging || offset + 100 >= count}
                  onPress={() => {
                    void page(offset + 100);
                  }}
                >
                  {t({ id: 'sql.next', message: 'Next page' })}
                </Button>
                <Button
                  onPress={() => {
                    void download('csv');
                  }}
                  aria-label={t({ id: 'export.csv', message: 'Download CSV' })}
                  icon={faDownload}
                />
                <Button
                  onPress={() => {
                    void download('xlsx');
                  }}
                  aria-label={t({ id: 'export.xlsx', message: 'Download Excel' })}
                  icon={faDownload}
                />
              </div>
            </>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {access.admin && (
        <SqlAdministration
          base={base}
          settings={access.settings}
          queryRole={access.queryRole}
          people={people}
          refresh={refresh}
        />
      )}
    </div>
  );
}

function SqlAdministration({
  base,
  settings,
  queryRole,
  people,
  refresh,
}: {
  base: string;
  settings: SqlSettings;
  queryRole: SqlAccess['queryRole'];
  people: readonly Collaborator[];
  refresh(): void;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const [draft, setDraft] = useState(settings);
  const setupSql = (source: string, reason?: SqlSetupIssue) =>
    reason === 'sql.setup.publicCreate'
      ? `-- ${t({ id: 'sql.setup.publicCreate.explanation', message: 'Remove the CREATE privilege that every role inherits through PUBLIC.' })}\n${source}`
      : source;
  const [personId, setPersonId] = useState('');
  const [login, setLogin] = useState<SqlLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = useQuery({ queryKey: ['sql-login', base], queryFn: () => api<SqlLogin>(`${base}/login`) });
  const current = login ?? state.data;
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(
        reason instanceof ApiError
          ? message(reason.info.messageKey, reason.info.params)
          : t({ id: 'sql.client.failed', message: 'The request failed.  Try again.' }),
      );
    } finally {
      setBusy(false);
    }
  };
  const change = (action: 'enable' | 'check' | 'rotate' | 'disable') =>
    perform(async () => {
      const next = await api<SqlLogin>(`${base}/login`, {
        body: { action, ...(personId ? { personId } : {}) },
      });
      setLogin(next);
    });
  const roles = {
    owner: t({ id: 'share.role.owner', message: 'Owner' }),
    creator: t({ id: 'share.role.creator', message: 'Creator' }),
    editor: t({ id: 'share.role.editor', message: 'Editor' }),
    commenter: t({ id: 'share.role.commenter', message: 'Commenter' }),
    reader: t({ id: 'share.role.reader', message: 'Reader' }),
  };
  return (
    <details>
      <summary>{t({ id: 'sql.settings', message: 'SQL administration' })}</summary>
      <fieldset disabled={busy}>
        <legend>{t({ id: 'sql.roles', message: 'Roles allowed to use the SQL editor' })}</legend>
        {DATABASE_ROLES.map((role) => (
          <label key={role}>
            <input
              type="checkbox"
              checked={draft.roles.includes(role)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  roles: event.target.checked
                    ? [...draft.roles, role]
                    : draft.roles.filter((item) => item !== role),
                })
              }
            />
            {roles[role]}
          </label>
        ))}
      </fieldset>
      <label>
        {t({ id: 'sql.timeout', message: 'Query timeout in milliseconds' })}
        <input
          type="number"
          min={10}
          max={120000}
          value={draft.timeoutMs}
          onChange={(event) => setDraft({ ...draft, timeoutMs: Number(event.target.value) })}
        />
      </label>
      <label>
        {t({ id: 'sql.rowCap', message: 'Maximum result rows' })}
        <input
          type="number"
          min={1}
          max={100000}
          value={draft.rowCap}
          onChange={(event) => setDraft({ ...draft, rowCap: Number(event.target.value) })}
        />
      </label>
      <Button
        isDisabled={busy}
        onPress={() => {
          void perform(async () => {
            await api(`${base}/settings`, { method: 'PUT', body: draft });
            refresh();
          });
        }}
      >
        {t({ id: 'sql.save', message: 'Save settings' })}
      </Button>
      {queryRole && !queryRole.active && queryRole.sql && (
        <>
          {queryRole.reason && <p role="status">{message(queryRole.reason)}</p>}
          <p>
            {t({
              id: 'sql.queryRole.note',
              message:
                'For extra protection, a database administrator can run this SQL to add a role that SQL queries run as, which can read only what those queries need.',
            })}
          </p>
          <ScriptField
            readOnly
            value={setupSql(queryRole.sql, queryRole.reason)}
            onChange={() => undefined}
            label={t({ id: 'sql.queryRole.sql', message: 'Query role SQL' })}
          />
        </>
      )}
      <h3>{t({ id: 'sql.outside', message: 'Outside tools' })}</h3>
      <p>
        {t({
          id: 'sql.outside.help',
          message:
            'The login reads this database as the person you choose.  Anyone with its password gets that same access.',
        })}
      </p>
      {current && current.reason !== 'sql.setup.outsideLogins' && (
        <p>
          {t({
            id: 'sql.outside.shared',
            message:
              'The login connects to the PostgreSQL database that every organization on this server shares.  It reads records only through its own views, but it can also see the names of the tables and fields in every database that has a login, roughly how many records each table holds, and the IDs of the databases and organizations that are changing, as they change.',
          })}
        </p>
      )}
      <div>
        {people.length > 10 ? (
          <Select
            label={t({ id: 'sql.person', message: 'Read as' })}
            selectedKey={personId || current?.personId || ''}
            onSelectionChange={(key) => setPersonId(String(key))}
          >
            <ListBoxItem id="">{t({ id: 'sql.person.choose', message: 'Choose a person' })}</ListBoxItem>
            {people.map((person) => (
              <ListBoxItem id={person.id} key={person.id}>
                {person.name}
              </ListBoxItem>
            ))}
          </Select>
        ) : (
          <label>
            {t({ id: 'sql.person', message: 'Read as' })}
            <select
              value={personId || current?.personId || ''}
              onChange={(event) => setPersonId(event.target.value)}
            >
              <option value="">{t({ id: 'sql.person.choose', message: 'Choose a person' })}</option>
              {people.map((person) => (
                <option value={person.id} key={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {current && (
        <>
          <p role="status">
            {current.ready
              ? t({ id: 'sql.login.ready', message: 'The login is ready.' })
              : current.reason
                ? message(current.reason)
                : current.enabled
                  ? t({
                      id: 'sql.login.pending',
                      message: 'Access is closed until the setup passes its check.',
                    })
                  : t({ id: 'sql.login.off', message: 'The login is off.' })}
          </p>
          <label>
            {t({ id: 'sql.login.role', message: 'PostgreSQL login' })}
            <input readOnly value={current.role} />
          </label>
          <label>
            {t({ id: 'sql.login.schema', message: 'View schema' })}
            <input readOnly value={current.schema} />
          </label>
          {current.password && (
            <label>
              {t({ id: 'sql.login.password', message: 'Password—save it now' })}
              <input readOnly value={current.password} />
            </label>
          )}
          {current.sql && (
            <>
              <p>
                {t({
                  id: 'sql.login.manual',
                  message:
                    'A PostgreSQL administrator can run this SQL on the server database, then choose Check.',
                })}
              </p>
              <ScriptField
                readOnly
                value={setupSql(current.sql, current.reason)}
                onChange={() => undefined}
                label={t({ id: 'sql.login.setupSql', message: 'Administrator SQL' })}
              />
            </>
          )}
        </>
      )}
      <div className="rio-sql__actions">
        <Button
          isDisabled={busy || !personId}
          onPress={() => {
            void change('enable');
          }}
        >
          {t({ id: 'sql.login.enable', message: 'Enable login' })}
        </Button>
        <Button
          isDisabled={busy || (!current?.enabled && !current?.sql)}
          onPress={() => {
            void change('check');
          }}
        >
          {t({ id: 'sql.login.check', message: 'Check' })}
        </Button>
        <Button
          isDisabled={busy || !current?.enabled}
          onPress={() => {
            void change('rotate');
          }}
        >
          {t({ id: 'sql.login.rotate', message: 'Rotate password' })}
        </Button>
        <Button
          isDisabled={busy || !current?.enabled}
          onPress={() => {
            void change('disable');
          }}
        >
          {t({ id: 'sql.login.disable', message: 'Turn off login' })}
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
