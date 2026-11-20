import { HelpDialogTitle } from '../../../docs/HelpDialogTitle';
import { i18n as messageCatalog, type I18n } from '@lingui/core';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  faBoxesStacked,
  faEye,
  faFile,
  faInbox,
  faLayerGroup,
  faListUl,
  faPlug,
  faRss,
  faTable,
  faTableCells,
  faPlus,
} from '@fortawesome/free-solid-svg-icons';
import {
  FieldCreate,
  FieldSpec,
  FILTER_LENGTH,
  filterProblem,
  isApiKind,
  isAppKind,
  isDocumentKind,
  isFileKind,
  isHttpEngine,
  isJsonPath,
  isPrimaryType,
  isSearchSource,
  LIMITS,
  newId,
  searchFilterProblem,
  WEBHOOK_FIELD_TYPES,
  type CellValue,
  type AppCatalogEntry,
  type SourceColumn,
  type Freshness,
  type SourceMeta,
  type SourceObject,
  type SourcePreview,
  type SourceSelect,
  type TableCreate,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  ListBox,
  FilterableList,
  normalizeFilter,
  ListBoxItem,
  ListBoxSection,
  Modal,
  SearchField,
  Select,
  Spinner,
  TextArea,
  TextField,
} from '@riosoma/ui';
import { api, ApiError } from '../../../api';
import type { DatabaseSession } from '../../../data';
import { useServerMessage } from '../../../messages/useServerMessage';
import { REPORT_MESSAGES } from '../../import/airtable/reportMessages';
import { useSourceForm } from '../../settings/sources/SourceForm';
import { WebhookAddressShown } from '../../settings/sources/WebhookPanel';
import { fieldTypeInfo } from '../fields/fieldTypes';
import { FreshnessChoice, RemoveMissing, Schedule } from './SyncSettings';
import './synced.css';

interface ColumnDraft {
  column: string;
  name: string;
  type: string;
  /** The field type the source suggested, which the default primary field goes by */
  suggested: string | null;
  include: boolean;
}

/** Field types that make a primary field people can read, in the order the wizard prefers them. */
const READABLE_PRIMARY_TYPES = ['text', 'email', 'url', 'phone'];

const WIZARD_HELP = [
  { section: 'choose-a-source', anchorId: 'synced.source' },
  { section: 'choose-a-table-or-query', anchorId: 'synced.object' },
  { section: 'choose-fields-and-keys', anchorId: 'synced.fields' },
  { section: 'set-the-sync-schedule', anchorId: 'synced.schedule' },
] as const;

/** How many of the preview's rows the field step shows. */
const PREVIEW_ROWS = 5;

function canBePrimary(type: string): boolean {
  const spec = FieldSpec.safeParse({ type });
  return spec.success && isPrimaryType(spec.data.type);
}

/**
 * The primary field a new synced table starts with: the first column the source suggests as text,
 * then as an email address, a link, or a phone number.  Only when there's none does it fall back to
 * the first key column, since keys are usually numbers that mean little to people.
 */
function defaultPrimary(candidates: readonly ColumnDraft[], keys: readonly string[]): string {
  for (const type of READABLE_PRIMARY_TYPES) {
    const match = candidates.find((column) => column.suggested === type);
    if (match) return match.column;
  }
  const key = keys.find((key) => candidates.some((column) => column.column === key));
  return key ?? candidates[0]?.column ?? '';
}

const OBJECT_ICONS = {
  table: faTable,
  view: faEye,
  file: faFile,
  files: faLayerGroup,
  endpoint: faPlug,
  collection: faBoxesStacked,
  sheet: faTableCells,
  list: faListUl,
  feed: faRss,
  posts: faInbox,
} as const;

/** How often the mapping step asks for a webhook's newest posts while it's open. */
const HOOK_POLL_MS = 3_000;

/** A path someone typed for a webhook, before any post has shown it, read as text until they choose. */
function typedColumn(path: string): SourceColumn {
  return {
    name: path,
    sourceType: 'string',
    nullable: true,
    suggested: { type: 'text', options: {} },
    alternatives: WEBHOOK_FIELD_TYPES.filter((type) => type !== 'text'),
  };
}

/** The drafts for a new set of columns, keeping what a person already chose for each one by name. */
function aligned(columns: readonly SourceColumn[], drafts: readonly ColumnDraft[]): ColumnDraft[] {
  return columns.map(
    (column) =>
      drafts.find((draft) => draft.column === column.name) ?? {
        column: column.name,
        name: column.name,
        type: column.suggested?.type ?? '',
        suggested: column.suggested?.type ?? null,
        // Row numbers and record IDs are there to key records by, so they start out left out.
        include: column.suggested !== null && FieldSpec.safeParse(column.suggested).success && !column.role,
      },
  );
}

/**
 * The name a new synced table starts with: a table's or an endpoint's own name, or a file's name
 * without its folder or extension, or the folder that files read together share.  A sheet or an
 * Airtable table known by its ID starts with the name people know it by.
 */
export function defaultTableName(
  object: SourceObject | undefined,
  fallback: string,
  catalog: I18n = messageCatalog,
): string {
  // A feed's items and a webhook's posts are the source's only offering, so the source names it.
  if (!object || object.type === 'feed' || object.type === 'posts') return fallback;
  if (object.type === 'file')
    return (
      object.name
        .split('/')
        .pop()!
        .replace(/\.[^.]+$/, '') || fallback
    );
  if (object.type === 'files')
    return (
      object.name
        .replace(/\*\.[a-z]+$/, '')
        .split('/')
        .filter(Boolean)
        .pop() || fallback
    );
  return appObjectLabel(object, catalog);
}

/** Account names remain literal while preset label patterns use the message catalog. */
function appObjectLabel(object: SourceObject, catalog: I18n): string {
  return object.labelMessageId
    ? catalog._(object.labelMessageId, { label: object.label ?? object.name, ...object.labelParams })
    : (object.label ?? object.name);
}

