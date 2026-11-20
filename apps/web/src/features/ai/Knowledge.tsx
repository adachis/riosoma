import { faTrashCan, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useSettingsSection, useSettingsLeaveGuard } from '../../screens/settings/SettingsDraft';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../../screens/settings/Setting';

import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import {
  KnowledgeSettings,
  DocumentImportSettings,
  roleAllows,
  type AiSettingsView,
  type DatabaseSchema,
  type MemoryNote,
  type RowData,
} from '@riosoma/contracts';
import { Button, Form, Heading, Link, ListBoxItem, Select, Spinner, Switch, TextField } from '@riosoma/ui';
import { api, ApiError, type ApiErrorInfo } from '../../api';
import { databasesQuery } from '../../data/databases';
import { useServerMessage } from '../../messages/useServerMessage';
import { useSession } from '../../session';
import { canManageAi } from './access';
import { databaseHref } from '../../screens/database/screen/routes';
import './Knowledge.css';
const embeddedPage = defineSettingsPage({
  area: 'admin',
  section: 'connections',
  page: 'ai',
  label: msg({ id: 'settings.nav.ai', message: 'AI' }),
  roles: ['organization-ai'],
});

const settingsPage = defineSettingsPage({
  area: 'personal',
  section: 'preferences',
  page: 'memories',
  label: msg({ id: 'knowledge.myMemories', message: 'My memories' }),
  roles: ['personal'],
  keywords: msg({ id: 'settings.search.keywords.memories', message: 'saved memories notes preferences' }),
});

export async function knowledgeCommand(body: Record<string, unknown>) {
  const result = await api<{ status: string; actionId: string; error?: ApiErrorInfo }>(
    '/api/knowledge/commands',
    { body: { ...body, id: crypto.randomUUID() } },
  );
  if (result.status === 'rejected') throw new ApiError(400, result.error!);
  return result.actionId;
}

function useChange() {
  const message = useServerMessage();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const run = async (body: Record<string, unknown>) => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const id = await knowledgeCommand(body);
      setLast(body.kind === 'knowledge.undo' ? null : id);
      await client.invalidateQueries({ queryKey: ['knowledge'] });
      return true;
    } catch (cause) {
      setError(message(cause instanceof ApiError ? cause.info.messageKey : 'errors.internal'));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    run,
    status: (
      <>
        {error && <p role="alert">{error}</p>}
        {last && (
          <div role="status">
            <Trans id="knowledge.saved">Saved</Trans>{' '}
            <Button isDisabled={busy} onPress={() => void run({ kind: 'knowledge.undo', actionId: last })}>
              <Trans id="knowledge.undo">Undo last change</Trans>
            </Button>
          </div>
        )}
      </>
    ),
  };
}

function Failure({ error }: { error: unknown }) {
  const message = useServerMessage();
  return <p role="alert">{message(error instanceof ApiError ? error.info.messageKey : 'errors.internal')}</p>;
}

function useDatabase(databaseId: string) {
  return useQuery({
    queryKey: ['knowledge', 'schema', databaseId],
    queryFn: () => api<DatabaseSchema>(`/api/databases/${encodeURIComponent(databaseId)}/schema`),
    enabled: Boolean(databaseId),
  });
}

export function PersonalMemories() {
  const requestLeave = useSettingsLeaveGuard();
  const { t } = useLingui();
  const query = useQuery(databasesQuery);
  const search = useSearch({ strict: false });
  const selected = 'database' in search && typeof search.database === 'string' ? search.database : '';
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'knowledge.myMemories', message: 'My memories' })}
    >
      {
        <section className="rio-knowledge">
          <Heading level={2} data-anchor="knowledge.myMemories">
            <Trans id="knowledge.myMemories">My memories</Trans>
          </Heading>
          <p>
            <Trans id="knowledge.personalHelp">
              Your notes stay private to you in the database you choose.
            </Trans>
          </p>
          <Link href={`?${new URLSearchParams({ database: selected, help: 'memory' })}`}>
            <Trans id="knowledge.memoryHelp">Help with memories</Trans>
          </Link>
          {query.isPending ? (
            <Spinner />
          ) : query.error ? (
            <Failure error={query.error} />
          ) : (
            <>
              <Setting
                page={settingsPage}
                id="database"
                label={msg({ id: 'knowledge.database', message: 'Database' })}
              >
                <Select
                  label={t({ id: 'knowledge.database', message: 'Database' })}
                  selectedKey={selected || null}
                  onSelectionChange={(value) => {
                    if (value)
                      void requestLeave().then((accepted) => {
                        if (accepted) {
                          window.history.pushState(
                            window.history.state,
                            '',
                            `/settings/memories?database=${encodeURIComponent(String(value))}`,
                          );
                          window.dispatchEvent(new PopStateEvent('popstate'));
                        }
                      });
                  }}
                >
                  {query.data.map((database) => (
                    <ListBoxItem key={database.id} id={database.id}>
                      {database.name}
                    </ListBoxItem>
                  ))}
                </Select>
              </Setting>
              {selected && (
                <>
                  <Link href={`/${encodeURIComponent(selected)}/settings/memories`}>
                    <Trans id="knowledge.databaseMemories">Database memories</Trans>
                  </Link>
                  <MemoryList key={selected} databaseId={selected} visibility="personal" editable />
                </>
              )}
            </>
          )}
        </section>
      }
    </Setting>
  );
}

