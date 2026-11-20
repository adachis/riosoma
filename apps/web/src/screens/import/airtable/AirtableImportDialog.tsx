import { faXmark } from '@fortawesome/free-solid-svg-icons';
import type { I18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import {
  AIRTABLE_TOKEN_SCOPES,
  isImportDone,
  LIMITS,
  type AirtableBase,
  type AirtableImport,
  type AirtableImportPhase,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  Link,
  Modal,
  PasswordField,
  ProgressBar,
  FilterableList,
  TextField,
} from '@riosoma/ui';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../../api';
import { serverMessage } from '../../../messages/useServerMessage';
import { cancelImport, listBases, recentImports, startImport, watchImport } from './api';
import { SUMMARY } from './reportMessages';
import './AirtableImport.css';

/** Where Airtable people make personal access tokens */
export const AIRTABLE_TOKEN_PAGE = 'https://airtable.com/create/tokens';

export interface AirtableImportDialogProps {
  onClose(): void;
  /** Opens the database an import made */
  onOpen(databaseId: string): void;
}

type Step =
  { kind: 'token' } | { kind: 'base'; bases: AirtableBase[] } | { kind: 'import'; job: AirtableImport };

const PHASES: Record<AirtableImportPhase | 'queued', ReturnType<typeof msg>> = {
  queued: msg({ id: 'import.airtable.phase.queued', message: 'Waiting to start' }),
  schema: msg({ id: 'import.airtable.phase.schema', message: 'Reading tables and fields' }),
  records: msg({ id: 'import.airtable.phase.records', message: 'Bringing records across' }),
  links: msg({ id: 'import.airtable.phase.links', message: 'Linking records' }),
  fields: msg({ id: 'import.airtable.phase.fields', message: 'Setting up formulas, lookups, and rollups' }),
  views: msg({ id: 'import.airtable.phase.views', message: 'Setting up views' }),
  report: msg({ id: 'import.airtable.phase.report', message: 'Writing the report' }),
};

const SO_FAR = msg({
  id: 'import.airtable.soFar',
  message:
    '{records, plural, one {# record} other {# records}} and {files, plural, one {# file} other {# files}} so far',
});

/** Why something failed, in the reader's language. */
function failure(i18n: I18n, thrown: unknown): string {
  return thrown instanceof ApiError
    ? serverMessage(i18n, thrown.info.messageKey, thrown.info.params)
    : serverMessage(i18n, 'errors.internal');
}

/** How far along an import is, out of 100, or null before it knows. */
function percent(job: Pick<AirtableImport, 'progress'>): number | null {
  const { phase, tables, tablesDone } = job.progress;
  if (!phase) return null;
  if (phase === 'records') return 5 + 75 * (tables ? tablesDone / tables : 0);
  return { schema: 2, links: 82, fields: 90, views: 95, report: 99 }[phase];
}

/**
 * Imports a whole Airtable base as a new database: paste a token, pick a base, and watch it come
 * across.  An import keeps going if the dialog closes, and the dialog picks it up again when it
 * opens.  The token lives in this dialog only until the import starts.
 */
export function AirtableImportDialog({ onClose, onOpen }: AirtableImportDialogProps) {
  const { t, i18n } = useLingui();
  const [step, setStep] = useState<Step>({ kind: 'token' });
  const [token, setToken] = useState('');
  const [baseId, setBaseId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [named, setNamed] = useState(false);
  const [tokenError, setTokenError] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const version = useRef(0);

  const reason = (thrown: unknown) => failure(i18n, thrown);

  const show = (job: AirtableImport) => {
    version.current = job.version;
    setStep({ kind: 'import', job });
  };

  // An import that's already going picks up where it is.
  useEffect(() => {
    let live = true;
    recentImports().then(
      (imports) => {
        const active = imports.find((item) => !isImportDone(item.state));
        if (!live || !active) return;
        version.current = active.version;
        setStep((current) => (current.kind === 'token' ? { kind: 'import', job: active } : current));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  const job = step.kind === 'import' ? step.job : null;
  const jobId = job?.id ?? null;
  const done = job ? isImportDone(job.state) : false;
  // Each answer waits on the server for the next change, so this asks only as often as things move.
  useEffect(() => {
    if (!jobId || done) return;
    const controller = new AbortController();
    const watch = async () => {
      for (;;) {
        const since = version.current;
        const next = await watchImport(jobId, since, controller.signal);
        if (controller.signal.aborted) return;
        version.current = next.version;
        setStep({ kind: 'import', job: next });
        if (isImportDone(next.state)) return;
        // An answer with no news only comes after a long wait, but never ask in a tight loop.
        if (next.version === since) await new Promise((resolve) => setTimeout(resolve, 1_000, undefined));
        if (controller.signal.aborted) return;
      }
    };
    watch().catch((thrown: unknown) => {
      if (!controller.signal.aborted) setError(failure(i18n, thrown));
    });
    return () => controller.abort();
  }, [jobId, done, i18n]);

  async function findBases() {
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    setTokenError(undefined);
    try {
      const bases = await listBases(token.trim());
      setStep({ kind: 'base', bases });
      const first = bases[0];
      setBaseId(first?.id ?? null);
      if (!named) setName(first?.name.slice(0, LIMITS.nameLength) ?? '');
    } catch (thrown) {
      if (thrown instanceof ApiError && thrown.info.fields?.token) setTokenError(reason(thrown));
      else setError(reason(thrown));
    } finally {
      setBusy(false);
    }
  }

  async function begin() {
    if (!baseId || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const started = await startImport({
        token: token.trim(),
        baseId,
        ...(name.trim() ? { name: name.trim() } : {}),
        viewName: t({ id: 'import.airtable.viewName', message: 'Grid view' }),
      });
      // The server has the token now, sealed, so this page doesn't keep it.
      setToken('');
      show(started);
    } catch (thrown) {
      setError(reason(thrown));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!job || busy) return;
    setBusy(true);
    try {
      show(await cancelImport(job.id));
    } catch (thrown) {
      setError(reason(thrown));
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    setStep({ kind: 'token' });
    setError(undefined);
    setTokenError(undefined);
    setNamed(false);
    setName('');
  }

  function permissionName(level: string): string {
    if (level === 'create') return t({ id: 'import.airtable.access.creator', message: 'Creator' });
    if (level === 'edit') return t({ id: 'import.airtable.access.editor', message: 'Editor' });
    if (level === 'comment') return t({ id: 'import.airtable.access.commenter', message: 'Commenter' });
    return t({ id: 'import.airtable.access.readOnly', message: 'Read only' });
  }

  const title =
    job === null
      ? t({ id: 'import.airtable.title', message: 'Import from Airtable' })
      : job.state === 'finished'
        ? t({ id: 'import.airtable.done', message: `Imported ${job.name}` })
        : t({ id: 'import.airtable.importing', message: `Importing ${job.name}` });

  return (
    <Modal
      isOpen
      isDismissable={!busy}
      isKeyboardDismissDisabled={busy}
      className="rio-airtable-import"
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog hideCloseButton>
        <DialogTitle>{title}</DialogTitle>
        {step.kind === 'token' ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void findBases();
            }}
          >
            <DialogBody className="rio-airtable-import__body">
              <p>
                {t({
                  id: 'import.airtable.intro',
                  message:
                    'Riosoma reads the base through Airtable’s API with a personal access token.  It uses the token only for this import and forgets it when the import ends.',
                })}
              </p>
              <div>
                <p>
                  {t({
                    id: 'import.airtable.scopesIntro',
                    message: 'Give the token these scopes, and access to the base you want:',
                  })}
                </p>
                <ul className="rio-airtable-import__scopes">
                  {AIRTABLE_TOKEN_SCOPES.map((scope) => (
                    <li key={scope}>
                      <code>{scope}</code>
                    </li>
                  ))}
                </ul>
                <Link href={AIRTABLE_TOKEN_PAGE} external>
                  {t({ id: 'import.airtable.createToken', message: 'Make a token on Airtable' })}
                </Link>
              </div>
              <PasswordField
                label={t({ id: 'import.airtable.token', message: 'Personal access token' })}
                value={token}
                onChange={(value) => {
                  setToken(value);
                  setTokenError(undefined);
                }}
                autoComplete="off"
                isRequired
                isDisabled={busy}
                isInvalid={Boolean(tokenError)}
                errorMessage={tokenError}
              />
              {error ? <Banner tone="danger">{error}</Banner> : null}
            </DialogBody>
            <DialogFooter>
              <Button onPress={onClose} isDisabled={busy}>
                {t({ id: 'import.airtable.cancel', message: 'Cancel' })}
              </Button>
              <Button type="submit" variant="primary" isPending={busy} isDisabled={!token.trim()}>
                {t({ id: 'import.airtable.findBases', message: 'Find bases' })}
              </Button>
            </DialogFooter>
          </form>
        ) : step.kind === 'base' ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void begin();
            }}
          >
            <DialogBody className="rio-airtable-import__body">
              <FilterableList
                listId="import.airtable.bases"
                items={[...step.bases]
                  .sort((left, right) => {
                    if (left.workspace || right.workspace) return 0;
                    const rank: Record<string, number> = { create: 0, edit: 1, comment: 2, read: 3, none: 3 };
                    return (rank[left.permissionLevel] ?? 4) - (rank[right.permissionLevel] ?? 4);
                  })
                  .map((base) => ({
                    id: base.id,
                    name: base.name,
                    group:
                      base.workspace?.id ?? (base.permissionLevel === 'none' ? 'read' : base.permissionLevel),
                    groupName: base.workspace?.name ?? permissionName(base.permissionLevel),
                  }))}
                label={t({ id: 'import.airtable.base', message: 'Base' })}
                selectedKeys={baseId ? [baseId] : []}
                isDisabled={busy}
                onSelectionChange={(keys) => {
                  const id = String([...keys][0] ?? '');
                  setBaseId(id);
                  const chosen = step.bases.find((base) => base.id === id);
                  if (chosen && !named) setName(chosen.name.slice(0, LIMITS.nameLength));
                }}
              />
              {step.bases.length === 0 ? (
                <Banner tone="warning">
                  {t({
                    id: 'import.airtable.noBases',
                    message:
                      'This token can’t see any bases.  On Airtable, add a base to the token’s access.',
                  })}
                </Banner>
              ) : null}
              {step.bases.length ? (
                <TextField
                  label={t({ id: 'import.airtable.name', message: 'Database name' })}
                  value={name}
                  maxLength={LIMITS.nameLength}
                  isDisabled={busy}
                  onChange={(value) => {
                    setName(value);
                    setNamed(true);
                  }}
                />
              ) : null}
              {error ? <Banner tone="danger">{error}</Banner> : null}
            </DialogBody>
            <DialogFooter>
              <Button onPress={() => setStep({ kind: 'token' })} isDisabled={busy}>
                {t({ id: 'import.airtable.back', message: 'Back' })}
              </Button>
              <Button type="submit" variant="primary" isPending={busy} isDisabled={!baseId}>
                {t({ id: 'import.airtable.start', message: 'Import' })}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <ImportState
            job={step.job}
            error={error}
            busy={busy}
            onStop={() => void stop()}
            onClose={onClose}
            onOpen={onOpen}
            onStartOver={startOver}
          />
        )}
      </Dialog>
    </Modal>
  );
}

/** What an import is doing, or how it ended, with what can be done next.  Other tools' imports share it. */
export function ImportState({
  job,
  error,
  busy,
  onStop,
  onClose,
  onOpen,
  onStartOver,
}: {
  job: Pick<AirtableImport, 'state' | 'progress' | 'report' | 'error' | 'databaseId'>;
  error: string | undefined;
  busy: boolean;
  onStop(): void;
  onClose(): void;
  onOpen(databaseId: string): void;
  onStartOver(): void;
}) {
  const { t, i18n } = useLingui();
  const close = (
    <Button
      onPress={onClose}
      isDisabled={busy}
      aria-label={t({ id: 'import.airtable.close', message: 'Close' })}
      icon={faXmark}
    />
  );
  if (job.state === 'finished') {
    const report = job.report;
    const changed = report?.items.filter((item) => item.status === 'changed').length ?? 0;
    const omitted = report?.items.filter((item) => item.status === 'omitted').length ?? 0;
    return (
      <>
        <DialogBody className="rio-airtable-import__body">
          {report ? (
            <p>
              {i18n._({
                ...SUMMARY,
                values: {
                  tables: report.tables,
                  records: report.records,
                  views: report.views,
                  files: report.files,
                },
              })}
            </p>
          ) : null}
          <p>
            {i18n._({
              ...msg({
                id: 'import.airtable.finishedNote',
                message:
                  '{changed, plural, one {# thing changed} other {# things changed}} on the way, and {omitted, plural, one {# was left out} other {# were left out}}.  The report opens with the database, and stays in its settings menu.',
              }),
              values: { changed, omitted },
            })}
          </p>
        </DialogBody>
        <DialogFooter>
          {close}
          <Button variant="primary" onPress={() => job.databaseId && onOpen(job.databaseId)}>
            {t({ id: 'import.airtable.open', message: 'Open database' })}
          </Button>
        </DialogFooter>
      </>
    );
  }
  if (job.state === 'failed' || job.state === 'canceled') {
    const why = job.error ? serverMessage(i18n, job.error.messageKey, job.error.params) : '';
    return (
      <>
        <DialogBody className="rio-airtable-import__body">
          <Banner tone={job.state === 'failed' ? 'danger' : 'warning'}>
            {job.state === 'failed'
              ? t({ id: 'import.airtable.stopped', message: `The import stopped: ${why}` })
              : t({ id: 'import.airtable.canceled', message: 'You stopped the import.' })}
          </Banner>
          {job.databaseId ? (
            <p>{t({ id: 'import.airtable.trashed', message: 'What it made so far is in the trash.' })}</p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          {close}
          <Button variant="primary" onPress={onStartOver}>
            {t({ id: 'import.airtable.again', message: 'Start over' })}
          </Button>
        </DialogFooter>
      </>
    );
  }
  const phase = job.state === 'queued' ? 'queued' : (job.progress.phase ?? 'schema');
  const label = i18n._(PHASES[phase]);
  const share = percent(job);
  const table = job.progress.table;
  return (
    <>
      <DialogBody className="rio-airtable-import__body">
        {share === null ? (
          <ProgressBar isIndeterminate label={label} />
        ) : (
          <ProgressBar value={share} label={label} />
        )}
        <p aria-live="polite">
          {i18n._({ ...SO_FAR, values: { records: job.progress.records, files: job.progress.files } })}
          {table && phase === 'records' ? (
            <>
              {'  '}
              {t({ id: 'import.airtable.reading', message: `Reading ${table}.` })}
            </>
          ) : null}
        </p>
        <p className="rio-airtable-import__note">
          {t({
            id: 'import.airtable.background',
            message:
              'You can close this.  The import keeps going, and it shows here again when you come back.',
          })}
        </p>
        {error ? <Banner tone="danger">{error}</Banner> : null}
      </DialogBody>
      <DialogFooter>
        <Button onPress={onStop} isPending={busy}>
          {t({ id: 'import.airtable.stop', message: 'Stop import' })}
        </Button>
        {close}
      </DialogFooter>
    </>
  );
}
