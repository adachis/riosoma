import { useEffect, useMemo, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  AIRTABLE_SYNC_OUT_SCOPES,
  LIMITS,
  newId,
  SYNC_OUT_INTERVALS,
  type DestinationInput,
  type DestinationKind,
  type DestinationPlace,
  type OutboundSync,
  type SyncOutInterval,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  Checkbox,
  DialogBody,
  DialogFooter,
  FilterableList,
  Form,
  Link,
  ListBoxItem,
  PasswordField,
  Radio,
  RadioGroup,
  Select,
  Spinner,
  TextField,
} from '@riosoma/ui';
import { useServerMessage } from '../../messages/useServerMessage';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../messages/errorInfo';
import { anchor } from '../../demos/anchors';
import { lookupPlaces, previewSyncOut, sendSyncOutCommand, useRequest } from './api';
import { ColumnPreview } from './ColumnPreview';
import { AIRTABLE_TOKEN_URL, useSyncOutWords } from './words';

const KIND_INFO: Record<DestinationKind, { name: string; description: string }> = {
  airtable: { name: 'Airtable', description: 'A table in one of your bases' },
  smartsheet: { name: 'Smartsheet', description: 'A sheet in your account' },
};

const STEPS = 4;

/** The field error a places call carries when the token itself was refused, else null. */
function tokenError(error: unknown): string | null {
  const info = errorInfo(error);
  return info?.fields?.token ?? null;
}