function MemoryList({
  databaseId,
  visibility,
  editable,
}: {
  databaseId: string;
  visibility: 'personal' | 'database';
  editable: boolean;
}) {
  const { t } = useLingui();
  const query = useQuery({
    queryKey: ['knowledge', 'memories', databaseId, visibility],
    queryFn: () =>
      api<MemoryNote[]>(`/api/knowledge/memories?${new URLSearchParams({ databaseId, visibility })}`),
    refetchInterval: 10000,
  });
  const [text, setText] = useState('');
  const [added, setAdded] = useState<MemoryNote[]>([]);
  const change = useChange();
  const save = (memoryId: string, value: string | null) =>
    change.run({ kind: 'memory.save', databaseId, memoryId, visibility, text: value });
  const pageDraft = useSettingsSection({
    dirty: editable && (Boolean(text) || added.length > 0),
    discard: () => {
      setText('');
      setAdded([]);
    },
    validate: () =>
      added.some((note) => !note.text.trim()) || (Boolean(text) && !text.trim())
        ? t({ id: 'knowledge.noteRequired', message: 'Enter text for this note.' })
        : null,
    save: async () => {
      const submitted = [...added, ...(text.trim() ? [{ id: crypto.randomUUID(), text: text.trim() }] : [])];
      for (const note of submitted) {
        if (!(await save(note.id, note.text.trim()))) throw new Error('errors.internal');
        setAdded((current) => current.filter((entry) => entry.id !== note.id || entry.text !== note.text));
      }
      setText((current) => (current === text ? '' : current));
    },
  });
  return (
    <div className="rio-knowledge" aria-busy={change.busy}>
      {query.isPending ? (
        <Spinner />
      ) : query.error ? (
        <Failure error={query.error} />
      ) : (
        <>
          {!query.data.length && (
            <p>
              <Trans id="knowledge.noMemories">No notes saved yet.</Trans>
            </p>
          )}
          {query.data
            .filter((note) => !added.some((entry) => entry.id === note.id))
            .map((note) => (
              <Note key={note.id} note={note} editable={editable} busy={change.busy} save={save} />
            ))}
        </>
      )}
      {added.map((note) => (
        <article key={note.id} id={note.id} className="rio-knowledge__note">
          <Setting page={settingsPage} id="added-note" label={msg({ id: 'knowledge.note', message: 'Note' })}>
            <TextField
              label={t({ id: 'knowledge.note', message: 'Note' })}
              value={note.text}
              onChange={(text) =>
                setAdded((current) =>
                  current.map((entry) => (entry.id === note.id ? { ...entry, text } : entry)),
                )
              }
              maxLength={1000}
              isInvalid={!note.text.trim()}
              errorMessage={t({ id: 'knowledge.noteRequired', message: 'Enter text for this note.' })}
            />
          </Setting>
          <Button
            onPress={() => setAdded((current) => current.filter((entry) => entry.id !== note.id))}
            aria-label={t({ id: 'knowledge.delete', message: 'Delete' })}
            icon={faTrashCan}
          />
        </article>
      ))}
      {editable && (
        <Form
          onSubmit={async (event) => {
            event.preventDefault();
            if (pageDraft.active) {
              if (!text.trim()) return;
              setAdded((current) => [
                ...current,
                {
                  id: crypto.randomUUID(),
                  databaseId,
                  visibility,
                  text: text.trim(),
                  updatedAt: new Date().toISOString(),
                },
              ]);
              setText('');
            } else if (await save(crypto.randomUUID(), text.trim())) setText('');
          }}
        >
          <Setting
            page={settingsPage}
            id="new-note"
            label={msg({ id: 'knowledge.newNote', message: 'New note' })}
          >
            <TextField
              label={t({ id: 'knowledge.newNote', message: 'New note' })}
              value={text}
              onChange={setText}
              maxLength={1000}
              isRequired
            />
          </Setting>
          <Button type="submit" isDisabled={change.busy || !text.trim()}>
            <Trans id="knowledge.addNote">Add note</Trans>
          </Button>
        </Form>
      )}
      {change.status}
    </div>
  );
}

