import { faPlus, faPen, faXmark } from '@fortawesome/free-solid-svg-icons';
import { PasswordSettings, SessionSettings } from './SessionSettings';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../Setting';

import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  PasskeyName,
  type AuthenticatorConfirmed,
  type AuthenticatorSetup,
  type MfaOverview,
  type Passkey,
  type PasskeyAdded,
  type RecoveryCodes,
  type SecondStepProof,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  Form,
  FormActions,
  Heading,
  Modal,
  Spinner,
  Text,
  TextField,
  toast,
} from '@riosoma/ui';
import { api } from '../../../api';
import { useRelativeTime } from '../../../relative-time';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { AuthenticatorForm } from '../../mfa/AuthenticatorForm';
import { mfaOverviewQuery } from '../../mfa/overview';
import { createPasskey, passkeyProblem, passkeysSupported, serverRefusal } from '../../mfa/passkeys';
import { needsProof, ProofDialog, ProofForm } from '../../mfa/ProofDialog';
import { RecoveryCodesList } from '../../mfa/RecoveryCodesList';
import { errorInfo } from '../../setup/useSetup';
import '../../mfa/mfa.css';
import { OrganizationPresets } from './OrganizationPresets';

const settingsPage = defineSettingsPage({
  area: 'personal',
  section: 'account',
  page: 'security',
  label: msg({ id: 'mfa.nav.security', message: 'Sign-in and security' }),
  roles: ['personal'],
  keywords: msg({
    id: 'settings.search.keywords.security',
    message: 'sign-in security passkeys two-step authentication recovery codes',
  }),
});

export const MFA_KEY = mfaOverviewQuery.queryKey;

function passkeyPath(passkey: Passkey): string {
  return `/api/me/mfa/passkeys/${encodeURIComponent(passkey.id)}`;
}

/**
 * Sign-in and security, for everyone: passkeys, the authenticator app, and recovery codes.  Once
 * someone has a second step, anything that adds a way in or takes one away asks for a fresh one
 * first, so a session left open somewhere can't change them.
 */
