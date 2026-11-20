import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  LIMITS,
  TOKEN_SCOPES,
  TokenCreate,
  type DatabaseSummary,
  type TokenCreated,
  type TokenScope,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  Checkbox,
  CheckboxGroup,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  Form,
  FilterableList,
  Modal,
  Radio,
  RadioGroup,
  Spinner,
  TextField,
  toast,
} from '@riosoma/ui';
import { api, ApiError } from '../../../api';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { mfaOverviewQuery } from '../../mfa/overview';
import { needsProof, ProofForm } from '../../mfa/ProofDialog';
import { errorInfo } from '../../setup/useSetup';
import { useScopeLabels } from './labels';
import './tokens.css';

/** How long a new token lives, as the radio's key.  `never` posts a null, which never expires. */
const EXPIRIES = [
  { key: '30', days: 30 },
  { key: '90', days: 90 },
  { key: '365', days: 365 },
  { key: 'never', days: null },
] as const;
type Expiry = (typeof EXPIRIES)[number]['key'];

/** Which databases a token may open: every one of them, or a list picked here. */
type Reach = 'all' | 'chosen';

const isScope = (value: string): value is TokenScope => (TOKEN_SCOPES as readonly string[]).includes(value);

/** Keeps a stray key from the radio group out of the expiry state. */
function expiryKey(key: string): Expiry {
  return EXPIRIES.find((option) => option.key === key)?.key ?? '90';
}

export interface CreateTokenDialogProps {
  /** The person's own databases, the only ones a token can be limited to. */
  databases: DatabaseSummary[];
  /** Those databases are still on their way, so the picker shows a wait instead of an empty list. */
  loadingDatabases: boolean;
  onClose(): void;
  onCreated(created: TokenCreated): void;
}

/**
 * Asks for a token's name, reach, and lifetime, then shows the secret once.  The server answers a
 * create with the token itself and stores only its hash, so after this dialog closes the value is
 * gone for good.  The warning and the read-only field are there for that one showing.  A token is
 * another way in, so someone with a second step confirms it's them before it's made.
 */