function Note({
  note,
  editable,
  busy,
  save,
}: {
  note: MemoryNote;
  editable: boolean;
  busy: boolean;
  save(id: string, text: string | null): Promise<boolean>;
}) {
  const { t } = useLingui();
  const [text, setText] = useState(note.text);
  const pageDraft = useSettingsSection({
    dirty: editable && text !== note.text,
    stored: note.text,
    discard: () => setText(note.text),
    validate: () =>
      text.trim() ? null : t({ id: 'knowledge.noteRequired', message: 'Enter text for this note.' }),
    save: async () => {
      if (!(await save(note.id, text.trim()))) throw new Error('errors.internal');
    },
  });
  return (
    <article id={note.id} className="rio-knowledge__note">
      {editable ? (
        <Form
          onSubmit={(event) => {
            event.preventDefault();
            if (pageDraft.active) void pageDraft.save?.();
            else void save(note.id, text.trim());
          }}
        >
          <Setting page={settingsPage} id="note" label={msg({ id: 'knowledge.note', message: 'Note' })}>
            <TextField
              label={t({ id: 'knowledge.note', message: 'Note' })}
              value={text}
              onChange={setText}
              maxLength={1000}
              isRequired
            />
          </Setting>
          <div className="rio-knowledge__actions">
            {!pageDraft.active && (
              <Button type="submit" isDisabled={busy || !text.trim() || text === note.text}>
                <Trans id="knowledge.save">Save</Trans>
              </Button>
            )}
            <Button
              isDisabled={busy}
              onPress={() => void save(note.id, null)}
              aria-label={t({ id: 'knowledge.delete', message: 'Delete' })}
              icon={faTrashCan}
            />
            <Link href={`#${note.id}`}>
              <Trans id="knowledge.noteLink">Link to note</Trans>
            </Link>
          </div>
        </Form>
      ) : (
        <p>{note.text}</p>
      )}
    </article>
  );
}

export function DatabaseMemories() {
  const { t } = useLingui();
  const { databaseId = '' } = useParams({ strict: false });
  const query = useDatabase(databaseId);
  return (
    <main className="rio-knowledge rio-knowledge--page">
      <Heading level={1} data-anchor="knowledge.databaseMemories">
        <Trans id="knowledge.databaseMemories">Database memories</Trans>
      </Heading>
      <Link href={databaseHref(databaseId)}>
        <Trans id="knowledge.back">Back to database</Trans>
      </Link>
      <Link href="?help=memory">
        <Trans id="knowledge.memoryHelp">Help with memories</Trans>
      </Link>
      <p>
        {t({
          id: 'knowledge.sharedHelp',
          message: 'Anyone who can open this database can read these notes.  Creators can edit them.',
        })}
      </p>
      {query.isPending ? (
        <Spinner />
      ) : query.error ? (
        <Failure error={query.error} />
      ) : (
        <MemoryList
          databaseId={databaseId}
          visibility="database"
          editable={roleAllows(query.data.database.role, 'editSchema')}
        />
      )}
      <Link href={`/${encodeURIComponent(databaseId)}/settings/similar`}>
        <Trans id="knowledge.similar">Find similar records</Trans>
      </Link>
    </main>
  );
}

export function KnowledgeAdmin({ view }: { view: AiSettingsView }) {
  const change = useChange();
  const query = useQuery({
    queryKey: ['knowledge', 'settings'],
    queryFn: () =>
      api<KnowledgeSettings & { searchKeys?: Record<string, boolean> }>('/api/knowledge/settings'),
  });
  return (
    <section className="rio-knowledge">
      <Heading level={2}>
        <Trans id="knowledge.settings">Memory and search</Trans>
      </Heading>
      {query.isPending ? (
        <Spinner />
      ) : query.error ? (
        <Failure error={query.error} />
      ) : (
        <KnowledgeForm initial={query.data} view={view} change={change} />
      )}
      {change.status}
    </section>
  );
}