/** The setup flow in one dialog: choose a destination, connect, check the columns, and start. */
export function SyncOutSetup({
  viewId,
  viewName,
  databaseId,
  kinds,
  onPending,
  onCancel,
  onCreated,
}: {
  viewId: string;
  viewName: string;
  databaseId: string;
  kinds: readonly DestinationKind[];
  onPending(pending: boolean): void;
  onCancel(): void;
  onCreated(sync: OutboundSync): void;
}) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const words = useSyncOutWords();
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const locale = i18n.locale || 'en-US';

  const [step, setStep] = useState(1);
  const [kind, setKind] = useState<DestinationKind>(kinds[0] ?? 'airtable');
  const [token, setToken] = useState('');
  const [base, setBase] = useState<DestinationPlace | null>(null);
  const [tableName, setTableName] = useState(viewName);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [everyMinutes, setEveryMinutes] = useState<SyncOutInterval | null>(60);
  const [removeMissing, setRemoveMissing] = useState(true);
  const [showErrors, setShowErrors] = useState(false);

  const buildDestination = (): DestinationInput | null =>
    base
      ? {
          kind: 'airtable',
          baseId: base.id,
          baseName: base.name,
          table: { mode: 'new', name: tableName.trim() },
        }
      : null;

  const places = useRequest((_: void, signal) =>
    lookupPlaces(viewId, { kind: 'airtable', credential: { token } }, signal),
  );
  const preview = useRequest((_: void, signal) => {
    const destination = buildDestination();
    if (!destination) return Promise.reject(new Error('no destination'));
    return previewSyncOut(
      viewId,
      { destination, credential: { token }, createColumns: true, timeZone, locale },
      signal,
    );
  });
  const create = useRequest((_: void, signal) => {
    const destination = buildDestination();
    if (!destination) return Promise.reject(new Error('no destination'));
    return sendSyncOutCommand(
      databaseId,
      {
        id: newId('command'),
        action: {
          kind: 'create',
          input: {
            viewId,
            name: name.trim(),
            destination,
            credential: { token },
            settings: { everyMinutes, removeMissing, createColumns: true, timeZone, locale },
          },
        },
      },
      signal,
    );
  });

  const busy = places.state === 'loading' || preview.state === 'loading' || create.state === 'loading';
  useEffect(() => onPending(busy), [busy, onPending]);

  const tokenRefused = tokenError(places.error);
  const placesOther = places.state === 'failed' && !tokenRefused ? places.error : undefined;
  const bases = places.state === 'done' ? places.data.places : [];
  const writableBases = bases.filter((place) => place.canWrite);

  // Changing the token clears any bases already found, so Find bases runs again.
  function changeToken(next: string) {
    setToken(next);
    setBase(null);
    places.reset();
  }

  function findBases() {
    setBase(null);
    void places.send().catch(() => {});
  }

  // Each step opens scrolled to the top, as the synced-table wizard does, by keying the body.
  function goTo(next: number) {
    setShowErrors(false);
    setStep(next);
    if (next === 3) {
      preview.reset();
      void preview.send().catch(() => {});
    }
    if (next === 4 && !nameTouched)
      setName(`${tableName.trim()} to ${KIND_INFO[kind].name}`.slice(0, LIMITS.nameLength));
  }

  const step2Valid =
    places.state === 'done' && Boolean(base) && Boolean(base?.canCreate) && tableName.trim().length > 0;
  const step3Valid = preview.state === 'done' && previewProblems().length === 0;
  const step4Valid = name.trim().length > 0;

  function previewProblems(): string[] {
    if (preview.state !== 'done') return [];
    const problems = preview.data.problems.map((problem) => message(problem.messageKey, problem.params));
    if (preview.data.key.action === 'create' && base && !base.canCreate)
      problems.push(message('syncOut.target.keyColumn'));
    return problems;
  }

  function onContinue() {
    if (step === 1) {
      goTo(2);
      return;
    }
    if (step === 2) {
      if (!step2Valid) {
        setShowErrors(true);
        return;
      }
      goTo(3);
      return;
    }
    if (step === 3) {
      if (!step3Valid) return;
      goTo(4);
      return;
    }
    if (!step4Valid) {
      setShowErrors(true);
      return;
    }
    void create.send().then(
      (result) => {
        if (result.sync) onCreated(result.sync);
      },
      () => {},
    );
  }

  const continueLabel =
    step === STEPS
      ? t({ id: 'syncOut.setup.start', message: 'Start syncing' })
      : t({ id: 'syncOut.setup.next', message: 'Continue' });

  return (
    <Form
      key={step}
      className="rio-sync-out__form"
      onSubmit={(event) => {
        event.preventDefault();
        onContinue();
      }}
    >
      <DialogBody key={step} className="rio-sync-out" aria-busy={busy}>
        <p className="rio-sync-out__step">
          {t({ id: 'syncOut.setup.step', message: `Step ${step} of ${STEPS}` })}
        </p>

        {step === 1 ? (
          <RadioGroup
            label={t({ id: 'syncOut.setup.kind', message: 'Where should this view’s rows go?' })}
            value={kind}
            onChange={(value) => setKind(value as DestinationKind)}
            {...anchor('syncOut.setup.kind')}
          >
            {kinds.map((option) => (
              <Radio
                key={option}
                value={option}
                description={
                  option === 'airtable'
                    ? t({ id: 'syncOut.kind.airtable.description', message: 'A table in one of your bases' })
                    : t({ id: 'syncOut.kind.smartsheet.description', message: 'A sheet in your account' })
                }
              >
                {option === 'airtable'
                  ? t({ id: 'syncOut.kind.airtable', message: 'Airtable' })
                  : t({ id: 'syncOut.kind.smartsheet', message: 'Smartsheet' })}
              </Radio>
            ))}
          </RadioGroup>
        ) : null}

        {step === 2 ? (
          <div className="rio-sync-out__connect">
            {placesOther ? (
              <Banner tone="danger">
                {message(errorInfo(placesOther)?.key ?? 'errors.internal', errorInfo(placesOther)?.params)}
                <Button size="sm" onPress={findBases}>
                  {t({ id: 'syncOut.retry', message: 'Try again' })}
                </Button>
              </Banner>
            ) : null}
            <PasswordField
              label={t({ id: 'syncOut.airtable.token.label', message: 'Airtable personal access token' })}
              autoComplete="off"
              value={token}
              onChange={changeToken}
              isInvalid={Boolean(tokenRefused) || (showErrors && token.trim().length === 0)}
              errorMessage={
                tokenRefused
                  ? message(tokenRefused)
                  : showErrors && token.trim().length === 0
                    ? t({ id: 'syncOut.setup.error.token', message: 'Paste a token.' })
                    : undefined
              }
              {...anchor('syncOut.setup.token')}
            />
            <div className="rio-sync-out__token-help">
              <p>
                {t({
                  id: 'syncOut.airtable.token.help',
                  message: 'The token needs these scopes, and access to the base you’ll sync to:',
                })}
              </p>
              <ul className="rio-sync-out__scopes">
                {AIRTABLE_SYNC_OUT_SCOPES.map((scope) => (
                  <li key={scope}>
                    <code>{scope}</code>
                  </li>
                ))}
              </ul>
              <Link external href={AIRTABLE_TOKEN_URL}>
                {t({ id: 'syncOut.airtable.token.link', message: 'Make a token on Airtable' })}
              </Link>
              <p className="rio-sync-out__note">
                {t({
                  id: 'syncOut.token.note',
                  message: 'Riosoma seals the token and never shows it again.',
                })}
              </p>
            </div>
            <Button
              variant="secondary"
              isDisabled={token.trim().length === 0 || places.state === 'loading'}
              onPress={findBases}
            >
              {t({ id: 'syncOut.airtable.find', message: 'Find bases' })}
            </Button>
            {showErrors &&
            token.trim().length > 0 &&
            places.state !== 'done' &&
            places.state !== 'loading' ? (
              <p className="rio-sync-out__field-error">
                {t({ id: 'syncOut.setup.error.find.airtable', message: 'Choose Find bases first.' })}
              </p>
            ) : null}

            {places.state === 'loading' ? (
              <Spinner label={t({ id: 'syncOut.finding', message: 'Looking…' })} />
            ) : places.state === 'done' ? (
              bases.length === 0 ? (
                <p className="rio-sync-out__note">
                  {t({ id: 'syncOut.airtable.base.empty', message: 'This token can’t open any base.' })}
                </p>
              ) : (
                <>
                  <FilterableList
                    listId="syncOut.bases"
                    label={t({ id: 'syncOut.airtable.base', message: 'Base' })}
                    filterLabel={t({ id: 'syncOut.airtable.base', message: 'Base' })}
                    selectionMode="single"
                    selectedKeys={base ? [base.id] : []}
                    items={bases.map((place) => ({
                      id: place.id,
                      name: place.name,
                      group: place.group ?? undefined,
                      groupName: place.group ?? undefined,
                      isDisabled: !place.canWrite,
                      description: place.canWrite
                        ? undefined
                        : t({ id: 'syncOut.place.readOnly', message: 'Read only' }),
                    }))}
                    onSelectionChange={(keys) => {
                      const id = [...keys][0];
                      setBase(bases.find((place) => place.id === id) ?? null);
                    }}
                  />
                  {writableBases.length === 0 ? (
                    <p className="rio-sync-out__note">
                      {t({
                        id: 'syncOut.airtable.base.readOnly',
                        message: 'This token can only read these bases.  Sync out needs one it can edit.',
                      })}
                    </p>
                  ) : null}
                  {showErrors && !base ? (
                    <p className="rio-sync-out__field-error">
                      {t({ id: 'syncOut.setup.error.base', message: 'Choose a base.' })}
                    </p>
                  ) : null}
                  {base ? (
                    <>
                      <p className="rio-sync-out__field-label">
                        {t({ id: 'syncOut.target.new', message: 'Make a new table' })}
                      </p>
                      <TextField
                        label={t({ id: 'syncOut.target.name', message: 'Table name' })}
                        value={tableName}
                        maxLength={LIMITS.nameLength}
                        isDisabled={!base.canCreate}
                        description={
                          base.canCreate
                            ? t({
                                id: 'syncOut.target.new.description',
                                message: 'Riosoma creates it with a column for each field in the view.',
                              })
                            : t({
                                id: 'syncOut.target.new.blocked',
                                message: 'The token can’t add tables to this base.',
                              })
                        }
                        isInvalid={showErrors && base.canCreate && tableName.trim().length === 0}
                        errorMessage={
                          showErrors && base.canCreate && tableName.trim().length === 0
                            ? t({
                                id: 'syncOut.setup.error.targetName.airtable',
                                message: 'Name the new table.',
                              })
                            : undefined
                        }
                        onChange={setTableName}
                      />
                    </>
                  ) : null}
                </>
              )
            ) : null}
          </div>
        ) : null}

        {step === 3 ? (
          <div className="rio-sync-out__columns-step">
            {preview.state === 'failed' ? (
              <Banner tone="danger">
                {message(
                  errorInfo(preview.error)?.key ?? 'errors.internal',
                  errorInfo(preview.error)?.params,
                )}
                <Button
                  size="sm"
                  onPress={() => {
                    preview.reset();
                    void preview.send().catch(() => {});
                  }}
                >
                  {t({ id: 'syncOut.retry', message: 'Try again' })}
                </Button>
              </Banner>
            ) : null}
            {preview.state === 'loading' ? (
              <Spinner label={t({ id: 'syncOut.columns.loading', message: 'Checking the columns…' })} />
            ) : preview.state === 'done' ? (
              <>
                <p className="rio-sync-out__intro">
                  {t({
                    id: 'syncOut.columns.intro.new',
                    message: 'Riosoma will create these columns, in the view’s order.',
                  })}
                </p>
                {previewProblems().length > 0 ? (
                  <Banner tone="danger">
                    <ul className="rio-sync-out__problems">
                      {previewProblems().map((problem, index) => (
                        <li key={index}>{problem}</li>
                      ))}
                    </ul>
                  </Banner>
                ) : null}
                <ColumnPreview preview={preview.data} />
              </>
            ) : null}
          </div>
        ) : null}

        {step === 4 ? (
          <div className="rio-sync-out__schedule">
            <ErrorBanner error={errorInfo(create.error)} />
            <TextField
              label={t({ id: 'syncOut.form.name', message: 'Name' })}
              description={t({ id: 'syncOut.form.name.help', message: 'Shown in this list and in history.' })}
              value={name}
              maxLength={LIMITS.nameLength}
              isInvalid={showErrors && name.trim().length === 0}
              errorMessage={
                showErrors && name.trim().length === 0
                  ? t({ id: 'syncOut.setup.error.name', message: 'Give this sync a name.' })
                  : undefined
              }
              onChange={(value) => {
                setNameTouched(true);
                setName(value);
              }}
            />
            <Select
              label={t({ id: 'syncOut.form.schedule', message: 'Schedule' })}
              description={t({
                id: 'syncOut.form.schedule.help',
                message: 'Riosoma also syncs whenever someone chooses Sync now.',
              })}
              selectedKey={everyMinutes === null ? 'manual' : String(everyMinutes)}
              onSelectionChange={(key) =>
                setEveryMinutes(key === 'manual' ? null : (Number(key) as SyncOutInterval))
              }
            >
              <ListBoxItem id="manual">{words.interval(null)}</ListBoxItem>
              {SYNC_OUT_INTERVALS.map((value) => (
                <ListBoxItem key={value} id={String(value)}>
                  {words.interval(value)}
                </ListBoxItem>
              ))}
            </Select>
            <Checkbox
              isSelected={removeMissing}
              onChange={setRemoveMissing}
              description={t({
                id: 'syncOut.form.removeMissing.help',
                message:
                  'When a record is deleted or stops matching the view’s filters, its row is removed there too.',
              })}
            >
              {t({ id: 'syncOut.form.removeMissing', message: 'Remove rows that leave the view' })}
            </Checkbox>
            <p className="rio-sync-out__note">
              {t({
                id: 'syncOut.setup.runsAs',
                message: 'Runs as you.  Each sync sends what you can see in this view at that moment.',
              })}
            </p>
            <p className="rio-sync-out__note">
              {t({ id: 'syncOut.setup.firstSync', message: 'The first sync starts right away.' })}
            </p>
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        {step === 1 ? (
          <Button isDisabled={busy} onPress={onCancel}>
            {t({ id: 'syncOut.setup.cancel', message: 'Cancel' })}
          </Button>
        ) : (
          <Button isDisabled={busy} onPress={() => goTo(step - 1)}>
            {t({ id: 'syncOut.setup.back', message: 'Back' })}
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          isPending={create.state === 'loading'}
          isDisabled={busy || (step === 3 && !step3Valid) || (step === 1 && kinds.length === 0)}
          {...(step === STEPS ? anchor('syncOut.setup.start') : {})}
        >
          {continueLabel}
        </Button>
      </DialogFooter>
    </Form>
  );
}