export function CreateTokenDialog({
  databases,
  loadingDatabases,
  onClose,
  onCreated,
}: CreateTokenDialogProps) {
  const { t } = useLingui();
  const labels = useScopeLabels();
  const fields = useRef<HTMLDivElement>(null);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<TokenScope[]>([]);
  const [reach, setReach] = useState<Reach>('all');
  const [chosen, setChosen] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<Expiry>('90');
  // Complaints wait for the first submit, so the dialog doesn't open on a form that is already red.
  const [attempted, setAttempted] = useState(false);
  const [created, setCreated] = useState<TokenCreated | null>(null);
  // The token waiting for a fresh second step, once the form is filled in.
  const [draft, setDraft] = useState<TokenCreate | null>(null);
  const [proving, setProving] = useState(false);
  const overview = useQuery(mfaOverviewQuery);
  const create = useMutation({
    mutationFn: (body: TokenCreate) => api<TokenCreated>('/api/tokens', { body }),
    onSuccess: (token) => {
      setCreated(token);
      onCreated(token);
    },
    onError: (error, body) => {
      // A second step added since the page loaded: ask for it now, with what was already typed.
      if (error instanceof ApiError && error.info.messageKey === 'mfa.proof.required') {
        void overview.refetch();
        setDraft(body);
      }
    },
  });
  const pending = create.isPending || proving;
  const missingScopes = scopes.length === 0;
  const missingDatabases = reach === 'chosen' && chosen.length === 0;

  // The name is what someone types first, so the field waits for them instead of the dialog.
  useEffect(() => {
    const frame = requestAnimationFrame(() => fields.current?.querySelector('input')?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const inDays = (count: number) =>
    t({ id: 'tokens.expiry.days', message: plural(count, { one: 'In # day', other: 'In # days' }) });

  function submit() {
    setAttempted(true);
    const body = TokenCreate.safeParse({
      name: name.trim(),
      scopes,
      databases: reach === 'all' ? 'all' : chosen,
      expiresInDays: EXPIRIES.find((option) => option.key === expiry)?.days ?? null,
    });
    // The contract is the only rule book: what it rejects never reaches the server.
    if (!body.success || pending) return;
    if (overview.data && needsProof(overview.data)) setDraft(body.data);
    else create.mutate(body.data);
  }

  async function copyToken(secret: string) {
    try {
      await navigator.clipboard.writeText(secret);
    } catch {
      // A browser that refuses the clipboard (no permission, or an insecure context) still leaves
      // the read-only field, so the token can be selected and copied by hand.
      return;
    }
    toast.show({ tone: 'success', title: t({ id: 'tokens.copied', message: 'Copied the token' }) });
  }

  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      isDismissable={!pending}
      isKeyboardDismissDisabled={pending}
    >
      <Dialog>
        <DialogTitle>
          {created ? (
            <Trans id="tokens.created.title">Copy your new token</Trans>
          ) : (
            <Trans id="tokens.create">Create token</Trans>
          )}
        </DialogTitle>
        {created ? (
          <>
            <DialogBody className="rio-tokens__reveal">
              <Banner tone="warning">
                {t({
                  id: 'tokens.created.warning',
                  message: "Copy this token now.  You won't be able to see it again.",
                })}
              </Banner>
              <div className="rio-tokens__secret">
                <div className="rio-tokens__secret-field">
                  {/* The field carries the name just given to the token: the secret itself has no
                      words of its own to be labeled with. */}
                  <TextField label={created.name} value={created.token} isReadOnly />
                </div>
                <Button
                  onPress={() => {
                    void copyToken(created.token);
                  }}
                  aria-label={t({ id: 'tokens.copy', message: 'Copy' })}
                  icon={faCopy}
                />
              </div>
            </DialogBody>
            <DialogFooter>
              <Button variant="primary" onPress={onClose}>
                <Trans id="tokens.done">Done</Trans>
              </Button>
            </DialogFooter>
          </>
        ) : draft ? (
          <DialogBody>
            {overview.data ? (
              <ProofForm
                message={t({
                  id: 'mfa.tokens.proof',
                  message: 'A token is another way into your account, so confirm it’s you first.',
                })}
                confirmLabel={t({ id: 'tokens.create', message: 'Create token' })}
                overview={overview.data}
                tone="primary"
                onBusyChange={setProving}
                onProof={(proof) => create.mutateAsync({ ...draft, proof })}
                onCancel={() => {
                  create.reset();
                  setDraft(null);
                }}
              />
            ) : (
              <Spinner />
            )}
          </DialogBody>
        ) : (
          <Form
            className="rio-tokens__form"
            validationBehavior="aria"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <DialogBody>
              <div className="rio-tokens__fields" ref={fields}>
                <TextField
                  label={t({ id: 'tokens.name', message: 'Name' })}
                  value={name}
                  onChange={setName}
                  maxLength={LIMITS.nameLength}
                  isRequired
                  isDisabled={pending}
                />
                <CheckboxGroup
                  label={t({ id: 'tokens.scopes', message: 'What it can do' })}
                  value={scopes}
                  onChange={(values) => setScopes(values.filter(isScope))}
                  isDisabled={pending}
                  validationBehavior="aria"
                  isInvalid={attempted && missingScopes}
                  errorMessage={t({
                    id: 'tokens.error.scopes',
                    message: 'Choose at least one thing this token can do.',
                  })}
                >
                  {TOKEN_SCOPES.map((scope) => (
                    <Checkbox key={scope} value={scope}>
                      {labels[scope]}
                    </Checkbox>
                  ))}
                </CheckboxGroup>
                <RadioGroup
                  label={t({ id: 'tokens.databases.pick', message: 'Databases' })}
                  value={reach}
                  onChange={(key) => setReach(key === 'chosen' ? 'chosen' : 'all')}
                  isDisabled={pending}
                >
                  <Radio value="all">
                    <Trans id="tokens.databases.allLabel">All databases I can open, now and later</Trans>
                  </Radio>
                  <Radio value="chosen">
                    <Trans id="tokens.databases.chosen">Only these databases</Trans>
                  </Radio>
                </RadioGroup>
                {reach === 'chosen' ? (
                  <div className="rio-tokens__pick">
                    {loadingDatabases ? <Spinner size="sm" /> : null}
                    {databases.length > 10 ? (
                      <FilterableList
                        label={t({ id: 'tokens.databases.chosen', message: 'Only these databases' })}
                        selectedKeys={chosen}
                        onSelectionChange={(keys) => setChosen([...keys].map(String))}
                        isDisabled={pending}
                        listId="tokens.databases"
                        items={databases}
                        selectionMode="multiple"
                        isInvalid={attempted && missingDatabases}
                        errorMessage={t({
                          id: 'tokens.error.databases',
                          message: 'Choose at least one database.',
                        })}
                      />
                    ) : (
                      <CheckboxGroup
                        aria-label={t({ id: 'tokens.databases.chosen', message: 'Only these databases' })}
                        value={chosen}
                        onChange={setChosen}
                        isDisabled={pending}
                        validationBehavior="aria"
                        isInvalid={attempted && missingDatabases}
                        errorMessage={t({
                          id: 'tokens.error.databases',
                          message: 'Choose at least one database.',
                        })}
                      >
                        {databases.map((database) => (
                          <Checkbox key={database.id} value={database.id}>
                            {database.name}
                          </Checkbox>
                        ))}
                      </CheckboxGroup>
                    )}
                  </div>
                ) : null}
                <RadioGroup
                  label={t({ id: 'tokens.expiry', message: 'Expires' })}
                  value={expiry}
                  onChange={(key) => setExpiry(expiryKey(key))}
                  isDisabled={pending}
                >
                  <Radio value="30">{inDays(30)}</Radio>
                  <Radio value="90">{inDays(90)}</Radio>
                  <Radio value="365">
                    <Trans id="tokens.expiry.year">In 1 year</Trans>
                  </Radio>
                  <Radio value="never">
                    <Trans id="tokens.expiry.never">Never</Trans>
                  </Radio>
                </RadioGroup>
                <ErrorBanner error={errorInfo(create.error)} />
              </div>
            </DialogBody>
            <DialogFooter>
              <Button type="submit" variant="primary" isPending={pending} isDisabled={!name.trim()}>
                <Trans id="tokens.create">Create token</Trans>
              </Button>
            </DialogFooter>
          </Form>
        )}
      </Dialog>
    </Modal>
  );
}