export function SecuritySettings() {
  const { t, i18n } = useLingui();
  const session = useSession();
  const queryClient = useQueryClient();
  const overview = useQuery(mfaOverviewQuery);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<Passkey | null>(null);
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const [app, setApp] = useState<{ setup: AuthenticatorSetup; replacing: boolean } | null>(null);
  const [appBusy, setAppBusy] = useState(false);
  const [turningOff, setTurningOff] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: MFA_KEY });

  const startApp = useMutation({
    mutationFn: (_replacing: boolean) =>
      api<AuthenticatorSetup>('/api/me/mfa/authenticator', { method: 'POST' }),
    onSuccess: (setup, replacing) => setApp({ setup, replacing }),
  });
  const remove = useMutation({
    mutationFn: ({ passkey, proof }: { passkey: Passkey; proof?: SecondStepProof }) =>
      api<void>(passkeyPath(passkey), { method: 'DELETE', body: proof ? { proof } : {} }),
    onSuccess: refresh,
  });

  if (overview.isPending) return <Spinner />;
  if (overview.isError) return <ErrorBanner error={errorInfo(overview.error)} />;
  const data = overview.data;
  const hasSecondStep = data.passkeys.length > 0 || data.authenticator.enabled;
  const canAddPasskeys = data.passkeysAvailable && passkeysSupported();
  const remaining = data.recoveryCodes.remaining;
  const since = data.authenticator.since
    ? i18n.date(new Date(data.authenticator.since), { dateStyle: 'medium' })
    : '';
  const lastOne = (passkey: Passkey) =>
    data.passkeys.length === 1 && data.passkeys[0]!.id === passkey.id && !data.authenticator.enabled;

  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'mfa.nav.security', message: 'Sign-in and security' })}
    >
      {
        <div className="rio-mfa">
          <OrganizationPresets />
          <Setting
            page={settingsPage}
            id="password"
            label={msg({ id: 'auth.reset.save', message: 'Change password' })}
          >
            <PasswordSettings />
          </Setting>
          <Setting
            page={settingsPage}
            id="sessions"
            label={msg({ id: 'auth.sessions.title', message: 'Where you’re signed in' })}
          >
            <SessionSettings />
          </Setting>
          <p className="rio-mfa__intro">
            <Trans id="mfa.settings.intro">
              {
                'A second step keeps your account safe even if someone learns your password.  After a password or an emailed link, Riosoma asks for one.'
              }
            </Trans>
          </p>
          {data.required && !hasSecondStep ? (
            <Banner tone="warning">
              <Trans id="mfa.settings.required">
                {'Your organization requires a second step.  Add a passkey or an authenticator app.'}
              </Trans>
            </Banner>
          ) : null}

          <Setting
            page={settingsPage}
            id="passkeys"
            label={msg({ id: 'mfa.settings.passkeys', message: 'Passkeys' })}
          >
            <section className="rio-mfa__section" aria-labelledby="mfa-passkeys">
              <div className="rio-mfa__head">
                <Heading level={2} id="mfa-passkeys">
                  <Trans id="mfa.settings.passkeys">Passkeys</Trans>
                </Heading>
                {canAddPasskeys ? (
                  <Button
                    onPress={() => setAdding(true)}
                    aria-label={t({ id: 'mfa.settings.addPasskey', message: 'Add a passkey' })}
                    icon={faPlus}
                  />
                ) : null}
              </div>
              <p className="rio-mfa__note">
                <Trans id="mfa.settings.passkeysAbout">
                  {
                    'A passkey signs you in with your fingerprint, face, or screen lock, with no password.  It also works as your second step.'
                  }
                </Trans>
              </p>
              {!data.passkeysAvailable ? (
                <p className="rio-mfa__note">
                  <Trans id="mfa.settings.passkeysOff">
                    Passkeys work only when this server’s address uses https.
                  </Trans>
                </p>
              ) : !passkeysSupported() ? (
                <p className="rio-mfa__note">
                  <Trans id="mfa.settings.passkeysUnsupported">This browser can’t use passkeys.</Trans>
                </p>
              ) : null}
              {data.passkeys.length ? (
                <ul className="rio-mfa__list">
                  {data.passkeys.map((passkey) => (
                    <PasskeyItem
                      key={passkey.id}
                      passkey={passkey}
                      onRename={() => setRenaming(passkey)}
                      onRemove={() => {
                        remove.reset();
                        setRemoving(passkey);
                      }}
                    />
                  ))}
                </ul>
              ) : null}
            </section>
          </Setting>

          <Setting
            page={settingsPage}
            id="authenticator"
            label={msg({ id: 'mfa.settings.app', message: 'Authenticator app' })}
          >
            <section className="rio-mfa__section" aria-labelledby="mfa-app">
              <div className="rio-mfa__head">
                <Heading level={2} id="mfa-app">
                  <Trans id="mfa.settings.app">Authenticator app</Trans>
                </Heading>
                {data.authenticator.enabled ? (
                  <div className="rio-mfa__buttons">
                    <Button isPending={startApp.isPending} onPress={() => startApp.mutate(true)}>
                      <Trans id="mfa.settings.appReplace">Replace</Trans>
                    </Button>
                    <Button onPress={() => setTurningOff(true)}>
                      <Trans id="mfa.settings.appOff">Turn off</Trans>
                    </Button>
                  </div>
                ) : (
                  <Button isPending={startApp.isPending} onPress={() => startApp.mutate(false)}>
                    <Trans id="mfa.settings.appSetUp">Set up</Trans>
                  </Button>
                )}
              </div>
              <p className="rio-mfa__note">
                <Trans id="mfa.settings.appAbout">
                  An authenticator app on your phone shows a new six-digit code every 30 seconds.
                </Trans>
              </p>
              <p className="rio-mfa__status">
                {data.authenticator.enabled ? (
                  <Trans id="mfa.settings.appOnSince">On since {since}</Trans>
                ) : (
                  <Trans id="mfa.settings.appIsOff">Off</Trans>
                )}
              </p>
              <ErrorBanner error={errorInfo(startApp.error)} />
            </section>
          </Setting>

          <Setting
            page={settingsPage}
            id="recovery-codes"
            label={msg({ id: 'mfa.settings.codes', message: 'Recovery codes' })}
          >
            <section className="rio-mfa__section" aria-labelledby="mfa-codes">
              <div className="rio-mfa__head">
                <Heading level={2} id="mfa-codes">
                  <Trans id="mfa.settings.codes">Recovery codes</Trans>
                </Heading>
                {hasSecondStep ? (
                  <Button onPress={() => setRegenerating(true)}>
                    <Trans id="mfa.settings.newCodes">Make new codes</Trans>
                  </Button>
                ) : null}
              </div>
              <p className="rio-mfa__note">
                <Trans id="mfa.settings.codesAbout">
                  {
                    'If your passkeys and your app are out of reach, a recovery code signs you in instead.  Each one works once.'
                  }
                </Trans>
              </p>
              <p className="rio-mfa__status">
                {hasSecondStep
                  ? t({
                      id: 'mfa.settings.codesLeft',
                      message: plural(remaining, { one: '# code left', other: '# codes left' }),
                    })
                  : t({
                      id: 'mfa.settings.codesFirst',
                      message: 'Add a passkey or an authenticator app first.',
                    })}
              </p>
            </section>
          </Setting>

          {adding ? (
            <AddPasskeyDialog
              overview={data}
              onClose={() => setAdding(false)}
              onAdded={(added) => {
                void refresh();
                if (added.recoveryCodes) setCodes(added.recoveryCodes);
              }}
            />
          ) : null}
          {renaming ? (
            <RenamePasskeyDialog passkey={renaming} onClose={() => setRenaming(null)} onRenamed={refresh} />
          ) : null}
          {removing && lastOne(removing) ? (
            <ProofDialog
              title={t({ id: 'mfa.settings.removeTitle', message: `Remove ${removing.name}?` })}
              message={t({
                id: 'mfa.settings.removeLast',
                message: 'It’s your last second step, so confirm it’s you first.',
              })}
              confirmLabel={t({ id: 'mfa.settings.remove', message: 'Remove' })}
              overview={data}
              onProof={(proof) => remove.mutateAsync({ passkey: removing, proof })}
              onClose={() => setRemoving(null)}
            />
          ) : removing ? (
            <ConfirmDialog
              isOpen
              tone="danger"
              title={t({ id: 'mfa.settings.removeTitle', message: `Remove ${removing.name}?` })}
              message={
                <>
                  <Trans id="mfa.settings.removeBody">It stops working for signing in to Riosoma.</Trans>
                  <ErrorBanner error={errorInfo(remove.error)} />
                </>
              }
              confirmLabel={t({ id: 'mfa.settings.remove', message: 'Remove' })}
              onOpenChange={(open) => {
                if (!open) setRemoving(null);
              }}
              onConfirm={() => remove.mutateAsync({ passkey: removing })}
            />
          ) : null}
          {app ? (
            <Modal
              isOpen
              isDismissable={!appBusy}
              isKeyboardDismissDisabled={appBusy}
              onOpenChange={(open) => {
                if (!open && !appBusy) setApp(null);
              }}
            >
              <Dialog>
                <DialogTitle>
                  {app.replacing ? (
                    <Trans id="mfa.settings.replaceTitle">Replace your authenticator app</Trans>
                  ) : (
                    <Trans id="mfa.settings.appTitle">Set up an authenticator app</Trans>
                  )}
                </DialogTitle>
                <DialogBody>
                  <AuthenticatorForm<AuthenticatorConfirmed>
                    setup={app.setup}
                    confirmPath="/api/me/mfa/authenticator/confirm"
                    onBusyChange={setAppBusy}
                    proof={
                      needsProof(data)
                        ? {
                            overview: data,
                            replacingApp: app.replacing,
                            message: app.replacing
                              ? t({
                                  id: 'mfa.settings.replaceProof',
                                  message:
                                    'Your current app stops working once the new one is on.  Confirm it’s you first.',
                                })
                              : t({
                                  id: 'mfa.settings.appProof',
                                  message:
                                    'The app will be another way into your account, so confirm it’s you first.',
                                }),
                            confirmLabel: app.replacing
                              ? t({ id: 'mfa.settings.appReplace', message: 'Replace' })
                              : t({ id: 'mfa.app.turnOn', message: 'Turn on' }),
                          }
                        : undefined
                    }
                    onConfirmed={(result) => {
                      const replaced = app.replacing;
                      setApp(null);
                      void refresh();
                      if (result.recoveryCodes) setCodes(result.recoveryCodes);
                      else
                        toast.show({
                          tone: 'success',
                          title: replaced
                            ? t({
                                id: 'mfa.settings.appReplaced',
                                message: 'Your new authenticator app is on',
                              })
                            : t({ id: 'mfa.settings.appOnNow', message: 'The authenticator app is on' }),
                        });
                    }}
                    actions={
                      <Button onPress={() => setApp(null)}>
                        <Trans id="mfa.settings.cancel">Cancel</Trans>
                      </Button>
                    }
                  />
                </DialogBody>
              </Dialog>
            </Modal>
          ) : null}
          {turningOff ? (
            <ProofDialog
              title={t({ id: 'mfa.settings.appOffTitle', message: 'Turn off the authenticator app?' })}
              message={t({
                id: 'mfa.settings.appOffBody',
                message: 'Its codes stop working.  Confirm it’s you first.',
              })}
              confirmLabel={t({ id: 'mfa.settings.appOff', message: 'Turn off' })}
              overview={data}
              onProof={(proof) =>
                api<void>('/api/me/mfa/authenticator', { method: 'DELETE', body: { proof } }).then(refresh)
              }
              onClose={() => setTurningOff(false)}
            />
          ) : null}
          {regenerating ? (
            <ProofDialog
              title={t({ id: 'mfa.settings.newCodesTitle', message: 'Make new recovery codes?' })}
              message={t({
                id: 'mfa.settings.newCodesProof',
                message: 'Your current recovery codes stop working.  Confirm it’s you first.',
              })}
              confirmLabel={t({ id: 'mfa.settings.newCodes', message: 'Make new codes' })}
              tone="primary"
              overview={data}
              onProof={async (proof) => {
                const made = await api<RecoveryCodes>('/api/me/mfa/recovery-codes', { body: { proof } });
                setCodes(made.codes);
                void refresh();
              }}
              onClose={() => setRegenerating(false)}
            />
          ) : null}
          {codes ? (
            <Modal
              isOpen
              isDismissable={false}
              isKeyboardDismissDisabled
              overlayClassName="rio-mfa-codes-overlay"
              className="rio-mfa-codes-modal"
            >
              <Dialog hideCloseButton>
                <DialogTitle>
                  <Trans id="mfa.settings.codesTitle">Your recovery codes</Trans>
                </DialogTitle>
                <DialogBody>
                  <RecoveryCodesList codes={codes} email={session?.user.email ?? ''} />
                </DialogBody>
                <DialogFooter>
                  <Button variant="primary" onPress={() => setCodes(null)}>
                    <Trans id="mfa.settings.codesDone">Done</Trans>
                  </Button>
                </DialogFooter>
              </Dialog>
            </Modal>
          ) : null}
        </div>
      }
    </Setting>
  );
}

