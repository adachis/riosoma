import { faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { useSettingsSection, useSettingsLeaveGuard } from '../../screens/settings/SettingsDraft';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../../screens/settings/Setting';

import { useId, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import {
  KnowledgeSettings,
  LibraryDetails,
  type KnowledgeLibrary,
  type KnowledgeDocument,
  type KnowledgePassage,
  type LibraryScope,
} from '@riosoma/contracts';
import { Button, Form, Heading, Link, ListBoxItem, Select, Spinner, TextArea, TextField } from '@riosoma/ui';
import { api, ApiError } from '../../api';
import { useServerMessage } from '../../messages/useServerMessage';
import { useSession } from '../../session';
import { unitsQuery } from '../../screens/settings/units/UnitFilter';
import { rolesAt } from '../../screens/settings/units/access';
import { canManageAi } from './access';
import './Knowledge.css';
import './Libraries.css';
const embeddedPage = defineSettingsPage({
  area: 'admin',
  section: 'connections',
  page: 'ai',
  label: msg({ id: 'settings.nav.ai', message: 'AI' }),
  roles: ['ai'],
});

const settingsPage = defineSettingsPage({
  area: 'personal',
  section: 'preferences',
  page: 'knowledge',
  label: msg({ id: 'libraries.personal', message: 'Personal knowledge' }),
  roles: ['personal'],
  keywords: msg({
    id: 'settings.search.keywords.knowledge',
    message: 'personal knowledge documents library guidance',
  }),
});

const libraryKey = ['knowledge', 'libraries'];
const sameScope = (left: LibraryScope, right: LibraryScope) => JSON.stringify(left) === JSON.stringify(right);
export function LibraryReader() {
  const { libraryId } = useParams({ from: '/app/knowledge/$libraryId' });
  const message = useServerMessage();
  const list = useQuery({
    queryKey: libraryKey,
    queryFn: () => api<KnowledgeLibrary[]>('/api/knowledge/libraries'),
  });
  if (list.isPending) return <Spinner />;
  const library = list.data?.find((entry) => entry.id === libraryId);
  if (!library)
    return (
      <p role="alert">
        {message(list.error instanceof ApiError ? list.error.info.messageKey : 'errors.notFound')}
      </p>
    );
  return (
    <div className="rio-knowledge rio-knowledge--page">
      <Heading level={1}>{library.name}</Heading>
      <KnowledgeLibraryPanel scope={library.scope} basePath={`/knowledge/${libraryId}`} />
    </div>
  );
}
export function PersonalLibrary() {
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'libraries.personal', message: 'Personal knowledge' })}
    >
      {<KnowledgeLibraryPanel scope={{ kind: 'personal' }} />}
    </Setting>
  );
}
export function DatabaseLibrary() {
  const { databaseId } = useParams({ from: '/app/$databaseId/settings/knowledge' });
  return (
    <main className="rio-knowledge rio-knowledge--page">
      <Link href={`/${databaseId}`}>
        <Trans id="libraries.back">Back to database</Trans>
      </Link>
      <KnowledgeLibraryPanel scope={{ kind: 'database', databaseId }} />
    </main>
  );
}
export function AdminLibraries() {
  const requestLeave = useSettingsLeaveGuard();
  const session = useSession();
  const { t } = useLingui();
  const tree = useQuery(unitsQuery);
  const search = useSearch({ strict: false }) as { unit?: string };
  const [unit, setUnit] = useState(search.unit ?? '');
  const units = (tree.data ?? []).filter((entry) =>
    rolesAt(session, tree.data ?? [], entry.id, ['ai']).includes('ai'),
  );
  const selected = unit || (canManageAi(session) ? '' : units[0]?.id);
  if (!canManageAi(session) && !selected) return tree.isPending ? <Spinner /> : null;
  return (
    <section className="rio-knowledge" id="knowledge">
      <Heading level={2} data-anchor="libraries.title">
        <Trans id="libraries.title">Knowledge</Trans>
      </Heading>
      {units.length > 0 && (
        <Setting
          page={embeddedPage}
          id="libraries-scope"
          label={msg({ id: 'libraries.scope', message: 'Library scope' })}
        >
          <Select
            label={t({ id: 'libraries.scope', message: 'Library scope' })}
            selectedKey={selected || 'organization'}
            onSelectionChange={(value) => {
              void requestLeave().then((accepted) => {
                if (accepted) setUnit(value === 'organization' ? '' : String(value));
              });
            }}
          >
            {canManageAi(session) && (
              <ListBoxItem id="organization">
                <Trans id="libraries.organization">Organization</Trans>
              </ListBoxItem>
            )}
            {units.map((entry) => (
              <ListBoxItem key={entry.id} id={entry.id}>
                {entry.name}
              </ListBoxItem>
            ))}
          </Select>
        </Setting>
      )}
      <KnowledgeLibraryPanel
        key={selected}
        scope={selected ? { kind: 'unit', unitId: selected } : { kind: 'organization' }}
      />
      {canManageAi(session) && <LibraryLimits />}
    </section>
  );
}