function KnowledgeForm({
  initial,
  view,
  change,
}: {
  initial: KnowledgeSettings & { searchKeys?: Record<string, boolean> };
  view: AiSettingsView;
  change: ReturnType<typeof useChange>;
}) {
  const { t } = useLingui();
  const cache = useQueryClient();
  const [imports, setImports] = useState(() => DocumentImportSettings.parse(initial.imports ?? {}));
  const [memory, setMemory] = useState(initial.memory);
  const [enabled, setEnabled] = useState(initial.search.enabled);
  const [address, setAddress] = useState(initial.search.address ?? '');
  const [engine, setEngine] = useState(initial.search.engine);
  const [embedding, setEmbedding] = useState(Boolean(initial.embedding));
  const [providerId, setProvider] = useState(initial.embedding?.providerId ?? '');
  const [model, setModel] = useState(initial.embedding?.model ?? '');
  const [endpoint, setEndpoint] = useState(initial.embedding?.address ?? '');
  const [protocol, setProtocol] = useState(initial.embedding?.protocol ?? 'compatible');
  const [key, setKey] = useState('');
  const [searchPower, setSearchPower] = useState(String(initial.search.powerWatts ?? ''));
  const [embeddingPower, setEmbeddingPower] = useState(String(initial.embedding?.powerWatts ?? ''));
  const [validated, setValidated] = useState(false);
  const searchChanged =
    !initial.search.enabled ||
    engine !== initial.search.engine ||
    address.trim() !== (initial.search.address ?? '');
  const missingAddress = enabled && searchChanged && !address.trim();
  // A stored key stays with the service and address it was entered for, so changing either needs
  // the key typed again.
  const retargeted = engine !== initial.search.engine || address.trim() !== (initial.search.address ?? '');
  const missingKey =
    enabled &&
    searchChanged &&
    engine !== 'searxng' &&
    !key.trim() &&
    (retargeted || !initial.searchKeys?.[engine]);
  const invalidMessage = t({
    id: 'knowledge.invalidDraft',
    message: 'Check the document import, search, and embedding settings.',
  });
  const fieldInvalid = (...path: string[]) =>
    validated &&
    !parsed.success &&
    parsed.error.issues.some((issue) => path.join('.') === issue.path.join('.'));
  const parsed = KnowledgeSettings.safeParse({
    libraries: initial.libraries,
    imports,
    memory,
    search: {
      enabled,
      engine,
      address: address.trim() || null,
      powerWatts: searchPower.trim() ? Number(searchPower) : null,
    },
    embedding: embedding
      ? {
          providerId,
          model: model.trim(),
          address: endpoint.trim(),
          protocol,
          powerWatts: embeddingPower.trim() ? Number(embeddingPower) : null,
        }
      : null,
  });
  const pageDraft = useSettingsSection({
    dirty:
      !parsed.success ||
      JSON.stringify(parsed.data) !==
        JSON.stringify(
          KnowledgeSettings.parse({
            ...initial,
            imports: DocumentImportSettings.parse(initial.imports ?? {}),
            search: { ...initial.search, powerWatts: initial.search.powerWatts ?? null },
            embedding: initial.embedding
              ? { ...initial.embedding, powerWatts: initial.embedding.powerWatts ?? null }
              : null,
          }),
        ) ||
      Boolean(key),
    stored: initial,
    discard: () => {
      setValidated(false);
      setImports(DocumentImportSettings.parse(initial.imports ?? {}));
      setMemory(initial.memory);
      setEnabled(initial.search.enabled);
      setAddress(initial.search.address ?? '');
      setEngine(initial.search.engine);
      setEmbedding(Boolean(initial.embedding));
      setProvider(initial.embedding?.providerId ?? '');
      setModel(initial.embedding?.model ?? '');
      setEndpoint(initial.embedding?.address ?? '');
      setProtocol(initial.embedding?.protocol ?? 'compatible');
      setSearchPower(String(initial.search.powerWatts ?? ''));
      setEmbeddingPower(String(initial.embedding?.powerWatts ?? ''));
      setKey('');
    },
    validate: () => {
      setValidated(true);
      if (missingAddress)
        return t({
          id: 'knowledge.searchAddressRequired',
          message: 'Enter a search service address before enabling web search.',
        });
      if (missingKey)
        return t({
          id: 'knowledge.searchKeyRequired',
          message: 'Enter a search API key before enabling this search service.',
        });
      return parsed.success ? null : invalidMessage;
    },
    save: async () => {
      if (!parsed.success) return;
      if (
        !(await change.run({
          kind: 'knowledge.settings',
          settings: {
            ...parsed.data,
            libraries:
              cache.getQueryData<KnowledgeSettings>(['knowledge', 'settings'])?.libraries ??
              initial.libraries,
          },
          // The key goes with the settings it belongs to, in one change.
          ...(key.trim() && engine !== 'searxng' ? { searchKey: key.trim() } : {}),
        }))
      )
        throw new Error('errors.internal');
      setKey('');
    },
  });
  return (
    <div className="rio-knowledge">
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          void pageDraft.save?.();
        }}
      >
        <fieldset disabled={change.busy}>
          <legend>{t({ id: 'import.document.settings', message: 'Photo and messy file imports' })}</legend>
          <Setting
            page={embeddedPage}
            id="knowledge-upload-limit"
            label={msg({ id: 'import.document.uploadLimit', message: 'Maximum upload size (bytes)' })}
          >
            <TextField
              label={t({ id: 'import.document.uploadLimit', message: 'Maximum upload size (bytes)' })}
              inputMode="numeric"
              isInvalid={fieldInvalid('imports', 'uploadBytes')}
              errorMessage={invalidMessage}
              value={String(imports.uploadBytes)}
              onChange={(value) => setImports({ ...imports, uploadBytes: Number(value) })}
            />
          </Setting>
          <Setting
            page={embeddedPage}
            id="knowledge-page-limit"
            label={msg({ id: 'import.document.pageLimit', message: 'Maximum PDF pages or workbook sheets' })}
          >
            <TextField
              label={t({ id: 'import.document.pageLimit', message: 'Maximum PDF pages or workbook sheets' })}
              inputMode="numeric"
              isInvalid={fieldInvalid('imports', 'pages')}
              errorMessage={invalidMessage}
              value={String(imports.pages)}
              onChange={(value) => setImports({ ...imports, pages: Number(value) })}
            />
          </Setting>
          {(['model', 'localModel'] as const).map((kind) => (
            <div key={kind}>
              <Setting
                page={embeddedPage}
                id="knowledge-provider"
                label={msg({ id: 'import.document.provider', message: 'Document provider' })}
              >
                <Select
                  label={
                    kind === 'model'
                      ? t({ id: 'import.document.provider', message: 'Document provider' })
                      : t({ id: 'import.document.localProvider', message: 'Local document provider' })
                  }
                  isInvalid={fieldInvalid('imports', kind, 'providerId')}
                  errorMessage={invalidMessage}
                  selectedKey={imports[kind]?.providerId ?? 'default'}
                  onSelectionChange={(value) =>
                    setImports({
                      ...imports,
                      [kind]: value === 'default' ? null : { providerId: String(value), model: '' },
                    })
                  }
                >
                  <ListBoxItem id="default">
                    {kind === 'model'
                      ? t({ id: 'import.document.automatic', message: 'Use an available vision model' })
                      : t({ id: 'import.document.noLocal', message: 'No local override' })}
                  </ListBoxItem>
                  {view.providers
                    .filter(
                      (provider) =>
                        (kind !== 'localModel' || provider.local) &&
                        view.settings.providers.some((allowed) => allowed.providerId === provider.providerId),
                    )
                    .map((provider) => (
                      <ListBoxItem key={provider.providerId} id={provider.providerId}>
                        {provider.name}
                      </ListBoxItem>
                    ))}
                </Select>
              </Setting>
              {imports[kind] && (
                <Setting
                  page={embeddedPage}
                  id="knowledge-model"
                  label={msg({ id: 'import.document.model', message: 'Vision model' })}
                >
                  <TextField
                    label={
                      kind === 'model'
                        ? t({ id: 'import.document.model', message: 'Vision model' })
                        : t({ id: 'import.document.localModel', message: 'Local vision model' })
                    }
                    isInvalid={fieldInvalid('imports', kind, 'model')}
                    errorMessage={invalidMessage}
                    value={imports[kind].model}
                    onChange={(model) => setImports({ ...imports, [kind]: { ...imports[kind]!, model } })}
                    isRequired
                  />
                </Setting>
              )}
            </div>
          ))}
          <Setting
            page={embeddedPage}
            id="knowledge-power"
            label={msg({ id: 'import.document.power', message: 'Local document power per request (watts)' })}
          >
            <TextField
              label={t({ id: 'import.document.power', message: 'Local document power per request (watts)' })}
              inputMode="decimal"
              isInvalid={fieldInvalid('imports', 'powerWatts')}
              errorMessage={invalidMessage}
              value={imports.powerWatts === null ? '' : String(imports.powerWatts)}
              onChange={(value) =>
                setImports({ ...imports, powerWatts: value.trim() ? Number(value) : null })
              }
            />
          </Setting>
          <p>
            {t({
              id: 'import.document.localHelp',
              message:
                'A local override handles images and spreadsheets on your hardware.  It never falls back to a remote provider.  For scanned PDFs with a local model, upload each page as an image.',
            })}
          </p>
          <Link href="?help=importing">
            {t({ id: 'import.document.helpLink', message: 'Help with document imports' })}
          </Link>
        </fieldset>
        <Setting
          page={embeddedPage}
          id="knowledge-memory-enabled"
          label={msg({ id: 'knowledge.memoryEnabled', message: 'Use saved memories' })}
        >
          <Switch isSelected={memory} onChange={setMemory}>
            <Trans id="knowledge.memoryEnabled">Use saved memories</Trans>
          </Switch>
        </Setting>
        <Heading level={3} data-anchor="knowledge.webSearch">
          <Trans id="knowledge.webSearch">Web search</Trans>
        </Heading>
        <Setting
          page={embeddedPage}
          id="knowledge-search-enabled"
          label={msg({ id: 'knowledge.searchEnabled', message: 'Allow web search' })}
        >
          <Switch isSelected={enabled} onChange={setEnabled}>
            <Trans id="knowledge.searchEnabled">Allow web search</Trans>
          </Switch>
        </Setting>
        <Setting
          page={embeddedPage}
          id="knowledge-search-engine"
          label={msg({ id: 'knowledge.searchEngine', message: 'Search service' })}
        >
          <Select
            label={t({ id: 'knowledge.searchEngine', message: 'Search service' })}
            selectedKey={engine}
            onSelectionChange={(value) => setEngine(value as typeof engine)}
          >
            <ListBoxItem id="searxng">
              {t({ id: 'knowledge.selfHosted', message: 'Self-hosted search' })}
            </ListBoxItem>
            <ListBoxItem id="subscription">
              {t({ id: 'knowledge.subscription', message: 'Subscription token API' })}
            </ListBoxItem>
            <ListBoxItem id="research">
              {t({ id: 'knowledge.research', message: 'Bearer search API' })}
            </ListBoxItem>
          </Select>
        </Setting>
        <Setting
          page={embeddedPage}
          id="knowledge-search-address"
          label={msg({ id: 'knowledge.searchAddress', message: 'Search service address' })}
        >
          <TextField
            label={t({ id: 'knowledge.searchAddress', message: 'Search service address' })}
            value={address}
            isInvalid={fieldInvalid('search', 'address') || missingAddress}
            errorMessage={
              missingAddress
                ? t({
                    id: 'knowledge.searchAddressRequired',
                    message: 'Enter a search service address before enabling web search.',
                  })
                : invalidMessage
            }
            onChange={setAddress}
            type="url"
          />
        </Setting>
        <Setting
          page={embeddedPage}
          id="knowledge-search-power"
          label={msg({ id: 'knowledge.searchPower', message: 'Search power per request (watts)' })}
        >
          <TextField
            label={t({ id: 'knowledge.searchPower', message: 'Search power per request (watts)' })}
            description={t({
              id: 'knowledge.powerHelp',
              message:
                'Use measured or documented service power allocated to one request, including hosting overhead.  Leave blank when unknown.',
            })}
            value={searchPower}
            isInvalid={fieldInvalid('search', 'powerWatts')}
            errorMessage={invalidMessage}
            onChange={setSearchPower}
            inputMode="decimal"
          />
        </Setting>
        <Link href="?help=web-search">
          <Trans id="knowledge.searchHelp">Help with web search</Trans>
        </Link>
        <Heading level={3} data-anchor="knowledge.embeddings">
          <Trans id="knowledge.embeddings">Embeddings</Trans>
        </Heading>
        <Setting
          page={embeddedPage}
          id="knowledge-embedding-enabled"
          label={msg({ id: 'knowledge.embeddingEnabled', message: 'Use embeddings' })}
        >
          <Switch isSelected={embedding} onChange={setEmbedding}>
            <Trans id="knowledge.embeddingEnabled">Use embeddings</Trans>
          </Switch>
        </Setting>
        {embedding && (
          <>
            <Setting
              page={embeddedPage}
              id="knowledge-provider-2"
              label={msg({ id: 'knowledge.provider', message: 'Embedding provider' })}
            >
              <Select
                label={t({ id: 'knowledge.provider', message: 'Embedding provider' })}
                selectedKey={providerId || null}
                isInvalid={fieldInvalid('embedding', 'providerId')}
                errorMessage={invalidMessage}
                onSelectionChange={(value) => setProvider(String(value))}
              >
                {view.providers
                  .filter((provider) =>
                    view.settings.providers.some((allowed) => allowed.providerId === provider.providerId),
                  )
                  .map((provider) => (
                    <ListBoxItem key={provider.providerId} id={provider.providerId}>
                      {provider.name}
                    </ListBoxItem>
                  ))}
              </Select>
            </Setting>
            <Setting
              page={embeddedPage}
              id="knowledge-model-2"
              label={msg({ id: 'knowledge.model', message: 'Embedding model' })}
            >
              <TextField
                label={t({ id: 'knowledge.model', message: 'Embedding model' })}
                value={model}
                isInvalid={fieldInvalid('embedding', 'model')}
                errorMessage={invalidMessage}
                onChange={setModel}
                isRequired
              />
            </Setting>
            <Setting
              page={embeddedPage}
              id="knowledge-embedding-address"
              label={msg({ id: 'knowledge.embeddingAddress', message: 'Embedding API base address' })}
            >
              <TextField
                label={t({ id: 'knowledge.embeddingAddress', message: 'Embedding API base address' })}
                value={endpoint}
                isInvalid={fieldInvalid('embedding', 'address')}
                errorMessage={invalidMessage}
                onChange={setEndpoint}
                type="url"
                isRequired
              />
            </Setting>
            <Setting
              page={embeddedPage}
              id="knowledge-embedding-power"
              label={msg({ id: 'knowledge.embeddingPower', message: 'Embedding power per request (watts)' })}
            >
              <TextField
                label={t({ id: 'knowledge.embeddingPower', message: 'Embedding power per request (watts)' })}
                description={t({
                  id: 'knowledge.powerHelp',
                  message:
                    'Use measured or documented service power allocated to one request, including hosting overhead.  Leave blank when unknown.',
                })}
                value={embeddingPower}
                isInvalid={fieldInvalid('embedding', 'powerWatts')}
                errorMessage={invalidMessage}
                onChange={setEmbeddingPower}
                inputMode="decimal"
              />
            </Setting>
            <Setting
              page={embeddedPage}
              id="knowledge-protocol"
              label={msg({ id: 'knowledge.protocol', message: 'Embedding API format' })}
            >
              <Select
                label={t({ id: 'knowledge.protocol', message: 'Embedding API format' })}
                selectedKey={protocol}
                onSelectionChange={(value) => setProtocol(value as typeof protocol)}
              >
                <ListBoxItem id="compatible">
                  {t({ id: 'knowledge.compatible', message: 'Compatible embeddings API' })}
                </ListBoxItem>
                <ListBoxItem id="local">
                  {t({ id: 'knowledge.local', message: 'Local embedding API' })}
                </ListBoxItem>
              </Select>
            </Setting>
          </>
        )}
        <Link href="?help=similar-records">
          <Trans id="knowledge.embeddingHelp">Help with embeddings</Trans>
        </Link>
      </Form>
      {engine !== 'searxng' && (
        <Form
          onSubmit={async (event) => {
            event.preventDefault();
            void pageDraft.save?.();
          }}
        >
          <Setting
            page={embeddedPage}
            id="knowledge-key"
            label={msg({ id: 'knowledge.key', message: 'Search API key' })}
          >
            <TextField
              label={t({ id: 'knowledge.key', message: 'Search API key' })}
              value={key}
              isInvalid={missingKey}
              errorMessage={t({
                id: 'knowledge.searchKeyRequired',
                message: 'Enter a search API key before enabling this search service.',
              })}
              onChange={setKey}
              type="password"
              autoComplete="new-password"
            />
          </Setting>
          <div className="rio-knowledge__actions">
            <Button
              isDisabled={change.busy}
              onPress={() => void change.run({ kind: 'knowledge.key', engine, key: null })}
              aria-label={t({ id: 'knowledge.removeKey', message: 'Remove key' })}
              icon={faXmark}
            />
          </div>
        </Form>
      )}
    </div>
  );
}