function PasskeyItem({
  passkey,
  onRename,
  onRemove,
}: {
  passkey: Passkey;
  onRename(): void;
  onRemove(): void;
}) {
  const { t, i18n } = useLingui();
  const name = passkey.name;
  const added = i18n.date(new Date(passkey.createdAt), { dateStyle: 'medium' });
  return (
    <li className="rio-mfa__item">
      <div className="rio-mfa__item-text">
        <span className="rio-mfa__item-name">{name}</span>
        <span className="rio-mfa__item-meta">
          <Trans id="mfa.settings.added">Added {added}</Trans>
        </span>
        <span className="rio-mfa__item-meta">
          {passkey.lastUsedAt ? (
            <LastUsed at={passkey.lastUsedAt} />
          ) : (
            <Trans id="mfa.settings.neverUsed">Never used</Trans>
          )}
        </span>
      </div>
      <Button
        size="sm"
        variant="quiet"
        aria-label={t({ id: 'mfa.settings.renameNamed', message: `Rename ${name}` })}
        onPress={onRename}
        icon={faPen}
      />
      <Button
        size="sm"
        variant="quiet"
        aria-label={t({ id: 'mfa.settings.removeNamed', message: `Remove ${name}` })}
        onPress={onRemove}
        icon={faXmark}
      />
    </li>
  );
}