export function KnowledgeLibraryPanel({ scope, basePath }: { scope: LibraryScope; basePath?: string }) {
  const { t } = useLingui();
  const message = useServerMessage();
  const cache = useQueryClient();
  const search = useSearch({ strict: false }) as { library?: string; document?: string; query?: string };
  const list = useQuery({
    queryKey: libraryKey,
    queryFn: () => api<KnowledgeLibrary[]>('/api/knowledge/libraries'),
  });
  const library = list.data?.find((entry) => sameScope(entry.scope, scope));
  const [draftId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const documents = useQuery({
    queryKey: [...libraryKey, library?.id],
    queryFn: () => api<KnowledgeDocument[]>(`/api/knowledge/libraries/${library!.id}/documents`),
    enabled: Boolean(library),
    // Indexing finishes after the upload answers, so the list asks again until every document is done.
    refetchInterval: (query) =>
      query.state.data?.some((document) => document.status === 'indexing') ? 1500 : false,
  });
  // Search results belong to the documents as they were searched, not to each check on their progress.
  const revision = (documents.data ?? [])
    .map((document) => `${document.id}:${document.status}:${document.updatedAt}`)
    .join('|');
  async function change(command: Record<string, unknown>) {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ status: string; actionId: string; error?: { messageKey: string } }>(
        '/api/knowledge/library-commands',
        { body: { id: crypto.randomUUID(), ...command } },
      );
      if (result.status === 'rejected') {
        setError(message(result.error?.messageKey ?? 'errors.internal'));
        return false;
      }
      setAction(result.actionId);
      await cache.invalidateQueries({ queryKey: libraryKey });
      return true;
    } catch (cause) {
      setError(message(cause instanceof ApiError ? cause.info.messageKey : 'errors.internal'));
      return false;
    } finally {
      setBusy(false);
    }
  }
  if (list.isPending) return <Spinner />;
  if (list.error)
    return (
      <p role="alert">
        {message(list.error instanceof ApiError ? list.error.info.messageKey : 'errors.internal')}
      </p>
    );
  const libraryId = library?.id ?? draftId;
  const base =
    basePath ??
    (scope.kind === 'database'
      ? `/${scope.databaseId}/settings/knowledge`
      : scope.kind === 'personal'
        ? '/settings/knowledge'
        : '/settings/ai');
  const params = new URLSearchParams({
    library: libraryId,
    ...(scope.kind === 'unit' ? { unit: scope.unitId } : {}),
  });
  const canManage = library?.canManage ?? true;
  return (
    <div className="rio-knowledge rio-libraries" aria-busy={busy}>
      {scope.kind === 'personal' && (
        <Heading level={2} data-anchor="libraries.personal">
          <Trans id="libraries.personal">Personal knowledge</Trans>
        </Heading>
      )}
      {scope.kind === 'database' && (
        <Heading level={1} data-anchor="libraries.database">
          <Trans id="libraries.database">Database knowledge</Trans>
        </Heading>
      )}
      <p>
        {t({
          id: 'libraries.help',
          message:
            'Documents are searched when a question needs them.  Short guidance is included in every conversation.',
        })}
      </p>
      <Link
        href={`${window.location.pathname}${window.location.search ? `${window.location.search}&` : '?'}help=knowledge-libraries${window.location.hash}`}
      >
        <Trans id="libraries.helpLink">Help with knowledge</Trans>
      </Link>
      {library && (
        <Link href={`${base}?${params}`}>
          <Trans id="libraries.link">Link to this library</Trans>
        </Link>
      )}
      <LibraryForm
        key={library ? library.id : draftId}
        library={library}
        scope={scope}
        disabled={busy || !canManage}
        save={(details) => change({ kind: 'library.save', libraryId, scope, details })}
      />
      {library && (
        <>
          <Heading level={3}>
            <Trans id="libraries.documents">Documents</Trans>
          </Heading>
          {documents.isPending && <Spinner />}
          {documents.error && (
            <p role="alert">
              {message(
                documents.error instanceof ApiError ? documents.error.info.messageKey : 'errors.internal',
              )}
            </p>
          )}
          {documents.data?.length === 0 && (
            <p>
              <Trans id="libraries.empty">No documents yet.</Trans>
            </p>
          )}
          {documents.data?.map((document) => (
            <article
              key={document.id}
              id={document.id}
              className="rio-knowledge__note"
              aria-current={search.document === document.id ? 'true' : undefined}
            >
              <Heading level={4}>
                <Link href={`${base}?${params}&document=${document.id}#${document.id}`}>{document.name}</Link>
              </Heading>
              <p aria-live="polite">
                {document.status === 'ready'
                  ? t({ id: 'libraries.ready', message: 'Ready to search' })
                  : document.status === 'indexing'
                    ? t({ id: 'libraries.statusIndexing', message: 'Indexing…' })
                    : document.status === 'blocked'
                      ? t({ id: 'libraries.statusBlocked', message: 'Blocked by data rules' })
                      : t({ id: 'libraries.failed', message: 'Indexing needs attention' })}
              </p>
              {document.errorKey && <p>{message(document.errorKey)}</p>}
              {canManage && (
                <div className="rio-knowledge__actions">
                  {document.status === 'indexing' ? (
                    <Button
                      isDisabled={busy}
                      onPress={() =>
                        void change({
                          kind: 'library.cancelIndex',
                          libraryId,
                          documentId: document.id,
                        })
                      }
                    >
                      <Trans id="libraries.stopIndexing">Stop indexing</Trans>
                    </Button>
                  ) : (
                    <Button
                      isDisabled={busy}
                      onPress={() =>
                        void change({ kind: 'library.index', libraryId, documentId: document.id })
                      }
                    >
                      <Trans id="libraries.reindex">Re-index</Trans>
                    </Button>
                  )}
                  <Button
                    isDisabled={busy}
                    onPress={() =>
                      void change({ kind: 'library.deleteDocument', libraryId, documentId: document.id })
                    }
                    aria-label={t({ id: 'libraries.delete', message: 'Delete document' })}
                    icon={faTrashCan}
                  />
                  <DocumentUpload
                    disabled={busy}
                    replace={document}
                    save={(source, name) =>
                      change({ kind: 'library.document', libraryId, documentId: document.id, source, name })
                    }
                  />
                </div>
              )}
            </article>
          ))}
          {canManage && (
            <DocumentUpload
              disabled={busy}
              save={(source, name) =>
                change({ kind: 'library.document', libraryId, documentId: crypto.randomUUID(), source, name })
              }
            />
          )}
          <SearchPreview
            revision={revision}
            library={library}
            initialQuery={search.query ?? ''}
            base={`${base}?${params}`}
          />
        </>
      )}
      {busy && (
        <p role="status">
          <Trans id="libraries.saving">Saving…</Trans>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {action && (
        <Button isDisabled={busy} onPress={() => void change({ kind: 'library.undo', actionId: action })}>
          <Trans id="libraries.undo">Undo last knowledge change</Trans>
        </Button>
      )}
    </div>
  );
}
function LibraryForm({
  library,
  scope,
  disabled,
  save,
}: {
  library?: KnowledgeLibrary;
  scope: LibraryScope;
  disabled: boolean;
  save(details: unknown): Promise<boolean>;
}) {
  const { t } = useLingui();
  const [name, setName] = useState(library?.name ?? '');
  const [description, setDescription] = useState(library?.description ?? '');
  const [guidance, setGuidance] = useState(library?.guidance ?? '');
  const [label, setLabel] = useState(library?.label ?? 'internal');
  const [validated, setValidated] = useState(false);
  const parsed = LibraryDetails.safeParse({ name, description, guidance, label });
  const pageDraft = useSettingsSection({
    dirty:
      JSON.stringify([name, description, guidance, label]) !==
      JSON.stringify([
        library?.name ?? '',
        library?.description ?? '',
        library?.guidance ?? '',
        library?.label ?? 'internal',
      ]),
    stored: library,
    discard: () => {
      setValidated(false);
      setName(library?.name ?? '');
      setDescription(library?.description ?? '');
      setGuidance(library?.guidance ?? '');
      setLabel(library?.label ?? 'internal');
    },
    validate: () => {
      setValidated(true);
      return parsed.success
        ? null
        : t({ id: 'libraries.invalidDetails', message: 'Complete the library name and check its details.' });
    },
    save: async () => {
      if (parsed.success && !(await save(parsed.data))) throw new Error('errors.internal');
    },
  });
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        if (pageDraft.active) void pageDraft.save?.();
        else if (parsed.success) void save(parsed.data);
      }}
    >
      <Setting page={settingsPage} id="name" label={msg({ id: 'libraries.name', message: 'Library name' })}>
        <TextField
          label={t({ id: 'libraries.name', message: 'Library name' })}
          value={name}
          onChange={setName}
          maxLength={120}
          isInvalid={(validated || Boolean(name)) && !name.trim()}
          errorMessage={t({
            id: 'libraries.invalidDetails',
            message: 'Complete the library name and check its details.',
          })}
          isRequired
          isDisabled={disabled}
        />
      </Setting>
      <Setting
        page={settingsPage}
        id="description"
        label={msg({ id: 'libraries.description', message: 'Short description' })}
      >
        <TextArea
          label={t({ id: 'libraries.description', message: 'Short description' })}
          value={description}
          onChange={setDescription}
          maxLength={300}
          isDisabled={disabled}
        />
      </Setting>
      <Setting
        page={settingsPage}
        id="classification"
        label={msg({ id: 'libraries.classification', message: 'Classification' })}
      >
        <Select
          label={t({ id: 'libraries.classification', message: 'Classification' })}
          selectedKey={label}
          onSelectionChange={(value) => setLabel(value as typeof label)}
          isDisabled={disabled}
        >
          <ListBoxItem id="public">
            <Trans id="libraries.label.public">Public</Trans>
          </ListBoxItem>
          <ListBoxItem id="internal">
            <Trans id="libraries.label.internal">Internal</Trans>
          </ListBoxItem>
          <ListBoxItem id="confidential">
            <Trans id="libraries.label.confidential">Confidential</Trans>
          </ListBoxItem>
          <ListBoxItem id="restricted">
            <Trans id="libraries.label.restricted">Restricted</Trans>
          </ListBoxItem>
        </Select>
      </Setting>
      {(scope.kind === 'organization' || scope.kind === 'personal') && (
        <Setting
          page={settingsPage}
          id="guidance"
          label={msg({ id: 'libraries.guidance', message: 'Short guidance' })}
          help={msg({
            id: 'libraries.guidanceHelp',
            message:
              'Up to 1,000 characters, included in every conversation when the library’s data rules allow it.',
          })}
        >
          <TextArea
            label={t({ id: 'libraries.guidance', message: 'Short guidance' })}
            description={t({
              id: 'libraries.guidanceHelp',
              message:
                'Up to 1,000 characters, included in every conversation when the library’s data rules allow it.',
            })}
            value={guidance}
            onChange={setGuidance}
            maxLength={1000}
            isDisabled={disabled}
          />
        </Setting>
      )}
      {!pageDraft.active && (
        <Button type="submit" isDisabled={disabled || !parsed.success}>
          <Trans id="libraries.save">Save library</Trans>
        </Button>
      )}
    </Form>
  );
}
function DocumentUpload({
  disabled,
  replace,
  save,
}: {
  disabled: boolean;
  replace?: KnowledgeDocument;
  save(source: unknown, name: string): Promise<boolean>;
}) {
  const { t } = useLingui();
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dropping, setDropping] = useState(false);
  const [invalidFile, setInvalidFile] = useState(false);
  const uploadHelpId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [failed, setFailed] = useState(false);
  function selectFiles(files: FileList | readonly File[]) {
    const next = files[0];
    const invalid =
      files.length !== 1 ||
      !next ||
      next.size > 10 * 1024 * 1024 ||
      !/\.(pdf|docx|md|markdown|txt|html|htm)$/i.test(next.name);
    setInvalidFile(invalid);
    setFailed(false);
    if (!invalid) setFile(next);
    if (invalid && fileInput.current) fileInput.current.value = '';
  }
  async function submit() {
    if (disabled || reading) return;
    setReading(true);
    setFailed(false);
    try {
      let source: unknown = { kind: 'text', text };
      if (file) {
        if (file.size > 10 * 1024 * 1024) {
          setFailed(true);
          return;
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let at = 0; at < bytes.length; at += 8192)
          binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
        source = { kind: 'file', base64: btoa(binary) };
      }
      if (await save(source, file?.name ?? name)) {
        setName('');
        setText('');
        setFile(null);
        if (fileInput.current) fileInput.current.value = '';
      }
    } catch {
      setFailed(true);
    } finally {
      setReading(false);
    }
  }
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {!replace && (
        <>
          <Setting
            page={settingsPage}
            id="document-name"
            label={msg({ id: 'libraries.documentName', message: 'Document name' })}
          >
            <TextField
              label={t({ id: 'libraries.documentName', message: 'Document name' })}
              value={name}
              onChange={setName}
              maxLength={200}
              isDisabled={disabled || Boolean(file)}
            />
          </Setting>
          <Setting
            page={settingsPage}
            id="paste"
            label={msg({ id: 'libraries.paste', message: 'Paste document text' })}
          >
            <TextArea
              label={t({ id: 'libraries.paste', message: 'Paste document text' })}
              value={text}
              onChange={setText}
              maxLength={500000}
              isDisabled={disabled || Boolean(file)}
            />
          </Setting>
        </>
      )}
      <div
        className="rio-libraries__dropzone"
        role="group"
        aria-label={t({ id: 'libraries.dropDocument', message: 'Drop a document here, or choose a file.' })}
        aria-disabled={disabled || reading || undefined}
        data-drag-over={dropping || undefined}
        onDragEnter={(event) => {
          if (event.dataTransfer.types.includes('Files') && !disabled && !reading) setDropping(true);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = disabled || reading ? 'none' : 'copy';
        }}
        onDragLeave={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))
            setDropping(false);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          event.stopPropagation();
          setDropping(false);
          if (!disabled && !reading) {
            selectFiles(event.dataTransfer.files);
            if (fileInput.current) fileInput.current.value = '';
          }
        }}
      >
        <p>
          <Trans id="libraries.dropDocument">Drop a document here, or choose a file.</Trans>
        </p>
        <p id={uploadHelpId}>
          <Trans id="libraries.uploadHelp">
            {
              'One PDF, Word (.docx), Markdown, plain text, or HTML file, up to 10 MB.  Your library may have a lower limit.'
            }
          </Trans>
        </p>
        <Setting
          page={settingsPage}
          id="replace-file"
          label={msg({ id: 'libraries.replaceFile', message: 'Replace file' })}
        >
          <label className="rio-libraries__file">
            {replace
              ? t({ id: 'libraries.replaceFile', message: 'Replace file' })
              : t({ id: 'libraries.file', message: 'Upload a document' })}
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,.docx,.md,.markdown,.txt,.html,.htm"
              disabled={disabled || reading}
              aria-describedby={uploadHelpId}
              onChange={(event) => {
                if (event.target.files?.length) selectFiles(event.target.files);
              }}
            />
          </label>
        </Setting>
        <p role="status">{file?.name}</p>
      </div>
      <Button
        type="submit"
        isPending={reading}
        isDisabled={disabled || (!file && (Boolean(replace) || !name.trim() || !text.trim()))}
      >
        {replace
          ? t({ id: 'libraries.replace', message: 'Replace document' })
          : t({ id: 'libraries.add', message: 'Add document' })}
      </Button>
      {invalidFile && (
        <p role="alert">
          <Trans id="libraries.invalidUpload">
            Choose one PDF, Word (.docx), Markdown, plain text, or HTML file no larger than 10 MB.
          </Trans>
        </p>
      )}
      {failed && (
        <p role="alert">
          {t({
            id: 'libraries.fileReadFailed',
            message: 'The file could not be read.  Choose a file no larger than 10 MB.',
          })}
        </p>
      )}
    </Form>
  );
}
function SearchPreview({
  revision,
  library,
  initialQuery,
  base,
}: {
  library: KnowledgeLibrary;
  initialQuery: string;
  base: string;
  revision: string;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const [text, setText] = useState(initialQuery);
  const [results, setResults] = useState<{ revision: string; passages: KnowledgePassage[] } | null>(null);
  const passages = results?.revision === revision ? results.passages : null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function search() {
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const result = await api<{ passages: KnowledgePassage[] }>('/api/knowledge/search-documents', {
        body: { query: text, libraryId: library.id },
      });
      setResults({ revision, passages: result.passages });
    } catch (cause) {
      setError(message(cause instanceof ApiError ? cause.info.messageKey : 'errors.internal'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rio-knowledge">
      <Heading level={3}>
        <Trans id="libraries.preview">Search preview</Trans>
      </Heading>
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <Setting
          page={settingsPage}
          id="query"
          label={msg({ id: 'libraries.query', message: 'Search documents for' })}
        >
          <TextField
            label={t({ id: 'libraries.query', message: 'Search documents for' })}
            value={text}
            onChange={setText}
            maxLength={2000}
          />
        </Setting>
        <Button type="submit" isPending={busy} isDisabled={busy || !text.trim()}>
          <Trans id="libraries.search">Search documents</Trans>
        </Button>
      </Form>
      <Link href={`${base}&query=${encodeURIComponent(text)}`}>
        <Trans id="libraries.searchLink">Link to this search</Trans>
      </Link>
      {error && <p role="alert">{error}</p>}
      <div aria-live="polite">
        {passages?.length === 0 && (
          <p>
            <Trans id="libraries.noMatches">No matching passages.</Trans>
          </p>
        )}
        {passages?.map((passage, index) => (
          <article key={`${passage.documentId}:${index}`}>
            <Link href={passage.url}>
              {passage.section ? (
                <Trans id="libraries.citation">
                  {passage.document}—{passage.section}
                </Trans>
              ) : (
                passage.document
              )}
            </Link>
            <p>{passage.text}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
function LibraryLimits() {
  const query = useQuery({
    queryKey: ['knowledge', 'settings'],
    queryFn: () => api<KnowledgeSettings>('/api/knowledge/settings'),
  });
  return query.data ? <LimitsForm settings={query.data} /> : null;
}
function LimitsForm({ settings }: { settings: KnowledgeSettings }) {
  const { t } = useLingui();
  const cache = useQueryClient();
  const message = useServerMessage();
  const [limits, setLimits] = useState(settings.libraries);
  const [_busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const labels = {
    public: t({ id: 'libraries.label.public', message: 'Public' }),
    internal: t({ id: 'libraries.label.internal', message: 'Internal' }),
    confidential: t({ id: 'libraries.label.confidential', message: 'Confidential' }),
    restricted: t({ id: 'libraries.label.restricted', message: 'Restricted' }),
  };
  const pageDraft = useSettingsSection({
    dirty: JSON.stringify(limits) !== JSON.stringify(settings.libraries),
    stored: settings.libraries,
    discard: () => {
      setLimits(settings.libraries);
      setError(null);
      setSaved(false);
    },
    validate: () =>
      KnowledgeSettings.safeParse({ ...settings, libraries: limits }).success
        ? null
        : t({ id: 'libraries.invalidLimits', message: 'Check the knowledge limits and data rules.' }),
    save: async () => {
      setBusy(true);
      setError(null);
      setSaved(false);
      try {
        const result = await api<{ status: string; error?: { messageKey: string } }>(
          '/api/knowledge/commands',
          {
            body: {
              kind: 'knowledge.settings',
              id: crypto.randomUUID(),
              settings: {
                ...(cache.getQueryData<KnowledgeSettings>(['knowledge', 'settings']) ?? settings),
                libraries: limits,
              },
            },
          },
        );
        if (result.status === 'rejected')
          throw new ApiError(400, {
            code: 'validation_failed',
            messageKey: result.error?.messageKey ?? 'errors.internal',
            userFault: true,
          });
        setSaved(true);
        await cache.invalidateQueries({ queryKey: ['knowledge', 'settings'] });
      } catch (cause) {
        setError(message(cause instanceof ApiError ? cause.info.messageKey : 'errors.internal'));
        throw cause;
      } finally {
        setBusy(false);
      }
    },
  });
  return (
    <Form
      className="rio-knowledge"
      onSubmit={(event) => {
        event.preventDefault();
        void pageDraft.save?.();
      }}
    >
      <Heading level={3}>
        <Trans id="libraries.limits">Knowledge limits and data rules</Trans>
      </Heading>
      <Setting
        page={embeddedPage}
        id="libraries-count-limit"
        label={msg({ id: 'libraries.countLimit', message: 'Documents per library' })}
        roles={['organization-ai']}
      >
        <TextField
          label={t({ id: 'libraries.countLimit', message: 'Documents per library' })}
          type="number"
          value={String(limits.documents)}
          onChange={(value) => setLimits({ ...limits, documents: Number(value) })}
        />
      </Setting>
      <Setting
        page={embeddedPage}
        id="libraries-size-limit"
        label={msg({ id: 'libraries.sizeLimit', message: 'Maximum file size in bytes' })}
        roles={['organization-ai']}
      >
        <TextField
          label={t({ id: 'libraries.sizeLimit', message: 'Maximum file size in bytes' })}
          type="number"
          value={String(limits.uploadBytes)}
          onChange={(value) => setLimits({ ...limits, uploadBytes: Number(value) })}
        />
      </Setting>
      <Setting
        page={embeddedPage}
        id="libraries-text-limit"
        label={msg({ id: 'libraries.textLimit', message: 'Maximum extracted characters' })}
        roles={['organization-ai']}
      >
        <TextField
          label={t({ id: 'libraries.textLimit', message: 'Maximum extracted characters' })}
          type="number"
          value={String(limits.extractedCharacters)}
          onChange={(value) => setLimits({ ...limits, extractedCharacters: Number(value) })}
        />
      </Setting>
      <Setting
        page={embeddedPage}
        id="libraries-search-power"
        label={msg({ id: 'libraries.searchPower', message: 'Document search power (watts)' })}
        roles={['organization-ai']}
      >
        <TextField
          label={t({ id: 'libraries.searchPower', message: 'Document search power (watts)' })}
          type="number"
          value={String(limits.searchPowerWatts ?? '')}
          onChange={(value) =>
            setLimits({ ...limits, searchPowerWatts: value.trim() ? Number(value) : null })
          }
        />
      </Setting>
      <Setting
        page={embeddedPage}
        id="libraries-classification-rules"
        label={msg({ id: 'settings.search.libraryRules', message: 'Library classification rules' })}
        roles={['organization-ai']}
      >
        {Object.entries(labels).map(([label, name]) => (
          <Select
            key={label}
            label={name}
            selectedKey={limits.rules[label as keyof typeof labels]}
            onSelectionChange={(value) =>
              setLimits({ ...limits, rules: { ...limits.rules, [label]: value } })
            }
          >
            <ListBoxItem id="allowed">
              <Trans id="libraries.rule.allowed">Approved providers</Trans>
            </ListBoxItem>
            <ListBoxItem id="local">
              <Trans id="libraries.rule.local">Local providers only</Trans>
            </ListBoxItem>
            <ListBoxItem id="blocked">
              <Trans id="libraries.rule.blocked">Do not send to AI</Trans>
            </ListBoxItem>
          </Select>
        ))}
      </Setting>
      {saved && (
        <p role="status">
          <Trans id="libraries.saved">Saved</Trans>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </Form>
  );
}