export function SimilarRecords() {
  const { t } = useLingui();
  const { databaseId = '' } = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const query = useDatabase(databaseId);
  const admin = canManageAi(useSession());
  const tables = useQuery({
    queryKey: ['knowledge', 'tables', databaseId],
    queryFn: () =>
      api<Array<{ tableId: string; enabled: boolean; pending: boolean }>>(
        `/api/knowledge/tables?databaseId=${encodeURIComponent(databaseId)}`,
      ),
    refetchInterval: 10000,
  });
  const [tableId, setTable] = useState(
    'table' in search && typeof search.table === 'string' ? search.table : '',
  );
  const [text, setText] = useState('query' in search && typeof search.query === 'string' ? search.query : '');
  const [results, setResults] = useState<RowData[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const requestVersion = useRef(0);
  useEffect(
    () => () => {
      requestVersion.current += 1;
    },
    [databaseId],
  );
  const change = useChange();
  const indexed = tables.data?.find((row) => row.tableId === tableId);
  async function find() {
    const version = ++requestVersion.current;
    setBusy(true);
    setError(null);
    setResults(null);
    const params = new URLSearchParams({ table: tableId, query: text });
    window.history.replaceState(window.history.state, '', `?${params}`);
    try {
      const result = await api<{ records: RowData[] }>('/api/knowledge/similar', {
        body: { tableId, text, limit: 10 },
      });
      if (version === requestVersion.current) setResults(result.records);
    } catch (cause) {
      if (version === requestVersion.current) setError(cause);
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  }
  return (
    <main className="rio-knowledge rio-knowledge--page">
      <Heading level={1} data-anchor="knowledge.similar">
        <Trans id="knowledge.similar">Find similar records</Trans>
      </Heading>
      <Link href={databaseHref(databaseId)}>
        <Trans id="knowledge.back">Back to database</Trans>
      </Link>
      <Link href={`?${new URLSearchParams({ table: tableId, query: text, help: 'similar-records' })}`}>
        <Trans id="knowledge.embeddingHelp">Help with embeddings</Trans>
      </Link>
      {query.isPending ? (
        <Spinner />
      ) : query.error ? (
        <Failure error={query.error} />
      ) : (
        <>
          <Form
            onSubmit={(event) => {
              event.preventDefault();
              void find();
            }}
          >
            <Select
              label={t({ id: 'knowledge.table', message: 'Table' })}
              selectedKey={tableId || null}
              onSelectionChange={(value) => {
                requestVersion.current += 1;
                setBusy(false);
                setError(null);
                setTable(String(value));
                setResults(null);
                const params = new URLSearchParams({ table: String(value), query: text });
                window.history.replaceState(window.history.state, '', `?${params}`);
              }}
            >
              {query.data.tables.map((table) => (
                <ListBoxItem id={table.id} key={table.id}>
                  {table.name}
                </ListBoxItem>
              ))}
            </Select>
            {tableId && admin && (
              <Switch
                isSelected={indexed?.enabled ?? false}
                isDisabled={change.busy}
                onChange={(enabled) =>
                  void change.run({ kind: 'embedding.table', databaseId, tableId, enabled })
                }
              >
                <Trans id="knowledge.indexTable">Index this table for similar records</Trans>
              </Switch>
            )}
            {indexed?.pending && indexed.enabled && (
              <p role="status">
                {t({
                  id: 'knowledge.indexPending',
                  message: 'This table is being indexed.  Results may be incomplete.',
                })}
              </p>
            )}
            <TextField
              label={t({ id: 'knowledge.similarText', message: 'Find records about' })}
              value={text}
              onChange={setText}
              maxLength={2000}
              isRequired
            />
            <Button type="submit" isDisabled={busy || !tableId || !text.trim() || !indexed?.enabled}>
              <Trans id="knowledge.find">Find records</Trans>
            </Button>
          </Form>
          {tables.error && <Failure error={tables.error} />}
          {busy && <Spinner />}
          {error !== null && <Failure error={error} />}
          <div aria-live="polite">
            {results &&
              (results.length ? (
                <ul>
                  {results.map((row) => {
                    const view = query.data.views.find((item) => item.tableId === tableId);
                    const table = query.data.tables.find((item) => item.id === tableId);
                    const name = table?.primaryFieldId ? row.values[table.primaryFieldId] : undefined;
                    return (
                      <li key={row.id}>
                        <Link href={databaseHref(databaseId, tableId, view?.id, row.id)}>
                          {typeof name === 'string' && name ? name : row.id}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p>
                  <Trans id="knowledge.noSimilar">No similar records found.</Trans>
                </p>
              ))}
          </div>
        </>
      )}
      {change.status}
    </main>
  );
}