function LastUsed({ at }: { at: string }) {
  const { t } = useLingui();
  const when = useRelativeTime(at);
  return <time dateTime={at}>{t({ id: 'mfa.settings.lastUsed', message: `Last used ${when}` })}</time>;
}

/**
 * Names a new passkey, then asks the browser to make it.  Beside another second step, a fresh one
 * comes first, and it's sent along with the new passkey.
 */
function AddPasskeyDialog({
  overview,
  onClose,
  onAdded,
}: {
  overview: MfaOverview;
  onClose(): void;
  onAdded(added: PasskeyAdded): void;
}) {
  const { t, i18n } = useLingui();
  const [name, setName] = useState(() => t({ id: 'mfa.settings.passkeyName', message: 'Passkey' }));
  const [stage, setStage] = useState<'name' | 'proof'>('name');
  const [proving, setProving] = useState(false);
  const add = useMutation({
    mutationFn: async (proof: SecondStepProof | undefined) => {
      const response = await createPasskey('/api/me/mfa/passkeys/options');
      return api<PasskeyAdded>('/api/me/mfa/passkeys', {
        body: { name: name.trim(), response, ...(proof ? { proof } : {}) },
      });
    },
    onSuccess: (added) => {
      onAdded(added);
      onClose();
    },
  });
  const busy = add.isPending || proving;
  const valid = PasskeyName.safeParse(name).success;
  const problem = passkeyProblem(add.error);
  return (
    <Modal
      isOpen
      isDismissable={!busy}
      isKeyboardDismissDisabled={busy}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>
          <Trans id="mfa.settings.addPasskey">Add a passkey</Trans>
        </DialogTitle>
        <DialogBody>
          {stage === 'proof' ? (
            <ProofForm
              message={t({
                id: 'mfa.settings.addPasskeyProof',
                message: 'A new passkey is another way into your account, so confirm it’s you first.',
              })}
              confirmLabel={t({ id: 'mfa.settings.addPasskeyConfirm', message: 'Add passkey' })}
              overview={overview}
              tone="primary"
              onBusyChange={setProving}
              onProof={(proof) => add.mutateAsync(proof)}
              onCancel={() => {
                add.reset();
                setStage('name');
              }}
            />
          ) : (
            <Form
              onSubmit={(event) => {
                event.preventDefault();
                if (!valid || add.isPending) return;
                if (needsProof(overview)) setStage('proof');
                else add.mutate(undefined);
              }}
            >
              <Text>
                <Trans id="mfa.settings.addPasskeyHelp">
                  Your browser will ask you to make one with your fingerprint, face, or screen lock.
                </Trans>
              </Text>
              <TextField
                label={t({ id: 'mfa.settings.passkeyNameLabel', message: 'Name' })}
                description={t({
                  id: 'mfa.settings.passkeyNameHelp',
                  message: 'A name like “Work laptop” helps you tell your passkeys apart.',
                })}
                value={name}
                onChange={setName}
                maxLength={60}
                isRequired
                autoFocus
              />
              <ErrorBanner error={serverRefusal(add.error)} />
              {problem ? <Banner tone="warning">{i18n._(problem)}</Banner> : null}
              <FormActions>
                <Button isDisabled={add.isPending} onPress={onClose}>
                  <Trans id="mfa.settings.cancel">Cancel</Trans>
                </Button>
                <Button type="submit" variant="primary" isDisabled={!valid} isPending={add.isPending}>
                  <Trans id="mfa.settings.continue">Continue</Trans>
                </Button>
              </FormActions>
            </Form>
          )}
        </DialogBody>
      </Dialog>
    </Modal>
  );
}