/** A preview value as plain text: empty for no value, and lists joined with commas. */
function plainValue(value: CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  return Array.isArray(value) ? value.join(', ') : String(value);
}

export function SyncWizard({
  appCatalog,
  sources,
  admin,
  session,
  onClose,
  onCreated,
}: {
  appCatalog?: readonly AppCatalogEntry[];
  sources: readonly SourceMeta[];
  admin: boolean;
  session: DatabaseSession;
  onClose(): void;
  onCreated(tableId: string, viewId: string): void;
}) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const [step, setStep] = useState(0);
  const [retry, setRetry] = useState(0);
  const [sourceId, setSourceId] = useState('');
  // Sources connected without leaving the wizard, merged over the list the database holds so a
  // brand-new one can be chosen before the list on the screen has caught up.
  const [extraSources, setExtraSources] = useState<SourceMeta[]>([]);
  const allSources = useMemo(() => {
    const byId = new Map(sources.map((source) => [source.id, source]));
    for (const source of extraSources) byId.set(source.id, source);
    return [...byId.values()];
  }, [sources, extraSources]);
  // Whether the first step is showing the connection form in place of the source choice.
  const [connecting, setConnecting] = useState(false);
  // A webhook connected here hands back its address once, shown before moving on to its posts.
  const [createdWebhook, setCreatedWebhook] = useState<{ meta: SourceMeta; path: string } | null>(null);
  const [objects, setObjects] = useState<SourceObject[]>([]);
  const [search, setSearch] = useState('');
  const [select, setSelect] = useState<SourceSelect>();
  // A MongoDB collection's filter, which only admins can write.
  const [filter, setFilter] = useState('');
  const [preview, setPreview] = useState<SourcePreview>();
  // What a person chose for each column so far, by name.  The drafts shown follow the columns.
  const [chosenColumns, setColumns] = useState<ColumnDraft[]>([]);
  const [fieldSearch, setFieldSearch] = useState('');
  const [keys, setKeys] = useState<string[]>([]);
  // The primary field a person picked, or null to follow the default as columns come and go.
  const [primaryChoice, setPrimaryChoice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const objectsLabel = useId();
  const [settings, setSettings] = useState({
    everyMinutes: 60 as number | null,
    allowOverrides: true,
    holdAboveDeleteShare: 0.5,
    freshness: 'copy' as Freshness,
  });
  // A feed's old items stay unless someone asks for them to go.
  const [removeMissing, setRemoveMissing] = useState(false);
  // Paths typed for a webhook, which posts haven't shown yet.
  const [typed, setTyped] = useState<SourceColumn[]>([]);
  const [path, setPath] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  // A file's name or a limit, which some messages about files name.
  const [errorParams, setErrorParams] = useState<Record<string, string | number | boolean>>();
  const failed = (thrown: unknown) => {
    setError(thrown instanceof ApiError ? thrown.info.messageKey : 'errors.internal');
    setErrorParams(thrown instanceof ApiError ? thrown.info.params : undefined);
  };
  const sourceKind = allSources.find((source) => source.id === sourceId)?.kind;
  const files = sourceKind !== undefined && isFileKind(sourceKind);
  const endpoints = sourceKind !== undefined && isApiKind(sourceKind);
  const searchEngine = sourceKind !== undefined && isSearchSource(sourceKind);
  const httpEngine = sourceKind !== undefined && isHttpEngine(sourceKind);
  const documents = sourceKind !== undefined && isDocumentKind(sourceKind);
  const apps = sourceKind !== undefined && isAppKind(sourceKind);
  const sheets = sourceKind === 'google-sheets' || sourceKind === 'excel-online';
  const lists = sourceKind === 'sharepoint-list';
  const hook = sourceKind === 'webhook';
  const feed = sourceKind === 'feed';
  // Files are read whole, endpoints as the API answers them, collections through a filter, and
  // sheets and Airtable tables as they are, so only a database takes a query.
  const queries = !files && !endpoints && !documents && !apps && !hook && !feed && !searchEngine;
  const objectSearchLabel = files
    ? t({ id: 'synced.wizard.searchFiles', message: 'Search files' })
    : endpoints
      ? t({ id: 'synced.wizard.searchEndpoints', message: 'Search endpoints' })
      : documents
        ? t({
            id: 'synced.wizard.searchCollections',
            message: 'Search collections and views',
          })
        : sheets
          ? t({ id: 'synced.wizard.searchSheets', message: 'Search sheets' })
          : lists
            ? t({ id: 'synced.wizard.searchLists', message: 'Search lists' })
            : sourceKind === 'app'
              ? t({ id: 'sources.app.searchObjects', message: 'Search objects' })
              : apps
                ? t({ id: 'synced.wizard.searchTables', message: 'Search tables' })
                : t({ id: 'synced.wizard.search', message: 'Search tables and views' });
  const filterText = admin && (documents || searchEngine) ? filter.trim() : '';
  // Meilisearch binds AND tighter than OR, so a filter that closes a group it never opened would
  // end the group a reader's record rules sit in.  Typesense joins the rules after the filter in
  // one string, so an open backtick would swallow them.  The server refuses both too, and saying so
  // here keeps an admin from finding that out after a table is made.
  const filterIssue = !filterText
    ? null
    : documents
      ? filterProblem(filterText)
      : sourceKind === 'meilisearch' || sourceKind === 'typesense'
        ? searchFilterProblem(filterText, sourceKind)
        : null;
  // What the table reads: the chosen collection, with its filter when an admin wrote one.
  const reading: SourceSelect | undefined =
    select?.kind === 'object' && filterText
      ? { ...select, ...(searchEngine ? { nativeFilter: filterText } : { filter: filterText }) }
      : select;
  useEffect(() => {
    if (!sourceId) return;
    const abort = new AbortController();
    void api<SourceObject[]>(`/api/sources/${sourceId}/objects`, { signal: abort.signal })
      .then((objects) => {
        if (!abort.signal.aborted) setObjects(objects);
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) failed(error);
      })
      .finally(() => {
        if (!abort.signal.aborted) setPending(false);
      });
    return () => abort.abort();
  }, [sourceId, retry]);
  async function next() {
    if (step !== 1) {
      setStep(step + 1);
      return;
    }
    if (!reading || filterIssue) return;
    setPending(true);
    setError('');
    try {
      const result = await api<SourcePreview>(`/api/sources/${sourceId}/preview`, {
        method: 'POST',
        body: { select: reading },
      });
      setPreview(result);
      setColumns(aligned(result.columns, []));
      setFieldSearch('');
      setTyped([]);
      // A webhook's key is a choice, since without one every post adds records.
      setKeys(hook ? [] : (result.keyCandidates[0] ?? []));
      setPrimaryChoice(null);
      const sourceName = allSources.find((source) => source.id === sourceId)?.name ?? '';
      setName(
        reading.kind === 'object'
          ? defaultTableName(
              objects.find(
                (object) => object.schema === reading.object.schema && object.name === reading.object.name,
              ),
              sourceName,
              i18n,
            )
          : sourceName,
      );
      setStep(2);
    } catch (error) {
      failed(error);
    } finally {
      setPending(false);
    }
  }
  // While a webhook's fields are being chosen, its newest posts keep arriving here.
  useEffect(() => {
    if (!hook || step !== 2 || !reading) return;
    const abort = new AbortController();
    const timer = setInterval(() => {
      void api<SourcePreview>(`/api/sources/${sourceId}/preview`, {
        method: 'POST',
        body: { select: reading },
        signal: abort.signal,
      })
        .then((result) => {
          if (!abort.signal.aborted) setPreview(result);
        })
        .catch(() => {
          // A missed look is tried again at the next tick.
        });
    }, HOOK_POLL_MS);
    return () => {
      clearInterval(timer);
      abort.abort();
    };
    // The reading doesn't change on this step, and a new object restarts the step anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hook, step, sourceId]);
  // A webhook's columns are what its posts showed, and then any path someone typed.
  const shown: SourcePreview | undefined =
    preview && typed.length
      ? {
          ...preview,
          columns: [
            ...preview.columns,
            ...typed.filter((column) => !preview.columns.some((entry) => entry.name === column.name)),
          ],
        }
      : preview;
  const columns = shown ? aligned(shown.columns, chosenColumns) : chosenColumns;
  const included = columns.filter((column) => column.include);
  const supported = new Set(
    shown?.columns
      .filter((column) => column.suggested && FieldSpec.safeParse(column.suggested).success)
      .map((column) => column.name),
  );
  const selectableTypes = [
    ...new Set(columns.filter((column) => supported.has(column.column)).map((column) => column.type)),
  ];
  const matchingColumns = columns.filter((column) =>
    normalizeFilter(`${column.column} ${column.name}`).includes(normalizeFilter(fieldSearch)),
  );
  function selectFields(matches: (column: ColumnDraft) => boolean) {
    const next = columns.map((column) => ({
      ...column,
      include: supported.has(column.column) && matches(column),
    }));
    setColumns(next);
    setPrimaryChoice((choice) =>
      next.some((column) => column.include && column.column === choice) ? choice : null,
    );
  }
  const primaryColumns = included.filter((column) => canBePrimary(column.type));
  // A person's pick stands while that column can still be the primary field.
  const primary =
    primaryColumns.find((column) => column.column === primaryChoice)?.column ??
    defaultPrimary(primaryColumns, keys);
  const fieldsValid =
    included.length > 0 &&
    included.length <= LIMITS.fieldsPerTable &&
    included.every((column) => column.name.trim()) &&
    (hook || keys.length > 0) &&
    keys.length <= 8 &&
    primaryColumns.some((column) => column.column === primary);
  async function create() {
    if (!shown || !reading || !fieldsValid || !name.trim()) return;
    setPending(true);
    setError('');
    try {
      const fields = [...included]
        .sort((a, b) => Number(b.column === primary) - Number(a.column === primary))
        .map((draft) => {
          const column = shown.columns.find((column) => column.name === draft.column)!;
          return FieldCreate.parse({
            id: newId('field'),
            name: draft.name.trim(),
            type: draft.type,
            options: draft.type === column.suggested?.type ? column.suggested.options : {},
            source: { column: column.name, sourceType: column.sourceType },
          });
        });
      const table: TableCreate = {
        id: newId('table'),
        name: name.trim(),
        description: '',
        fields,
        view: { id: newId('view'), name: t({ id: 'view.type.grid', message: 'Grid' }) },
        records: [],
        source: {
          sourceId,
          select: reading,
          keyColumns: keys,
          ...settings,
          // A webhook's posts fill its table as they come, so it has no schedule.
          ...(hook ? { everyMinutes: null, freshness: 'copy' as const } : {}),
          ...(feed && removeMissing ? { removeMissing: true } : {}),
        },
      };
      const result = await session.run([{ kind: 'table.create', table }]).done;
      if (!result.rejected) {
        onCreated(table.id, table.view.id);
        onClose();
      } else setError('errors.internal');
    } catch (error) {
      failed(error);
    } finally {
      setPending(false);
    }
  }
  // Options are known by their place in the source's list, since names repeat across schemas.
  const groups = new Map<string | null, Array<{ key: string; object: SourceObject }>>();
  objects.forEach((object, index) => {
    const words = `${object.schemaLabel ?? object.schema ?? ''} ${appObjectLabel(object, i18n)}`;
    if (!normalizeFilter(words).includes(normalizeFilter(search))) return;
    groups.set(object.schema, [...(groups.get(object.schema) ?? []), { key: String(index), object }]);
  });
  const chosen =
    select?.kind === 'object'
      ? objects.findIndex(
          (object) => object.schema === select.object.schema && object.name === select.object.name,
        )
      : -1;
  /** A file's size in the unit that reads best, or nothing when the source didn't say. */
  const size = (bytes: number | null | undefined) => {
    if (bytes === null || bytes === undefined) return null;
    const [value, unit] =
      bytes >= 1024 * 1024 * 1024
        ? [bytes / 1024 / 1024 / 1024, 'gigabyte']
        : bytes >= 1024 * 1024
          ? [bytes / 1024 / 1024, 'megabyte']
          : bytes >= 1024
            ? [bytes / 1024, 'kilobyte']
            : [bytes, 'byte'];
    return i18n.number(value, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 });
  };
  /** What an object is called: its own name, or for a feed or a webhook, what it offers. */
  const objectName = (object: SourceObject) =>
    object.type === 'feed'
      ? t({ id: 'synced.wizard.feedItems', message: 'The feed’s items' })
      : object.type === 'posts'
        ? t({ id: 'synced.wizard.webhookPosts', message: 'Posts to the webhook' })
        : appObjectLabel(object, i18n);
  const objectOption = ({ key, object }: { key: string; object: SourceObject }) => {
    const count = object.rowEstimate ?? 0;
    const together = object.files ?? 0;
    const bytes = size(object.bytes);
    return (
      <ListBoxItem
        key={key}
        id={key}
        textValue={objectName(object)}
        icon={OBJECT_ICONS[object.type]}
        description={
          <>
            {/* The icon is decorative, so the kind is spelled out for screen readers. */}
            <span className="rio-synced-sr-only">
              {object.type === 'view'
                ? t({ id: 'synced.wizard.view', message: 'View' })
                : object.type === 'file'
                  ? t({ id: 'synced.wizard.file', message: 'File' })
                  : object.type === 'files'
                    ? t({ id: 'synced.wizard.files', message: 'Files read together' })
                    : object.type === 'endpoint'
                      ? t({ id: 'synced.wizard.endpoint', message: 'Endpoint' })
                      : object.type === 'collection'
                        ? t({ id: 'synced.wizard.collection', message: 'Collection' })
                        : object.type === 'sheet'
                          ? t({ id: 'synced.wizard.sheet', message: 'Sheet' })
                          : object.type === 'list'
                            ? t({ id: 'synced.wizard.list', message: 'List' })
                            : object.type === 'feed'
                              ? t({ id: 'synced.wizard.feed', message: 'Feed' })
                              : object.type === 'posts'
                                ? t({ id: 'synced.wizard.posts', message: 'Posts' })
                                : t({ id: 'synced.wizard.table', message: 'Table' })}
            </span>
            {object.rowEstimate !== null &&
              t({
                id: 'synced.wizard.rows',
                message: plural(count, { one: 'About # record', other: 'About # records' }),
              })}
            {object.type === 'files' || bytes !== null ? (
              <span className="rio-synced-object__meta">
                {object.type === 'files' && (
                  <span>
                    {t({
                      id: 'synced.wizard.fileCount',
                      message: plural(together, { one: '# file', other: '# files' }),
                    })}
                  </span>
                )}
                {bytes !== null && <span>{bytes}</span>}
              </span>
            ) : null}
          </>
        }
      >
        {objectName(object)}
      </ListBoxItem>
    );
  };
  /** What a column's note says: an import report's line, or a Data Source message. */
  const noteText = (note: NonNullable<SourceColumn['notes']>[number]) => {
    const report = REPORT_MESSAGES[note.messageKey];
    return report ? i18n._({ ...report, values: note.params ?? {} }) : message(note.messageKey, note.params);
  };
  // A row number is a poor key, since rows move, so choosing one says so.
  const rowNumberKey =
    shown?.columns.some((column) => column.role === 'rowNumber' && keys.includes(column.name)) ?? false;
  const pathIssue = path.trim() !== '' && !isJsonPath(path.trim());
  function addPath() {
    const text = path.trim();
    if (!text || !isJsonPath(text) || shown?.columns.some((column) => column.name === text)) return;
    setTyped([...typed, typedColumn(text)]);
    setPath('');
  }
  // Leave the connection form and go straight to choosing what to sync from the source just made.
  function chooseSourceAndContinue(id: string) {
    setPending(true);
    setError('');
    setErrorParams(undefined);
    setSourceId(id);
    setSelect(undefined);
    setFilter('');
    setObjects([]);
    setConnecting(false);
    setCreatedWebhook(null);
    setStep(1);
  }
  function handleConnected(meta: SourceMeta) {
    setExtraSources((current) => [...current.filter((source) => source.id !== meta.id), meta]);
    chooseSourceAndContinue(meta.id);
  }
  function handleCreatedWebhook(meta: SourceMeta, webhookPath: string) {
    setExtraSources((current) => [...current.filter((source) => source.id !== meta.id), meta]);
    setCreatedWebhook({ meta, path: webhookPath });
  }
  // The same connection form the settings screen uses, rendered here in place on the first step.
  const connect = useSourceForm({
    appCatalog,
    onSaved: handleConnected,
    onCreatedWebhook: handleCreatedWebhook,
  });
  return (
    <Modal
      size="lg"
      isOpen
      onOpenChange={(open) => {
        if (!open && !pending && !connect.busy) onClose();
      }}
    >
      <Dialog>
        <HelpDialogTitle
          moduleId="synced-tables"
          section={WIZARD_HELP[step]!.section}
          anchorId={WIZARD_HELP[step]!.anchorId}
        >
          <Trans id="synced.wizard.title">Sync from a data source</Trans>
        </HelpDialogTitle>
        {/* Keyed by step, so each step opens scrolled to its top. */}
        <DialogBody key={step} className="rio-synced-body" aria-busy={pending}>
          <div className="rio-synced-form">
            {error && (
              <Banner tone="danger">
                {message(error, errorParams)}
                {step === 0 && (
                  <Button
                    onPress={() => {
                      setPending(true);
                      setError('');
                      setErrorParams(undefined);
                      setRetry(retry + 1);
                    }}
                  >
                    <Trans id="synced.tryAgain">Try again</Trans>
                  </Button>
                )}
              </Banner>
            )}
            {pending && <Spinner />}
            {step === 0 && !connecting && (
              <>
                {allSources.length > 0 && (
                  <Select
                    label={t({ id: 'synced.wizard.source', message: 'Choose a data source' })}
                    selectedKey={sourceId || null}
                    onSelectionChange={(key) => {
                      if (String(key) === sourceId) return;
                      setPending(true);
                      setError('');
                      setSourceId(String(key));
                      setSelect(undefined);
                      setFilter('');
                      setObjects([]);
                    }}
                  >
                    {allSources.map((source) => (
                      <ListBoxItem key={source.id} id={source.id}>
                        {source.name}
                      </ListBoxItem>
                    ))}
                  </Select>
                )}
                {admin ? (
                  // A new source is connected here, without leaving for Settings: the primary move
                  // when the database has no source yet, a quieter one beside the choice otherwise.
                  <Button
                    variant={allSources.length ? 'secondary' : 'primary'}
                    icon={faPlus}
                    onPress={() => {
                      setError('');
                      setErrorParams(undefined);
                      setConnecting(true);
                    }}
                  >
                    <Trans id="synced.wizard.connect">Connect a new data source</Trans>
                  </Button>
                ) : (
                  <p className="rio-synced-note">
                    <Trans id="synced.wizard.connect.cannot">
                      A Data Sources admin can connect a new data source for everyone to sync from.
                    </Trans>
                  </p>
                )}
              </>
            )}
            {step === 0 && connecting && !createdWebhook && connect.body}
            {step === 0 && connecting && createdWebhook && (
              <>
                <p className="rio-synced-note">
                  <Trans id="synced.wizard.webhookConnected">
                    {
                      'The webhook is saved.  Give this address to the system that sends posts, then choose its posts to sync.'
                    }
                  </Trans>
                </p>
                <WebhookAddressShown path={createdWebhook.path} />
              </>
            )}
            {step === 1 && (
              <>
                <h3 id={objectsLabel}>
                  <Trans id="synced.wizard.object">Choose what to sync</Trans>
                </h3>
                {objects.length > 10 ? (
                  <FilterableList
                    listId={`sync.objects:${sourceId}`}
                    filterLabel={objectSearchLabel}
                    label={t({ id: 'synced.wizard.object', message: 'Choose what to sync' })}
                    emptyMessage={
                      files
                        ? t({ id: 'synced.wizard.noFiles', message: 'No files found.' })
                        : endpoints
                          ? t({ id: 'synced.wizard.noEndpoints', message: 'No endpoints found.' })
                          : documents
                            ? t({
                                id: 'synced.wizard.noCollections',
                                message: 'No collections or views found.',
                              })
                            : sheets
                              ? t({ id: 'synced.wizard.noSheets', message: 'No sheets found.' })
                              : lists
                                ? t({ id: 'synced.wizard.noLists', message: 'No lists found.' })
                                : apps
                                  ? t({ id: 'synced.wizard.noTables', message: 'No tables found.' })
                                  : t({
                                      id: 'synced.wizard.noObjects',
                                      message: 'No tables or views found.',
                                    })
                    }
                    items={objects.map((object, index) => ({
                      id: String(index),
                      name: objectName(object),
                      group: object.schema ?? undefined,
                      groupName: object.schemaLabel ?? object.schema ?? undefined,
                      description: objectOption({ key: String(index), object }).props.description,
                    }))}
                    selectedKeys={chosen === -1 ? [] : [String(chosen)]}
                    onSelectionChange={(keys) => {
                      const object = objects[Number([...keys][0])];
                      if (object)
                        setSelect({ kind: 'object', object: { schema: object.schema, name: object.name } });
                    }}
                  />
                ) : (
                  <>
                    <TextField label={objectSearchLabel} value={search} onChange={setSearch} />
                    <ListBox
                      className="rio-synced-objects"
                      aria-labelledby={objectsLabel}
                      selectionMode="single"
                      disallowEmptySelection
                      selectedKeys={chosen === -1 ? [] : [String(chosen)]}
                      onSelectionChange={(selection) => {
                        const [key] = selection === 'all' ? [] : selection;
                        const object = key === undefined ? undefined : objects[Number(key)];
                        if (object)
                          setSelect({ kind: 'object', object: { schema: object.schema, name: object.name } });
                      }}
                      renderEmptyState={() => (
                        <p className="rio-synced-objects__empty">
                          {files
                            ? t({ id: 'synced.wizard.noFiles', message: 'No files found.' })
                            : endpoints
                              ? t({ id: 'synced.wizard.noEndpoints', message: 'No endpoints found.' })
                              : documents
                                ? t({
                                    id: 'synced.wizard.noCollections',
                                    message: 'No collections or views found.',
                                  })
                                : sheets
                                  ? t({ id: 'synced.wizard.noSheets', message: 'No sheets found.' })
                                  : lists
                                    ? t({ id: 'synced.wizard.noLists', message: 'No lists found.' })
                                    : apps
                                      ? t({ id: 'synced.wizard.noTables', message: 'No tables found.' })
                                      : t({
                                          id: 'synced.wizard.noObjects',
                                          message: 'No tables or views found.',
                                        })}
                        </p>
                      )}
                    >
                      {[...groups].map(([schema, entries], index) =>
                        schema === null ? (
                          entries.map(objectOption)
                        ) : (
                          <ListBoxSection
                            key={`schema-${index}`}
                            id={`schema-${index}`}
                            title={entries[0]!.object.schemaLabel ?? schema}
                          >
                            {entries.map(objectOption)}
                          </ListBoxSection>
                        ),
                      )}
                    </ListBox>{' '}
                  </>
                )}
                {admin && (documents || searchEngine) && (
                  <TextArea
                    className="rio-synced-query"
                    label={t({ id: 'synced.wizard.filter', message: 'Filter' })}
                    description={
                      searchEngine
                        ? sourceKind === 'meilisearch'
                          ? t({
                              id: 'synced.wizard.engineFilter.meilisearch',
                              message:
                                'Optional.  Written in Meilisearch’s own filter syntax, and always applied together with a view’s filters and its record rules.  Keep its parentheses inside the filter.',
                            })
                          : t({
                              id: 'synced.wizard.engineFilter',
                              message:
                                'Optional.  Written in the engine’s own filter syntax.  Elasticsearch and OpenSearch take a JSON query object.',
                            })
                        : t({
                            id: 'synced.wizard.filter.hint',
                            message:
                              'Optional.  A JSON query document that picks which documents to sync.  Use field comparisons, $and, $or, or $in.',
                          })
                    }
                    // An example of the syntax, which is code rather than words to translate.
                    placeholder={searchEngine ? undefined : '{ "status": "active" }'}
                    value={filter}
                    maxLength={FILTER_LENGTH}
                    rows={4}
                    isInvalid={filterIssue !== null}
                    errorMessage={
                      filterIssue === 'javascript'
                        ? message('sources.mongodb.javascript')
                        : filterIssue === 'json'
                          ? message('sources.mongodb.filter')
                          : filterIssue === 'unbalanced'
                            ? message('sources.engines.filterGroup')
                            : undefined
                    }
                    onChange={setFilter}
                  />
                )}
                {/* File and API sources have no query to write. */}
                {admin && queries && (
                  <Button onPress={() => setSelect({ kind: 'query', sql: '' })}>
                    <Trans id="synced.wizard.query">Write a query</Trans>
                  </Button>
                )}
                {admin && queries && select?.kind === 'query' && (
                  <TextArea
                    className="rio-synced-query"
                    label={t({ id: 'synced.wizard.queryLabel', message: 'Query' })}
                    description={
                      httpEngine
                        ? t({
                            id: 'synced.wizard.engineQuery',
                            message:
                              'Use read-only Cypher for Neo4j, Flux for InfluxDB 2, SQL for InfluxDB 3, or PromQL for Prometheus.  A Flux query names its own time range.  The others read the source’s window.',
                          })
                        : undefined
                    }
                    value={select.sql}
                    maxLength={20000}
                    rows={6}
                    onChange={(sql) => setSelect({ kind: 'query', sql })}
                  />
                )}
              </>
            )}
            {step === 2 && shown && (
              <>
                <h3>
                  <Trans id="synced.wizard.fields">Choose fields</Trans>
                </h3>
                {included.length > LIMITS.fieldsPerTable && (
                  <Banner tone="danger">
                    {t({
                      id: 'synced.wizard.fieldLimit',
                      message: `Choose up to ${LIMITS.fieldsPerTable} fields to create this table.  Clear some selections to continue.`,
                    })}
                  </Banner>
                )}
                {hook && (
                  <p className="rio-synced-note" role="status">
                    {shown.rows.length
                      ? t({
                          id: 'synced.wizard.hookPosts',
                          message:
                            'These are the last posts sent while this step has been open.  Send another to see it here.',
                        })
                      : t({
                          id: 'synced.wizard.hookWaiting',
                          message:
                            'Send a post to the webhook’s address now, and its fields show here.  Only posts sent while this step is open are kept, and only the last 10.',
                        })}
                  </p>
                )}
                {/* Scrolls sideways for wide sources, so it takes the keyboard as well. */}
                <div
                  className="rio-synced-preview"
                  role="region"
                  tabIndex={0}
                  aria-label={t({ id: 'synced.wizard.preview', message: 'Preview' })}
                >
                  <table aria-label={t({ id: 'synced.wizard.preview', message: 'Preview' })}>
                    <thead>
                      <tr>
                        {shown.columns.map((column) => (
                          <th key={column.name} scope="col">
                            <span className="rio-synced-preview__cell">{column.name}</span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {shown.rows.slice(0, PREVIEW_ROWS).map((row, index) => (
                        <tr key={index}>
                          {shown.columns.map((_, position) => (
                            <td key={position}>
                              <span className="rio-synced-preview__cell">{plainValue(row[position])}</span>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="rio-synced-field-tools">
                  <SearchField
                    label={t({ id: 'synced.wizard.searchFields', message: 'Search fields' })}
                    description={t({
                      id: 'synced.wizard.searchFields.hint',
                      message: 'Search hides fields.  Selection buttons apply to all fields.',
                    })}
                    value={fieldSearch}
                    onChange={setFieldSearch}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.preventDefault();
                    }}
                  />
                  <div className="rio-synced-field-actions">
                    <Button onPress={() => selectFields(() => true)}>
                      <Trans id="synced.wizard.selectAll">Select all</Trans>
                    </Button>
                    <Button onPress={() => selectFields(() => false)}>
                      <Trans id="synced.wizard.selectNone">Select none</Trans>
                    </Button>
                    <Select
                      label={t({ id: 'synced.wizard.selectByType', message: 'Select by type' })}
                      selectedKey={null}
                      onSelectionChange={(key) => selectFields((column) => column.type === String(key))}
                    >
                      {selectableTypes.flatMap((type) => {
                        const spec = FieldSpec.safeParse({ type });
                        return spec.success
                          ? [
                              <ListBoxItem id={type} key={type}>
                                {i18n._(fieldTypeInfo(spec.data.type).name)}
                              </ListBoxItem>,
                            ]
                          : [];
                      })}
                    </Select>
                  </div>
                  <p className="rio-synced-note" role="status">
                    {t({
                      id: 'synced.wizard.selectedCount',
                      message: `${included.length} of ${columns.length} fields selected`,
                    })}
                  </p>
                </div>
                {matchingColumns.length === 0 && (
                  <p className="rio-synced-note">
                    <Trans id="synced.wizard.noFields">No fields match your search.</Trans>
                  </p>
                )}
                <FieldEditors columns={matchingColumns}>
                  {(draft) => {
                    const column = shown.columns.find((column) => column.name === draft.column);
                    if (!column) return null;
                    const unsupported = !column.suggested || !FieldSpec.safeParse(column.suggested).success;
                    const change = (patch: Partial<ColumnDraft>) => {
                      setColumns(
                        columns.map((value) =>
                          value.column === draft.column ? { ...value, ...patch } : value,
                        ),
                      );
                      // Leaving out the chosen primary field hands the choice back to the default.
                      if (patch.include === false && draft.column === primaryChoice) setPrimaryChoice(null);
                    };
                    const includeLabel = (column: string) =>
                      t({ id: 'synced.wizard.include', message: `Include ${column}` });
                    return (
                      <div
                        key={column.name}
                        className="rio-synced-column"
                        role="group"
                        aria-label={column.name}
                      >
                        <Checkbox
                          isDisabled={unsupported}
                          isSelected={draft.include}
                          onChange={(include) => change({ include })}
                        >
                          {includeLabel(column.name)}
                        </Checkbox>
                        {unsupported ? (
                          <p>
                            <Trans id="synced.wizard.unsupported">
                              Riosoma can’t hold this column’s type.
                            </Trans>{' '}
                            {column.sourceType}
                          </p>
                        ) : (
                          <>
                            <TextField
                              label={t({ id: 'synced.wizard.fieldName', message: 'Field name' })}
                              value={draft.name}
                              maxLength={255}
                              isDisabled={!draft.include}
                              onChange={(name) => change({ name })}
                            />
                            <Select
                              label={t({ id: 'synced.wizard.fieldType', message: 'Field type' })}
                              selectedKey={draft.type}
                              isDisabled={!draft.include}
                              onSelectionChange={(key) => change({ type: String(key) })}
                            >
                              {[...new Set([column.suggested!.type, ...column.alternatives])].flatMap(
                                (type) => {
                                  const spec = FieldSpec.safeParse({
                                    type,
                                    options: type === column.suggested?.type ? column.suggested.options : {},
                                  });
                                  return spec.success
                                    ? [
                                        <ListBoxItem id={type} key={type}>
                                          {i18n._(fieldTypeInfo(spec.data.type).name)}
                                        </ListBoxItem>,
                                      ]
                                    : [];
                                },
                              )}
                            </Select>
                          </>
                        )}
                        {column.notes?.map((note, position) => (
                          <p key={position} className="rio-synced-column__note">
                            {noteText(note)}
                          </p>
                        ))}
                      </div>
                    );
                  }}
                </FieldEditors>
                {hook && (
                  <div className="rio-synced-path">
                    <TextField
                      label={t({ id: 'synced.wizard.path', message: 'Add a path' })}
                      description={t({
                        id: 'synced.wizard.path.hint',
                        message:
                          'A path posts will have, like customer.email, when no post has shown it yet.',
                      })}
                      value={path}
                      maxLength={255}
                      isInvalid={pathIssue}
                      onChange={setPath}
                    />
                    <Button
                      isDisabled={!path.trim() || pathIssue}
                      onPress={addPath}
                      aria-label={t({ id: 'synced.wizard.path.add', message: 'Add' })}
                      icon={faPlus}
                    />
                  </div>
                )}
                <fieldset>
                  <legend>
                    <Trans id="synced.wizard.key">Key columns</Trans>
                  </legend>
                  <p>
                    {hook ? (
                      <Trans id="synced.wizard.keyHelpHook">
                        {
                          'Optional.  A post whose key matches a record updates it.  Without a key, every post adds records.'
                        }
                      </Trans>
                    ) : (
                      <Trans id="synced.wizard.keyHelp">
                        Values that identify each record from one sync to the next.
                      </Trans>
                    )}
                  </p>
                  <div
                    className="rio-synced-keys"
                    role="region"
                    aria-label={t({ id: 'synced.wizard.key', message: 'Key columns' })}
                    tabIndex={0}
                  >
                    {shown.columns.map((column) => (
                      <Checkbox
                        key={column.name}
                        isSelected={keys.includes(column.name)}
                        isDisabled={!column.suggested || (!keys.includes(column.name) && keys.length >= 8)}
                        onChange={(checked) =>
                          setKeys(
                            checked ? [...keys, column.name] : keys.filter((key) => key !== column.name),
                          )
                        }
                      >
                        {column.name}
                      </Checkbox>
                    ))}
                  </div>
                  {rowNumberKey && (
                    <Banner tone="warning">
                      {t({
                        id: 'synced.wizard.rowNumberKey',
                        message:
                          'Row numbers change when someone adds, removes, or sorts rows, and records then trade their own fields and overrides.  Choose a column whose values never change, if there is one.',
                      })}
                    </Banner>
                  )}
                </fieldset>
                <Select
                  label={t({ id: 'synced.wizard.primary', message: 'Primary field' })}
                  selectedKey={primary || null}
                  onSelectionChange={(key) => setPrimaryChoice(String(key))}
                >
                  {primaryColumns.map((column) => (
                    <ListBoxItem id={column.column} key={column.column}>
                      {column.name}
                    </ListBoxItem>
                  ))}
                </Select>
              </>
            )}
            {step === 3 && (
              <>
                <h3>
                  <Trans id="synced.wizard.settings">Settings</Trans>
                </h3>
                <TextField
                  label={t({ id: 'synced.wizard.name', message: 'Table name' })}
                  value={name}
                  onChange={setName}
                  maxLength={255}
                  isRequired
                />
                {!hook && (
                  <FreshnessChoice
                    value={settings.freshness}
                    kind={sourceKind}
                    onChange={(freshness) => setSettings({ ...settings, freshness })}
                  />
                )}
                <Schedule value={settings} kind={sourceKind} onChange={setSettings} />
                {feed && <RemoveMissing value={removeMissing} onChange={setRemoveMissing} />}
              </>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          {connecting ? (
            createdWebhook ? (
              <Button variant="primary" onPress={() => chooseSourceAndContinue(createdWebhook.meta.id)}>
                <Trans id="synced.wizard.connect.continue">Choose what to sync</Trans>
              </Button>
            ) : (
              <>
                <Button isDisabled={connect.busy} onPress={() => setConnecting(false)}>
                  <Trans id="synced.wizard.back">Back</Trans>
                </Button>
                <Button
                  onPress={() => connect.runTest()}
                  isDisabled={!connect.ready}
                  isPending={connect.testing}
                >
                  <Trans id="sources.test">Test connection</Trans>
                </Button>
                <Button
                  variant="primary"
                  onPress={() => connect.save()}
                  isDisabled={!connect.ready}
                  isPending={connect.saving}
                >
                  <Trans id="synced.wizard.connectSave">Save and continue</Trans>
                </Button>
              </>
            )
          ) : (
            <>
              {step > 0 && (
                <Button
                  isDisabled={pending}
                  onPress={() => {
                    setError('');
                    setStep(step - 1);
                  }}
                >
                  <Trans id="synced.wizard.back">Back</Trans>
                </Button>
              )}
              {step < 3 ? (
                <Button
                  variant="primary"
                  isDisabled={
                    pending ||
                    (step === 0
                      ? !sourceId
                      : step === 1
                        ? !select || (select.kind === 'query' && !select.sql.trim()) || filterIssue !== null
                        : !fieldsValid)
                  }
                  onPress={() => {
                    void next();
                  }}
                >
                  <Trans id="synced.wizard.next">Next</Trans>
                </Button>
              ) : (
                <Button
                  variant="primary"
                  isPending={pending}
                  isDisabled={!name.trim()}
                  onPress={() => {
                    void create();
                  }}
                >
                  <Trans id="synced.wizard.create">Create synced table</Trans>
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}

/** Large sources mount visible editors while the wizard retains every field draft. */
function FieldEditors({
  columns,
  children,
}: {
  columns: ColumnDraft[];
  children(column: ColumnDraft): ReactNode;
}) {
  const { t } = useLingui();
  const scroller = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ top: 0, height: 120, viewport: 480 });
  const previousHeight = useRef(layout.height);
  const [focused, setFocused] = useState<string>();
  const virtual = columns.length > 80;
  const first = Math.max(0, Math.floor(layout.top / layout.height) - 1);
  const last = Math.min(columns.length, Math.ceil((layout.top + layout.viewport) / layout.height) + 1);
  const pinned = columns.findIndex((column) => column.column === focused);
  const visible = columns
    .map((_, index) => index)
    .filter((index) => (index >= first && index < last) || index === pinned);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (virtual && element && previousHeight.current !== layout.height) {
      // Keep the same field in view when wrapping or notes make the editor rows taller.
      element.scrollTop = (element.scrollTop / previousHeight.current) * layout.height;
      const active = document.activeElement;
      if (active instanceof HTMLElement && element.contains(active)) {
        const viewport = element.getBoundingClientRect();
        const control = active.getBoundingClientRect();
        if (control.top < viewport.top) element.scrollTop -= viewport.top - control.top;
        else if (control.bottom > viewport.bottom) element.scrollTop += control.bottom - viewport.bottom;
      }
      const top = element.scrollTop;
      setLayout((previous) => (previous.top === top ? previous : { ...previous, top }));
    }
    previousHeight.current = layout.height;
  }, [virtual, layout.height]);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!virtual || !element) return;
    const measure = () => {
      const height = Math.max(
        120,
        ...Array.from(element.querySelectorAll<HTMLElement>('[data-field-index]')).map(
          (row) => row.getBoundingClientRect().height,
        ),
      );
      setLayout((previous) => {
        const next = {
          top: element.scrollTop,
          height: Math.max(previous.height, height),
          viewport: element.clientHeight || previous.viewport,
        };
        return next.top === previous.top &&
          next.height === previous.height &&
          next.viewport === previous.viewport
          ? previous
          : next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const row of element.querySelectorAll('[data-field-index]')) observer.observe(row);
    return () => observer.disconnect();
  }, [virtual, columns, first, last, pinned]);
  if (!virtual) return columns.map(children);
  const focus = (index: number, backwards = false) => {
    if (!columns[index] || !scroller.current) return;
    scroller.current.scrollTop = index * layout.height;
    flushSync(() => setLayout((previous) => ({ ...previous, top: scroller.current!.scrollTop })));
    const row = scroller.current.querySelector(`[data-field-index="${index}"]`);
    const controls = row?.querySelectorAll<HTMLElement>(
      'input:not(:disabled), button:not(:disabled), [tabindex="0"]',
    );
    (backwards ? controls?.item(controls.length - 1) : controls?.item(0))?.focus();
  };
  return (
    <div
      ref={scroller}
      className="rio-synced-editors"
      role="region"
      tabIndex={0}
      aria-label={t({ id: 'synced.wizard.fields', message: 'Choose fields' })}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        setLayout((previous) => (previous.top === top ? previous : { ...previous, top }));
      }}
      onFocusCapture={(event) => {
        const row = (event.target as Element).closest<HTMLElement>('[data-field-index]');
        if (row) setFocused(columns[Number(row.dataset.fieldIndex)]?.column);
      }}
      onKeyDownCapture={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Home' || event.key === 'End')) {
          event.preventDefault();
          focus(event.key === 'Home' ? 0 : columns.length - 1);
        } else if (event.key === 'Tab') {
          const row = (event.target as Element).closest<HTMLElement>('[data-field-index]');
          if (!row) return;
          const controls = row.querySelectorAll<HTMLElement>(
            'input:not(:disabled), button:not(:disabled), [tabindex="0"]',
          );
          const edge = event.shiftKey ? controls[0] : controls[controls.length - 1];
          const next = Number(row.dataset.fieldIndex) + (event.shiftKey ? -1 : 1);
          if (event.target === edge && columns[next]) {
            event.preventDefault();
            focus(next, event.shiftKey);
          }
        }
      }}
    >
      <ul
        style={{
          blockSize: columns.length * layout.height,
          position: 'relative',
          listStyle: 'none',
          margin: 0,
          padding: 0,
        }}
      >
        {visible.map((index) => (
          <li
            key={columns[index]!.column}
            data-field-index={index}
            aria-posinset={index + 1}
            aria-setsize={columns.length}
            style={{
              position: 'absolute',
              insetInline: 0,
              insetBlockStart: index * layout.height,
              minBlockSize: layout.height,
            }}
          >
            {children(columns[index]!)}
          </li>
        ))}
      </ul>
    </div>
  );
}
