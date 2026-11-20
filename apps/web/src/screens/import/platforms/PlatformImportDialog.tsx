import type { I18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import {
  isImportDone,
  LIMITS,
  PLATFORM_CLOUD_URLS,
  PLATFORM_NAMES,
  SMARTSHEET_REGIONS,
  platformAddressProblem,
  type ImportPlatform,
  type PlatformBase,
  type PlatformBasesRequest,
  type PlatformImport,
  type PlatformPreview,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  Modal,
  PasswordField,
  FilterableList,
  Radio,
  RadioGroup,
  TextField,
} from '@riosoma/ui';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../../api';
import { serverMessage } from '../../../messages/useServerMessage';
import { ImportState } from '../airtable/AirtableImportDialog';
import { cancelImport, listBases, recentImports, startImport, watchImport, previewImport } from './api';
import '../airtable/AirtableImport.css';
import { taskFieldNames } from './taskFieldNames';
import { PlatformPreviewView } from './PlatformPreview';

export interface PlatformImportDialogProps {
  platform: ImportPlatform;
  onClose(): void;
  /** Opens the database an import made */
  onOpen(databaseId: string): void;
}

type Step =
  | { kind: 'connect' }
  | { kind: 'base'; bases: PlatformBase[] }
  | { kind: 'preview'; bases: PlatformBase[]; preview: PlatformPreview }
  | { kind: 'import'; job: PlatformImport };

const INTRO = msg({
  id: 'import.platform.intro',
  message:
    'Riosoma reads {product} through its API, from the service you use.  It uses what you give it only for this import, and forgets it when the import ends.',
});
const TOKEN_HELP = msg({
  id: 'import.platform.tokenHelp',
  message:
    '{platform, select, nocodb {Make an API token in NocoDB under Account settings, Tokens.} baserow {Make a database token in Baserow under My settings, Database tokens, with read access to the database.} grist {Make an API key in Grist under Profile settings, API.} teable {Make a personal access token in Teable under your account, Developer, and give it read access to the bases you want.} notion {Make a Notion connection with read content permission and share the databases you want with it.} monday {Copy your personal API token from monday.com under your profile, Developers, My access tokens.} clickup {Make a personal API token in ClickUp under Settings, Apps.} asana {Make a personal access token in the Asana developer console.} smartsheet {Make an API access token in Smartsheet under Account, Personal settings, API access.  API access requires a Business or Enterprise plan.} seatable {Make an API token for one base in SeaTable under its Advanced settings, API access, with read permission.  It reads that base alone.} other {Make an API token in {product} and paste it here.}}',
});
const TOKEN_LABEL = msg({
  id: 'import.platform.token',
  message:
    '{platform, select, baserow {Database token} grist {API key} teable {Access token} smartsheet {Access token} clickup {API token} asana {Access token} notion {Connection token} other {API token}}',
});
const FIND = msg({
  id: 'import.platform.find',
  message:
    '{platform, select, grist {Find documents} baserow {Find databases} clickup {Find lists} asana {Find projects} notion {Find databases} monday {Find boards} smartsheet {Find sheets} other {Find bases}}',
});
const FIND_SHEETS = msg({ id: 'import.smartsheet.findSheets', message: 'Find sheets' });
const PICK = msg({
  id: 'import.platform.base',
  message:
    '{platform, select, grist {Document} baserow {Database} clickup {Lists} asana {Projects} notion {Database} monday {Board} smartsheet {Sheet} other {Base}}',
});
const NONE = msg({
  id: 'import.platform.noBases',
  message:
    'Those details can’t see any {platform, select, grist {documents} baserow {databases} clickup {lists} asana {projects} notion {databases} monday {boards} smartsheet {sheets} other {bases}}.  In {product}, give them access to the one you want.',
});
const SIGN_IN_NOTE = msg({
  id: 'import.platform.signInNote',
  message:
    'A database token brings tables, fields, records, and files.  Baserow shares views only with people who sign in, so sign in to bring them too.  Riosoma signs in once and keeps only the token Baserow answers with while the import runs.',
});

/** Why something failed, in the reader's language. */
function failure(i18n: I18n, thrown: unknown): string {
  return thrown instanceof ApiError
    ? serverMessage(i18n, thrown.info.messageKey, thrown.info.params)
    : serverMessage(i18n, 'errors.internal');
}

/**
 * Imports a whole base from NocoDB, Teable, or SeaTable, a database from Baserow, or a document
 * from Grist or a sheet from Smartsheet as a new database: give the tool's address and a token,
 * pick what to bring, and watch it come across, the way importing from Airtable works.  An import
 * keeps going if the dialog closes, and the dialog picks it up again when it opens.  Tokens and
 * passwords live in this dialog only until the import starts.
 */
export function PlatformImportDialog({ platform, onClose, onOpen }: PlatformImportDialogProps) {
  const { t, i18n } = useLingui();
  const product = PLATFORM_NAMES[platform];
  const values = { platform, product };
  const [step, setStep] = useState<Step>({ kind: 'connect' });
  const [address, setAddress] = useState<string>(PLATFORM_CLOUD_URLS[platform]);
  const fieldNames = {
    parent: t({ id: 'import.smartsheet.parent', message: 'Parent row' }),
    attachments: t({ id: 'import.smartsheet.attachments', message: 'Attachments' }),
    attachmentName: t({ id: 'import.smartsheet.attachmentName', message: 'Attachment name' }),
    attachmentParent: t({ id: 'import.smartsheet.attachmentParent', message: 'Source location' }),
    predecessorDetails: t({ id: 'import.smartsheet.predecessorDetails', message: 'Dependency details' }),
  };
  const [signIn, setSignIn] = useState(false);
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [baseId, setBaseId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const taskPlatform = platform === 'clickup' || platform === 'asana';
  const databasePlatform = platform === 'notion' || platform === 'monday';
  const needsPreview = taskPlatform || databasePlatform || platform === 'smartsheet';
  const importFieldNames = () =>
    platform === 'smartsheet'
      ? fieldNames
      : taskPlatform
        ? taskFieldNames(i18n)
        : {
            body: t({ id: 'import.platform.field.body', message: 'Page body' }),
            group: t({ id: 'import.platform.field.group', message: 'Group' }),
            children: t({ id: 'import.platform.field.children', message: 'Subitems' }),
            parent: t({ id: 'import.platform.field.parent', message: 'Parent item' }),
            name: t({ id: 'import.platform.field.name', message: 'Name' }),
          };
  const [name, setName] = useState('');
  const [named, setNamed] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  const withPassword = signIn && platform === 'baserow';

  const reason = (thrown: unknown) => failure(i18n, thrown);
  const credentials = (): PlatformBasesRequest =>
    withPassword
      ? { address: address.trim(), email: email.trim(), password }
      : { address: address.trim(), token: token.trim() };
  const ready =
    platformAddressProblem(address) === null &&
    (withPassword ? Boolean(email.trim() && password) : Boolean(token.trim()));

  const show = (job: PlatformImport) => {
    version.current = job.version;
    setStep({ kind: 'import', job });
  };

  // An import that's already going picks up where it is.
  useEffect(() => {
    let live = true;
    recentImports(platform).then(
      (imports) => {
        const active = imports.find((item) => !isImportDone(item.state));
        if (!live || !active) return;
        version.current = active.version;
        setStep((current) => (current.kind === 'connect' ? { kind: 'import', job: active } : current));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [platform]);

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
        const next = await watchImport(platform, jobId, since, controller.signal);
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
  }, [platform, jobId, done, i18n]);

  async function findBases() {
    if (!ready || busy) return;
    setBusy(true);
    setError(undefined);
    setFieldErrors({});
    try {
      const bases = await listBases(platform, credentials());
      setStep({ kind: 'base', bases });
      const first = bases[0];
      setSelectedIds(first ? [first.id] : []);
      setBaseId(first?.id ?? null);
      if (!named) setName(first?.name.slice(0, LIMITS.nameLength) ?? '');
    } catch (thrown) {
      const fields = thrown instanceof ApiError ? (thrown.info.fields ?? {}) : {};
      if (fields.address || fields.token) {
        const text = reason(thrown);
        setFieldErrors({
          ...(fields.address ? { address: text } : {}),
          ...(fields.token ? { [withPassword ? 'password' : 'token']: text } : {}),
        });
      } else setError(reason(thrown));
    } finally {
      setBusy(false);
    }
  }

  async function preview() {
    if (!baseId || busy || step.kind !== 'base') return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await previewImport(platform, {
        ...credentials(),
        baseId,
        additionalBaseIds: selectedIds.filter((id) => id !== baseId),
        fieldNames: importFieldNames(),
      });
      setStep({ kind: 'preview', bases: step.bases, preview: result });
    } catch (thrown) {
      setError(reason(thrown));
    } finally {
      setBusy(false);
    }
  }

  async function begin() {
    if (!baseId || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const started = await startImport(platform, {
        ...credentials(),
        baseId,
        ...(taskPlatform ? { additionalBaseIds: selectedIds.filter((id) => id !== baseId) } : {}),
        fieldNames: importFieldNames(),
        ...(name.trim() ? { name: name.trim() } : {}),
        viewName: t({ id: 'import.airtable.viewName', message: 'Grid view' }),
      });
      // The server has what it needs now, sealed, so this page doesn't keep it.
      setToken('');
      setPassword('');
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
      show(await cancelImport(platform, job.id));
    } catch (thrown) {
      setError(reason(thrown));
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    setStep({ kind: 'connect' });
    setError(undefined);
    setFieldErrors({});
    setNamed(false);
    setName('');
  }

  const title =
    job === null
      ? t({ id: 'import.platform.title', message: `Import from ${product}` })
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
        {step.kind === 'connect' ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void findBases();
            }}
          >
            <DialogBody className="rio-airtable-import__body">
              <p>
                {platform === 'smartsheet'
                  ? t({
                      id: 'import.smartsheet.intro',
                      message:
                        'Riosoma reads the sheets your Smartsheet access token can see.  It uses the token only for this import and forgets it when the import ends.',
                    })
                  : i18n._({ ...INTRO, values })}
              </p>
              {platform === 'smartsheet' ? (
                <RadioGroup
                  label={t({ id: 'import.smartsheet.region', message: 'Smartsheet region' })}
                  value={address}
                  isDisabled={busy}
                  onChange={(value) => {
                    setAddress(value);
                    setFieldErrors({});
                  }}
                >
                  <Radio value={SMARTSHEET_REGIONS.us}>
                    {t({ id: 'import.smartsheet.region.us', message: 'United States' })}
                  </Radio>
                  <Radio value={SMARTSHEET_REGIONS.eu}>
                    {t({ id: 'import.smartsheet.region.eu', message: 'Europe' })}
                  </Radio>
                  <Radio value={SMARTSHEET_REGIONS.au}>
                    {t({ id: 'import.smartsheet.region.au', message: 'Australia' })}
                  </Radio>
                </RadioGroup>
              ) : (
                <TextField
                  label={t({ id: 'import.platform.address', message: 'Address' })}
                  description={t({
                    id: 'import.platform.addressHelp',
                    message: `Your server’s address, or ${PLATFORM_CLOUD_URLS[platform]} for ${product}’s hosted service.`,
                  })}
                  type="url"
                  value={address}
                  maxLength={LIMITS.urlLength}
                  isRequired
                  isDisabled={busy}
                  isInvalid={Boolean(fieldErrors.address)}
                  errorMessage={fieldErrors.address}
                  onChange={(value) => {
                    setAddress(value);
                    // A field marked wrong keeps the form from sending, so a change to any of them clears them all.
                    setFieldErrors({});
                  }}
                />
              )}
              {taskPlatform ? (
                <a
                  href={
                    platform === 'clickup'
                      ? 'https://app.clickup.com/settings/apps'
                      : 'https://app.asana.com/0/my-apps'
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  {t({ id: 'import.platform.makeToken', message: 'Create a token' })}
                </a>
              ) : null}
              {databasePlatform ? (
                <a
                  href={
                    platform === 'notion'
                      ? 'https://www.notion.so/profile/integrations'
                      : 'https://monday.com/developers/apps'
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  {t({ id: 'import.platform.tokenLink', message: `Get a token in ${product}` })}
                </a>
              ) : null}
              {platform === 'baserow' ? (
                <RadioGroup
                  label={t({ id: 'import.platform.signInWith', message: 'Read Baserow with' })}
                  value={signIn ? 'password' : 'token'}
                  isDisabled={busy}
                  onChange={(value) => {
                    setSignIn(value === 'password');
                    setFieldErrors({});
                  }}
                  description={i18n._(SIGN_IN_NOTE)}
                >
                  <Radio value="token">
                    {t({ id: 'import.platform.withToken', message: 'A database token' })}
                  </Radio>
                  <Radio value="password">
                    {t({ id: 'import.platform.withPassword', message: 'My email address and password' })}
                  </Radio>
                </RadioGroup>
              ) : null}
              {withPassword ? (
                <>
                  <TextField
                    label={t({ id: 'import.platform.email', message: 'Email address' })}
                    type="email"
                    autoComplete="off"
                    value={email}
                    isRequired
                    isDisabled={busy}
                    onChange={(value) => {
                      setEmail(value);
                      setFieldErrors({});
                    }}
                  />
                  <PasswordField
                    label={t({ id: 'import.platform.password', message: 'Password' })}
                    value={password}
                    autoComplete="off"
                    isRequired
                    isDisabled={busy}
                    isInvalid={Boolean(fieldErrors.password)}
                    errorMessage={fieldErrors.password}
                    onChange={(value) => {
                      setPassword(value);
                      setFieldErrors({});
                    }}
                  />
                </>
              ) : (
                <PasswordField
                  label={i18n._({ ...TOKEN_LABEL, values })}
                  description={i18n._({ ...TOKEN_HELP, values })}
                  value={token}
                  autoComplete="off"
                  isRequired
                  isDisabled={busy}
                  isInvalid={Boolean(fieldErrors.token)}
                  errorMessage={fieldErrors.token}
                  onChange={(value) => {
                    setToken(value);
                    setFieldErrors({});
                  }}
                />
              )}
              {platform === 'smartsheet' ? (
                <a
                  href="https://help.smartsheet.com/articles/2482389-generate-API-key"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t({ id: 'import.smartsheet.makeToken', message: 'Create a Smartsheet access token' })}
                </a>
              ) : null}
              {error ? <Banner tone="danger">{error}</Banner> : null}
            </DialogBody>
            <DialogFooter>
              <Button onPress={onClose} isDisabled={busy}>
                {t({ id: 'import.airtable.cancel', message: 'Cancel' })}
              </Button>
              <Button type="submit" variant="primary" isPending={busy} isDisabled={!ready}>
                {platform === 'smartsheet' ? i18n._(FIND_SHEETS) : i18n._({ ...FIND, values })}
              </Button>
            </DialogFooter>
          </form>
        ) : step.kind === 'base' ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void (needsPreview ? preview() : begin());
            }}
          >
            <DialogBody className="rio-airtable-import__body">
              {step.bases.length ? (
                <FilterableList
                  listId={`import.${platform}.bases`}
                  items={step.bases.map((base) => ({
                    id: base.id,
                    name: base.name,
                    group: base.group ?? undefined,
                  }))}
                  label={i18n._({ ...PICK, values })}
                  selectionMode={taskPlatform ? 'multiple' : 'single'}
                  selectedKeys={taskPlatform ? selectedIds : baseId ? [baseId] : []}
                  description={
                    taskPlatform
                      ? t({
                          id: 'import.platform.taskSelection',
                          message:
                            'Select the lists or projects to bring into one database.  Each becomes a table.',
                        })
                      : undefined
                  }
                  isDisabled={busy}
                  onSelectionChange={(keys) => {
                    const ids = [...keys].map(String);
                    setSelectedIds(ids);
                    const id = ids[0] ?? '';
                    setBaseId(id);
                    const chosen = step.bases.find((base) => base.id === id);
                    if (chosen && !named) setName(chosen.name.slice(0, LIMITS.nameLength));
                  }}
                />
              ) : (
                <Banner tone="warning">{i18n._({ ...NONE, values })}</Banner>
              )}
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
              <Button onPress={() => setStep({ kind: 'connect' })} isDisabled={busy}>
                {t({ id: 'import.airtable.back', message: 'Back' })}
              </Button>
              <Button type="submit" variant="primary" isPending={busy} isDisabled={!baseId}>
                {needsPreview
                  ? t({ id: 'import.platform.preview', message: 'Preview' })
                  : t({ id: 'import.airtable.start', message: 'Import' })}
              </Button>
            </DialogFooter>
          </form>
        ) : step.kind === 'preview' ? (
          <>
            <DialogBody className="rio-airtable-import__body">
              <PlatformPreviewView platform={platform} preview={step.preview} />
              {error ? <Banner tone="danger">{error}</Banner> : null}
            </DialogBody>
            <DialogFooter>
              <Button onPress={() => setStep({ kind: 'base', bases: step.bases })} isDisabled={busy}>
                {t({ id: 'import.airtable.back', message: 'Back' })}
              </Button>
              <Button variant="primary" isPending={busy} onPress={() => void begin()}>
                {t({ id: 'import.airtable.start', message: 'Import' })}
              </Button>
            </DialogFooter>
          </>
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