function RenamePasskeyDialog({
  passkey,
  onClose,
  onRenamed,
}: {
  passkey: Passkey;
  onClose(): void;
  onRenamed(): void;
}) {
  const { t } = useLingui();
  const [name, setName] = useState(passkey.name);
  const rename = useMutation({
    mutationFn: () => api<Passkey>(passkeyPath(passkey), { method: 'PATCH', body: { name: name.trim() } }),
    onSuccess: () => {
      onRenamed();
      onClose();
    },
  });
  const valid = PasskeyName.safeParse(name).success;
  return (
    <Modal
      isOpen
      isDismissable={!rename.isPending}
      onOpenChange={(open) => {
        if (!open && !rename.isPending) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>
          <Trans id="mfa.settings.renameTitle">Rename passkey</Trans>
        </DialogTitle>
        <DialogBody>
          <Form
            onSubmit={(event) => {
              event.preventDefault();
              if (valid && !rename.isPending) rename.mutate();
            }}
          >
            <TextField
              label={t({ id: 'mfa.settings.passkeyNameLabel', message: 'Name' })}
              value={name}
              onChange={setName}
              maxLength={60}
              isRequired
              autoFocus
            />
            <ErrorBanner error={errorInfo(rename.error)} />
            <FormActions>
              <Button isDisabled={rename.isPending} onPress={onClose}>
                <Trans id="mfa.settings.cancel">Cancel</Trans>
              </Button>
              <Button type="submit" variant="primary" isDisabled={!valid} isPending={rename.isPending}>
                <Trans id="mfa.settings.save">Save</Trans>
              </Button>
            </FormActions>
          </Form>
        </DialogBody>
      </Dialog>
    </Modal>
  );
}
